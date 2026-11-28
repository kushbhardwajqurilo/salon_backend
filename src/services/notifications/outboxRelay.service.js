import crypto from "node:crypto";
import { OutboxEvent } from "../../models/notifications/outboxEvent.model.js";
import { recoverPendingAppointmentOutboxEvents } from "../appointments/appointment.service.js";
import { notificationQueue } from "../../queues/client.js";
import { redactSensitiveText } from "./notificationEventContract.js";
import { logger } from "../../utils/logger.js";

const DEFAULT_BATCH_LIMIT = 25;
const DEFAULT_MAX_ATTEMPTS = 5;
const DEFAULT_BASE_BACKOFF_MS = 5000;
const MAX_BACKOFF_MS = 3_600_000; // 1 hour cap
const DEFAULT_STALE_AFTER_MS = 120_000;

/**
 * Atomically claims up to `limit` eligible pending outbox events.
 * Uses findOneAndUpdate so concurrent relay workers cannot claim the same event.
 */
export async function claimPendingOutboxEvents({
  limit = DEFAULT_BATCH_LIMIT,
  workerId = `relay-${crypto.randomUUID().slice(0, 8)}`,
  now = new Date(),
} = {}) {
  const claimed = [];
  const safeLimit = Math.max(
    1,
    Math.min(Number(limit) || DEFAULT_BATCH_LIMIT, 100),
  );

  for (let i = 0; i < safeLimit; i += 1) {
    const doc = await OutboxEvent.findOneAndUpdate(
      {
        status: "pending",
        availableAt: { $lte: now },
      },
      {
        $set: {
          status: "processing",
          claimedAt: now,
          claimedBy: workerId,
        },
        $inc: { attempts: 1 },
      },
      {
        sort: { availableAt: 1, createdAt: 1 },
        returnDocument: 'after',
      },
    );

    if (!doc) break;
    claimed.push(doc);
  }

  return claimed;
}

/**
 * Recovers stale `processing` claims whose lease expired after a worker crash.
 */
export async function recoverStaleProcessingClaims({
  staleAfterMs = DEFAULT_STALE_AFTER_MS,
  now = new Date(),
} = {}) {
  const cutoff = new Date(now.getTime() - staleAfterMs);
  const result = await OutboxEvent.updateMany(
    {
      status: "processing",
      claimedAt: { $lte: cutoff },
    },
    {
      $set: {
        status: "pending",
        availableAt: now,
        claimedAt: null,
        claimedBy: null,
        lastError: {
          code: "STALE_CLAIM_RECOVERED",
          message: "Processing lease expired before completion",
          occurredAt: now,
        },
      },
    },
  );

  const recoveredCount = result?.modifiedCount ?? 0;
  if (recoveredCount > 0) {
    logger.warn(`[OUTBOX_STALE_RECOVERED] count=${recoveredCount}`);
  }
  return recoveredCount;
}

/**
 * Publishes a single claimed outbox event to `notificationQueue` using a stable
 * BullMQ `jobId` derived from `event.eventId` for at-least-once idempotent enqueueing.
 */
