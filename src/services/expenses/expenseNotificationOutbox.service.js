import { createOutboxEvent } from "../notifications/outbox.service.js";
import { logger } from "../../utils/logger.js";

export async function emitExpenseOutboxEvent({
  eventType,
  expense,
  operationId,
  session = null,
}) {
  if (!expense?._id || !expense?.organizationId || !expense?.branchId) {
    throw new Error("Valid expense is required");
  }

  try {
    return await createOutboxEvent(
      {
        organizationId: expense.organizationId,
        branchId: expense.branchId,
        eventType,
        idempotencyKey: `${eventType}:${expense._id}:${operationId || "default"}`,
        payload: {
          expenseId: String(expense._id),
          expenseCode: expense.expenseCode,
          employeeUserId:
            eventType === "expense.approved" || eventType === "expense.rejected"
              ? expense.recordedBy
                ? String(expense.recordedBy)
                : null
              : null,
        },
      },
      { session, validateBranch: false },
    );
  } catch (err) {
    if (session) throw err;
    logger.warn(
      `[EXPENSE_OUTBOX_FAILED] expense=${expense._id} type=${eventType} err=${err?.message || err}`,
    );
    return null;
  }
}
