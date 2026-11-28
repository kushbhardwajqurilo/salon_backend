import { Invoice } from "../../models/billing/invoice.model.js";
import { CustomerMembership } from "../../models/memberships/customerMembership.model.js";
import { Subscription } from "../../models/subscriptions/subscription.model.js";
import { SubscriptionUsage } from "../../models/subscriptions/subscriptionUsage.model.js";
import { Branch } from "../../models/branches/branch.model.js";

const toPaise = (amount) => {
  const num = Number(amount || 0);
  if (!Number.isFinite(num)) return 0;
  return Math.round(num * 100);
};

const ACTIVE_RESERVATION_STATUSES = ["pending", "processing"];
const SETTLED_REFUND_STATUSES = ["completed", "partially_completed"];

/**
 * Computes authoritative, organization-scoped historical benefit accounting
 * for all membership and subscription lines on an invoice.
 */
export async function computeBenefitAccountingForInvoice({
  invoice,
  organizationId,
  refundCases = [],
  netLinePaidByLineId = new Map(),
  session = null,
}) {
  const lines = Array.isArray(invoice?.lines) ? invoice.lines : [];
  const entitlementLines = lines.filter(
    (l) => l.lineType === "membership" || l.lineType === "subscription",
  );

  if (entitlementLines.length === 0) {
    return {
      benefitAccounting: [],
      byLineId: new Map(),
      reconciliationRequired: false,
      reconciliationReasons: [],
    };
  }

  const branchNameCache = new Map();
  const resolveBranchName = async (branchId) => {
    if (!branchId) return "Unknown Branch";
    const key = String(branchId);
    if (branchNameCache.has(key)) return branchNameCache.get(key);
    const branch = await Branch.findOne({ _id: branchId, organizationId })
      .select("name")
      .session(session)
      .lean();
    const name = branch?.name || "Branch";
    branchNameCache.set(key, name);
    return name;
  };

  const benefitAccounting = [];
  const byLineId = new Map();
  const globalReconciliationReasons = [];

  for (const line of entitlementLines) {
    const lineId = String(line._id);
    const originalNetPaidPaise =
      netLinePaidByLineId.get(lineId) ?? Math.max(0, toPaise(line.customerPayable));

    // Prior settled & pending refunds for this specific line
    let previouslySettledRefundsPaise = 0;
    let pendingRefundReservationsPaise = 0;
    for (const rc of refundCases) {
      const allocs = Array.isArray(rc.allocations) ? rc.allocations : [];
      const matching = allocs.filter((a) => String(a.lineId) === lineId);
      const allocSum = matching.reduce(
        (s, a) => s + Number(a.allocatedAmountPaise || 0),
        0,
      );
      if (SETTLED_REFUND_STATUSES.includes(rc.status)) {
        previouslySettledRefundsPaise += allocSum;
      } else if (ACTIVE_RESERVATION_STATUSES.includes(rc.status)) {
        pendingRefundReservationsPaise += allocSum;
      }
    }

    if (line.lineType === "subscription") {
      const result = await _computeSubscriptionBenefitAccounting({
        invoice,
        line,
        lineId,
        organizationId,
        originalNetPaidPaise,
        previouslySettledRefundsPaise,
        pendingRefundReservationsPaise,
        resolveBranchName,
        session,
      });
      benefitAccounting.push(result);
      byLineId.set(lineId, result);
      if (result.reconciliationRequired) {
        globalReconciliationReasons.push(...result.reconciliationReasons);
      }
    } else if (line.lineType === "membership") {
      const result = await _computeMembershipBenefitAccounting({
        invoice,
        line,
        lineId,
        organizationId,
        originalNetPaidPaise,
        previouslySettledRefundsPaise,
        pendingRefundReservationsPaise,
        resolveBranchName,
        session,
      });
      benefitAccounting.push(result);
      byLineId.set(lineId, result);
      if (result.reconciliationRequired) {
        globalReconciliationReasons.push(...result.reconciliationReasons);
      }
    }
  }

  return {
    benefitAccounting,
    byLineId,
    reconciliationRequired: globalReconciliationReasons.length > 0,
    reconciliationReasons: Array.from(new Set(globalReconciliationReasons)),
  };
}

