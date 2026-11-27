import { createOutboxEvent } from "../notifications/outbox.service.js";

/**
 * Emits leave.approved, leave.rejected, or leave.cancelled to the OutboxEvent table.
 * Excludes sensitive leave reasons or medical details.
 */
export async function emitLeaveStatusOutboxEvent({
  eventType,
  leave,
  organizationId,
  session = null,
}) {
  if (!leave?._id || !organizationId) {
    throw new Error("Valid leave and organizationId are required");
  }

  const employeeUserId = leave.userId || leave.staffId?._id || leave.staffId || null;

  return createOutboxEvent(
    {
      organizationId,
      branchId: leave.branchId ?? null,
      eventType,
      idempotencyKey: `${eventType}:${leave._id}`,
      payload: {
        leaveId: String(leave._id),
        employeeUserId: employeeUserId ? String(employeeUserId) : null,
        status: leave.status || null,
        branchId: leave.branchId ? String(leave.branchId) : null,
      },
    },
    { session, validateBranch: false },
  );
}
