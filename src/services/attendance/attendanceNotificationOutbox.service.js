import { createOutboxEvent } from "../notifications/outbox.service.js";
import { logger } from "../../utils/logger.js";

/**
 * Emits `attendance.marked` or `attendance.corrected` with minimal non-sensitive metadata.
 * Excludes biometric templates, raw provider payloads, and device credentials.
 */
export async function emitAttendanceOutboxEvent({
  eventType,
  attendance,
  employeeUserId,
  organizationId,
  operationId = null,
  session = null,
}) {
  if (!attendance?._id || !employeeUserId || !organizationId) {
    throw new Error("Valid attendance, employeeUserId, and organizationId are required");
  }
  if (eventType === "attendance.corrected" && !operationId) {
    throw new Error("operationId is required for attendance.corrected");
  }

  try {
    return await createOutboxEvent(
      {
        organizationId,
        branchId: attendance.branchId ?? null,
        eventType,
        idempotencyKey: `${eventType}:${attendance._id}:${operationId || "default"}`,
        payload: {
          attendanceId: String(attendance._id),
          employeeUserId: String(employeeUserId),
          branchId: attendance.branchId ? String(attendance.branchId) : null,
        },
      },
      { session, validateBranch: false },
    );
  } catch (err) {
    if (session) throw err;
    logger.error(
      `[ATTENDANCE_OUTBOX_FAILED] attendanceId=${attendance._id} org=${organizationId} err=${err?.message}`,
    );
    return { created: false, duplicate: false, error: true };
  }
}
