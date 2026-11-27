import { createOutboxEvent } from "../notifications/outbox.service.js";
import { logger } from "../../utils/logger.js";

/**
 * Emits `payroll.payslip_published` with strictly non-confidential metadata.
 * Never includes salary figures, deductions, bank details, or PDF URLs.
 */
export async function emitPayslipPublishedOutboxEvent({
  payrollRecord,
  employeeUserId,
  organizationId,
  session = null,
}) {
  if (!payrollRecord?._id || !employeeUserId || !organizationId) {
    throw new Error("Valid payrollRecord, employeeUserId, and organizationId are required");
  }

  try {
    return await createOutboxEvent(
      {
        organizationId,
        branchId: payrollRecord.branchId ?? null,
        eventType: "payroll.payslip_published",
        idempotencyKey: `payroll.payslip_published:${payrollRecord._id}`,
        payload: {
          payslipId: String(payrollRecord._id),
          employeeUserId: String(employeeUserId),
          branchId: payrollRecord.branchId ? String(payrollRecord.branchId) : null,
          portalLinkOnly: true,
        },
      },
      { session, validateBranch: false },
    );
  } catch (err) {
    if (session) throw err;
    logger.error(
      `[PAYSLIP_OUTBOX_FAILED] payslipId=${payrollRecord._id} org=${organizationId} err=${err?.message}`,
    );
    return { created: false, duplicate: false, error: true };
  }
}
