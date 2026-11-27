import { createOutboxEvent } from "../notifications/outbox.service.js";
import { logger } from "../../utils/logger.js";

export async function emitCouponRedeemedOutboxEvent({
  invoice,
  coupon,
  usageLedgerId,
  session,
}) {
  if (!invoice?._id || !invoice?.organizationId || !invoice?.customerId || !coupon?._id) {
    throw new Error("Valid invoice and coupon are required");
  }

  try {
    return await createOutboxEvent(
      {
        organizationId: invoice.organizationId,
        branchId: invoice.branchId ?? null,
        eventType: "coupon.redeemed",
        idempotencyKey: `coupon-redeemed:${usageLedgerId || invoice._id}`,
        payload: {
          customerId: String(invoice.customerId),
          invoiceId: String(invoice._id),
          invoiceNumber: invoice.invoiceNumber || null,
          couponId: String(coupon._id),
          couponCode: coupon.code,
          usageLedgerId: usageLedgerId ? String(usageLedgerId) : null,
        },
      },
      { session, validateBranch: false },
    );
  } catch (err) {
    if (session && err?.code === 11000) throw err;
    logger.warn(
      `[COUPON_REDEMPTION_OUTBOX_FAILED] invoice=${invoice._id} coupon=${coupon._id} err=${err?.message || err}`,
    );
    return null;
  }
}

export async function emitCouponUsageLimitExhaustedOutboxEvent({
  coupon,
  organizationId,
  branchId,
  session,
}) {
  if (!coupon?._id || !organizationId) {
    throw new Error("Valid coupon and organizationId are required");
  }

  try {
    return await createOutboxEvent(
      {
        organizationId,
        branchId: branchId ?? null,
        eventType: "coupon.usage_limit_exhausted",
        idempotencyKey: `coupon-usage-limit-exhausted:${coupon._id}`,
        payload: {
          couponId: String(coupon._id),
          couponCode: coupon.code,
          usageLimit: coupon.totalUsageLimit,
        },
      },
      { session, validateBranch: false },
    );
  } catch (err) {
    if (session && err?.code === 11000) throw err;
    logger.warn(
      `[COUPON_USAGE_LIMIT_OUTBOX_FAILED] coupon=${coupon._id} err=${err?.message || err}`,
    );
    return null;
  }
}