async function _computeSubscriptionBenefitAccounting({
  invoice,
  line,
  lineId,
  organizationId,
  originalNetPaidPaise,
  previouslySettledRefundsPaise,
  pendingRefundReservationsPaise,
  resolveBranchName,
  session,
}) {
  const subQuery = {
    organizationId,
    isDeleted: false,
    $or: [
      ...(line.subscriptionId ? [{ _id: line.subscriptionId }] : []),
      { purchaseInvoiceId: invoice._id },
    ],
  };

  const subscription = await Subscription.findOne(subQuery)
    .session(session)
    .lean();

  const reconciliationReasons = [];
  const usageHistory = [];
  const seenUsageKeys = new Set();

  let lifetimeConsumedPaise = 0;
  let pendingReservedUsagePaise = 0;

  if (!subscription) {
    reconciliationReasons.push(
      `Subscription record not found for line '${line.name}' (${lineId}).`,
    );
  } else {
    // 1. Query all historical invoices across all branches of the same organization
    const historicalInvoices = await Invoice.find({
      organizationId,
      isDeleted: false,
      status: { $ne: "cancelled" },
      "lines.subscriptionId": subscription._id,
    })
      .select("invoiceNumber branchId createdAt status lines")
      .session(session)
      .lean();

    for (const histInv of historicalInvoices) {
      const branchName = await resolveBranchName(histInv.branchId);
      const invLines = Array.isArray(histInv.lines) ? histInv.lines : [];
      for (const hLine of invLines) {
        if (
          !hLine.subscriptionId ||
          String(hLine.subscriptionId) !== String(subscription._id)
        ) {
          continue;
        }
        // Skip the purchase line itself if it happens to carry subscriptionId
        if (
          String(histInv._id) === String(invoice._id) &&
          hLine.lineType === "subscription"
        ) {
          continue;
        }
        if (hLine.status === "cancelled" || hLine.status === "reversed") {
          continue;
        }

        const dedupeKey = hLine.appointmentServiceId
          ? `apptSvc:${String(hLine.appointmentServiceId)}`
          : `invLine:${String(histInv._id)}:${String(hLine._id)}`;
        if (seenUsageKeys.has(dedupeKey)) continue;
        seenUsageKeys.add(dedupeKey);

        const rawValue =
          hLine.subscriptionCoveredAmount ?? hLine.lineTotal ?? null;
        if (rawValue === null || rawValue === undefined || !Number.isFinite(Number(rawValue))) {
          reconciliationReasons.push(
            `Missing historical price snapshot on invoice ${histInv.invoiceNumber} for '${hLine.name}'.`,
          );
          continue;
        }

        const consumedPaise = Math.max(0, toPaise(rawValue));
        const isPending = histInv.status === "draft" || histInv.status === "pending";

        if (isPending) {
          pendingReservedUsagePaise += consumedPaise;
        } else {
          lifetimeConsumedPaise += consumedPaise;
        }

        usageHistory.push({
          usageId: dedupeKey,
          invoiceId: String(histInv._id),
          invoiceNumber: histInv.invoiceNumber,
          branchName,
          date: histInv.createdAt,
          itemName: hLine.name || "Subscription Service",
          quantity: Number(hLine.quantity || 1),
          consumedPaise,
          status: isPending ? "pending" : "consumed",
          sourceType: "invoice_line",
        });
      }
    }

    // 2. Query durable SubscriptionUsage records (avoiding double counting)
    const usageRecords = await SubscriptionUsage.find({
      organizationId,
      subscriptionId: subscription._id,
      isDeleted: false,
      status: { $nin: ["cancelled", "reversed"] },
    })
      .session(session)
      .lean();

    for (const usage of usageRecords) {
      const dedupeKey = usage.appointmentServiceId
        ? `apptSvc:${String(usage.appointmentServiceId)}`
        : usage.invoiceId && usage.invoiceLineId
          ? `invLine:${String(usage.invoiceId)}:${String(usage.invoiceLineId)}`
          : `subUsage:${String(usage._id)}`;

      if (seenUsageKeys.has(dedupeKey)) continue;
      seenUsageKeys.add(dedupeKey);

      const rawValue =
        usage.valuePaise !== undefined && usage.valuePaise !== null
          ? Number(usage.valuePaise) / 100
          : usage.unitPriceSnapshot !== undefined && usage.unitPriceSnapshot !== null
            ? Number(usage.unitPriceSnapshot) * Number(usage.quantity || 1)
            : null;

      if (rawValue === null || !Number.isFinite(rawValue)) {
        reconciliationReasons.push(
          `Missing historical valuation snapshot on SubscriptionUsage ${String(usage._id)} for '${usage.serviceName}'.`,
        );
        continue;
      }

      const consumedPaise = Math.max(0, toPaise(rawValue));
      const isPending = usage.status === "pending" || usage.status === "reserved";
      if (isPending) {
        pendingReservedUsagePaise += consumedPaise;
      } else {
        lifetimeConsumedPaise += consumedPaise;
      }

      const branchName = await resolveBranchName(usage.branchId);
      usageHistory.push({
        usageId: dedupeKey,
        invoiceId: usage.invoiceId ? String(usage.invoiceId) : null,
        invoiceNumber: usage.appointmentCode || "Usage Record",
        branchName,
        date: usage.createdAt,
        itemName: usage.serviceName,
        quantity: Number(usage.quantity || 1),
        consumedPaise,
        status: isPending ? "pending" : "consumed",
        sourceType: "subscription_usage",
      });
    }
  }

  const remainingRefundablePaise = Math.max(
    0,
    originalNetPaidPaise -
      lifetimeConsumedPaise -
      pendingReservedUsagePaise -
      previouslySettledRefundsPaise -
      pendingRefundReservationsPaise,
  );

  return {
    lineId,
    entitlementId: subscription ? String(subscription._id) : null,
    entitlementType: "subscription",
    name: line.name,
    originalNetPaidPaise,
    lifetimeConsumedPaise,
    pendingReservedUsagePaise,
    previouslySettledRefundsPaise,
    pendingRefundReservationsPaise,
    remainingRefundablePaise,
    reconciliationRequired: reconciliationReasons.length > 0,
    reconciliationReasons,
    usageHistory,
  };
}

