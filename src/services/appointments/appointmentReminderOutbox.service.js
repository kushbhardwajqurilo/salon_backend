import { createOutboxEvent } from "../notifications/outbox.service.js";
import { OutboxEvent } from "../../models/notifications/outboxEvent.model.js";
import { Notification } from "../../models/notifications/notification.model.js";

/**
 * Schedules an appointment reminder via the OutboxEvent foundation.
 * Preserves legacy appointment.service.js reminder flow for safe rollback.
 */
export async function scheduleAppointmentReminderOutbox({
  appointment,
  availableAt,
  session = null,
}) {
  const startIso = new Date(appointment.startAt).toISOString();
  return createOutboxEvent(
    {
      organizationId: appointment.organizationId,
      branchId: appointment.branchId ?? null,
      eventType: "appointment.reminder_due",
      idempotencyKey: `apt.reminder:${appointment._id}:${startIso}`,
      payload: {
        appointmentId: String(appointment._id),
        customerId: String(appointment.customerId),
        appointmentCode: appointment.appointmentCode || null,
        startAt: startIso,
      },
      availableAt,
    },
    { session, validateBranch: false },
  );
}

/**
 * Cancels any pending or queued reminder notifications for a cancelled/rescheduled appointment.
 */
export async function cancelAppointmentReminderNotifications({
  organizationId,
  appointmentId,
}) {
  const outboxRes = await OutboxEvent.updateMany(
    {
      organizationId,
      eventType: "appointment.reminder_due",
      "payload.appointmentId": String(appointmentId),
      status: "pending",
    },
    {
      $set: {
        status: "failed",
        lastError: {
          code: "APPOINTMENT_CANCELLED",
          message: "Cancelled before relay publication",
          occurredAt: new Date(),
        },
      },
    },
  );

  const notifRes = await Notification.updateMany(
    {
      organizationId,
      eventType: "appointment.reminder_due",
      "metadata.appointmentId": String(appointmentId),
      status: { $in: ["pending", "queued"] },
    },
    { $set: { status: "cancelled" } },
  );

  return {
    cancelledOutboxCount: outboxRes?.modifiedCount ?? 0,
    cancelledCount: notifRes?.modifiedCount ?? 0,
  };
}
