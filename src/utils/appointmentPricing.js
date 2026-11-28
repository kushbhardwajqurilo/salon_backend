/**
 * Single Authoritative Financial Calculation Contract for Appointments.
 *
 * Ensures consistent, decimal-safe monetary arithmetic across:
 * - Appointment creation
 * - Appointment service editing
 * - Appointment completion
 * - Appointment retrieval & POS Ready-to-Bill Queue
 * - Historical appointment reconciliation
 */

/**
 * Round a monetary value to 2 decimal places using integer-cent precision
 * to avoid IEEE-754 floating-point drift.
 */
export function round2(value) {
  const num = Number(value);
  if (!Number.isFinite(num)) return 0;
  return Math.round((num + Number.EPSILON) * 100) / 100;
}

/**
 * Determine whether a service line is covered/redeemed by a subscription.
 */
export function isServiceSubscriptionCovered(service) {
  if (!service) return false;
  return Boolean(
    service.isRedeemedViaSubscription ||
      service.subscriptionUsageId ||
      service.appliedSubscriptionId,
  );
}

/**
 * Extract the effective manual concession from a legacy pricing object
 * without ever misclassifying membership discounts as manual concessions.
 */
export function resolveManualDiscountAmount({
  explicitManualDiscount,
  legacyDiscount,
  membershipDiscountAmount,
}) {
  if (
    explicitManualDiscount !== undefined &&
    explicitManualDiscount !== null &&
    Number.isFinite(Number(explicitManualDiscount))
  ) {
    return round2(Math.max(0, Number(explicitManualDiscount)));
  }

  if (
    legacyDiscount !== undefined &&
    legacyDiscount !== null &&
    Number.isFinite(Number(legacyDiscount))
  ) {
    // Legacy `pricing.discount` stored (manualDiscount + membershipDiscount).
    // Subtract membershipDiscountAmount so membership savings are never
    // misclassified as Front-Desk / Special Concession.
    return round2(
      Math.max(0, Number(legacyDiscount) - round2(membershipDiscountAmount)),
    );
  }

  return 0;
}

/**
 * Compute the authoritative financial breakdown for an appointment from its
 * service snapshots and optional manual discount.
 *
 * Fundamental equation:
 * totalPayable = max(0, grossSubtotal - subscriptionWaivedAmount - membershipDiscountAmount - manualDiscountAmount)
 */
export function calculateAppointmentPricing({
  services = [],
  manualDiscountAmount,
  legacyDiscount,
} = {}) {
  let grossSubtotal = 0;
  let subscriptionWaivedAmount = 0;
  let membershipDiscountAmount = 0;

  for (const service of services) {
    const originalPrice = round2(Math.max(0, Number(service?.price) || 0));
    grossSubtotal = round2(grossSubtotal + originalPrice);

    if (isServiceSubscriptionCovered(service)) {
      // Subscription-redeemed services are waived in full and never receive
      // duplicate membership discounts.
      subscriptionWaivedAmount = round2(subscriptionWaivedAmount + originalPrice);
    } else {
      const rawMembershipDiscount = round2(
        Math.max(0, Number(service?.membershipDiscountAmount) || 0),
      );
      const clampedMembershipDiscount = Math.min(
        originalPrice,
        rawMembershipDiscount,
      );
      membershipDiscountAmount = round2(
        membershipDiscountAmount + clampedMembershipDiscount,
      );
    }
  }

  const resolvedManualDiscount = resolveManualDiscountAmount({
    explicitManualDiscount: manualDiscountAmount,
    legacyDiscount,
    membershipDiscountAmount,
  });

  const totalDiscount = round2(
    membershipDiscountAmount + resolvedManualDiscount,
  );

  const totalPayable = round2(
    Math.max(
      0,
      grossSubtotal -
        subscriptionWaivedAmount -
        membershipDiscountAmount -
        resolvedManualDiscount,
    ),
  );

  return {
    subtotal: grossSubtotal,
    grossSubtotal,
    subscriptionWaivedAmount,
    membershipDiscountAmount,
    manualDiscountAmount: resolvedManualDiscount,
    discount: totalDiscount,
    total: totalPayable,
    totalPayable,
  };
}

/**
 * Reconcile an appointment's pricing object for API responses without mutating
 * historical database records.
 */
export function reconcileAppointmentPricing(appointment) {
  if (!appointment) return calculateAppointmentPricing();

  const existingPricing = appointment.pricing || {};
  return calculateAppointmentPricing({
    services: appointment.services || [],
    manualDiscountAmount: existingPricing.manualDiscountAmount,
    legacyDiscount: existingPricing.discount,
  });
}