async function _computeMembershipBenefitAccounting({
  invoice,
  line,
  lineId,
  organizationId,
  originalNetPaidPaise,
  previouslySettledRefundsPaise,
  pendingRefundReservationsPaise,
  resolveBranchName,
  session,
}) {
  const memQuery = {
    organizationId,
    isDeleted: false,
    $or: [
      ...(line.membershipId ? [{ _id: line.membershipId }] : []),
      ...(line.membershipPurchaseId
        ? [{ membershipPurchaseId: line.membershipPurchaseId }]
        : []),
      { purchaseInvoiceId: invoice._id },
    ],
  };

  const membership = await CustomerMembership.findOne(memQuery)
    .session(session)
    .lean();

  const reconciliationReasons = [];
  const usageHistory = [];
  const seenUsageKeys = new Set();

  let lifetimeConsumedPaise = 0;
  let pendingReservedUsagePaise = 0;

  if (!membership) {
    reconciliationReasons.push(
      `CustomerMembership record not found for line '${line.name}' (${lineId}).`,
    );
  } else {
    const historicalInvoices = await Invoice.find({
      organizationId,
      customerId: membership.customerId,
      isDeleted: false,
      status: { $ne: "cancelled" },
      $or: [
        { membershipId: membership._id },
        { "lines.membershipId": membership._id },
        { "lines.appliedDiscounts.membershipId": membership._id },
        { "appliedDiscounts.membershipId": membership._id },
      ],
    })
      .select(
        "invoiceNumber branchId createdAt status membershipId membershipDiscountAmount lines appliedDiscounts",
      )
      .session(session)
      .lean();

    for (const histInv of historicalInvoices) {
      const branchName = await resolveBranchName(histInv.branchId);
      const isPending = histInv.status === "draft" || histInv.status === "pending";
      let foundLineLevelMembershipDiscount = false;

      const invLines = Array.isArray(histInv.lines) ? histInv.lines : [];
      for (const hLine of invLines) {
        if (
          String(histInv._id) === String(invoice._id) &&
          hLine.lineType === "membership"
        ) {
          continue;
        }
        if (hLine.status === "cancelled" || hLine.status === "reversed") {
          continue;
        }

        const lineDiscounts = Array.isArray(hLine.appliedDiscounts)
          ? hLine.appliedDiscounts
          : [];
        for (const d of lineDiscounts) {
          const isMembershipDiscount =
            (d.membershipId && String(d.membershipId) === String(membership._id)) ||
            d.source === "membership" ||
            d.discountSource === "membership";

          if (!isMembershipDiscount) continue;
          foundLineLevelMembershipDiscount = true;

          const dedupeKey = `invLineDisc:${String(histInv._id)}:${String(hLine._id)}:${String(d._id || d.name || "membership")}`;
          if (seenUsageKeys.has(dedupeKey)) continue;
          seenUsageKeys.add(dedupeKey);

          const rawVal = d.calculatedAmount ?? d.discountAmount ?? null;
          if (rawVal === null || rawVal === undefined || !Number.isFinite(Number(rawVal))) {
            reconciliationReasons.push(
              `Missing membership discount snapshot on invoice ${histInv.invoiceNumber} for '${hLine.name}'.`,
            );
            continue;
          }

          const consumedPaise = Math.max(0, toPaise(rawVal));
          if (isPending) {
            pendingReservedUsagePaise += consumedPaise;
          } else {
            lifetimeConsumedPaise += consumedPaise;
          }

          usageHistory.push({
            usageId: dedupeKey,
            invoiceId: String(histInv._id),
            invoiceNumber: histInv.invoiceNumber,
            branchName,
            date: histInv.createdAt,
            itemName: `${hLine.name} (Membership Discount)`,
            quantity: Number(hLine.quantity || 1),
            consumedPaise,
            status: isPending ? "pending" : "consumed",
            sourceType: "membership_discount",
          });
        }
      }

      // Fallback to invoice-level membershipDiscountAmount if no line-level breakdown was recorded
      if (
        !foundLineLevelMembershipDiscount &&
        histInv.membershipId &&
        String(histInv.membershipId) === String(membership._id) &&
        Number(histInv.membershipDiscountAmount || 0) > 0
      ) {
        const dedupeKey = `invMemDisc:${String(histInv._id)}`;
        if (!seenUsageKeys.has(dedupeKey)) {
          seenUsageKeys.add(dedupeKey);
          const consumedPaise = Math.max(0, toPaise(histInv.membershipDiscountAmount));
          if (isPending) {
            pendingReservedUsagePaise += consumedPaise;
          } else {
            lifetimeConsumedPaise += consumedPaise;
          }
          usageHistory.push({
            usageId: dedupeKey,
            invoiceId: String(histInv._id),
            invoiceNumber: histInv.invoiceNumber,
            branchName,
            date: histInv.createdAt,
            itemName: "Membership Invoice Discount",
            quantity: 1,
            consumedPaise,
            status: isPending ? "pending" : "consumed",
            sourceType: "membership_invoice_discount",
          });
        }
      }
    }
  }

  const remainingRefundablePaise = Math.max(
    0,
    originalNetPaidPaise -
      lifetimeConsumedPaise -
      pendingReservedUsagePaise -
      previouslySettledRefundsPaise -
      pendingRefundReservationsPaise,
  );

  return {
    lineId,
    entitlementId: membership ? String(membership._id) : null,
    entitlementType: "membership",
    name: line.name,
    originalNetPaidPaise,
    lifetimeConsumedPaise,
    pendingReservedUsagePaise,
    previouslySettledRefundsPaise,
    pendingRefundReservationsPaise,
    remainingRefundablePaise,
    reconciliationRequired: reconciliationReasons.length > 0,
    reconciliationReasons,
    usageHistory,
  };
}
