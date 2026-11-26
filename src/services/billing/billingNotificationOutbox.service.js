import { createOutboxEvent } from "../notifications/outbox.service.js";

/**
 * Emits verified billing/invoice/payment outbox events.
 * - Never infers subscription/membership entitlement activation from payment.
 * - Distinguishes payerCustomerId from beneficiaryCustomerId.
 * - Uses deterministic idempotencyKey per invoice & operationId.
 */
export async function emitBillingOutboxEvent({
  eventType,
  invoice,
  operationId,
  payerCustomerId = null,
  beneficiaryCustomerId = null,
  amountInPaise = null,
  session = null,
}) {
  if (!invoice?._id || !invoice?.organizationId) {
    throw new Error("Valid invoice with _id and organizationId is required");
  }

  const resolvedPayer = payerCustomerId || invoice.customerId || null;
  const resolvedBeneficiary = beneficiaryCustomerId || null;

  return createOutboxEvent(
    {
      organizationId: invoice.organizationId,
      branchId: invoice.branchId ?? null,
      eventType,
      idempotencyKey: `${eventType}:${invoice._id}:${operationId || "default"}`,
      payload: {
        invoiceId: String(invoice._id),
        invoiceNumber: invoice.invoiceNumber || null,
        payerCustomerId: resolvedPayer ? String(resolvedPayer) : null,
        beneficiaryCustomerId: resolvedBeneficiary ? String(resolvedBeneficiary) : null,
        amountInPaise: typeof amountInPaise === "number" ? amountInPaise : null,
        paymentStatus: invoice.paymentStatus || null,
      },
    },
    { session, validateBranch: false },
  );
}
