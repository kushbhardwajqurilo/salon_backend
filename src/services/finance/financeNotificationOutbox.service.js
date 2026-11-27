import { createOutboxEvent } from "../notifications/outbox.service.js";
import { logger } from "../../utils/logger.js";

export async function emitFinanceDayClosureOutboxEvent({
  eventType,
  closure,
  session = null,
}) {
  if (!closure?._id || !closure?.organizationId || !closure?.branchId) {
    throw new Error("Valid day closure is required");
  }

  try {
    return await createOutboxEvent(
      {
        organizationId: closure.organizationId,
        branchId: closure.branchId,
        eventType,
        idempotencyKey: `${eventType}:${closure._id}`,
        payload: {
          closureId: String(closure._id),
          businessDate: closure.businessDate,
          reconciliationResult: closure.reconciliationResult,
        },
      },
      { session, validateBranch: false },
    );
  } catch (err) {
    if (session) throw err;
    logger.warn(
      `[FINANCE_OUTBOX_FAILED] closure=${closure._id} type=${eventType} err=${err?.message || err}`,
    );
    return null;
  }
}