export async function publishClaimedOutboxEvent(
  event,
  {
    now = new Date(),
    maxAttempts = DEFAULT_MAX_ATTEMPTS,
    baseBackoffMs = DEFAULT_BASE_BACKOFF_MS,
  } = {},
) {
  try {
    await notificationQueue.add(
      event.eventType,
      {
        eventId: event.eventId,
        organizationId: String(event.organizationId),
        branchId: event.branchId ? String(event.branchId) : null,
        eventType: event.eventType,
        idempotencyKey: event.idempotencyKey,
        schemaVersion: event.schemaVersion,
        payload: event.payload,
      },
      {
        jobId: event.eventId,
      },
    );

    const publishedAt = new Date();
    await OutboxEvent.updateOne(
      { _id: event._id, status: "processing", claimedBy: event.claimedBy },
      {
        $set: {
          status: "published",
          publishedAt,
          claimedAt: null,
          claimedBy: null,
          lastError: null,
        },
      },
    );

    return { status: "published", eventId: event.eventId };
  } catch (err) {
    const attempts = event.attempts || 1;
    const isTerminal = attempts >= maxAttempts;
    const delayMs = Math.min(
      baseBackoffMs * Math.pow(2, Math.max(0, attempts - 1)),
      MAX_BACKOFF_MS,
    );
    const nextStatus = isTerminal ? "failed" : "pending";

    await OutboxEvent.updateOne(
      { _id: event._id, status: "processing", claimedBy: event.claimedBy },
      {
        $set: {
          status: nextStatus,
          availableAt: isTerminal
            ? event.availableAt
            : new Date(now.getTime() + delayMs),
          claimedAt: null,
          claimedBy: null,
          lastError: {
            code: err?.code ? String(err.code) : "QUEUE_PUBLISH_FAILED",
            message: redactSensitiveText(
              err?.message || "Queue publication failed",
            ),
            occurredAt: new Date(),
          },
        },
      },
    );

    logger.error(
      `[OUTBOX_PUBLISH_FAILED] eventId=${event.eventId} attempts=${attempts} nextStatus=${nextStatus}`,
    );

    return { status: nextStatus, eventId: event.eventId };
  }
}

/**
 * Executes one bounded outbox relay & stale-claim recovery cycle.
 */
export async function runOutboxRelayCycle(options = {}) {
  const now = options.now ?? new Date();
  try {
    await recoverPendingAppointmentOutboxEvents(options.organizationId ?? null, options.limit ?? 50);
  } catch (err) {
    logger.warn(`[APPOINTMENT_OUTBOX_RELAY_RECOVERY_FAILED] err=${err?.message || err}`);
  }
  const recoveredCount = await recoverStaleProcessingClaims({
    staleAfterMs: options.staleAfterMs,
    now,
  });

  const claimed = await claimPendingOutboxEvents({
    limit: options.limit,
    workerId: options.workerId,
    now,
  });

  let publishedCount = 0;
  let failedCount = 0;

  for (const event of claimed) {
    const res = await publishClaimedOutboxEvent(event, {
      now,
      maxAttempts: options.maxAttempts,
      baseBackoffMs: options.baseBackoffMs,
    });
    if (res.status === "published") {
      publishedCount += 1;
    } else {
      failedCount += 1;
    }
  }

  return {
    recoveredCount,
    claimedCount: claimed.length,
    publishedCount,
    failedCount,
  };
}

let relayTimer = null;
let initialTickTimer = null;
let relayInFlight = false;

/**
 * Starts the periodic outbox relay loop in the current process.
 */
export function startOutboxRelay({ intervalMs = 5000 } = {}) {
  if (relayTimer) return;

  const tick = async () => {
    if (relayInFlight) return;
    relayInFlight = true;
    try {
      await runOutboxRelayCycle();
    } catch (err) {
      logger.error(`[OUTBOX_RELAY_CYCLE_ERROR] ${err?.message || err}`);
    } finally {
      relayInFlight = false;
    }
  };

  relayTimer = setInterval(tick, intervalMs);
  if (typeof relayTimer.unref === "function") {
    relayTimer.unref();
  }
  // Trigger an initial cycle shortly after startup
  initialTickTimer = setTimeout(tick, 1000);
  if (typeof initialTickTimer.unref === "function") {
    initialTickTimer.unref();
  }
  logger.info(`🚀 Notification Outbox Relay started (interval=${intervalMs}ms)`);
}

/**
 * Stops the periodic outbox relay loop.
 */
export async function stopOutboxRelay() {
  if (initialTickTimer) {
    clearTimeout(initialTickTimer);
    initialTickTimer = null;
  }
  if (relayTimer) {
    clearInterval(relayTimer);
    relayTimer = null;
  }
  logger.info("🛑 Notification Outbox Relay stopped");
}
