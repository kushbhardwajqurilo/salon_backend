import crypto from "node:crypto";
import { Notification } from "../../models/notifications/notification.model.js";
import { emailQueue, smsQueue } from "../../queues/client.js";
import {
  resolveRecipientsForEvent,
  evaluateConsentAndChannel,
} from "./recipientResolver.service.js";
import { redactSensitiveText } from "./notificationEventContract.js";
import { logger } from "../../utils/logger.js";

/**
 * Orchestrates an outbox event into durable Notification records and
 * enqueues eligible email/sms deliveries.
 *
 * - Idempotent per (organizationId, sourceEventId, recipientType, recipientId, purpose, channel).
 * - Persists `in_app` notifications directly as `delivered` for the recipient inbox.
 * - Keeps `whatsapp` in `pending` (unsupported until provider integration).
 * - Never claims `sent` or `delivered` on external queue insertion.
 */
export async function orchestrateOutboxEvent(event) {
  const targets = await resolveRecipientsForEvent(event);
  const results = [];

  for (const target of targets) {
    for (const channel of target.channels) {
      const eligibility = evaluateConsentAndChannel({
        recipient: target.recipient,
        purpose: target.purpose,
        channel,
        eventType: event.eventType,
      });

      if (!eligibility.eligible) {
        results.push({
          recipientId: target.recipientId,
          channel,
          status: "skipped",
          reason: eligibility.reason,
        });
        continue;
      }

      const idempotencyKey = `${event.eventId}:${target.recipientType}:${target.recipientId}:${target.purpose}:${channel}`;
      const notificationId = crypto.randomUUID();

      // Strip any sensitive fields for payroll
      const safeMetadata =
        target.purpose === "payroll"
          ? { portalLinkOnly: true, payslipId: event.payload?.payslipId ?? null }
          : { ...(event.payload || {}) };

      let notification;
      try {
        notification = await Notification.create({
          notificationId,
          organizationId: event.organizationId,
          branchId: event.branchId ?? null,
          sourceEventId: event.eventId,
          eventType: event.eventType,
          purpose: target.purpose,
          recipientType: target.recipientType,
          recipientId: target.recipientId,
          channel,
          status: "pending",
          idempotencyKey,
          metadata: safeMetadata,
        });
      } catch (err) {
        if (err?.code === 11000) {
          const existing = await Notification.findOne({
            organizationId: event.organizationId,
            idempotencyKey,
          });
          if (!existing || existing.status !== "pending") {
            results.push({
              recipientId: target.recipientId,
              channel,
              status: "duplicate",
            });
            continue;
          }
          // Resume stranded pending notification (e.g. crash before enqueue)
          notification = existing;
        } else {
          throw err;
        }
      }

      // Keep whatsapp as pending (provider integration not yet implemented)
      if (channel === "whatsapp") {
        results.push({
          notificationId: notification.notificationId,
          channel,
          status: "pending",
        });
        continue;
      }

      // In-app delivery is complete once persisted in MongoDB for the recipient inbox
      if (channel === "in_app") {
        await Notification.updateOne(
          { _id: notification._id, status: "pending" },
          { $set: { status: "delivered", deliveredAt: new Date() } },
        );
        results.push({
          notificationId: notification.notificationId,
          channel,
          status: "delivered",
        });
        continue;
      }

      try {
        const targetQueue = channel === "email" ? emailQueue : smsQueue;
        await targetQueue.add(
          event.eventType,
          {
            notificationId: notification.notificationId,
            organizationId: String(event.organizationId),
            branchId: event.branchId ? String(event.branchId) : null,
            recipientId: String(target.recipientId),
            metadata: safeMetadata,
          },
          { jobId: notification.notificationId },
        );

        await Notification.updateOne(
          { _id: notification._id, status: "pending" },
          { $set: { status: "queued" } },
        );

        results.push({
          notificationId: notification.notificationId,
          channel,
          status: "queued",
        });
      } catch (err) {
        await Notification.updateOne(
          { _id: notification._id, status: "pending" },
          {
            $set: {
              status: "failed",
              failureReason: redactSensitiveText(err?.message || "Queue enqueue failed"),
            },
          },
        );
        logger.error(
          `[NOTIFICATION_ENQUEUE_FAILED] id=${notification.notificationId} channel=${channel}`,
        );
        results.push({
          notificationId: notification.notificationId,
          channel,
          status: "failed",
        });
      }
    }
  }

  return results;
}
