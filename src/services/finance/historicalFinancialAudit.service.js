import {
  reconcileAppointmentPricing,
  round2,
} from "../../utils/appointmentPricing.js";

/**
 * Pure, read-only historical financial impact auditor.
 * Does NOT mutate any database records.
 */
export function auditHistoricalRecords({
  appointments = [],
  invoices = [],
  refundCases = [],
} = {}) {
  const findings = [];
  const appointmentExpectedMap = new Map();
  const invoiceMap = new Map();

  for (const apt of appointments) {
    const originalSubtotal = round2(apt.pricing?.subtotal ?? 0);
    const originalDiscount = round2(apt.pricing?.discount ?? 0);
    const originalTotal = round2(apt.pricing?.total ?? 0);
    const aptId = String(apt._id || apt.id || "");

    const hasServices = Array.isArray(apt.services) && apt.services.length > 0;
    const hasAmbiguousDiscount =
      originalDiscount > 0 &&
      apt.pricing?.manualDiscountAmount === undefined &&
      apt.pricing?.membershipDiscountAmount === undefined &&
      (!hasServices ||
        apt.services.every((s) => (s.membershipDiscountAmount || 0) === 0));

    if (!hasServices || hasAmbiguousDiscount) {
      findings.push({
        recordId: aptId,
        recordCode: apt.appointmentCode || aptId,
        transactionType: "appointment",
        status: apt.status || "unknown",
        original: {
          subtotal: originalSubtotal,
          discount: originalDiscount,
          total: originalTotal,
        },
        expected: null,
        difference: null,
        paymentImpact: !hasServices
          ? "Missing service snapshots; cannot safely reconstruct pricing"
          : "Ambiguous legacy discount classification; cannot distinguish membership vs manual concession",
        subscriptionBalanceImpact: "Unknown without complete service snapshots",
        recommendedAction: "MANUAL_REVIEW_INCOMPLETE_OR_AMBIGUOUS_LEGACY_RECORD",
      });
      continue;
    }

    const expected = reconcileAppointmentPricing(apt);
    if (aptId) {
      appointmentExpectedMap.set(aptId, expected);
    }

    const totalDiff = round2(expected.totalPayable - originalTotal);
    const hasMissingBreakdown =
      apt.pricing?.subscriptionWaivedAmount === undefined ||
      apt.pricing?.membershipDiscountAmount === undefined ||
      apt.pricing?.manualDiscountAmount === undefined;

    if (totalDiff !== 0 || hasMissingBreakdown) {
      findings.push({
        recordId: aptId,
        recordCode: apt.appointmentCode || aptId,
        transactionType: "appointment",
        status: apt.status || "unknown",
        original: {
          subtotal: originalSubtotal,
          discount: originalDiscount,
          total: originalTotal,
        },
        expected: {
          grossSubtotal: expected.grossSubtotal,
          subscriptionWaivedAmount: expected.subscriptionWaivedAmount,
          membershipDiscountAmount: expected.membershipDiscountAmount,
          manualDiscountAmount: expected.manualDiscountAmount,
          totalPayable: expected.totalPayable,
        },
        difference: totalDiff,
        paymentImpact:
          totalDiff === 0
            ? "None (breakdown backfill only)"
            : totalDiff < 0
              ? `Appointment total overstated by ${Math.abs(totalDiff)}`
              : `Appointment total understated by ${totalDiff}`,
        subscriptionBalanceImpact:
          expected.subscriptionWaivedAmount > 0
            ? `Subscription waiver of ${expected.subscriptionWaivedAmount} was not reflected in pricing.total`
            : "None",
        recommendedAction:
          totalDiff === 0
            ? "SAFE_NON_DESTRUCTIVE_BREAKDOWN_BACKFILL"
            : "SAFE_PRICING_RECONCILIATION_AFTER_APPROVAL",
      });
    }
  }

  for (const inv of invoices) {
    const invId = String(inv._id || inv.id || "");
    if (invId) {
      invoiceMap.set(invId, inv);
    }
    const aptId = inv.appointmentId ? String(inv.appointmentId._id || inv.appointmentId) : null;
    const expectedAptPricing = aptId ? appointmentExpectedMap.get(aptId) : null;

    if (!expectedAptPricing) continue;

    const invTotal = round2(inv.grandTotal ?? inv.total ?? inv.pricing?.total ?? 0);
    const amountPaid = round2(inv.amountPaid ?? 0);
    const diff = round2(expectedAptPricing.totalPayable - invTotal);

    if (diff !== 0) {
      const isPaid = inv.status === "paid" || amountPaid > expectedAptPricing.totalPayable;
      findings.push({
        recordId: invId,
        recordCode: inv.invoiceNumber || invId,
        transactionType: "invoice",
        status: inv.status || "unknown",
        original: {
          total: invTotal,
          amountPaid,
          balanceDue: round2(Math.max(0, invTotal - amountPaid)),
        },
        expected: {
          totalPayable: expectedAptPricing.totalPayable,
          expectedBalanceDue: round2(
            Math.max(0, expectedAptPricing.totalPayable - amountPaid),
          ),
        },
        difference: diff,
        paymentImpact: isPaid
          ? `Customer paid ${amountPaid} vs expected ${expectedAptPricing.totalPayable} (potential refund/credit of ${round2(Math.max(0, amountPaid - expectedAptPricing.totalPayable))})`
          : `Outstanding balance overstated by ${Math.abs(diff)}`,
        subscriptionBalanceImpact: "Preserve existing subscription usage; verify no double redemption",
        recommendedAction: isPaid
          ? "MANUAL_REVIEW_PAID_INVOICE_NO_AUTO_MUTATION"
          : "RECALCULATE_DRAFT_OR_UNPAID_INVOICE_AFTER_APPROVAL",
      });
    }
  }

  const refundsByInvoice = new Map();
  for (const refund of refundCases) {
    const refundId = String(refund._id || refund.id || "");
    const invId = refund.invoiceId
      ? String(refund.invoiceId._id || refund.invoiceId)
      : null;
    const requestedRupees = round2((refund.requestedAmountPaise ?? 0) / 100);

    if (!invId || !invoiceMap.has(invId)) {
      findings.push({
        recordId: refundId,
        recordCode: refund.refundNumber || refundId,
        transactionType: "refund",
        status: refund.status || "unknown",
        original: {
          requestedAmount: requestedRupees,
          invoiceId: invId,
        },
        expected: null,
        difference: null,
        paymentImpact: "Unmatched refund: linked invoice not found",
        subscriptionBalanceImpact: "Verify domain reversal status manually",
        recommendedAction: "MANUAL_REVIEW_UNMATCHED_REFUND",
      });
      continue;
    }

    if (!["cancelled", "rejected"].includes(refund.status)) {
      const list = refundsByInvoice.get(invId) || [];
      list.push({ refundId, refundNumber: refund.refundNumber, requestedRupees, status: refund.status });
      refundsByInvoice.set(invId, list);
    }
  }

  for (const [invId, activeRefunds] of refundsByInvoice.entries()) {
    const inv = invoiceMap.get(invId);
    const amountPaid = round2(inv?.amountPaid ?? 0);
    const totalRefunded = round2(
      activeRefunds.reduce((sum, r) => sum + r.requestedRupees, 0),
    );

    if (activeRefunds.length > 1 || totalRefunded > amountPaid) {
      findings.push({
        recordId: invId,
        recordCode: inv?.invoiceNumber || invId,
        transactionType: "refund_reconciliation",
        status: inv?.status || "unknown",
        original: {
          amountPaid,
          refundCount: activeRefunds.length,
          totalRefunded,
          refundNumbers: activeRefunds.map((r) => r.refundNumber || r.refundId),
        },
        expected: {
          maxRefundableAmount: amountPaid,
        },
        difference: round2(totalRefunded - amountPaid),
        paymentImpact:
          totalRefunded > amountPaid
            ? `Total refunded (${totalRefunded}) exceeds amountPaid (${amountPaid})`
            : `Multiple active/completed refunds (${activeRefunds.length}) on single invoice`,
        subscriptionBalanceImpact: "Verify no duplicate domain reversals",
        recommendedAction: "MANUAL_REVIEW_DUPLICATE_OR_EXCESS_REFUND",
      });
    }
  }

  return {
    generatedAt: new Date().toISOString(),
    dryRun: true,
    summary: {
      totalAppointmentsAudited: appointments.length,
      totalInvoicesAudited: invoices.length,
      totalRefundsAudited: refundCases.length,
      affectedRecordsCount: findings.length,
      affectedAppointmentsCount: findings.filter(
        (f) => f.transactionType === "appointment",
      ).length,
      affectedInvoicesCount: findings.filter(
        (f) => f.transactionType === "invoice",
      ).length,
      affectedRefundsCount: findings.filter(
        (f) =>
          f.transactionType === "refund" ||
          f.transactionType === "refund_reconciliation",
      ).length,
    },
    findings,
  };
}
