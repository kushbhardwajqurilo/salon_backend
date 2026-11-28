import { settlementFulfillmentEventService } from "../incentives/settlementFulfillmentEvent.service.js";
import { refundService } from "./refund.service.js";
import mongoose from "mongoose";
import { AppError } from "../../utils/errors.js";
import { Invoice } from "../../models/billing/invoice.model.js";
import { Payment } from "../../models/billing/payment.model.js";
import { InvoiceSettlementEvent } from "../../models/incentives/invoiceSettlementEvent.model.js";
import { Appointment } from "../../models/appointments/appointment.model.js";
import { reconcileAppointmentPricing } from "../../utils/appointmentPricing.js";
import { Subscription } from "../../models/subscriptions/subscription.model.js";
import { Customer } from "../../models/customers/customer.model.js";
import { Sequence } from "../../models/sequence/sequence.model.js";
import { AuditLog, AUDIT_ACTIONS } from "../../models/audit/auditLog.model.js";
import { invoiceRepository } from "../../repositories/billing/invoice.repository.js";
import { paymentRepository } from "../../repositories/billing/payment.repository.js";

import crypto from "crypto";
import { Branch } from "../../models/branches/branch.model.js";
import { Organization } from "../../models/organizations/organization.model.js";
import { OrganizationSettings } from "../../models/settings/organizationSettings.model.js";
import { generateInvoicePdf as createInvoicePdf } from "./invoicePdf.service.js";
import { runInTransaction } from "../../utils/transaction.js";
import { loyaltyService } from "../loyalty/loyalty.service.js";
import { inventoryService } from "../inventory/inventory.service.js";
import { productRepository } from "../../repositories/inventory/product.repository.js";
import { stockMovementRepository } from "../../repositories/inventory/stockMovement.repository.js";
import { StockBalance } from "../../models/inventory/stockBalance.model.js";
import { StockMovement } from "../../models/inventory/stockMovement.model.js";
import { MembershipPlan } from "../../models/memberships/membershipPlan.model.js";
import { CustomerMembership } from "../../models/memberships/customerMembership.model.js";
import { SubscriptionPlan } from "../../models/subscriptions/subscriptionPlan.model.js";
import { SubscriptionUsage } from "../../models/subscriptions/subscriptionUsage.model.js";
import { Service } from "../../models/services/service.model.js";
import { Coupon } from "../../models/coupons/coupon.model.js";
import { CouponUsage } from "../../models/coupons/couponUsage.model.js";
import { CouponCustomerUsage } from "../../models/coupons/couponCustomerUsage.model.js";
import { smsQueue } from "../../queues/client.js";
import { emitBillingOutboxEvent } from "./billingNotificationOutbox.service.js";
import {
  emitCouponRedeemedOutboxEvent,
  emitCouponUsageLimitExhaustedOutboxEvent,
} from "../coupons/couponNotificationOutbox.service.js";
import { logger } from "../../utils/logger.js";
import {
  loadStaffAttributionSnapshot,
  resolveStaffAttribution,
} from "./staffAttribution.service.js";
import { CampaignAttributionService } from "../marketing/campaignAttribution.service.js";
import { AuditLogService } from "../audit/auditLog.service.js";

function allocatePaiseProportionally(totalPaise, weightedLines) {
  if (!Number.isInteger(totalPaise) || totalPaise < 0) {
    throw new AppError("Refund total must be integer paise", 400);
  }
  const totalWeight = weightedLines.reduce((sum, line) => sum + line.weight, 0);
  if (totalWeight <= 0)
    return weightedLines.map((line) => ({ ...line, paise: 0 }));

  let allocated = 0;
  const shares = weightedLines.map((line) => {
    const numerator = BigInt(totalPaise) * BigInt(line.weight);
    const denominator = BigInt(totalWeight);
    const paise = Number(numerator / denominator);
    allocated += paise;
    return {
      ...line,
      paise,
      remainder: numerator % denominator,
    };
  });

  let remaining = totalPaise - allocated;
  const byRemainder = [...shares].sort((a, b) => {
    if (a.remainder !== b.remainder) return a.remainder > b.remainder ? -1 : 1;
    return a.lineId.localeCompare(b.lineId);
  });
  for (let index = 0; remaining > 0; index += 1, remaining -= 1) {
    byRemainder[index % byRemainder.length].paise += 1;
  }

  return shares.map(({ remainder, ...share }) => share);
}

/**
 * Checks whether a given service qualifies for membership benefits based on category
 * and specific service inclusion and exclusion lists.
 * Rules:
 * 1. Exclusions have absolute precedence: if serviceId or categoryId is excluded, return false.
 * 2. If neither eligibleServiceIds nor eligibleServiceCategoryIds are specified, all services qualify.
 * 3. If eligible lists are specified, the service must match at least one inclusion rule.
 */
export function isServiceEligibleForMembershipBenefits(service, benefits) {
  if (!benefits) return false;
  const srvId = (
    service.serviceId?._id ||
    service.serviceId ||
    service._id ||
    service.id
  )?.toString();
  const catId = (service.categoryId?._id || service.categoryId)?.toString();

  // 1. Check exclusions first (precedence)
  if (
    Array.isArray(benefits.excludedServiceIds) &&
    srvId &&
    benefits.excludedServiceIds.some(
      (id) => (id?._id || id)?.toString() === srvId,
    )
  ) {
    return false;
  }
  if (
    Array.isArray(benefits.excludedServiceCategoryIds) &&
    catId &&
    benefits.excludedServiceCategoryIds.some(
      (id) => (id?._id || id)?.toString() === catId,
    )
  ) {
    return false;
  }

  // 2. Check inclusions
  const hasEligibleServices =
    Array.isArray(benefits.eligibleServiceIds) &&
    benefits.eligibleServiceIds.length > 0;
  const hasEligibleCats =
    Array.isArray(benefits.eligibleServiceCategoryIds) &&
    benefits.eligibleServiceCategoryIds.length > 0;

  // Default: if no inclusions specified, all services qualify (except exclusions handled above)
  if (!hasEligibleServices && !hasEligibleCats) return true;

  if (
    hasEligibleServices &&
    srvId &&
    benefits.eligibleServiceIds.some(
      (id) => (id?._id || id)?.toString() === srvId,
    )
  ) {
    return true;
  }

  if (
    hasEligibleCats &&
    catId &&
    benefits.eligibleServiceCategoryIds.some(
      (id) => (id?._id || id)?.toString() === catId,
    )
  ) {
    return true;
  }

  return false;
}

export class BillingService {
  constructor(deps = {}) {
    this.auditLogService = deps.auditLogService || new AuditLogService();
  }
  /**
   * Option B: Allocates discount only to uncovered, customer-payable services.
   * Enforces exact reconciliation between invoice header and line items.
   * Compatible with legacy scalar desiredDiscount or structured two-pass calculation.
   */
  calculateInvoiceTotals(lines, desiredDiscount) {
    let subtotal = 0;
    let totalSubscriptionCoverage = 0;
    let uncoveredTotal = 0;

    for (const line of lines) {
      subtotal = Number((subtotal + line.lineTotal).toFixed(2));
      if (line.isCoveredBySubscription) {
        totalSubscriptionCoverage = Number(
          (totalSubscriptionCoverage + line.subscriptionCoveredAmount).toFixed(
            2,
          ),
        );
      } else {
        uncoveredTotal = Number((uncoveredTotal + line.lineTotal).toFixed(2));
      }
    }

    // Discount applies strictly to uncovered services, capped at their total
    const effectiveDiscount = Math.min(
      uncoveredTotal,
      Math.max(0, Number(Number(desiredDiscount || 0).toFixed(2))),
    );

    let remainingDiscountToDistribute = effectiveDiscount;
    const uncoveredLines = lines.filter((l) => !l.isCoveredBySubscription);

    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];
      if (line.isCoveredBySubscription) {
        line.discountAmount = 0;
        line.customerPayable = 0;
      } else {
        const isLastUncovered =
          uncoveredLines.length > 0 &&
          ((line.appointmentServiceId &&
            uncoveredLines[uncoveredLines.length - 1].appointmentServiceId &&
            line.appointmentServiceId.toString() ===
              uncoveredLines[
                uncoveredLines.length - 1
              ].appointmentServiceId.toString()) ||
            i === lines.length - 1);

        if (uncoveredTotal === 0 || effectiveDiscount === 0) {
          line.discountAmount = 0;
          line.customerPayable = line.lineTotal;
        } else if (isLastUncovered) {
          line.discountAmount = Number(
            remainingDiscountToDistribute.toFixed(2),
          );
          line.customerPayable = Math.max(
            0,
            Number((line.lineTotal - line.discountAmount).toFixed(2)),
          );
          remainingDiscountToDistribute = 0;
        } else {
          const proportional = Number(
            ((line.lineTotal / uncoveredTotal) * effectiveDiscount).toFixed(2),
          );
          const allocated = Math.min(
            remainingDiscountToDistribute,
            proportional,
          );
          line.discountAmount = allocated;
          line.customerPayable = Math.max(
            0,
            Number((line.lineTotal - allocated).toFixed(2)),
          );
          remainingDiscountToDistribute = Number(
            (remainingDiscountToDistribute - allocated).toFixed(2),
          );
        }
      }
    }

    const grossPayable = Math.max(
      0,
      Number((subtotal - effectiveDiscount).toFixed(2)),
    );
    const payableAmount = Math.max(
      0,
      Number((grossPayable - totalSubscriptionCoverage).toFixed(2)),
    );

    return {
      subtotal: Number(subtotal.toFixed(2)),
      discountTotal: Number(effectiveDiscount.toFixed(2)),
      grossPayable,
      subscriptionCoveredAmount: Number(totalSubscriptionCoverage.toFixed(2)),
      payableAmount,
    };
  }

  /**
   * Two-pass authoritative discount recomputation engine.
   * Pass 0: Line totals and subscription isolation
   * Pass 1: Sequential line-level and selected-lines discounts on uncovered lines
   * Pass 2: Sequential invoice-level discounts on remaining net uncovered pool
   * Pass 3: Proportional allocation with last-line penny remainder
   * Pass 4: Loyalty preview/redemption if applicable
   * Pass 5: Total aggregation and payment status derivation
   */
  recalculateInvoiceFinancials(
    lines,
    invoiceAppliedDiscounts = [],
    existingLoyaltyDiscount = 0,
    amountPaid = 0,
  ) {
    let subtotal = 0;
    let subscriptionCoveredAmount = 0;
    let eligibleUncoveredAmount = 0;

    // Pass 0: Line totals and subscription isolation
    for (const line of lines) {
      const lineTotal = Number(
        Number(line.lineTotal || line.unitPrice * (line.quantity || 1)).toFixed(
          2,
        ),
      );
      line.lineTotal = lineTotal;
      subtotal = Number((subtotal + lineTotal).toFixed(2));

      if (line.isCoveredBySubscription) {
        line.subscriptionCoveredAmount = lineTotal;
        subscriptionCoveredAmount = Number(
          (subscriptionCoveredAmount + lineTotal).toFixed(2),
        );
        line.appliedDiscounts = [];
        line.lineDiscountTotal = 0;
        line.allocatedInvoiceDiscount = 0;
        line.discountAmount = 0;
        line.customerPayable = 0;
      } else {
        line.subscriptionCoveredAmount = 0;
        eligibleUncoveredAmount = Number(
          (eligibleUncoveredAmount + lineTotal).toFixed(2),
        );
      }
    }

    // Pass 1: Sequential line-level discounts
    let lineDiscountsTotal = 0;
    const uncoveredLines = lines.filter((l) => !l.isCoveredBySubscription);

    for (const line of uncoveredLines) {
      let remainingLineBase = line.lineTotal;
      let calculatedLineDiscount = 0;
      const appliedDiscounts = Array.isArray(line.appliedDiscounts)
        ? line.appliedDiscounts
        : [];

      for (const d of appliedDiscounts) {
        let calc = 0;
        if (d.discountType === "percentage") {
          calc = Number(
            ((remainingLineBase * d.enteredValue) / 100).toFixed(2),
          );
        } else {
          // For fixed discount on a line (whether single-line or pre-allocated selected_lines),
          // enteredValue is the fixed amount allocated to this line.
          calc = Math.min(
            remainingLineBase,
            Number(Number(d.enteredValue).toFixed(2)),
          );
        }
        calc = Math.max(0, calc);
        d.calculatedAmount = calc;
        calculatedLineDiscount = Number(
          (calculatedLineDiscount + calc).toFixed(2),
        );
        remainingLineBase = Math.max(
          0,
          Number((remainingLineBase - calc).toFixed(2)),
        );
      }

      line.lineDiscountTotal = calculatedLineDiscount;
      lineDiscountsTotal = Number(
        (lineDiscountsTotal + calculatedLineDiscount).toFixed(2),
      );
      line.netUncoveredLineBase = remainingLineBase;
    }

    // Pass 2: Sequential invoice-level discounts on remaining net uncovered pool
    const netUncoveredPool = uncoveredLines.reduce(
      (acc, l) => Number((acc + (l.netUncoveredLineBase || 0)).toFixed(2)),
      0,
    );
    let remainingPool = netUncoveredPool;
    let invoiceDiscountsTotal = 0;
    const invDiscounts = Array.isArray(invoiceAppliedDiscounts)
      ? invoiceAppliedDiscounts
      : [];

    for (const d of invDiscounts) {
      let calc = 0;
      if (d.discountType === "percentage") {
        calc = Number(((remainingPool * d.enteredValue) / 100).toFixed(2));
      } else {
        calc = Math.min(
          remainingPool,
          Number(Number(d.enteredValue).toFixed(2)),
        );
      }
      calc = Math.max(0, calc);
      d.calculatedAmount = calc;
      invoiceDiscountsTotal = Number((invoiceDiscountsTotal + calc).toFixed(2));
      remainingPool = Math.max(0, Number((remainingPool - calc).toFixed(2)));
    }

    // Pass 3: Proportional invoice discount allocation across uncovered lines
    let remainingInvoiceDiscountToDistribute = invoiceDiscountsTotal;

    for (let i = 0; i < uncoveredLines.length; i++) {
      const line = uncoveredLines[i];
      const isLast = i === uncoveredLines.length - 1;

      if (netUncoveredPool === 0 || invoiceDiscountsTotal === 0) {
        line.allocatedInvoiceDiscount = 0;
      } else if (isLast) {
        line.allocatedInvoiceDiscount = Number(
          remainingInvoiceDiscountToDistribute.toFixed(2),
        );
        remainingInvoiceDiscountToDistribute = 0;
      } else {
        const proportional = Number(
          (
            (line.netUncoveredLineBase / netUncoveredPool) *
            invoiceDiscountsTotal
          ).toFixed(2),
        );
        const allocated = Math.min(
          remainingInvoiceDiscountToDistribute,
          proportional,
        );
        line.allocatedInvoiceDiscount = allocated;
        remainingInvoiceDiscountToDistribute = Number(
          (remainingInvoiceDiscountToDistribute - allocated).toFixed(2),
        );
      }

      line.discountAmount = Number(
        (
          (line.lineDiscountTotal || 0) + (line.allocatedInvoiceDiscount || 0)
        ).toFixed(2),
      );
      line.customerPayable = Math.max(
        0,
        Number((line.lineTotal - line.discountAmount).toFixed(2)),
      );
    }

    // Pass 4: Loyalty discount (cannot exceed remaining uncovered pool)
    const postInvoiceDiscountPool = Math.max(
      0,
      Number((netUncoveredPool - invoiceDiscountsTotal).toFixed(2)),
    );
    const loyaltyDiscountAmount = Math.min(
      postInvoiceDiscountPool,
      Math.max(0, Number(Number(existingLoyaltyDiscount || 0).toFixed(2))),
    );

    // Pass 5: Total aggregation & reconciliation
    const discountTotal = Number(
      (
        lineDiscountsTotal +
        invoiceDiscountsTotal +
        loyaltyDiscountAmount
      ).toFixed(2),
    );
    const grossPayable = Math.max(
      0,
      Number((subtotal - discountTotal).toFixed(2)),
    );
    const payableAmount = Math.max(
      0,
      Number((eligibleUncoveredAmount - discountTotal).toFixed(2)),
    );
    const amountDue = Math.max(
      0,
      Number((payableAmount - amountPaid).toFixed(2)),
    );
    const paymentStatus = this.derivePaymentStatus(amountPaid, amountDue);

    return {
      subtotal: Number(subtotal.toFixed(2)),
      subscriptionCoveredAmount: Number(subscriptionCoveredAmount.toFixed(2)),
      eligibleUncoveredAmount: Number(eligibleUncoveredAmount.toFixed(2)),
      lineDiscountsTotal: Number(lineDiscountsTotal.toFixed(2)),
      invoiceDiscountsTotal: Number(invoiceDiscountsTotal.toFixed(2)),
      loyaltyDiscountAmount: Number(loyaltyDiscountAmount.toFixed(2)),
      discountTotal,
      grossPayable,
      payableAmount,
      amountDue,
      paymentStatus,
    };
  }
  /**
   * Generates sequential organization-scoped Invoice number: INV-YYYYMMDD-XXXX
   */
  async generateInvoiceNumber(organizationId) {
    const sequenceKey = `INV_${organizationId.toString()}`;
    const seq = await Sequence.findOneAndUpdate(
      { key: sequenceKey },
      { $inc: { seq: 1 } },
      { new: true, upsert: true },
    );
    const today = new Date();
    const yyyy = today.getFullYear();
    const mm = String(today.getMonth() + 1).padStart(2, "0");
    const dd = String(today.getDate()).padStart(2, "0");
    const num = String(seq.seq).padStart(4, "0");
    return `INV-${yyyy}${mm}${dd}-${num}`;
  }

  /**
   * Generates sequential organization-scoped Payment number: PAY-YYYYMMDD-XXXX
   */
  async generatePaymentNumber(organizationId) {
    const sequenceKey = `PAY_${organizationId.toString()}`;
    const seq = await Sequence.findOneAndUpdate(
      { key: sequenceKey },
      { $inc: { seq: 1 } },
      { new: true, upsert: true },
    );
    const today = new Date();
    const yyyy = today.getFullYear();
    const mm = String(today.getMonth() + 1).padStart(2, "0");
    const dd = String(today.getDate()).padStart(2, "0");
    const num = String(seq.seq).padStart(4, "0");
    return `PAY-${yyyy}${mm}${dd}-${num}`;
  }

  /**
   * Transaction execution helper for financial operations (payment recording, voiding)
   */
  async executeTransaction(callback, { requireTransaction = true } = {}) {
    return await runInTransaction(callback, { requireTransaction });
  }

  /**
   * Helper to derive deterministic payment status based on balances:
   * 1. amountDue === 0 -> "paid"
   * 2. amountPaid > 0 && amountDue > 0 -> "partially_paid"
   * 3. amountPaid === 0 && amountDue > 0 -> "unpaid"
   */
  derivePaymentStatus(amountPaid, amountDue) {
    if (amountDue === 0) {
      return "paid";
    }
    if (amountPaid > 0 && amountDue > 0) {
      return "partially_paid";
    }
    return "unpaid";
  }

  /**
   * 1. CREATE DRAFT INVOICE FROM APPOINTMENT
   */
  async createInvoiceFromAppointment(
    data,
    organizationId,
    userId,
    session = null,
  ) {
    const {
      appointmentId,
      branchId,
      discount,
      redeemLoyaltyPoints,
      notes = "",
    } = data;

    // Load target appointment strictly scoped to organization
    let aptQuery = Appointment.findOne({
      _id: appointmentId,
      organizationId,
      isDeleted: false,
    });
    if (session) aptQuery = aptQuery.session(session);
    const appointment = await aptQuery;

    if (!appointment) {
      throw new AppError("Appointment not found", 404);
    }

    // Branch match validation
    const aptBranchId = appointment.branchId?._id
      ? appointment.branchId._id.toString()
      : appointment.branchId.toString();

    if (aptBranchId !== branchId.toString()) {
      throw new AppError(
        "Target branchId does not match appointment branch",
        400,
      );
    }

    // Appointment status validation: cannot bill cancelled, no_show, or in_progress appointments
    if (appointment.status !== "completed") {
      throw new AppError(
        `Cannot create invoice for appointment in '${appointment.status}' status. Appointment must be completed first.`,
        400,
      );
    }

    const appointmentPerformerAttribution = await loadStaffAttributionSnapshot(
      appointment.staffId,
      organizationId,
      session,
    );

    // Check for existing active (non-cancelled) invoice for this appointment
    const existingActiveInvoice = await Invoice.findOne({
      appointmentId: appointment._id,
      organizationId,
      status: { $ne: "cancelled" },
      isDeleted: false,
    });

    if (existingActiveInvoice) {
      throw new AppError(
        `An active invoice (${existingActiveInvoice.invoiceNumber}) already exists for this appointment`,
        400,
      );
    }

    // Load customer profile snapshot
    const customer = await Customer.findOne({
      _id: appointment.customerId,
      organizationId,
      isDeleted: false,
    });

    if (!customer) {
      throw new AppError("Customer record not found for this appointment", 404);
    }

    const customerSnapshot = {
      name: customer.name,
      phone: customer.phone,
      email: customer.email || null,
    };

    // Construct immutable appointment pricing snapshot
    const reconciledPricing = reconcileAppointmentPricing(appointment);
    const appointmentPricingSnapshot = {
      subtotal: reconciledPricing.grossSubtotal,
      grossSubtotal: reconciledPricing.grossSubtotal,
      subscriptionWaivedAmount: reconciledPricing.subscriptionWaivedAmount,
      membershipDiscountAmount: reconciledPricing.membershipDiscountAmount,
      manualDiscountAmount: reconciledPricing.manualDiscountAmount,
      discount: reconciledPricing.discount,
      total: reconciledPricing.totalPayable,
      totalPayable: reconciledPricing.totalPayable,
    };

    // Map service snapshots to invoice lines
    // Inspect linked subscriptions and ensure coverage is only granted if the subscription is:
    // 1. Found in the same organization
    // 2. Belongs to the same customer
    // 3. Status is "active" or "pending_payment" (or line was already redeemed via subscription)
    // 4. Within validity dates (startDate <= now <= endDate)
    // 5. Permitted at the appointment's branch
    // 6. Contains an entitlement matching the serviceId with remaining quantity
    // 7. Prevent duplicate coverage/over-consumption across multiple lines sharing the same subscription entitlement
    const appliedSubIds = (appointment.services || [])
      .map((s) => s.appliedSubscriptionId)
      .filter(Boolean);

    const subscriptionMap = new Map();
    if (appliedSubIds.length > 0) {
      const subs = await Subscription.find({
        _id: { $in: appliedSubIds },
        organizationId,
        isDeleted: false,
      });
      for (const sub of subs) {
        subscriptionMap.set(sub._id.toString(), sub);
      }
    }

    const aptBranchIdStr = aptBranchId;
    const now = new Date();
    // Track simulated consumption per subscription & service during invoice line generation to prevent duplicate coverage
    const allocatedEntitlementCounts = new Map(); // key: `${subId}_${serviceId}` -> number of lines covered

    const invoiceLines = (appointment.services || []).map((s) => {
      const unitPrice = Number(s.price); // Authoritative snapshot price from appointment
      const quantity = 1;
      const lineTotal = Number((unitPrice * quantity).toFixed(2));

      let isCovered = false;
      if (s.isRedeemedViaSubscription || s.subscriptionUsageId) {
        // Line was already redeemed and verified at appointment completion
        isCovered = true;
      } else if (s.appliedSubscriptionId) {
        const sub = subscriptionMap.get(s.appliedSubscriptionId.toString());
        if (sub) {
          const isCorrectOrg =
            sub.organizationId.toString() === organizationId.toString();

          let member = null;
          let isCustomerEnrolled = false;
          if (Array.isArray(sub.members) && sub.members.length > 0) {
            member = sub.members.find(
              (m) =>
                m.customerId.toString() === appointment.customerId.toString(),
            );
            isCustomerEnrolled =
              Boolean(member) &&
              ["active", "pending_payment"].includes(member.status);
          } else {
            isCustomerEnrolled =
              sub.customerId.toString() === appointment.customerId.toString();
          }

          const isAllowedStatus = ["active", "pending_payment"].includes(
            sub.status,
          );
          const isWithinDates =
            (!sub.startDate || new Date(sub.startDate) <= now) &&
            (!sub.endDate || new Date(sub.endDate) >= now);

          // Branch eligibility check (effective intersection: sub is hard maximum, member further restricts)
          const subBranches = Array.isArray(sub.permittedBranchIds)
            ? sub.permittedBranchIds
            : [];
          const memberBranches =
            member && Array.isArray(member.permittedBranchIds)
              ? member.permittedBranchIds
              : [];
          let isPermittedBranch = true;
          if (subBranches.length > 0) {
            isPermittedBranch = subBranches.some(
              (b) => b.toString() === aptBranchIdStr,
            );
          }
          if (isPermittedBranch && memberBranches.length > 0) {
            isPermittedBranch = memberBranches.some(
              (b) => b.toString() === aptBranchIdStr,
            );
          }

          if (
            isCorrectOrg &&
            isCustomerEnrolled &&
            isAllowedStatus &&
            isWithinDates &&
            isPermittedBranch
          ) {
            const sIdStr = s.serviceId ? s.serviceId.toString() : null;
            const entitlementsList = member
              ? member.entitlements
              : sub.entitlements;
            const entitlement = (entitlementsList || []).find(
              (e) => e.serviceId && e.serviceId.toString() === sIdStr,
            );
            if (entitlement && (entitlement.remainingQuantity || 0) > 0) {
              const allocKey = `${sub._id.toString()}_${sIdStr}`;
              const currentlyAllocated =
                allocatedEntitlementCounts.get(allocKey) || 0;
              if (currentlyAllocated < entitlement.remainingQuantity) {
                isCovered = true;
                allocatedEntitlementCounts.set(
                  allocKey,
                  currentlyAllocated + 1,
                );
              }
            }
          }
        }
      }

      const subscriptionCoveredAmount = isCovered ? lineTotal : 0;

      return {
        lineType: "service",
        serviceType: s.serviceType || "registered",
        serviceId: s.serviceId || null,
        staffId: appointment.staffId || null,
        attribution: {
          performedBy: appointmentPerformerAttribution,
        },
        appointmentServiceId: s._id,
        name: s.name,
        duration: s.duration,
        quantity,
        unitPrice,
        lineTotal,
        isCoveredBySubscription: isCovered,
        appliedSubscriptionId: s.appliedSubscriptionId || null,
        subscriptionUsageId: s.subscriptionUsageId || null,
        subscriptionCoveredAmount,
        discountAmount: 0,
        customerPayable: Math.max(
          0,
          Number((lineTotal - subscriptionCoveredAmount).toFixed(2)),
        ),
      };
    });

    // Append product lines if passed with appointment checkout
    const productItemsToReserve = [];
    if (Array.isArray(data.productLines) && data.productLines.length > 0) {
      for (const prodInput of data.productLines) {
        const product = await productRepository.findById(
          prodInput.productId,
          organizationId,
          session,
        );
        if (!product) {
          throw new AppError(`Product not found: ${prodInput.productId}`, 404);
        }
        if (product.status !== "active") {
          throw new AppError(
            `Cannot sell inactive product '${product.name}'`,
            400,
          );
        }
        if (!["retail_sale", "both"].includes(product.usageType)) {
          throw new AppError(
            `Product '${product.name}' is not designated for retail sale`,
            400,
          );
        }

        const qty = Number(prodInput.quantity);
        const soldBy = await resolveStaffAttribution(
          prodInput.soldByStaffId,
          organizationId,
          branchId,
          session,
        );
        const unitPrice = Number(product.sellingPrice || 0);
        const lineTotal = Number((qty * unitPrice).toFixed(2));

        invoiceLines.push({
          lineType: "product",
          productId: product._id,
          attribution: { soldBy },
          sku: product.sku,
          stockUnit: product.stockUnit,
          costPriceSnapshot: product.costPrice || 0,
          name: product.name,
          duration: 0,
          quantity: qty,
          unitPrice,
          lineTotal,
          isCoveredBySubscription: false,
          subscriptionCoveredAmount: 0,
          discountAmount: 0,
          customerPayable: lineTotal,
        });

        productItemsToReserve.push({
          productId: product._id,
          quantity: qty,
        });
      }
    }

    // Discount resolution: use override if explicitly provided, else seed from appointment
    const effectiveDiscountInput =
      discount !== undefined && discount !== null
        ? discount
        : data.discountTotal;
    let standardDiscount =
      effectiveDiscountInput !== undefined && effectiveDiscountInput !== null
        ? Number(Number(effectiveDiscountInput).toFixed(2))
        : Number((appointmentPricingSnapshot.discount || 0).toFixed(2));

    if (standardDiscount < 0) {
      throw new AppError("Discount cannot be negative", 400);
    }

    // Optional loyalty redemption calculation
    let loyaltyRedeemedPoints = 0;
    let loyaltyDiscountAmount = 0;

    if (redeemLoyaltyPoints && Number(redeemLoyaltyPoints) > 0) {
      // Preliminary calculation to find eligible uncovered amount before loyalty
      const preTotals = this.calculateInvoiceTotals(
        invoiceLines,
        standardDiscount,
      );
      const eligibleAmount = preTotals.payableAmount;

      const preview = await loyaltyService.previewRedemption(
        customer._id,
        eligibleAmount,
        redeemLoyaltyPoints,
        organizationId,
      );

      loyaltyRedeemedPoints = preview.appliedPoints;
      loyaltyDiscountAmount = preview.appliedDiscount;
    }

    const totalDiscountToAllocate = Number(
      (standardDiscount + loyaltyDiscountAmount).toFixed(2),
    );

    // Calculate totals and allocate discount to uncovered lines strictly
    const totals = this.calculateInvoiceTotals(
      invoiceLines,
      totalDiscountToAllocate,
    );

    const amountPaid = 0;
    const amountDue = totals.payableAmount;
    const paymentStatus = this.derivePaymentStatus(amountPaid, amountDue);

    const invoiceNumber = await this.generateInvoiceNumber(organizationId);

    const invoiceDoc = new Invoice({
      organizationId,
      branchId,
      invoiceNumber,
      appointmentId: appointment._id,
      appointmentCode: appointment.appointmentCode,
      invoiceType:
        productItemsToReserve.length > 0 ? "combined" : "appointment",
      appointmentPricingSnapshot,
      customerId: customer._id,
      customerSnapshot,
      lines: invoiceLines,
      subtotal: totals.subtotal,
      discountTotal: totals.discountTotal,
      loyaltyRedeemedPoints,
      loyaltyDiscountAmount,
      grossPayable: totals.grossPayable,
      subscriptionCoveredAmount: totals.subscriptionCoveredAmount,
      payableAmount: totals.payableAmount,
      amountPaid,
      amountDue,
      status: "draft",
      paymentStatus,
      notes,
      createdBy: userId,
    });

    try {
      if (session) {
        await invoiceDoc.save({ session });
      } else {
        await invoiceDoc.save();
      }

      // If this invoice is billed against an existing standalone subscription, link invoiceId to the subscription
      if (subscriptionId) {
        const subIdToLink =
          typeof subscriptionId === "object"
            ? subscriptionId._id || subscriptionId
            : subscriptionId;
        const updateQuery = Subscription.updateOne(
          { _id: subIdToLink, organizationId },
          {
            $set: { invoiceId: invoiceDoc._id },
            $push: {
              invoiceHistory: {
                invoiceId: invoiceDoc._id,
                invoiceNumber: invoiceDoc.invoiceNumber,
                status: invoiceDoc.status || "draft",
                issuedAt: new Date(),
              },
            },
          },
        );
        if (session) {
          await updateQuery.session(session);
        } else {
          await updateQuery;
        }
      }

      if (productItemsToReserve.length > 0) {
        await inventoryService.reserveStockForInvoice({
          invoiceId: invoiceDoc._id,
          branchId,
          organizationId,
          items: productItemsToReserve,
          session,
        });
      }
    } catch (err) {
      if (err.code === 11000) {
        throw new AppError(
          "An active invoice already exists for this appointment",
          409,
        );
      }
      throw err;
    }

    // Audit log
    const auditData = {
      organizationId,
      branchId,
      actorId: userId,
      action: AUDIT_ACTIONS.INVOICE_CREATED,
      entityType: "Invoice",
      entityId: invoiceDoc._id,
      description: `Draft invoice ${invoiceNumber} created for appointment ${appointment.appointmentCode}`,
      metadata: {
        invoiceNumber,
        appointmentCode: appointment.appointmentCode,
        payableAmount: totals.payableAmount,
        discountTotal: totals.discountTotal,
      },
    };
    if (session) {
      const auditDoc = new AuditLog(auditData);
      await auditDoc.save({ session });
    } else {
      await AuditLog.create(auditData);
    }

    await emitBillingOutboxEvent({
      eventType: "invoice.created",
      invoice: invoiceDoc,
      operationId: String(invoiceDoc._id),
      amountInPaise: Math.round((invoiceDoc.amountDue || 0) * 100),
      session,
    });

    return invoiceDoc;
  }

  /**
   * 1b. CREATE DRAFT OR FINALIZED INVOICE FOR SUBSCRIPTION SALE
   */
  async createInvoiceForSubscriptionSale(
    data,
    organizationId,
    userId,
    session = null,
  ) {
    const {
      subscriptionId,
      branchId,
      productLines = [],
      discount = 0,
      redeemLoyaltyPoints = 0,
      notes = "",
    } = data;

    let subQuery = Subscription.findOne({
      _id: subscriptionId,
      organizationId,
      isDeleted: false,
    });
    if (session) subQuery = subQuery.session(session);
    const subscription = await subQuery;

    if (!subscription) {
      throw new AppError("Subscription not found", 404);
    }

    // Subscription sale invoice belongs to the validated selling branch (branchId).
    // Redemption eligibility across branches is governed independently by subscription.permittedBranchIds.

    // Check for existing active invoice for this subscription
    let existingInvQuery = Invoice.findOne({
      subscriptionId: subscription._id,
      organizationId,
      status: { $ne: "cancelled" },
      isDeleted: false,
    });
    if (session) existingInvQuery = existingInvQuery.session(session);
    const existingActiveInvoice = await existingInvQuery;

    if (existingActiveInvoice) {
      throw new AppError(
        `An active invoice (${existingActiveInvoice.invoiceNumber}) already exists for this subscription sale`,
        400,
      );
    }

    // Load payer customer profile snapshot
    const payerId = subscription.payerCustomerId || subscription.customerId;
    let custQuery = Customer.findOne({
      _id: payerId,
      organizationId,
      isDeleted: false,
    });
    if (session) custQuery = custQuery.session(session);
    const customer = await custQuery;

    if (!customer) {
      throw new AppError(
        "Customer record not found for this subscription",
        404,
      );
    }

    const customerSnapshot = {
      name: customer.name,
      phone: customer.phone,
      email: customer.email || null,
    };

    const salePrice = Number(subscription.price);
    const unitPrice = salePrice;
    const quantity = 1;
    const lineTotal = Number((unitPrice * quantity).toFixed(2));

    const invoiceLines = [
      {
        lineType: "subscription",
        serviceType: undefined,
        serviceId: null,
        subscriptionId: subscription._id,
        attribution: subscription.attribution || {},
        appointmentServiceId: null,
        name: `Subscription: ${subscription.subscriptionCode}`,
        duration: 0,
        quantity,
        unitPrice,
        lineTotal,
        isCoveredBySubscription: false,
        appliedSubscriptionId: null,
        subscriptionUsageId: null,
        subscriptionCoveredAmount: 0,
        discountAmount: 0,
        customerPayable: lineTotal,
      },
    ];

    const productItemsToReserve = [];

    // Optional unified retail product lines sold alongside subscription
    if (Array.isArray(productLines) && productLines.length > 0) {
      for (const prodInput of productLines) {
        const product = await productRepository.findById(
          prodInput.productId,
          organizationId,
          session,
        );
        if (!product) {
          throw new AppError(`Product not found: ${prodInput.productId}`, 404);
        }
        if (product.status !== "active") {
          throw new AppError(
            `Cannot sell inactive product '${product.name}'`,
            400,
          );
        }
        if (!["retail_sale", "both"].includes(product.usageType)) {
          throw new AppError(
            `Product '${product.name}' is not designated for retail sale`,
            400,
          );
        }

        const qty = Number(prodInput.quantity);
        const soldBy = await resolveStaffAttribution(
          prodInput.soldByStaffId,
          organizationId,
          branchId,
          session,
        );
        const prodUnitPrice = Number(product.sellingPrice || 0);
        const prodLineTotal = Number((qty * prodUnitPrice).toFixed(2));

        invoiceLines.push({
          lineType: "product",
          productId: product._id,
          attribution: { soldBy },
          sku: product.sku,
          stockUnit: product.stockUnit,
          costPriceSnapshot: product.costPrice || 0,
          name: product.name,
          duration: 0,
          quantity: qty,
          unitPrice: prodUnitPrice,
          lineTotal: prodLineTotal,
          isCoveredBySubscription: false,
          subscriptionCoveredAmount: 0,
          discountAmount: 0,
          customerPayable: prodLineTotal,
        });

        productItemsToReserve.push({
          productId: product._id,
          quantity: qty,
        });
      }
    }

    let standardDiscount = Number(Number(discount || 0).toFixed(2));
    if (standardDiscount < 0) {
      throw new AppError("Discount cannot be negative", 400);
    }

    let loyaltyRedeemedPoints = 0;
    let loyaltyDiscountAmount = 0;

    if (redeemLoyaltyPoints && Number(redeemLoyaltyPoints) > 0) {
      const preTotals = this.calculateInvoiceTotals(
        invoiceLines,
        standardDiscount,
      );
      const eligibleAmount = preTotals.payableAmount;

      const preview = await loyaltyService.previewRedemption(
        customer._id,
        eligibleAmount,
        redeemLoyaltyPoints,
        organizationId,
      );

      loyaltyRedeemedPoints = preview.appliedPoints;
      loyaltyDiscountAmount = preview.appliedDiscount;
    }

    const totalDiscountToAllocate = Number(
      (standardDiscount + loyaltyDiscountAmount).toFixed(2),
    );
    const totals = this.calculateInvoiceTotals(
      invoiceLines,
      totalDiscountToAllocate,
    );

    const amountPaid = 0;
    const amountDue = totals.payableAmount;
    const paymentStatus = this.derivePaymentStatus(amountPaid, amountDue);

    const invoiceNumber = await this.generateInvoiceNumber(organizationId);

    const invoiceDoc = new Invoice({
      organizationId,
      branchId,
      invoiceNumber,
      invoiceType:
        productItemsToReserve.length > 0 ? "combined" : "subscription",
      appointmentId: null,
      appointmentCode: null,
      appointmentPricingSnapshot: null,
      subscriptionId: subscription._id,
      subscriptionCode: subscription.subscriptionCode,
      customerId: customer._id,
      customerSnapshot,
      lines: invoiceLines,
      subtotal: totals.subtotal,
      discountTotal: totals.discountTotal,
      loyaltyRedeemedPoints,
      loyaltyDiscountAmount,
      grossPayable: totals.grossPayable,
      subscriptionCoveredAmount: totals.subscriptionCoveredAmount,
      payableAmount: totals.payableAmount,
      amountPaid,
      amountDue,
      status: "draft",
      paymentStatus,
      notes,
      createdBy: userId,
    });

    try {
      if (session) {
        await invoiceDoc.save({ session });
      } else {
        await invoiceDoc.save();
      }

      // If this invoice is billed against an existing standalone subscription, link invoiceId to the subscription
      if (subscriptionId) {
        const subIdToLink =
          typeof subscriptionId === "object"
            ? subscriptionId._id || subscriptionId
            : subscriptionId;
        const updateQuery = Subscription.updateOne(
          { _id: subIdToLink, organizationId },
          {
            $set: { invoiceId: invoiceDoc._id },
            $push: {
              invoiceHistory: {
                invoiceId: invoiceDoc._id,
                invoiceNumber: invoiceDoc.invoiceNumber,
                status: invoiceDoc.status || "draft",
                issuedAt: new Date(),
              },
            },
          },
        );
        if (session) {
          await updateQuery.session(session);
        } else {
          await updateQuery;
        }
      }

      if (productItemsToReserve.length > 0) {
        await inventoryService.reserveStockForInvoice({
          invoiceId: invoiceDoc._id,
          branchId,
          organizationId,
          items: productItemsToReserve,
          session,
        });
      }
    } catch (err) {
      if (err.code === 11000) {
        throw new AppError(
          "An active invoice already exists for this subscription",
          409,
        );
      }
      throw err;
    }

    // Link invoiceId and record in invoiceHistory for subscription document
    subscription.invoiceId = invoiceDoc._id;
    if (!Array.isArray(subscription.invoiceHistory)) {
      subscription.invoiceHistory = [];
    }
    subscription.invoiceHistory.push({
      invoiceId: invoiceDoc._id,
      invoiceNumber: invoiceDoc.invoiceNumber,
      status: "draft",
      issuedAt: new Date(),
    });

    if (session) {
      await subscription.save({ session });
    } else {
      await subscription.save();
    }

    // Audit log
    const auditData = {
      organizationId,
      branchId,
      actorId: userId,
      action: AUDIT_ACTIONS.INVOICE_CREATED,
      entityType: "Invoice",
      entityId: invoiceDoc._id,
      description: `Draft subscription sale invoice ${invoiceNumber} created for subscription ${subscription.subscriptionCode}`,
      metadata: {
        invoiceNumber,
        subscriptionCode: subscription.subscriptionCode,
        payableAmount: totals.payableAmount,
        discountTotal: totals.discountTotal,
      },
    };
    if (session) {
      const aLog = new AuditLog(auditData);
      await aLog.save({ session });
    } else {
      await AuditLog.create(auditData);
    }

    await emitBillingOutboxEvent({
      eventType: "invoice.created",
      invoice: invoiceDoc,
      operationId: String(invoiceDoc._id),
      amountInPaise: Math.round((invoiceDoc.amountDue || 0) * 100),
      session,
    });

    return invoiceDoc;
  }

  /**
   * 1c. CREATE DRAFT RETAIL POS INVOICE (WALK-IN OR COMBINED CART)
   */
  async createRetailInvoice(data, organizationId, userId, session = null) {
    const {
      customerId,
      branchId,
      productLines = [],
      discount = 0,
      redeemLoyaltyPoints = 0,
      notes = "",
    } = data;

    if (!Array.isArray(productLines) || productLines.length === 0) {
      throw new AppError(
        "Retail invoice must contain at least one product item",
        400,
      );
    }

    // Load customer profile snapshot
    const customer = await Customer.findOne({
      _id: customerId,
      organizationId,
      isDeleted: false,
    });

    if (!customer) {
      throw new AppError("Customer record not found", 404);
    }

    const customerSnapshot = {
      name: customer.name,
      phone: customer.phone,
      email: customer.email || null,
    };

    const invoiceLines = [];
    const productItemsToReserve = [];
    for (const prodInput of productLines) {
      const product = await productRepository.findById(
        prodInput.productId,
        organizationId,
        session,
      );
      if (!product) {
        throw new AppError(`Product not found: ${prodInput.productId}`, 404);
      }
      if (product.status !== "active") {
        throw new AppError(
          `Cannot sell inactive product '${product.name}'`,
          400,
        );
      }
      if (!["retail_sale", "both"].includes(product.usageType)) {
        throw new AppError(
          `Product '${product.name}' is not designated for retail sale`,
          400,
        );
      }

      const qty = Number(prodInput.quantity);
      const soldBy = await resolveStaffAttribution(
        prodInput.soldByStaffId,
        organizationId,
        branchId,
        session,
      );
      const unitPrice = Number(product.sellingPrice || 0);
      const lineTotal = Number((qty * unitPrice).toFixed(2));

      invoiceLines.push({
        lineType: "product",
        productId: product._id,
        attribution: { soldBy },
        sku: product.sku,
        stockUnit: product.stockUnit,
        costPriceSnapshot: product.costPrice || 0,
        name: product.name,
        duration: 0,
        quantity: qty,
        unitPrice,
        lineTotal,
        isCoveredBySubscription: false,
        subscriptionCoveredAmount: 0,
        discountAmount: 0,
        customerPayable: lineTotal,
      });

      productItemsToReserve.push({
        productId: product._id,
        quantity: qty,
      });
    }

    const standardDiscount = Number(Number(discount || 0).toFixed(2));
    if (standardDiscount < 0) {
      throw new AppError("Discount cannot be negative", 400);
    }

    let loyaltyRedeemedPoints = 0;
    let loyaltyDiscountAmount = 0;

    if (redeemLoyaltyPoints && Number(redeemLoyaltyPoints) > 0) {
      const preTotals = this.calculateInvoiceTotals(
        invoiceLines,
        standardDiscount,
      );
      const eligibleAmount = preTotals.payableAmount;

      const preview = await loyaltyService.previewRedemption(
        customer._id,
        eligibleAmount,
        redeemLoyaltyPoints,
        organizationId,
      );

      loyaltyRedeemedPoints = preview.appliedPoints;
      loyaltyDiscountAmount = preview.appliedDiscount;
    }

    const totalDiscountToAllocate = Number(
      (standardDiscount + loyaltyDiscountAmount).toFixed(2),
    );
    const totals = this.calculateInvoiceTotals(
      invoiceLines,
      totalDiscountToAllocate,
    );

    const amountPaid = 0;
    const amountDue = totals.payableAmount;
    const paymentStatus = this.derivePaymentStatus(amountPaid, amountDue);

    const invoiceNumber = await this.generateInvoiceNumber(organizationId);

    const invoiceDoc = new Invoice({
      organizationId,
      branchId,
      invoiceNumber,
      invoiceType: "retail",
      appointmentId: null,
      appointmentCode: null,
      appointmentPricingSnapshot: null,
      subscriptionId: null,
      subscriptionCode: null,
      customerId: customer._id,
      customerSnapshot,
      lines: invoiceLines,
      subtotal: totals.subtotal,
      discountTotal: totals.discountTotal,
      loyaltyRedeemedPoints,
      loyaltyDiscountAmount,
      grossPayable: totals.grossPayable,
      subscriptionCoveredAmount: 0,
      payableAmount: totals.payableAmount,
      amountPaid,
      amountDue,
      status: "draft",
      paymentStatus,
      notes,
      createdBy: userId,
    });

    try {
      if (session) {
        await invoiceDoc.save({ session });
      } else {
        await invoiceDoc.save();
      }

      // If this invoice is billed against an existing standalone subscription, link invoiceId to the subscription
      if (subscriptionId) {
        const subIdToLink =
          typeof subscriptionId === "object"
            ? subscriptionId._id || subscriptionId
            : subscriptionId;
        const updateQuery = Subscription.updateOne(
          { _id: subIdToLink, organizationId },
          {
            $set: { invoiceId: invoiceDoc._id },
            $push: {
              invoiceHistory: {
                invoiceId: invoiceDoc._id,
                invoiceNumber: invoiceDoc.invoiceNumber,
                status: invoiceDoc.status || "draft",
                issuedAt: new Date(),
              },
            },
          },
        );
        if (session) {
          await updateQuery.session(session);
        } else {
          await updateQuery;
        }
      }

      // Reserve stock atomically for retail items
      await inventoryService.reserveStockForInvoice({
        invoiceId: invoiceDoc._id,
        branchId,
        organizationId,
        items: productItemsToReserve,
        session,
      });
    } catch (err) {
      throw err;
    }

    const auditData = {
      organizationId,
      branchId,
      actorId: userId,
      action: AUDIT_ACTIONS.INVOICE_CREATED,
      entityType: "Invoice",
      entityId: invoiceDoc._id,
      description: `Draft retail invoice ${invoiceNumber} created for customer ${customer.name}`,
      metadata: {
        invoiceNumber,
        itemCount: invoiceLines.length,
        payableAmount: totals.payableAmount,
      },
    };
    if (session) {
      const aLog = new AuditLog(auditData);
      await aLog.save({ session });
    } else {
      await AuditLog.create(auditData);
    }

    await emitBillingOutboxEvent({
      eventType: "invoice.created",
      invoice: invoiceDoc,
      operationId: String(invoiceDoc._id),
      amountInPaise: Math.round((invoiceDoc.amountDue || 0) * 100),
      session,
    });

    return invoiceDoc;
  }

  /**
   * 1d. CREATE UNIFIED DRAFT INVOICE
   * Authoritative multi-line creation pipeline supporting any combination of:
   * - appointment services
   * - walk-in custom services
   * - retail products (with POS stock reservation)
   * - subscription plans (with same-appointment entitlement coverage waiver)
   * - membership plans (with same-invoice benefit discount pre-evaluation)
   */
  async createUnifiedInvoice(data, organizationId, userId, session = null) {
    if (!session) {
      return this.executeTransaction((transactionSession) =>
        this.createUnifiedInvoice(
          data,
          organizationId,
          userId,
          transactionSession,
        ),
      );
    }

    const {
      branchId,
      customerId: explicitCustomerId,
      appointmentId,
      subscriptionId,
      membershipPlanId,
      productLines = [],
      membershipLines = [],
      subscriptionLines = [],
      serviceLines = [],
      discount = 0,
      discountTotal,
      redeemLoyaltyPoints = 0,
      notes = "",
    } = data;

    let targetCustomerId = explicitCustomerId;
    let appointment = null;
    let appointmentPerformerAttribution = null;
    let appointmentPricingSnapshot = null;
    let reusedDraftInvoice = null;

    // 1. Resolve appointment context if provided
    if (appointmentId) {
      let aptQuery = Appointment.findOne({
        _id: appointmentId,
        organizationId,
        isDeleted: false,
      });
      if (session) aptQuery = aptQuery.session(session);
      appointment = await aptQuery;

      if (!appointment) {
        throw new AppError("Appointment not found", 404);
      }

      const aptBranchId = appointment.branchId?._id
        ? appointment.branchId._id.toString()
        : appointment.branchId.toString();

      if (aptBranchId !== branchId.toString()) {
        throw new AppError(
          "Target branchId does not match appointment branch",
          400,
        );
      }

      if (appointment.status !== "completed") {
        throw new AppError(
          `Cannot create invoice for appointment in '${appointment.status}' status. Appointment must be completed first.`,
          400,
        );
      }

      appointmentPerformerAttribution = await loadStaffAttributionSnapshot(
        appointment.staffId,
        organizationId,
        session,
      );

      // Check existing active invoice
      const existingActiveInvoice = await Invoice.findOne({
        appointmentId: appointment._id,
        organizationId,
        status: { $ne: "cancelled" },
        isDeleted: false,
      });

      if (existingActiveInvoice) {
        // If an invoice is already finalized or paid, reject recreation
        if (existingActiveInvoice.status !== "draft") {
          throw new AppError(
            `An active invoice (${existingActiveInvoice.invoiceNumber}) already exists for this appointment`,
            400,
          );
        }

        // If the draft invoice already exists and no new composite lines were submitted,
        // idempotently resume and return the existing active draft invoice.
        const hasExtraLines =
          (productLines && productLines.length > 0) ||
          (serviceLines && serviceLines.length > 0) ||
          (subscriptionLines && subscriptionLines.length > 0) ||
          (membershipLines && membershipLines.length > 0) ||
          membershipPlanId;

        if (!hasExtraLines) {
          return existingActiveInvoice;
        }

        // The caller wants to update the cart of this ongoing draft invoice.
        // We preserve this draft invoice's identity (_id and invoiceNumber).
        reusedDraftInvoice = existingActiveInvoice;
      }

      targetCustomerId = appointment.customerId;
      appointmentPricingSnapshot = {
        subtotal: appointment.pricing?.subtotal ?? 0,
        discount: appointment.pricing?.discount ?? 0,
        total: appointment.pricing?.total ?? 0,
      };
    }

    // 1b. If legacy subscriptionId was passed without explicit customerId, derive customer from subscription
    if (!targetCustomerId && subscriptionId) {
      let subQuery = Subscription.findOne({
        _id: subscriptionId,
        organizationId,
        isDeleted: false,
      });
      if (session) subQuery = subQuery.session(session);
      const sub = await subQuery;
      if (sub) {
        targetCustomerId = sub.payerCustomerId || sub.customerId;
      }
    }

    // 2. Resolve Customer Profile Snapshot
    if (!targetCustomerId) {
      throw new AppError(
        "A customer must be specified or derived from an appointment or subscription",
        400,
      );
    }

    let custQuery = Customer.findOne({
      _id: targetCustomerId,
      organizationId,
      isDeleted: false,
    });
    if (session) custQuery = custQuery.session(session);
    const customer = await custQuery;

    if (!customer) {
      throw new AppError("Customer record not found", 404);
    }

    const customerSnapshot = {
      name: customer.name,
      phone: customer.phone,
      email: customer.email || null,
    };

    const invoiceLines = [];
    const productItemsToReserve = [];

    // Helper to track and match subscription entitlements in this invoice
    // Map of serviceId (string) -> available quantity for immediate same-appointment waiver
    const newSubscriptionEntitlements = new Map();
    const createdPendingSubs = [];
    const createdPendingMemberships = [];

    // 3. Process In-Cart Subscription Plans (Upsell or direct sale)
    // Combine subscriptionLines array and legacy subscriptionId if passed
    const normalizedSubPlanInputs = [...subscriptionLines];
    if (subscriptionId) {
      // Legacy subscription record lookup
      const existingSub = await Subscription.findOne({
        _id: subscriptionId,
        organizationId,
        isDeleted: false,
      }).session(session);
      if (existingSub) {
        invoiceLines.push({
          lineType: "subscription",
          subscriptionId: existingSub._id,
          attribution: existingSub.attribution || {},
          name: `Subscription: ${existingSub.subscriptionCode}`,
          duration: 0,
          quantity: 1,
          unitPrice: Number(existingSub.price),
          lineTotal: Number(existingSub.price),
          isCoveredBySubscription: false,
          subscriptionCoveredAmount: 0,
          discountAmount: 0,
          customerPayable: Number(existingSub.price),
        });
      }
    }

    for (const subInput of normalizedSubPlanInputs) {
      const plan = await SubscriptionPlan.findOne({
        _id: subInput.planId,
        organizationId,
        isActive: true,
        isDeleted: false,
      }).session(session);

      if (!plan) {
        throw new AppError(
          `Active subscription plan not found: ${subInput.planId}`,
          404,
        );
      }

      // Branch authorization
      if (
        Array.isArray(plan.permittedBranchIds) &&
        plan.permittedBranchIds.length > 0
      ) {
        const isPermitted = plan.permittedBranchIds.some(
          (b) => b.toString() === branchId.toString(),
        );
        if (!isPermitted) {
          throw new AppError(
            `Subscription plan '${plan.name}' is not permitted at this branch`,
            403,
          );
        }
      }

      // Authoritative server-side price (never trust client)
      const unitPrice = Number(plan.suggestedPrice);
      const lineTotal = unitPrice;
      const soldBy = await resolveStaffAttribution(
        subInput.soldByStaffId,
        organizationId,
        branchId,
        session,
      );

      // Register entitlements for same-appointment coverage matching
      for (const ent of plan.entitlements || []) {
        const sId = ent.serviceId.toString();
        const currentQty = newSubscriptionEntitlements.get(sId) || 0;
        newSubscriptionEntitlements.set(sId, currentQty + ent.quantity);
      }

      invoiceLines.push({
        lineType: "subscription",
        subscriptionPlanId: plan._id,
        attribution: { soldBy },
        name: `Subscription Plan: ${plan.name}`,
        duration: 0,
        quantity: 1,
        unitPrice,
        lineTotal,
        isCoveredBySubscription: false,
        subscriptionCoveredAmount: 0,
        discountAmount: 0,
        customerPayable: lineTotal,
      });
    }

    // 4. Process In-Cart Membership Plans (Upsell or direct sale)
    const normalizedMemInputs = [...membershipLines];
    if (membershipPlanId) {
      normalizedMemInputs.push({ membershipPlanId, quantity: 1 });
    }

    let inCartMembershipBenefits = null;
    let inCartMembershipPurchaseLineId = null;
    let existingActiveMembership = null;

    for (const memInput of normalizedMemInputs) {
      let plan = null;
      let existingGroupMemberships = [];
      let isExistingPendingMembership = false;

      // Check if this is an existing pending membership awaiting payment
      if (memInput.customerMembershipId || memInput.membershipPurchaseId) {
        const queryFilter = {
          organizationId,
          isDeleted: false,
        };
        if (memInput.customerMembershipId) {
          queryFilter._id = memInput.customerMembershipId;
        } else if (memInput.membershipPurchaseId) {
          queryFilter.membershipPurchaseId = memInput.membershipPurchaseId;
        }

        const targetCm =
          await CustomerMembership.findOne(queryFilter).session(session);
        if (!targetCm) {
          throw new AppError("Pending customer membership not found", 404);
        }

        if (targetCm.status !== "pending_payment") {
          throw new AppError(
            `Customer membership ${targetCm.membershipCode} is already ${targetCm.status} and cannot be invoiced again`,
            400,
          );
        }

        // Load all sibling beneficiary memberships under the same purchase group
        existingGroupMemberships = await CustomerMembership.find({
          membershipPurchaseId: targetCm.membershipPurchaseId,
          organizationId,
          isDeleted: false,
        }).session(session);

        if (existingGroupMemberships.length === 0) {
          existingGroupMemberships = [targetCm];
        }

        // Verify plan either from membershipPlanId or planSnapshot
        if (targetCm.membershipPlanId) {
          plan = await MembershipPlan.findOne({
            _id: targetCm.membershipPlanId,
            organizationId,
          }).session(session);
        }

        // If plan record was archived or deleted, fallback to the immutable planSnapshot stored on enrollment
        if (!plan) {
          plan = {
            _id: targetCm.membershipPlanId,
            name: targetCm.planSnapshot?.name || "Membership Plan",
            tier: targetCm.planSnapshot?.tier || "Standard",
            price: targetCm.planSnapshot?.price || 0,
            validityMonths: targetCm.planSnapshot?.validityMonths || 12,
            maxBeneficiaries: targetCm.planSnapshot?.maxBeneficiaries || 1,
            benefits: targetCm.planSnapshot?.benefits || {},
            permittedBranchIds: targetCm.permittedBranchIds || [],
          };
        }

        isExistingPendingMembership = true;
      } else {
        plan = await MembershipPlan.findOne({
          _id: memInput.membershipPlanId,
          organizationId,
          isActive: true,
          isDeleted: false,
        }).session(session);

        if (!plan) {
          throw new AppError(
            `Active membership plan not found: ${memInput.membershipPlanId}`,
            404,
          );
        }
      }

      if (
        Array.isArray(plan.permittedBranchIds) &&
        plan.permittedBranchIds.length > 0
      ) {
        const isPermitted = plan.permittedBranchIds.some(
          (b) => b.toString() === branchId.toString(),
        );
        if (!isPermitted) {
          throw new AppError(
            `Membership plan '${plan.name}' is not permitted at this branch`,
            403,
          );
        }
      }

      const unitPrice = Number(plan.price);
      const qty = Number(memInput.quantity || 1);
      const lineTotal = Number((unitPrice * qty).toFixed(2));
      const soldBy = await resolveStaffAttribution(
        memInput.soldByStaffId,
        organizationId,
        branchId,
        session,
      );

      // Multi-beneficiary resolution & validation (supports both legacy beneficiaryCustomerIds and per-beneficiary overrides)
      let payerId = memInput.payerCustomerId || targetCustomerId;
      let targetBeneficiaries = [];
      const beneficiaryOverridesList = Array.isArray(memInput.beneficiaries)
        ? memInput.beneficiaries
        : [];

      if (isExistingPendingMembership && existingGroupMemberships.length > 0) {
        payerId = existingGroupMemberships[0].payerCustomerId || payerId;
        targetBeneficiaries = existingGroupMemberships.map((m) =>
          m.customerId.toString(),
        );
      } else if (beneficiaryOverridesList.length > 0) {
        targetBeneficiaries = beneficiaryOverridesList.map((b) => b.customerId);
      } else if (
        Array.isArray(memInput.beneficiaryCustomerIds) &&
        memInput.beneficiaryCustomerIds.length > 0
      ) {
        targetBeneficiaries = memInput.beneficiaryCustomerIds;
      } else {
        targetBeneficiaries = [payerId];
      }

      // Check unique beneficiaries
      const uniqueBeneficiaryIds = Array.from(
        new Set(targetBeneficiaries.map((b) => b.toString())),
      );
      if (uniqueBeneficiaryIds.length !== targetBeneficiaries.length) {
        throw new AppError(
          "Duplicate beneficiaries detected in membership purchase line",
          400,
        );
      }

      const maxAllowed = plan.maxBeneficiaries || 1;
      if (uniqueBeneficiaryIds.length > maxAllowed) {
        throw new AppError(
          `Membership plan '${plan.name}' allows at most ${maxAllowed} beneficiaries, but ${uniqueBeneficiaryIds.length} were specified`,
          400,
        );
      }

      // Validate all beneficiaries and payer exist within organization
      const verifiedBeneficiaries = await Customer.find({
        _id: { $in: uniqueBeneficiaryIds },
        organizationId,
        isDeleted: false,
      }).session(session);

      if (verifiedBeneficiaries.length !== uniqueBeneficiaryIds.length) {
        throw new AppError(
          "One or more beneficiaries not found in organization",
          404,
        );
      }

      // Build structured beneficiaryOverrides array mapping each beneficiary customer to their custom benefits (or plan defaults)
      const formattedBeneficiaryOverrides = uniqueBeneficiaryIds.map((bId) => {
        if (isExistingPendingMembership) {
          const matchingCm = existingGroupMemberships.find(
            (m) => m.customerId.toString() === bId.toString(),
          );
          if (matchingCm?.planSnapshot?.benefits) {
            return {
              customerId: bId,
              benefits: matchingCm.planSnapshot.benefits,
            };
          }
        }

        const foundOverride = beneficiaryOverridesList.find(
          (o) =>
            (o.customerId?._id || o.customerId)?.toString() === bId.toString(),
        );
        const mergedBenefits = foundOverride?.benefits
          ? {
              serviceDiscountPercentage:
                foundOverride.benefits.serviceDiscountPercentage !== undefined
                  ? Number(foundOverride.benefits.serviceDiscountPercentage)
                  : (plan.benefits?.serviceDiscountPercentage ?? 0),
              productDiscountPercentage:
                foundOverride.benefits.productDiscountPercentage !== undefined
                  ? Number(foundOverride.benefits.productDiscountPercentage)
                  : (plan.benefits?.productDiscountPercentage ?? 0),
              eligibleServiceCategoryIds:
                foundOverride.benefits.eligibleServiceCategoryIds ||
                plan.benefits?.eligibleServiceCategoryIds ||
                [],
              eligibleServiceIds:
                foundOverride.benefits.eligibleServiceIds ||
                plan.benefits?.eligibleServiceIds ||
                [],
              excludedServiceCategoryIds:
                foundOverride.benefits.excludedServiceCategoryIds ||
                plan.benefits?.excludedServiceCategoryIds ||
                [],
              excludedServiceIds:
                foundOverride.benefits.excludedServiceIds ||
                plan.benefits?.excludedServiceIds ||
                [],
              complimentaryPerks:
                foundOverride.benefits.complimentaryPerks ||
                plan.benefits?.complimentaryPerks ||
                [],
            }
          : typeof plan.benefits?.toObject === "function"
            ? plan.benefits.toObject()
            : plan.benefits
              ? { ...plan.benefits }
              : {};

        return {
          customerId: bId,
          benefits: mergedBenefits,
        };
      });

      // Track active benefits for same-invoice benefit preview ONLY IF the target appointment/cart customer is among beneficiaries!
      const matchingBeneficiaryOverride = formattedBeneficiaryOverrides.find(
        (b) => b.customerId.toString() === targetCustomerId.toString(),
      );
      if (matchingBeneficiaryOverride) {
        inCartMembershipBenefits = matchingBeneficiaryOverride.benefits;
      }
      inCartMembershipPurchaseLineId = new mongoose.Types.ObjectId();

      const resolvedCmId = isExistingPendingMembership
        ? existingGroupMemberships[0]?._id
        : memInput.customerMembershipId || null;
      const resolvedCmIds = isExistingPendingMembership
        ? existingGroupMemberships.map((m) => m._id)
        : Array.isArray(memInput.customerMembershipIds)
          ? memInput.customerMembershipIds
          : memInput.customerMembershipId
            ? [memInput.customerMembershipId]
            : [];
      const resolvedPurchaseId = isExistingPendingMembership
        ? existingGroupMemberships[0]?.membershipPurchaseId
        : memInput.membershipPurchaseId || null;

      invoiceLines.push({
        _id: inCartMembershipPurchaseLineId,
        lineType: "membership",
        membershipPlanId: plan._id,
        payerCustomerId: payerId,
        beneficiaryCustomerIds: uniqueBeneficiaryIds,
        beneficiaryOverrides: formattedBeneficiaryOverrides,
        customerMembershipId: resolvedCmId,
        customerMembershipIds: resolvedCmIds,
        membershipPurchaseId: resolvedPurchaseId,
        attribution: { soldBy },
        membershipTierSnapshot: plan.tier || "Standard",
        name: `Membership: ${plan.name}`,
        duration: 0,
        quantity: qty,
        unitPrice,
        lineTotal,
        isCoveredBySubscription: false,
        subscriptionCoveredAmount: 0,
        discountAmount: 0,
        customerPayable: lineTotal,
      });
    }

    // Also check if customer already has an existing active or pending_payment membership (outside this cart)
    if (!inCartMembershipBenefits) {
      const now = new Date(Date.now());
      const candidateCmQuery = {
        organizationId,
        customerId: targetCustomerId,
        status: { $in: ["active", "pending_payment"] },
        startDate: { $lte: now },
        endDate: { $gte: now },
        isDeleted: false,
      };

      if (branchId) {
        candidateCmQuery.$or = [
          { permittedBranchIds: { $exists: false } },
          { permittedBranchIds: { $size: 0 } },
          { permittedBranchIds: branchId },
        ];
      }

      let cmFindQuery = CustomerMembership.find(candidateCmQuery).sort({
        status: 1, // 'active' prioritized over 'pending_payment'
        "planSnapshot.benefits.serviceDiscountPercentage": -1,
        createdAt: -1,
      });

      if (session) cmFindQuery = cmFindQuery.session(session);
      const candidateMemberships = await cmFindQuery;

      for (const cm of candidateMemberships) {
        const permitted =
          !Array.isArray(cm.permittedBranchIds) ||
          cm.permittedBranchIds.length === 0 ||
          cm.permittedBranchIds.some(
            (b) => b.toString() === branchId.toString(),
          );

        if (permitted && cm.planSnapshot?.benefits) {
          existingActiveMembership = cm;
          inCartMembershipBenefits = cm.planSnapshot.benefits;
          break;
        }
      }
    }

    // 5. Process Appointment Services (if appointment-started checkout)
    const existingSubMap = new Map();
    const allocatedEntitlementCounts = new Map();
    const now = new Date();
    const branchIdStr = branchId.toString();

    // Collect all candidate subscription IDs from appointment services or walk-in service inputs
    const candidateSubIds = [];
    if (appointment && Array.isArray(appointment.services)) {
      for (const s of appointment.services) {
        if (s.appliedSubscriptionId) {
          candidateSubIds.push(s.appliedSubscriptionId.toString());
        }
      }
    }
    if (Array.isArray(serviceLines)) {
      for (const s of serviceLines) {
        if (s.appliedSubscriptionId) {
          candidateSubIds.push(s.appliedSubscriptionId.toString());
        }
      }
    }

    // Also if targetCustomerId exists, look up active subscriptions for this customer to support auto-matching
    let customerActiveSubs = [];
    if (targetCustomerId) {
      let subsQuery = Subscription.find({
        organizationId,
        isDeleted: false,
        status: { $in: ["active", "pending_payment"] },
        $or: [
          { customerId: targetCustomerId },
          { payerCustomerId: targetCustomerId },
          { "members.customerId": targetCustomerId },
        ],
      });
      if (session) subsQuery = subsQuery.session(session);
      customerActiveSubs = await subsQuery;
      for (const sub of customerActiveSubs) {
        existingSubMap.set(sub._id.toString(), sub);
      }
    }

    if (candidateSubIds.length > 0) {
      const missingSubIds = candidateSubIds.filter(
        (id) => !existingSubMap.has(id),
      );
      if (missingSubIds.length > 0) {
        let subsQuery = Subscription.find({
          _id: { $in: missingSubIds },
          organizationId,
          isDeleted: false,
        });
        if (session) subsQuery = subsQuery.session(session);
        const subs = await subsQuery;
        for (const sub of subs) {
          existingSubMap.set(sub._id.toString(), sub);
        }
      }
    }

    if (appointment && Array.isArray(appointment.services)) {
      for (const s of appointment.services) {
        const unitPrice = Number(s.price); // Authoritative snapshot price
        const quantity = 1;
        const lineTotal = Number((unitPrice * quantity).toFixed(2));

        let isCovered = false;
        let appliedSubscriptionId = s.appliedSubscriptionId || null;
        let subscriptionUsageId = s.subscriptionUsageId || null;

        // Check if pre-redeemed
        if (s.isRedeemedViaSubscription || s.subscriptionUsageId) {
          isCovered = true;
        } else if (
          s.appliedSubscriptionId &&
          existingSubMap.has(s.appliedSubscriptionId.toString())
        ) {
          // Check existing active subscription linked to appointment
          const sub = existingSubMap.get(s.appliedSubscriptionId.toString());
          let member = null;
          let isCustomerEnrolled = false;
          if (Array.isArray(sub.members) && sub.members.length > 0) {
            member = sub.members.find(
              (m) =>
                m.customerId.toString() === appointment.customerId.toString(),
            );
            isCustomerEnrolled =
              Boolean(member) &&
              ["active", "pending_payment"].includes(member.status);
          } else {
            isCustomerEnrolled =
              sub.customerId.toString() === appointment.customerId.toString();
          }

          const isAllowedStatus = ["active", "pending_payment"].includes(
            sub.status,
          );
          const isWithinDates =
            (!sub.startDate || new Date(sub.startDate) <= now) &&
            (!sub.endDate || new Date(sub.endDate) >= now);

          const subBranches = Array.isArray(sub.permittedBranchIds)
            ? sub.permittedBranchIds
            : [];
          const memberBranches =
            member && Array.isArray(member.permittedBranchIds)
              ? member.permittedBranchIds
              : [];
          let isPermittedBranch = true;
          if (subBranches.length > 0) {
            isPermittedBranch = subBranches.some(
              (b) => b.toString() === branchIdStr,
            );
          }
          if (isPermittedBranch && memberBranches.length > 0) {
            isPermittedBranch = memberBranches.some(
              (b) => b.toString() === branchIdStr,
            );
          }

          if (
            isCustomerEnrolled &&
            isAllowedStatus &&
            isWithinDates &&
            isPermittedBranch
          ) {
            const sIdStr = s.serviceId ? s.serviceId.toString() : null;
            const entitlementsList = member
              ? member.entitlements
              : sub.entitlements;
            const entitlement = (entitlementsList || []).find(
              (e) => e.serviceId && e.serviceId.toString() === sIdStr,
            );
            if (entitlement && (entitlement.remainingQuantity || 0) > 0) {
              const allocKey = `${sub._id.toString()}_${sIdStr}`;
              const currentlyAllocated =
                allocatedEntitlementCounts.get(allocKey) || 0;
              if (currentlyAllocated < entitlement.remainingQuantity) {
                isCovered = true;
                allocatedEntitlementCounts.set(
                  allocKey,
                  currentlyAllocated + 1,
                );
              }
            }
          }
        } else if (newSubscriptionEntitlements.has(s.serviceId?.toString())) {
          // Same-appointment subscription upsell coverage!
          const sId = s.serviceId.toString();
          const remainingInCartEnt = newSubscriptionEntitlements.get(sId);
          if (remainingInCartEnt > 0) {
            isCovered = true;
            newSubscriptionEntitlements.set(sId, remainingInCartEnt - 1);
          }
        }

        const subscriptionCoveredAmount = isCovered ? lineTotal : 0;
        let customerPayable = Math.max(
          0,
          Number((lineTotal - subscriptionCoveredAmount).toFixed(2)),
        );

        // Evaluate in-flight membership tier discount if not covered
        let isDiscountedByMembership = false;
        let membershipDiscountAmount = 0;

        if (
          !isCovered &&
          inCartMembershipBenefits &&
          inCartMembershipBenefits.serviceDiscountPercentage > 0
        ) {
          // If serviceId is present, verify service and category eligibility
          let isEligible = true;
          if (s.serviceId) {
            let serviceDoc = await Service.findOne({
              _id: s.serviceId,
              organizationId,
            }).session(session);
            isEligible = isServiceEligibleForMembershipBenefits(
              serviceDoc || { _id: s.serviceId },
              inCartMembershipBenefits,
            );
          } else {
            isEligible = isServiceEligibleForMembershipBenefits(
              { name: s.name },
              inCartMembershipBenefits,
            );
          }

          if (isEligible) {
            isDiscountedByMembership = true;
            const pct = inCartMembershipBenefits.serviceDiscountPercentage;
            membershipDiscountAmount = Number(
              ((lineTotal * pct) / 100).toFixed(2),
            );
            customerPayable = Math.max(
              0,
              Number((customerPayable - membershipDiscountAmount).toFixed(2)),
            );
          }
        }

        invoiceLines.push({
          lineType: "service",
          serviceType: s.serviceType || "registered",
          serviceId: s.serviceId || null,
          staffId: appointment.staffId || null,
          attribution: {
            performedBy: appointmentPerformerAttribution,
          },
          appointmentServiceId: s._id,
          name: s.name,
          duration: s.duration,
          quantity,
          unitPrice,
          lineTotal,
          isCoveredBySubscription: isCovered,
          appliedSubscriptionId,
          subscriptionUsageId,
          subscriptionCoveredAmount,
          appliedCustomerMembershipId: isDiscountedByMembership
            ? existingActiveMembership?._id || null
            : null,
          membershipBenefitSourceLineId: isDiscountedByMembership
            ? inCartMembershipPurchaseLineId
            : null,
          isDiscountedByMembership,
          membershipDiscountAmount,
          discountAmount: membershipDiscountAmount,
          customerPayable,
        });
      }
    }

    // 6. Process Custom Walk-in Services (if provided)
    for (const svcInput of serviceLines) {
      const service = await Service.findOne({
        _id: svcInput.serviceId,
        organizationId,
        $or: [{ status: "active" }, { isActive: true }],
      }).session(session);

      if (!service) {
        throw new AppError(`Service not found: ${svcInput.serviceId}`, 404);
      }

      const qty = Number(svcInput.quantity || 1);
      const performedBy = await resolveStaffAttribution(
        svcInput.performedByStaffId,
        organizationId,
        branchId,
        session,
      );
      // Strictly resolve authoritative catalog price server-side; do not trust client unitPrice
      const unitPrice = Number(service.pricing?.basePrice ?? 0);
      const lineTotal = Number((qty * unitPrice).toFixed(2));

      let isCovered = false;
      let appliedSubscriptionId = null;
      const sId = service._id.toString();

      // Check explicit subscription passed from client or auto-match from active customer subscriptions
      let candidateSub = null;
      if (
        svcInput.appliedSubscriptionId &&
        existingSubMap.has(svcInput.appliedSubscriptionId.toString())
      ) {
        candidateSub = existingSubMap.get(
          svcInput.appliedSubscriptionId.toString(),
        );
      } else if (targetCustomerId && customerActiveSubs.length > 0) {
        // Auto-match an active subscription with remaining quota
        for (const sub of customerActiveSubs) {
          let member = null;
          let isCustomerEnrolled = false;
          if (Array.isArray(sub.members) && sub.members.length > 0) {
            member = sub.members.find(
              (m) => m.customerId.toString() === targetCustomerId.toString(),
            );
            isCustomerEnrolled =
              Boolean(member) &&
              ["active", "pending_payment"].includes(member.status);
          } else {
            isCustomerEnrolled =
              sub.customerId.toString() === targetCustomerId.toString();
          }

          const isAllowedStatus = ["active", "pending_payment"].includes(
            sub.status,
          );
          const isWithinDates =
            (!sub.startDate || new Date(sub.startDate) <= now) &&
            (!sub.endDate || new Date(sub.endDate) >= now);

          const subBranches = Array.isArray(sub.permittedBranchIds)
            ? sub.permittedBranchIds
            : [];
          const memberBranches =
            member && Array.isArray(member.permittedBranchIds)
              ? member.permittedBranchIds
              : [];
          let isPermittedBranch = true;
          if (subBranches.length > 0) {
            isPermittedBranch = subBranches.some(
              (b) => b.toString() === branchIdStr,
            );
          }
          if (isPermittedBranch && memberBranches.length > 0) {
            isPermittedBranch = memberBranches.some(
              (b) => b.toString() === branchIdStr,
            );
          }

          if (
            isCustomerEnrolled &&
            isAllowedStatus &&
            isWithinDates &&
            isPermittedBranch
          ) {
            const entitlementsList = member
              ? member.entitlements
              : sub.entitlements;
            const entitlement = (entitlementsList || []).find(
              (e) => e.serviceId && e.serviceId.toString() === sId,
            );
            if (entitlement && (entitlement.remainingQuantity || 0) > 0) {
              const allocKey = `${sub._id.toString()}_${sId}`;
              const currentlyAllocated =
                allocatedEntitlementCounts.get(allocKey) || 0;
              if (currentlyAllocated + qty <= entitlement.remainingQuantity) {
                candidateSub = sub;
                break;
              }
            }
          }
        }
      }

      if (candidateSub) {
        let member = null;
        let isCustomerEnrolled = false;
        if (
          Array.isArray(candidateSub.members) &&
          candidateSub.members.length > 0 &&
          targetCustomerId
        ) {
          member = candidateSub.members.find(
            (m) => m.customerId.toString() === targetCustomerId.toString(),
          );
          isCustomerEnrolled =
            Boolean(member) &&
            ["active", "pending_payment"].includes(member.status);
        } else if (targetCustomerId) {
          isCustomerEnrolled =
            candidateSub.customerId.toString() === targetCustomerId.toString();
        }

        const isAllowedStatus = ["active", "pending_payment"].includes(
          candidateSub.status,
        );
        const isWithinDates =
          (!candidateSub.startDate ||
            new Date(candidateSub.startDate) <= now) &&
          (!candidateSub.endDate || new Date(candidateSub.endDate) >= now);

        const subBranches = Array.isArray(candidateSub.permittedBranchIds)
          ? candidateSub.permittedBranchIds
          : [];
        const memberBranches =
          member && Array.isArray(member.permittedBranchIds)
            ? member.permittedBranchIds
            : [];
        let isPermittedBranch = true;
        if (subBranches.length > 0) {
          isPermittedBranch = subBranches.some(
            (b) => b.toString() === branchIdStr,
          );
        }
        if (isPermittedBranch && memberBranches.length > 0) {
          isPermittedBranch = memberBranches.some(
            (b) => b.toString() === branchIdStr,
          );
        }

        if (
          isCustomerEnrolled &&
          isAllowedStatus &&
          isWithinDates &&
          isPermittedBranch
        ) {
          const entitlementsList = member
            ? member.entitlements
            : candidateSub.entitlements;
          const entitlement = (entitlementsList || []).find(
            (e) => e.serviceId && e.serviceId.toString() === sId,
          );
          if (entitlement && (entitlement.remainingQuantity || 0) > 0) {
            const allocKey = `${candidateSub._id.toString()}_${sId}`;
            const currentlyAllocated =
              allocatedEntitlementCounts.get(allocKey) || 0;
            if (currentlyAllocated + qty <= entitlement.remainingQuantity) {
              isCovered = true;
              appliedSubscriptionId = candidateSub._id;
              allocatedEntitlementCounts.set(
                allocKey,
                currentlyAllocated + qty,
              );
            }
          }
        }
      } else if (newSubscriptionEntitlements.has(sId)) {
        const remainingInCartEnt = newSubscriptionEntitlements.get(sId);
        if (remainingInCartEnt >= qty) {
          isCovered = true;
          newSubscriptionEntitlements.set(sId, remainingInCartEnt - qty);
        }
      }

      const subscriptionCoveredAmount = isCovered ? lineTotal : 0;
      let customerPayable = Math.max(
        0,
        Number((lineTotal - subscriptionCoveredAmount).toFixed(2)),
      );

      let isDiscountedByMembership = false;
      let membershipDiscountAmount = 0;
      if (
        !isCovered &&
        inCartMembershipBenefits &&
        inCartMembershipBenefits.serviceDiscountPercentage > 0
      ) {
        const isEligible = isServiceEligibleForMembershipBenefits(
          service,
          inCartMembershipBenefits,
        );
        if (isEligible) {
          isDiscountedByMembership = true;
          const pct = inCartMembershipBenefits.serviceDiscountPercentage;
          membershipDiscountAmount = Number(
            ((lineTotal * pct) / 100).toFixed(2),
          );
          customerPayable = Math.max(
            0,
            Number((customerPayable - membershipDiscountAmount).toFixed(2)),
          );
        }
      }

      invoiceLines.push({
        lineType: "service",
        serviceType: "registered",
        serviceId: service._id,
        staffId: performedBy?.staffId || null,
        attribution: { performedBy },
        appointmentServiceId: null,
        name: service.name,
        duration: service.duration || 30,
        quantity: qty,
        unitPrice,
        lineTotal,
        isCoveredBySubscription: isCovered,
        appliedSubscriptionId,
        subscriptionUsageId: null,
        subscriptionCoveredAmount,
        appliedCustomerMembershipId: isDiscountedByMembership
          ? existingActiveMembership?._id || null
          : null,
        membershipBenefitSourceLineId: isDiscountedByMembership
          ? inCartMembershipPurchaseLineId
          : null,
        isDiscountedByMembership,
        membershipDiscountAmount,
        discountAmount: membershipDiscountAmount,
        customerPayable,
      });
    }

    // 7. Process Retail Products (with server-side selling price & reservation prep)
    for (const prodInput of productLines) {
      const product = await productRepository.findById(
        prodInput.productId,
        organizationId,
        session,
      );
      if (!product) {
        throw new AppError(`Product not found: ${prodInput.productId}`, 404);
      }
      if (product.status !== "active") {
        throw new AppError(
          `Cannot sell inactive product '${product.name}'`,
          400,
        );
      }
      if (!["retail_sale", "both"].includes(product.usageType)) {
        throw new AppError(
          `Product '${product.name}' is not designated for retail sale`,
          400,
        );
      }

      const qty = Number(prodInput.quantity);
      const unitPrice = Number(product.sellingPrice || 0);
      const lineTotal = Number((qty * unitPrice).toFixed(2));
      const soldBy = await resolveStaffAttribution(
        prodInput.soldByStaffId,
        organizationId,
        branchId,
        session,
      );

      let isDiscountedByMembership = false;
      let membershipDiscountAmount = 0;
      let customerPayable = lineTotal;

      if (
        inCartMembershipBenefits &&
        inCartMembershipBenefits.productDiscountPercentage > 0
      ) {
        isDiscountedByMembership = true;
        const pct = inCartMembershipBenefits.productDiscountPercentage;
        membershipDiscountAmount = Number(((lineTotal * pct) / 100).toFixed(2));
        customerPayable = Math.max(
          0,
          Number((customerPayable - membershipDiscountAmount).toFixed(2)),
        );
      }

      invoiceLines.push({
        lineType: "product",
        productId: product._id,
        attribution: { soldBy },
        sku: product.sku,
        stockUnit: product.stockUnit,
        costPriceSnapshot: product.costPrice || 0,
        name: product.name,
        duration: 0,
        quantity: qty,
        unitPrice,
        lineTotal,
        isCoveredBySubscription: false,
        subscriptionCoveredAmount: 0,
        appliedCustomerMembershipId: isDiscountedByMembership
          ? existingActiveMembership?._id || null
          : null,
        membershipBenefitSourceLineId: isDiscountedByMembership
          ? inCartMembershipPurchaseLineId
          : null,
        isDiscountedByMembership,
        membershipDiscountAmount,
        discountAmount: membershipDiscountAmount,
        customerPayable,
      });

      productItemsToReserve.push({
        productId: product._id,
        quantity: qty,
      });
    }

    if (invoiceLines.length === 0) {
      throw new AppError(
        "Invoice must contain at least one valid line item",
        400,
      );
    }

    // 8. Financial Recalculation & Discounts
    const effectiveDiscountInput =
      discountTotal !== undefined && discountTotal !== null
        ? discountTotal
        : data.discount !== undefined && data.discount !== null
          ? data.discount
          : appointmentPricingSnapshot
            ? appointmentPricingSnapshot.discount
            : 0;
    let manualDiscount = Number(Number(effectiveDiscountInput || 0).toFixed(2));
    if (manualDiscount < 0) {
      throw new AppError("Discount cannot be negative", 400);
    }

    // Optional loyalty redemption calculation
    let loyaltyRedeemedPoints = 0;
    let loyaltyDiscountAmount = 0;

    if (redeemLoyaltyPoints && Number(redeemLoyaltyPoints) > 0) {
      // Preliminary calculation to find eligible uncovered amount before loyalty
      let preSubtotal = 0;
      let preSubCovered = 0;
      for (const line of invoiceLines) {
        preSubtotal = Number((preSubtotal + line.lineTotal).toFixed(2));
        preSubCovered = Number(
          (preSubCovered + (line.subscriptionCoveredAmount || 0)).toFixed(2),
        );
      }
      const eligibleAmount = Math.max(
        0,
        Number((preSubtotal - preSubCovered - manualDiscount).toFixed(2)),
      );

      const preview = await loyaltyService.previewRedemption(
        targetCustomerId,
        eligibleAmount,
        redeemLoyaltyPoints,
        organizationId,
        session,
      );

      loyaltyRedeemedPoints = preview.appliedPoints;
      loyaltyDiscountAmount = preview.appliedDiscount;
    }

    // Line totals and customerPayable have already accounted for in-cart membership discounts.
    // If additional manual discount or loyalty is applied, distribute across lines.
    const additionalDiscount = Number(
      (manualDiscount + loyaltyDiscountAmount).toFixed(2),
    );
    let totals;

    if (additionalDiscount > 0) {
      totals = this.calculateInvoiceTotals(invoiceLines, additionalDiscount);
    } else {
      // Calculate totals directly from lines
      let subtotal = 0;
      let totalSubCovered = 0;
      let totalDiscounts = 0;
      let totalPayable = 0;

      for (const line of invoiceLines) {
        subtotal = Number((subtotal + line.lineTotal).toFixed(2));
        totalSubCovered = Number(
          (totalSubCovered + (line.subscriptionCoveredAmount || 0)).toFixed(2),
        );
        totalDiscounts = Number(
          (
            totalDiscounts +
            (line.membershipDiscountAmount || line.discountAmount || 0)
          ).toFixed(2),
        );
        totalPayable = Number((totalPayable + line.customerPayable).toFixed(2));
      }

      totals = {
        subtotal,
        discountTotal: totalDiscounts,
        grossPayable: Number((subtotal - totalDiscounts).toFixed(2)),
        subscriptionCoveredAmount: totalSubCovered,
        payableAmount: totalPayable,
      };
    }

    const amountPaid = 0;
    const amountDue = totals.payableAmount;
    const paymentStatus = this.derivePaymentStatus(amountPaid, amountDue);

    // Determine invoice type tag
    let derivedInvoiceType = "unified";
    if (appointmentId && invoiceLines.every((l) => l.lineType === "service")) {
      derivedInvoiceType = "appointment";
    } else if (invoiceLines.every((l) => l.lineType === "product")) {
      derivedInvoiceType = "retail";
    } else if (invoiceLines.every((l) => l.lineType === "subscription")) {
      derivedInvoiceType = "subscription";
    } else if (invoiceLines.every((l) => l.lineType === "membership")) {
      derivedInvoiceType = "membership";
    } else {
      derivedInvoiceType = "combined";
    }

    let invoiceDoc;
    if (reusedDraftInvoice) {
      invoiceDoc = reusedDraftInvoice;
      invoiceDoc.invoiceType = derivedInvoiceType;
      invoiceDoc.appointmentPricingSnapshot = appointmentPricingSnapshot;
      invoiceDoc.customerSnapshot = customerSnapshot;
      invoiceDoc.lines = invoiceLines;
      invoiceDoc.subtotal = totals.subtotal;
      invoiceDoc.discountTotal = totals.discountTotal;
      invoiceDoc.loyaltyRedeemedPoints = loyaltyRedeemedPoints;
      invoiceDoc.loyaltyDiscountAmount = loyaltyDiscountAmount;
      invoiceDoc.grossPayable = totals.grossPayable;
      invoiceDoc.subscriptionCoveredAmount = totals.subscriptionCoveredAmount;
      invoiceDoc.payableAmount = totals.payableAmount;
      invoiceDoc.amountDue = totals.payableAmount;
      if (notes) invoiceDoc.notes = notes;
    } else {
      const invoiceNumber = await this.generateInvoiceNumber(organizationId);

      invoiceDoc = new Invoice({
        organizationId,
        branchId,
        invoiceNumber,
        appointmentId: appointment?._id || null,
        appointmentCode: appointment?.appointmentCode || null,
        subscriptionId: subscriptionId
          ? typeof subscriptionId === "object"
            ? subscriptionId._id || subscriptionId
            : subscriptionId
          : null,
        invoiceType: derivedInvoiceType,
        appointmentPricingSnapshot,
        customerId: customer._id,
        customerSnapshot,
        lines: invoiceLines,
        subtotal: totals.subtotal,
        discountTotal: totals.discountTotal,
        loyaltyRedeemedPoints,
        loyaltyDiscountAmount,
        grossPayable: totals.grossPayable,
        subscriptionCoveredAmount: totals.subscriptionCoveredAmount,
        payableAmount: totals.payableAmount,
        amountPaid,
        amountDue,
        status: "draft",
        paymentStatus,
        notes,
        createdBy: userId,
      });
    }

    if (
      existingActiveMembership &&
      invoiceLines.some((line) => line.isDiscountedByMembership)
    ) {
      existingActiveMembership.lastBenefitReservationAt = new Date();
      existingActiveMembership.lastBenefitReservationInvoiceId = invoiceDoc._id;
      await existingActiveMembership.save({ session });
    }

    try {
      if (productItemsToReserve.length > 0) {
        // Safely adjust / update stock reservations for this invoice
        await inventoryService.reserveStockForInvoice({
          invoiceId: invoiceDoc._id,
          branchId,
          organizationId,
          items: productItemsToReserve,
          session,
        });
      } else if (reusedDraftInvoice) {
        // If the updated cart removed all product lines, release existing reservation
        await inventoryService.releaseReservationForInvoice({
          invoiceId: invoiceDoc._id,
          organizationId,
          session,
        });
      }

      if (session) {
        await invoiceDoc.save({ session });
      } else {
        await invoiceDoc.save();
      }

      // If this invoice is billed against an existing standalone subscription, link invoiceId to the subscription
      if (subscriptionId) {
        const subIdToLink =
          typeof subscriptionId === "object"
            ? subscriptionId._id || subscriptionId
            : subscriptionId;
        const updateQuery = Subscription.updateOne(
          { _id: subIdToLink, organizationId },
          {
            $set: { invoiceId: invoiceDoc._id },
            $push: {
              invoiceHistory: {
                invoiceId: invoiceDoc._id,
                invoiceNumber: invoiceDoc.invoiceNumber,
                status: invoiceDoc.status || "draft",
                issuedAt: new Date(),
              },
            },
          },
        );
        if (session) {
          await updateQuery.session(session);
        } else {
          await updateQuery;
        }
      }

      // If this invoice contains membership lines with pre-instantiated memberships, link them to invoiceDoc
      let didInstantiateMemberships = false;
      for (const l of invoiceDoc.lines || []) {
        if (l.lineType === "membership" && l.customerMembershipId) {
          if (!invoiceDoc.customerMembershipId) {
            invoiceDoc.customerMembershipId = l.customerMembershipId;
            invoiceDoc.customerMembershipIds = l.customerMembershipIds || [
              l.customerMembershipId,
            ];
            if (l.membershipPurchaseId) {
              invoiceDoc.membershipPurchaseId = l.membershipPurchaseId;
            }
            didInstantiateMemberships = true;
          }

          // Ensure pre-existing CustomerMembership records link back to this invoiceDoc
          const targetIds = [
            l.customerMembershipId,
            ...(Array.isArray(l.customerMembershipIds)
              ? l.customerMembershipIds
              : []),
          ];
          const updateCmQuery = CustomerMembership.updateMany(
            {
              _id: { $in: targetIds },
              organizationId,
              isDeleted: false,
            },
            {
              $set: {
                invoiceId: invoiceDoc._id,
                notes: `Linked to Invoice #${invoiceDoc.invoiceNumber} (Pending Payment)`,
              },
            },
          );
          if (session) {
            await updateCmQuery.session(session);
          } else {
            await updateCmQuery;
          }
        }
      }

      // If this invoice contains membership lines that don't have customerMembershipId yet, instantiate them in pending_payment status!
      const mLinesToInstantiate = (invoiceDoc.lines || []).filter(
        (l) =>
          l.lineType === "membership" &&
          l.membershipPlanId &&
          !l.customerMembershipId,
      );
      for (const mLine of mLinesToInstantiate) {
        let planQuery = MembershipPlan.findOne({
          _id: mLine.membershipPlanId,
          organizationId,
        });
        if (session) planQuery = planQuery.session(session);
        const plan = await planQuery.exec();

        if (plan) {
          const startDate = new Date();
          const endDate = new Date(startDate);
          endDate.setMonth(endDate.getMonth() + (plan.validityMonths || 12));

          const payerId = mLine.payerCustomerId || invoiceDoc.customerId;
          let beneficiaryIds = [payerId];
          if (
            Array.isArray(mLine.beneficiaryCustomerIds) &&
            mLine.beneficiaryCustomerIds.length > 0
          ) {
            beneficiaryIds = mLine.beneficiaryCustomerIds;
          }

          const membershipPurchaseId = new mongoose.Types.ObjectId();
          mLine.membershipPurchaseId = membershipPurchaseId;
          invoiceDoc.membershipPurchaseId = membershipPurchaseId;

          const createdMemberships = [];
          for (let i = 0; i < beneficiaryIds.length; i++) {
            const bId = beneficiaryIds[i];
            const memCode = `MEM-${Date.now().toString().slice(-6)}-${Math.floor(100 + Math.random() * 900)}${i > 0 ? `-${i + 1}` : ""}`;
            const overrideConfig = Array.isArray(mLine.beneficiaryOverrides)
              ? mLine.beneficiaryOverrides.find(
                  (o) =>
                    (o.customerId?._id || o.customerId)?.toString() ===
                    bId.toString(),
                )
              : null;
            const effectiveBenefits = overrideConfig?.benefits || plan.benefits;

            const newMembership = new CustomerMembership({
              organizationId,
              customerId: bId,
              payerCustomerId: payerId,
              membershipPurchaseId,
              membershipPlanId: plan._id,
              attribution: mLine.attribution || {},
              membershipCode: memCode,
              planSnapshot: {
                name: plan.name,
                tier: plan.tier || "Standard",
                price: mLine.unitPrice,
                validityMonths: plan.validityMonths || 12,
                maxBeneficiaries: plan.maxBeneficiaries || 1,
                benefits: effectiveBenefits,
              },
              status: "pending_payment",
              startDate,
              endDate,
              permittedBranchIds: plan.permittedBranchIds || [],
              invoiceId: invoiceDoc._id,
              notes: `Created via Invoice #${invoiceDoc.invoiceNumber} (Pending Payment)`,
            });

            if (session) {
              await newMembership.save({ session });
            } else {
              await newMembership.save();
            }
            createdMemberships.push(newMembership);
          }

          if (createdMemberships.length > 0) {
            const firstMembership = createdMemberships[0];
            mLine.customerMembershipId = firstMembership._id;
            mLine.customerMembershipIds = createdMemberships.map((m) => m._id);
            invoiceDoc.customerMembershipId = firstMembership._id;
            invoiceDoc.customerMembershipIds = createdMemberships.map(
              (m) => m._id,
            );
            invoiceDoc.membershipCode = firstMembership.membershipCode;
            didInstantiateMemberships = true;
          }
        }
      }

      if (didInstantiateMemberships) {
        if (session) {
          await invoiceDoc.save({ session });
        } else {
          await invoiceDoc.save();
        }
      }
    } catch (err) {
      if (err.code === 11000) {
        throw new AppError(
          "An active invoice already exists for this appointment or unique sequence",
          409,
        );
      }
      throw err;
    }

    const auditData = {
      organizationId,
      branchId,
      actorId: userId,
      action: reusedDraftInvoice
        ? AUDIT_ACTIONS.INVOICE_UPDATED
        : AUDIT_ACTIONS.INVOICE_CREATED,
      entityType: "Invoice",
      entityId: invoiceDoc._id,
      description: reusedDraftInvoice
        ? `Draft unified invoice ${invoiceDoc.invoiceNumber} updated for customer ${customer.name}`
        : `Draft unified invoice ${invoiceDoc.invoiceNumber} created for customer ${customer.name}`,
      metadata: {
        invoiceNumber: invoiceDoc.invoiceNumber,
        invoiceType: derivedInvoiceType,
        itemCount: invoiceLines.length,
        payableAmount: totals.payableAmount,
      },
    };

    if (session) {
      const aLog = new AuditLog(auditData);
      await aLog.save({ session });
    } else {
      await AuditLog.create(auditData);
    }

    await emitBillingOutboxEvent({
      eventType: "invoice.created",
      invoice: invoiceDoc,
      operationId: String(invoiceDoc._id),
      amountInPaise: Math.round((invoiceDoc.amountDue || 0) * 100),
      session,
    });

    return invoiceDoc;
  }

  /**
   * 2. UPDATE DRAFT INVOICE (DISCOUNT & NOTES ONLY)
   */
  async updateDraftInvoice(id, updates, organizationId, branchId, userId) {
    const invoice = await Invoice.findOne({
      _id: id,
      organizationId,
      isDeleted: false,
    });

    if (!invoice) {
      throw new AppError("Invoice not found", 404);
    }

    if (invoice.branchId.toString() !== branchId.toString()) {
      throw new AppError("Target branchId does not match invoice branch", 400);
    }

    if (invoice.status !== "draft") {
      throw new AppError(
        `Cannot modify invoice with status '${invoice.status}'. Only draft invoices may be modified.`,
        400,
      );
    }

    if (updates.notes !== undefined) {
      invoice.notes = updates.notes;
    }

    // Support updating product lines on draft invoice
    if (Array.isArray(updates.productLines)) {
      const nonProductLines = invoice.lines.filter(
        (l) => l.lineType !== "product",
      );
      const updatedProductLines = [];
      const productItemsToReserve = [];

      for (const prodInput of updates.productLines) {
        const product = await productRepository.findById(
          prodInput.productId,
          organizationId,
        );
        if (!product) {
          throw new AppError(`Product not found: ${prodInput.productId}`, 404);
        }
        if (product.status !== "active") {
          throw new AppError(
            `Cannot sell inactive product '${product.name}'`,
            400,
          );
        }
        if (!["retail_sale", "both"].includes(product.usageType)) {
          throw new AppError(
            `Product '${product.name}' is not designated for retail sale`,
            400,
          );
        }

        const qty = Number(prodInput.quantity);
        const soldBy = await resolveStaffAttribution(
          prodInput.soldByStaffId,
          organizationId,
          branchId,
        );
        const unitPrice = Number(product.sellingPrice || 0);
        const lineTotal = Number((qty * unitPrice).toFixed(2));

        updatedProductLines.push({
          lineType: "product",
          productId: product._id,
          attribution: { soldBy },
          sku: product.sku,
          stockUnit: product.stockUnit,
          costPriceSnapshot: product.costPrice || 0,
          name: product.name,
          duration: 0,
          quantity: qty,
          unitPrice,
          lineTotal,
          isCoveredBySubscription: false,
          subscriptionCoveredAmount: 0,
          discountAmount: 0,
          customerPayable: lineTotal,
        });

        productItemsToReserve.push({
          productId: product._id,
          quantity: qty,
        });
      }

      invoice.lines = [...nonProductLines, ...updatedProductLines];

      // Update reservation atomically
      await inventoryService.reserveStockForInvoice({
        invoiceId: invoice._id,
        branchId,
        organizationId,
        items: productItemsToReserve,
      });

      // Recalculate totals
      const lines = invoice.lines.map((l) =>
        l.toObject ? l.toObject() : { ...l },
      );
      const totals = this.calculateInvoiceTotals(
        lines,
        invoice.discountTotal || 0,
      );
      invoice.subtotal = totals.subtotal;
      invoice.grossPayable = totals.grossPayable;
      invoice.payableAmount = totals.payableAmount;
      invoice.amountDue = Math.max(
        0,
        Number((invoice.payableAmount - invoice.amountPaid).toFixed(2)),
      );
      invoice.paymentStatus = this.derivePaymentStatus(
        invoice.amountPaid,
        invoice.amountDue,
      );
    }

    if (
      updates.discountTotal !== undefined ||
      updates.redeemLoyaltyPoints !== undefined
    ) {
      let standardDiscount =
        updates.discountTotal !== undefined
          ? Number(Number(updates.discountTotal).toFixed(2))
          : invoice.discountTotal - (invoice.loyaltyDiscountAmount || 0);

      if (standardDiscount < 0) {
        throw new AppError("Discount cannot be negative", 400);
      }

      let pointsToRedeem =
        updates.redeemLoyaltyPoints !== undefined
          ? Number(updates.redeemLoyaltyPoints)
          : invoice.loyaltyRedeemedPoints || 0;

      let loyaltyDiscountAmount = 0;
      let loyaltyRedeemedPoints = 0;

      const lines = invoice.lines.map((l) =>
        l.toObject ? l.toObject() : { ...l },
      );

      if (pointsToRedeem > 0) {
        const preTotals = this.calculateInvoiceTotals(lines, standardDiscount);
        const eligibleAmount = preTotals.payableAmount;

        const preview = await loyaltyService.previewRedemption(
          invoice.customerId,
          eligibleAmount,
          pointsToRedeem,
          organizationId,
        );

        loyaltyRedeemedPoints = preview.appliedPoints;
        loyaltyDiscountAmount = preview.appliedDiscount;
      }

      const totalDiscount = Number(
        (standardDiscount + loyaltyDiscountAmount).toFixed(2),
      );
      const totals = this.calculateInvoiceTotals(lines, totalDiscount);

      invoice.lines = lines;
      invoice.discountTotal = totals.discountTotal;
      invoice.loyaltyRedeemedPoints = loyaltyRedeemedPoints;
      invoice.loyaltyDiscountAmount = loyaltyDiscountAmount;
      invoice.grossPayable = totals.grossPayable;
      invoice.subscriptionCoveredAmount = totals.subscriptionCoveredAmount;
      invoice.payableAmount = totals.payableAmount;
      invoice.amountDue = Math.max(
        0,
        Number((invoice.payableAmount - invoice.amountPaid).toFixed(2)),
      );
      invoice.paymentStatus = this.derivePaymentStatus(
        invoice.amountPaid,
        invoice.amountDue,
      );
    }

    await invoice.save();
    return invoice;
  }

  async correctInvoiceAttribution(
    id,
    { lineId, sourceRole, staffId, reason },
    organizationId,
    branchId,
    userId,
  ) {
    return this.executeTransaction(async (session) => {
      const invoice = await Invoice.findOne({
        _id: id,
        organizationId,
        isDeleted: false,
      }).session(session);

      if (!invoice) {
        throw new AppError("Invoice not found", 404);
      }
      if (invoice.branchId.toString() !== branchId.toString()) {
        throw new AppError(
          "Target branchId does not match invoice branch",
          400,
        );
      }
      if (invoice.status !== "draft") {
        throw new AppError(
          "Attribution can only be corrected before invoice finalization",
          400,
        );
      }

      const line = invoice.lines.id(lineId);
      if (!line) {
        throw new AppError("Invoice line not found", 404);
      }
      if (
        sourceRole === "seller" &&
        !["product", "membership", "subscription"].includes(line.lineType)
      ) {
        throw new AppError(
          "Seller attribution is not valid for this line",
          400,
        );
      }
      if (
        sourceRole === "renewal_handler" &&
        (line.lineType !== "subscription" || !line.subscriptionId)
      ) {
        throw new AppError(
          "Renewal-handler attribution requires a renewal subscription line",
          400,
        );
      }

      const attributionKey =
        sourceRole === "seller" ? "soldBy" : "renewalHandler";
      const resolved = await resolveStaffAttribution(
        staffId,
        organizationId,
        branchId,
        session,
      );
      const previous = line.attribution?.[attributionKey] || null;
      line.attribution = line.attribution || {};
      line.attribution[attributionKey] = resolved;

      let linkedSubscription = null;
      if (line.subscriptionId) {
        linkedSubscription = await Subscription.findOne({
          _id: line.subscriptionId,
          organizationId,
          isDeleted: false,
        }).session(session);
        if (!linkedSubscription) {
          throw new AppError("Linked subscription not found", 404);
        }
        linkedSubscription.attribution = linkedSubscription.attribution || {};
        linkedSubscription.attribution[attributionKey] = resolved;
        await linkedSubscription.save({ session });
      }

      await invoice.save({ session });
      const auditLog = new AuditLog({
        organizationId,
        branchId,
        actorId: userId,
        action: AUDIT_ACTIONS.INVOICE_ATTRIBUTION_CORRECTED,
        entityType: "Invoice",
        entityId: invoice._id,
        description: `Invoice ${invoice.invoiceNumber} source attribution corrected`,
        metadata: {
          lineId: line._id,
          sourceRole,
          previousStaffId: previous?.staffId || null,
          newStaffId: resolved?.staffId || null,
          reason: reason.trim(),
        },
      });
      await auditLog.save({ session });

      await emitBillingOutboxEvent({
        eventType: "invoice.payment_reversed",
        invoice: updatedInvoice,
        operationId: String(payment._id),
        amountInPaise: Math.round((payment.amount || 0) * 100),
        session,
      });
      return invoice;
    });
  }

  /**
   * Helper to capture a financial snapshot for discount history tracking
   */
  captureInvoiceSnapshot(invoice) {
    return {
      subtotal: Number((invoice.subtotal || 0).toFixed(2)),
      subscriptionCoveredAmount: Number(
        (invoice.subscriptionCoveredAmount || 0).toFixed(2),
      ),
      eligibleUncoveredAmount: Number(
        (invoice.eligibleUncoveredAmount || 0).toFixed(2),
      ),
      lineDiscountsTotal: Number((invoice.lineDiscountsTotal || 0).toFixed(2)),
      invoiceDiscountsTotal: Number(
        (invoice.invoiceDiscountsTotal || 0).toFixed(2),
      ),
      loyaltyDiscountAmount: Number(
        (invoice.loyaltyDiscountAmount || 0).toFixed(2),
      ),
      discountTotal: Number((invoice.discountTotal || 0).toFixed(2)),
      grossPayable: Number((invoice.grossPayable || 0).toFixed(2)),
      payableAmount: Number((invoice.payableAmount || 0).toFixed(2)),
      amountPaid: Number((invoice.amountPaid || 0).toFixed(2)),
      amountDue: Number((invoice.amountDue || 0).toFixed(2)),
      paymentStatus: invoice.paymentStatus || "unpaid",
    };
  }

  /**
   * Helper to safely emit global AuditLog events without breaking the primary invoice transaction.
   * If the secondary AuditLog write fails, logs error with metadata rather than silently swallowing.
   */
  async emitDiscountAuditLog(
    action,
    invoice,
    historyEntry,
    organizationId,
    branchId,
    userId,
  ) {
    try {
      const auditLog = new AuditLog({
        organizationId,
        branchId,
        actorId: userId || null,
        action,
        entityType: "Invoice",
        entityId: invoice._id,
        description: `Invoice ${invoice.invoiceNumber} discount ${historyEntry.action}: ${historyEntry.discountType} ${historyEntry.enteredValue} (${historyEntry.reason})`,
        metadata: {
          invoiceNumber: invoice.invoiceNumber,
          discountId: historyEntry.discountId,
          discountLevel: historyEntry.discountLevel,
          lineId: historyEntry.lineId,
          discountType: historyEntry.discountType,
          enteredValue: historyEntry.enteredValue,
          calculatedAmount: historyEntry.calculatedAmount,
          reason: historyEntry.reason,
          payableAmount: invoice.payableAmount,
          amountDue: invoice.amountDue,
        },
      });
      await auditLog.save();
    } catch (auditErr) {
      logger.error(
        `[AUDIT_LOG_DELIVERY_FAILURE] Failed to record global AuditLog for ${action} on invoice ${invoice._id}: ${auditErr.message}`,
        {
          error: auditErr,
          invoiceId: invoice._id,
          historyEntry,
        },
      );
    }
  }

  /**
   * Guards draft invoices by materializing legacy scalar discountTotal exactly once.
   * Guarantees old scalar discount is never counted twice and maintains stable identity.
   */
  materializeLegacyDiscountIfNeeded(invoice) {
    const hasStructured =
      (invoice.appliedDiscounts && invoice.appliedDiscounts.length > 0) ||
      (invoice.lines &&
        invoice.lines.some(
          (l) => l.appliedDiscounts && l.appliedDiscounts.length > 0,
        ));

    if (!hasStructured && Number(invoice.discountTotal || 0) > 0) {
      const legacyAmount = Number(invoice.discountTotal.toFixed(2));
      const legacyId = new mongoose.Types.ObjectId();
      invoice.appliedDiscounts = [
        {
          discountId: legacyId,
          name: "Legacy Discount",
          discountLevel: "invoice",
          discountType: "fixed",
          enteredValue: legacyAmount,
          calculatedAmount: legacyAmount,
          reason: "Legacy unitemized invoice discount",
          appliedBy: invoice.createdBy || null,
          appliedAt: invoice.createdAt || new Date(),
          isLegacy: true,
        },
      ];
      invoice.invoiceDiscountsTotal = legacyAmount;
      invoice.lineDiscountsTotal = 0;
    }
  }

  /**
   * Apply a discount to a draft invoice.
   * Supports:
   * - "line": single line item discount (via lineId)
   * - "selected_lines": multiple line items discount (via lineIds)
   * - "invoice": invoice-level discount (allocated across uncovered lines)
   */
  async applyInvoiceDiscount(id, payload, organizationId, branchId, userId) {
    const {
      discountLevel,
      lineId,
      lineIds,
      name = "Discount",
      discountType,
      enteredValue,
      reason,
    } = payload;
    const val = Number(Number(enteredValue).toFixed(2));

    const invoice = await Invoice.findOne({
      _id: id,
      organizationId,
      isDeleted: false,
    });

    if (!invoice) {
      throw new AppError("Invoice not found", 404);
    }
    if (invoice.branchId.toString() !== branchId.toString()) {
      throw new AppError("Target branchId does not match invoice branch", 400);
    }
    if (invoice.status !== "draft") {
      throw new AppError(
        `Cannot apply discount to an invoice with status '${invoice.status}'. Only draft invoices may be discounted.`,
        400,
      );
    }

    // Materialize legacy scalar discount if present so it is not lost or double-counted
    this.materializeLegacyDiscountIfNeeded(invoice);

    const snapshotBefore = this.captureInvoiceSnapshot(invoice);
    const lines = invoice.lines.map((l) =>
      l.toObject ? l.toObject() : { ...l },
    );
    const invoiceAppliedDiscounts = (invoice.appliedDiscounts || []).map((d) =>
      d.toObject ? d.toObject() : { ...d },
    );
    let targetLineName = null;
    let targetLineId = null;
    let targetLineIds = undefined;
    const newDiscountId = new mongoose.Types.ObjectId();

    if (discountLevel === "line") {
      if (!lineId) {
        throw new AppError("lineId is required for line-level discounts", 400);
      }
      const targetLine = lines.find(
        (l) => l._id.toString() === lineId.toString(),
      );
      if (!targetLine) {
        throw new AppError("Invoice line not found", 404);
      }
      if (targetLine.isCoveredBySubscription) {
        throw new AppError(
          "Subscription-covered services cannot receive discounts",
          400,
        );
      }
      targetLineName = targetLine.name;
      targetLineId = targetLine._id;
      targetLine.appliedDiscounts = targetLine.appliedDiscounts || [];
      targetLine.appliedDiscounts.push({
        discountId: newDiscountId,
        name: name || "Discount",
        discountLevel: "line",
        lineId: targetLine._id,
        discountType,
        enteredValue: val,
        calculatedAmount: 0, // Calculated during recomputation
        reason,
        appliedBy: userId || null,
        appliedAt: new Date(),
        isLegacy: false,
      });
    } else if (discountLevel === "selected_lines") {
      if (!Array.isArray(lineIds) || lineIds.length === 0) {
        throw new AppError(
          "lineIds array is required and must contain at least one lineId for selected_lines discounts",
          400,
        );
      }
      const uniqueLineIds = Array.from(
        new Set(lineIds.map((lid) => lid.toString())),
      );
      if (uniqueLineIds.length !== lineIds.length) {
        throw new AppError(
          "Duplicate line IDs are not allowed in lineIds",
          400,
        );
      }

      const selectedLines = [];
      for (const lid of uniqueLineIds) {
        const found = lines.find((l) => l._id.toString() === lid);
        if (!found) {
          throw new AppError(
            `Invoice line with ID ${lid} not found on this invoice`,
            404,
          );
        }
        if (found.isCoveredBySubscription) {
          throw new AppError(
            `Line '${found.name}' is covered by subscription and cannot receive discounts`,
            400,
          );
        }
        selectedLines.push(found);
      }

      targetLineIds = selectedLines.map((l) => l._id);
      targetLineName = selectedLines.map((l) => l.name).join(", ");

      if (discountType === "percentage") {
        for (const line of selectedLines) {
          line.appliedDiscounts = line.appliedDiscounts || [];
          line.appliedDiscounts.push({
            discountId: newDiscountId,
            name: name || "Discount",
            discountLevel: "selected_lines",
            lineId: line._id,
            lineIds: targetLineIds,
            discountType: "percentage",
            enteredValue: val,
            calculatedAmount: 0,
            reason,
            appliedBy: userId || null,
            appliedAt: new Date(),
            isLegacy: false,
          });
        }
      } else {
        // Fixed amount discount across selected lines
        // 1. Calculate eligible undiscounted base for each selected line (lineTotal - existing line discounts)
        const lineEligibleBases = [];
        let totalEligibleBase = 0;

        for (const line of selectedLines) {
          let remBase = line.lineTotal;
          for (const d of line.appliedDiscounts || []) {
            let c = 0;
            if (d.discountType === "percentage") {
              c = Number(((remBase * d.enteredValue) / 100).toFixed(2));
            } else {
              c = Math.min(remBase, Number(Number(d.enteredValue).toFixed(2)));
            }
            c = Math.max(0, c);
            remBase = Math.max(0, Number((remBase - c).toFixed(2)));
          }
          lineEligibleBases.push({ line, eligibleBase: remBase });
          totalEligibleBase = Number((totalEligibleBase + remBase).toFixed(2));
        }

        // Align with preview behavior: clamp requested fixed amount to total remaining eligible amount
        const effectiveVal = Math.min(val, totalEligibleBase);

        // 2. Allocate proportionally across selected lines with two-decimal rounding & remainder assigned to the last line
        let remainingToDistribute = effectiveVal;
        for (let i = 0; i < lineEligibleBases.length; i++) {
          const item = lineEligibleBases[i];
          const isLast = i === lineEligibleBases.length - 1;
          let alloc = 0;

          if (totalEligibleBase === 0 || effectiveVal === 0) {
            alloc = 0;
          } else if (isLast) {
            alloc = Number(remainingToDistribute.toFixed(2));
            alloc = Math.min(alloc, item.eligibleBase);
            remainingToDistribute = 0;
          } else {
            const prop = Number(
              ((item.eligibleBase / totalEligibleBase) * effectiveVal).toFixed(
                2,
              ),
            );
            alloc = Math.min(remainingToDistribute, prop);
            alloc = Math.min(alloc, item.eligibleBase);
            remainingToDistribute = Number(
              (remainingToDistribute - alloc).toFixed(2),
            );
          }

          item.line.appliedDiscounts = item.line.appliedDiscounts || [];
          item.line.appliedDiscounts.push({
            discountId: newDiscountId,
            name: name || "Discount",
            discountLevel: "selected_lines",
            lineId: item.line._id,
            lineIds: targetLineIds,
            discountType: "fixed",
            enteredValue: alloc, // Allocated fixed amount for this specific line
            calculatedAmount: alloc,
            reason,
            appliedBy: userId || null,
            appliedAt: new Date(),
            isLegacy: false,
          });
        }
      }
    } else {
      // Invoice-level discount
      invoiceAppliedDiscounts.push({
        discountId: newDiscountId,
        name: name || "Discount",
        discountLevel: "invoice",
        lineId: null,
        discountType,
        enteredValue: val,
        calculatedAmount: 0,
        reason,
        appliedBy: userId || null,
        appliedAt: new Date(),
        isLegacy: false,
      });
    }

    // Recompute all financials from scratch
    const financials = this.recalculateInvoiceFinancials(
      lines,
      invoiceAppliedDiscounts,
      invoice.loyaltyDiscountAmount || 0,
      invoice.amountPaid || 0,
    );

    // Partial-payment guard: new payable amount cannot be less than what customer already paid
    if (financials.payableAmount < (invoice.amountPaid || 0)) {
      throw new AppError(
        `Cannot apply discount. Resulting payable amount (₹${financials.payableAmount.toFixed(2)}) cannot be less than amount already paid (₹${(invoice.amountPaid || 0).toFixed(2)}). Please void or refund payments first.`,
        400,
      );
    }

    // Capture snapshot after recomputation
    const snapshotAfter = {
      ...financials,
      amountPaid: invoice.amountPaid || 0,
    };

    // Find the exact calculated amount and allocations for the applied discount
    let calculatedDiscountAmount = 0;
    let allocations = undefined;

    if (discountLevel === "line") {
      const targetLine = lines.find(
        (l) => l._id.toString() === lineId.toString(),
      );
      const d = targetLine.appliedDiscounts.find(
        (x) => x.discountId.toString() === newDiscountId.toString(),
      );
      calculatedDiscountAmount = d ? d.calculatedAmount : 0;
    } else if (discountLevel === "selected_lines") {
      allocations = [];
      for (const line of lines) {
        if (Array.isArray(line.appliedDiscounts)) {
          const d = line.appliedDiscounts.find(
            (x) => x.discountId.toString() === newDiscountId.toString(),
          );
          if (d) {
            calculatedDiscountAmount = Number(
              (calculatedDiscountAmount + d.calculatedAmount).toFixed(2),
            );
            allocations.push({
              lineId: line._id,
              lineName: line.name,
              allocatedAmount: d.calculatedAmount,
            });
          }
        }
      }
    } else {
      const d = invoiceAppliedDiscounts.find(
        (x) => x.discountId.toString() === newDiscountId.toString(),
      );
      calculatedDiscountAmount = d ? d.calculatedAmount : 0;
    }

    const historyEntry = {
      historyId: new mongoose.Types.ObjectId(),
      action: "applied",
      discountId: newDiscountId,
      discountLevel,
      lineId: targetLineId ? new mongoose.Types.ObjectId(targetLineId) : null,
      lineIds: targetLineIds,
      lineName: targetLineName,
      allocations,
      discountType,
      enteredValue: val,
      calculatedAmount: calculatedDiscountAmount,
      reason,
      performedBy: userId || null,
      performedAt: new Date(),
      snapshotBefore,
      snapshotAfter,
      notes: "",
    };

    // Concurrency guard: update conditionally against captured server version (__v or updatedAt)
    const serverVersion = invoice.__v;
    const serverUpdatedAt = invoice.updatedAt;

    const query = {
      _id: id,
      organizationId,
      status: "draft",
    };
    if (serverVersion !== undefined) {
      query.__v = serverVersion;
    } else {
      query.updatedAt = serverUpdatedAt;
    }

    const updateDoc = {
      $inc: { __v: 1 },
      $set: {
        lines,
        appliedDiscounts: invoiceAppliedDiscounts,
        subtotal: financials.subtotal,
        subscriptionCoveredAmount: financials.subscriptionCoveredAmount,
        lineDiscountsTotal: financials.lineDiscountsTotal,
        invoiceDiscountsTotal: financials.invoiceDiscountsTotal,
        discountTotal: financials.discountTotal,
        grossPayable: financials.grossPayable,
        payableAmount: financials.payableAmount,
        amountDue: financials.amountDue,
        paymentStatus: financials.paymentStatus,
      },
      $push: {
        discountHistory: historyEntry,
      },
    };

    const updatedInvoice = await Invoice.findOneAndUpdate(query, updateDoc, {
      new: true,
    });
    if (!updatedInvoice) {
      throw new AppError(
        "Invoice was modified concurrently. Please refresh and retry.",
        409,
      );
    }

    // Secondary global AuditLog emission
    await this.emitDiscountAuditLog(
      AUDIT_ACTIONS.INVOICE_DISCOUNT_APPLIED,
      updatedInvoice,
      historyEntry,
      organizationId,
      branchId,
      userId,
    );

    return {
      invoice: updatedInvoice,
      historyEntry,
    };
  }

  /**
   * Modify an existing discount (line-level, selected-lines, or invoice-level)
   */
  async modifyInvoiceDiscount(
    id,
    discountId,
    payload,
    organizationId,
    branchId,
    userId,
  ) {
    const { enteredValue, reason } = payload;
    const val = Number(Number(enteredValue).toFixed(2));

    const invoice = await Invoice.findOne({
      _id: id,
      organizationId,
      isDeleted: false,
    });

    if (!invoice) {
      throw new AppError("Invoice not found", 404);
    }
    if (invoice.branchId.toString() !== branchId.toString()) {
      throw new AppError("Target branchId does not match invoice branch", 400);
    }
    if (invoice.status !== "draft") {
      throw new AppError(
        `Cannot modify discounts on an invoice with status '${invoice.status}'. Only draft invoices may be modified.`,
        400,
      );
    }

    this.materializeLegacyDiscountIfNeeded(invoice);

    const snapshotBefore = this.captureInvoiceSnapshot(invoice);
    const lines = invoice.lines.map((l) =>
      l.toObject ? l.toObject() : { ...l },
    );
    const invoiceAppliedDiscounts = (invoice.appliedDiscounts || []).map((d) =>
      d.toObject ? d.toObject() : { ...d },
    );

    // Locate discount target (either in lines or at invoice root)
    let foundLevel = null;
    let foundDiscount = null;
    let targetLineName = null;
    let targetLineId = null;
    let targetLineIds = undefined;
    const matchingLineEntries = [];

    // Check lines for matching discountId
    for (const l of lines) {
      if (Array.isArray(l.appliedDiscounts)) {
        const d = l.appliedDiscounts.find(
          (x) => x.discountId.toString() === discountId.toString(),
        );
        if (d) {
          matchingLineEntries.push({ line: l, discount: d });
        }
      }
    }

    if (matchingLineEntries.length > 0) {
      foundDiscount = matchingLineEntries[0].discount;
      foundLevel =
        foundDiscount.discountLevel ||
        (matchingLineEntries.length > 1 ? "selected_lines" : "line");
      if (foundLevel === "line") {
        targetLineId = matchingLineEntries[0].line._id;
        targetLineName = matchingLineEntries[0].line.name;
      } else {
        targetLineIds = matchingLineEntries.map((m) => m.line._id);
        targetLineName = matchingLineEntries.map((m) => m.line.name).join(", ");
      }
    }

    // Check invoice-level
    if (!foundDiscount) {
      const d = invoiceAppliedDiscounts.find(
        (x) => x.discountId.toString() === discountId.toString(),
      );
      if (d) {
        foundLevel = "invoice";
        foundDiscount = d;
      }
    }

    if (!foundDiscount) {
      throw new AppError("Discount record not found on this invoice", 404);
    }

    if (foundDiscount.discountType === "percentage" && val > 100) {
      throw new AppError("Percentage discount cannot exceed 100%", 400);
    }

    // Apply updated value based on level
    if (foundLevel === "line") {
      foundDiscount.enteredValue = val;
      foundDiscount.reason = reason;
      foundDiscount.appliedBy = userId || null;
      foundDiscount.appliedAt = new Date();
    } else if (foundLevel === "selected_lines") {
      if (foundDiscount.discountType === "percentage") {
        for (const item of matchingLineEntries) {
          item.discount.enteredValue = val;
          item.discount.reason = reason;
          item.discount.appliedBy = userId || null;
          item.discount.appliedAt = new Date();
        }
      } else {
        // Fixed discount modification across multiple selected lines
        // 1. Calculate eligible base for each selected line PRIOR to this discount
        const lineEligibleBases = [];
        let totalEligibleBase = 0;

        for (const item of matchingLineEntries) {
          const l = item.line;
          let remBase = l.lineTotal;
          for (const d of l.appliedDiscounts || []) {
            if (d.discountId.toString() === discountId.toString()) {
              continue; // Exclude current discount being modified
            }
            let c = 0;
            if (d.discountType === "percentage") {
              c = Number(((remBase * d.enteredValue) / 100).toFixed(2));
            } else {
              c = Math.min(remBase, Number(Number(d.enteredValue).toFixed(2)));
            }
            c = Math.max(0, c);
            remBase = Math.max(0, Number((remBase - c).toFixed(2)));
          }
          lineEligibleBases.push({ item, eligibleBase: remBase });
          totalEligibleBase = Number((totalEligibleBase + remBase).toFixed(2));
        }

        // Align with preview behavior: clamp requested fixed amount to total remaining eligible amount
        const effectiveVal = Math.min(val, totalEligibleBase);

        // 2. Re-allocate proportionally
        let remainingToDistribute = effectiveVal;
        for (let i = 0; i < lineEligibleBases.length; i++) {
          const baseItem = lineEligibleBases[i];
          const isLast = i === lineEligibleBases.length - 1;
          let alloc = 0;

          if (totalEligibleBase === 0 || effectiveVal === 0) {
            alloc = 0;
          } else if (isLast) {
            alloc = Number(remainingToDistribute.toFixed(2));
            alloc = Math.min(alloc, baseItem.eligibleBase);
            remainingToDistribute = 0;
          } else {
            const prop = Number(
              (
                (baseItem.eligibleBase / totalEligibleBase) *
                effectiveVal
              ).toFixed(2),
            );
            alloc = Math.min(remainingToDistribute, prop);
            alloc = Math.min(alloc, baseItem.eligibleBase);
            remainingToDistribute = Number(
              (remainingToDistribute - alloc).toFixed(2),
            );
          }

          baseItem.item.discount.enteredValue = alloc;
          baseItem.item.discount.reason = reason;
          baseItem.item.discount.appliedBy = userId || null;
          baseItem.item.discount.appliedAt = new Date();
        }
      }
    } else {
      // Invoice-level discount
      foundDiscount.enteredValue = val;
      foundDiscount.reason = reason;
      foundDiscount.appliedBy = userId || null;
      foundDiscount.appliedAt = new Date();
    }

    // Recompute all financials from scratch
    const financials = this.recalculateInvoiceFinancials(
      lines,
      invoiceAppliedDiscounts,
      invoice.loyaltyDiscountAmount || 0,
      invoice.amountPaid || 0,
    );

    if (financials.payableAmount < (invoice.amountPaid || 0)) {
      throw new AppError(
        `Cannot modify discount. Resulting payable amount (₹${financials.payableAmount.toFixed(2)}) cannot be less than amount already paid (₹${(invoice.amountPaid || 0).toFixed(2)}). Please void or refund payments first.`,
        400,
      );
    }

    const snapshotAfter = {
      ...financials,
      amountPaid: invoice.amountPaid || 0,
    };

    let calculatedDiscountAmount = 0;
    let allocations = undefined;

    if (foundLevel === "line") {
      calculatedDiscountAmount = foundDiscount.calculatedAmount;
    } else if (foundLevel === "selected_lines") {
      allocations = [];
      for (const item of matchingLineEntries) {
        calculatedDiscountAmount = Number(
          (calculatedDiscountAmount + item.discount.calculatedAmount).toFixed(
            2,
          ),
        );
        allocations.push({
          lineId: item.line._id,
          lineName: item.line.name,
          allocatedAmount: item.discount.calculatedAmount,
        });
      }
    } else {
      calculatedDiscountAmount = foundDiscount.calculatedAmount;
    }

    const historyEntry = {
      historyId: new mongoose.Types.ObjectId(),
      action: "modified",
      discountId: new mongoose.Types.ObjectId(discountId),
      discountLevel: foundLevel,
      lineId: targetLineId ? new mongoose.Types.ObjectId(targetLineId) : null,
      lineIds: targetLineIds,
      lineName: targetLineName,
      allocations,
      discountType: foundDiscount.discountType,
      enteredValue: val,
      calculatedAmount: calculatedDiscountAmount,
      reason,
      performedBy: userId || null,
      performedAt: new Date(),
      snapshotBefore,
      snapshotAfter,
      notes: "",
    };

    const serverVersion = invoice.__v;
    const serverUpdatedAt = invoice.updatedAt;

    const query = {
      _id: id,
      organizationId,
      status: "draft",
    };
    if (serverVersion !== undefined) {
      query.__v = serverVersion;
    } else {
      query.updatedAt = serverUpdatedAt;
    }

    const updateDoc = {
      $inc: { __v: 1 },
      $set: {
        lines,
        appliedDiscounts: invoiceAppliedDiscounts,
        subtotal: financials.subtotal,
        subscriptionCoveredAmount: financials.subscriptionCoveredAmount,
        lineDiscountsTotal: financials.lineDiscountsTotal,
        invoiceDiscountsTotal: financials.invoiceDiscountsTotal,
        discountTotal: financials.discountTotal,
        grossPayable: financials.grossPayable,
        payableAmount: financials.payableAmount,
        amountDue: financials.amountDue,
        paymentStatus: financials.paymentStatus,
      },
      $push: {
        discountHistory: historyEntry,
      },
    };

    const updatedInvoice = await Invoice.findOneAndUpdate(query, updateDoc, {
      new: true,
    });
    if (!updatedInvoice) {
      throw new AppError(
        "Invoice was modified concurrently. Please refresh and retry.",
        409,
      );
    }

    await this.emitDiscountAuditLog(
      AUDIT_ACTIONS.INVOICE_DISCOUNT_MODIFIED,
      updatedInvoice,
      historyEntry,
      organizationId,
      branchId,
      userId,
    );

    return {
      invoice: updatedInvoice,
      historyEntry,
    };
  }

  /**
   * Remove an existing discount (line-level, selected-lines, or invoice-level)
   */
  async removeInvoiceDiscount(
    id,
    discountId,
    payload,
    organizationId,
    branchId,
    userId,
  ) {
    const { reason } = payload;

    const invoice = await Invoice.findOne({
      _id: id,
      organizationId,
      isDeleted: false,
    });

    if (!invoice) {
      throw new AppError("Invoice not found", 404);
    }
    if (invoice.branchId.toString() !== branchId.toString()) {
      throw new AppError("Target branchId does not match invoice branch", 400);
    }
    if (invoice.status !== "draft") {
      throw new AppError(
        `Cannot remove discounts from an invoice with status '${invoice.status}'. Only draft invoices may be modified.`,
        400,
      );
    }

    this.materializeLegacyDiscountIfNeeded(invoice);

    const snapshotBefore = this.captureInvoiceSnapshot(invoice);
    const lines = invoice.lines.map((l) =>
      l.toObject ? l.toObject() : { ...l },
    );
    let invoiceAppliedDiscounts = (invoice.appliedDiscounts || []).map((d) =>
      d.toObject ? d.toObject() : { ...d },
    );

    let foundLevel = null;
    let foundDiscount = null;
    let targetLineName = null;
    let targetLineId = null;
    let targetLineIds = undefined;
    const removedLineEntries = [];

    // Check lines for matching discountId
    for (const l of lines) {
      if (Array.isArray(l.appliedDiscounts)) {
        const idx = l.appliedDiscounts.findIndex(
          (x) => x.discountId.toString() === discountId.toString(),
        );
        if (idx !== -1) {
          const d = l.appliedDiscounts[idx];
          removedLineEntries.push({ line: l, discount: d });
          l.appliedDiscounts.splice(idx, 1);
        }
      }
    }

    if (removedLineEntries.length > 0) {
      foundDiscount = removedLineEntries[0].discount;
      foundLevel =
        foundDiscount.discountLevel ||
        (removedLineEntries.length > 1 ? "selected_lines" : "line");
      if (foundLevel === "line") {
        targetLineId = removedLineEntries[0].line._id;
        targetLineName = removedLineEntries[0].line.name;
      } else {
        targetLineIds = removedLineEntries.map((m) => m.line._id);
        targetLineName = removedLineEntries.map((m) => m.line.name).join(", ");
      }
    }

    // Check invoice-level
    if (!foundDiscount) {
      const idx = invoiceAppliedDiscounts.findIndex(
        (x) => x.discountId.toString() === discountId.toString(),
      );
      if (idx !== -1) {
        foundLevel = "invoice";
        foundDiscount = invoiceAppliedDiscounts[idx];
        invoiceAppliedDiscounts.splice(idx, 1);
      }
    }

    if (!foundDiscount) {
      throw new AppError("Discount record not found on this invoice", 404);
    }

    // Recompute all financials from scratch
    const financials = this.recalculateInvoiceFinancials(
      lines,
      invoiceAppliedDiscounts,
      invoice.loyaltyDiscountAmount || 0,
      invoice.amountPaid || 0,
    );

    // Note: removing a discount increases payableAmount, so it will always be >= amountPaid
    const snapshotAfter = {
      ...financials,
      amountPaid: invoice.amountPaid || 0,
    };

    let calculatedDiscountAmount = 0;
    let allocations = undefined;

    if (foundLevel === "line") {
      calculatedDiscountAmount = foundDiscount.calculatedAmount;
    } else if (foundLevel === "selected_lines") {
      allocations = [];
      for (const item of removedLineEntries) {
        calculatedDiscountAmount = Number(
          (calculatedDiscountAmount + item.discount.calculatedAmount).toFixed(
            2,
          ),
        );
        allocations.push({
          lineId: item.line._id,
          lineName: item.line.name,
          allocatedAmount: item.discount.calculatedAmount,
        });
      }
    } else {
      calculatedDiscountAmount = foundDiscount.calculatedAmount;
    }

    const historyEntry = {
      historyId: new mongoose.Types.ObjectId(),
      action: "removed",
      discountId: new mongoose.Types.ObjectId(discountId),
      discountLevel: foundLevel,
      lineId: targetLineId ? new mongoose.Types.ObjectId(targetLineId) : null,
      lineIds: targetLineIds,
      lineName: targetLineName,
      allocations,
      discountType: foundDiscount.discountType,
      enteredValue: foundDiscount.enteredValue,
      calculatedAmount: calculatedDiscountAmount,
      reason,
      performedBy: userId || null,
      performedAt: new Date(),
      snapshotBefore,
      snapshotAfter,
      notes: foundDiscount.isLegacy ? "Removed legacy discount" : "",
    };

    const serverVersion = invoice.__v;
    const serverUpdatedAt = invoice.updatedAt;

    const query = {
      _id: id,
      organizationId,
      status: "draft",
    };
    if (serverVersion !== undefined) {
      query.__v = serverVersion;
    } else {
      query.updatedAt = serverUpdatedAt;
    }

    const updateDoc = {
      $inc: { __v: 1 },
      $set: {
        lines,
        appliedDiscounts: invoiceAppliedDiscounts,
        subtotal: financials.subtotal,
        subscriptionCoveredAmount: financials.subscriptionCoveredAmount,
        lineDiscountsTotal: financials.lineDiscountsTotal,
        invoiceDiscountsTotal: financials.invoiceDiscountsTotal,
        discountTotal: financials.discountTotal,
        grossPayable: financials.grossPayable,
        payableAmount: financials.payableAmount,
        amountDue: financials.amountDue,
        paymentStatus: financials.paymentStatus,
      },
      $push: {
        discountHistory: historyEntry,
      },
    };

    const updatedInvoice = await Invoice.findOneAndUpdate(query, updateDoc, {
      new: true,
    });
    if (!updatedInvoice) {
      throw new AppError(
        "Invoice was modified concurrently. Please refresh and retry.",
        409,
      );
    }

    await this.emitDiscountAuditLog(
      AUDIT_ACTIONS.INVOICE_DISCOUNT_REMOVED,
      updatedInvoice,
      historyEntry,
      organizationId,
      branchId,
      userId,
    );

    return {
      invoice: updatedInvoice,
      historyEntry,
    };
  }

  /**
   * Retrieve embedded discount audit history for an invoice
   */
  async getInvoiceDiscountHistory(id, organizationId, branchId = null) {
    const query = { _id: id, organizationId, isDeleted: false };
    if (branchId) {
      query.branchId = branchId;
    }

    const invoice = await Invoice.findOne(query).populate(
      "discountHistory.performedBy",
      "name email",
    );

    if (!invoice) {
      throw new AppError("Invoice not found", 404);
    }

    // If invoice has legacy discount but empty discountHistory, synthesize stable read-only representation without mutating DB
    let history = invoice.discountHistory || [];
    if (history.length === 0 && Number(invoice.discountTotal || 0) > 0) {
      const stableLegacyId = invoice._id; // Stable derived ID
      history = [
        {
          historyId: stableLegacyId,
          action: "applied",
          discountId: stableLegacyId,
          discountLevel: "invoice",
          lineId: null,
          lineName: null,
          discountType: "fixed",
          enteredValue: invoice.discountTotal,
          calculatedAmount: invoice.discountTotal,
          reason: "Legacy unitemized invoice discount",
          performedBy: invoice.createdBy || null,
          performedAt: invoice.createdAt,
          snapshotBefore: {
            subtotal: invoice.subtotal,
            subscriptionCoveredAmount: invoice.subscriptionCoveredAmount || 0,
            eligibleUncoveredAmount: Number(
              (
                invoice.subtotal - (invoice.subscriptionCoveredAmount || 0)
              ).toFixed(2),
            ),
            lineDiscountsTotal: 0,
            invoiceDiscountsTotal: invoice.discountTotal,
            loyaltyDiscountAmount: invoice.loyaltyDiscountAmount || 0,
            discountTotal: invoice.discountTotal,
            grossPayable: invoice.grossPayable,
            payableAmount: invoice.payableAmount,
            amountPaid: invoice.amountPaid || 0,
            amountDue: invoice.amountDue || 0,
            paymentStatus: invoice.paymentStatus || "unpaid",
          },
          snapshotAfter: {
            subtotal: invoice.subtotal,
            subscriptionCoveredAmount: invoice.subscriptionCoveredAmount || 0,
            eligibleUncoveredAmount: Number(
              (
                invoice.subtotal - (invoice.subscriptionCoveredAmount || 0)
              ).toFixed(2),
            ),
            lineDiscountsTotal: 0,
            invoiceDiscountsTotal: invoice.discountTotal,
            loyaltyDiscountAmount: invoice.loyaltyDiscountAmount || 0,
            discountTotal: invoice.discountTotal,
            grossPayable: invoice.grossPayable,
            payableAmount: invoice.payableAmount,
            amountPaid: invoice.amountPaid || 0,
            amountDue: invoice.amountDue || 0,
            paymentStatus: invoice.paymentStatus || "unpaid",
          },
          notes: "Legacy representation generated on read without mutation",
        },
      ];
    }

    return history;
  }

  /**
   * 3. FINALIZE INVOICE (FREEZE FINANCIAL TOTALS)
   */
  /**
   * COUPON INTEGRATION: Apply a coupon to a draft invoice
   */
  async applyCouponToInvoice(id, couponCode, organizationId, branchId, userId) {
    if (!couponCode || typeof couponCode !== "string") {
      throw new AppError("Coupon code is required", 400);
    }
    const normalizedCode = couponCode.trim().toUpperCase();

    const invoice = await Invoice.findOne({
      _id: id,
      organizationId,
      isDeleted: false,
    });

    if (!invoice) {
      throw new AppError("Invoice not found", 404);
    }
    if (invoice.branchId.toString() !== branchId.toString()) {
      throw new AppError("Target branchId does not match invoice branch", 400);
    }
    if (invoice.status !== "draft") {
      throw new AppError(
        "Cannot apply coupon to an invoice with status '" +
          invoice.status +
          "'. Only draft invoices may receive coupons.",
        400,
      );
    }

    // Anti-stacking: Reject if a coupon is already applied
    if (invoice.coupon && invoice.coupon.couponId) {
      throw new AppError(
        "Invoice already has coupon '" +
          invoice.coupon.code +
          "' applied. Remove it before applying another coupon.",
        400,
      );
    }

    // Anti-stacking: Reject if any promotional/manual discounts already exist on the invoice
    const hasInvoiceManualDiscounts =
      Array.isArray(invoice.appliedDiscounts) &&
      invoice.appliedDiscounts.length > 0;
    const hasLineManualDiscounts =
      Array.isArray(invoice.lines) &&
      invoice.lines.some(
        (l) =>
          Array.isArray(l.appliedDiscounts) && l.appliedDiscounts.length > 0,
      );

    if (hasInvoiceManualDiscounts || hasLineManualDiscounts) {
      throw new AppError(
        "Cannot apply coupon to an invoice with existing promotional or manual discounts. Stacking is not permitted.",
        400,
      );
    }

    // Lookup coupon within the authenticated organization
    const coupon = await Coupon.findOne({
      organizationId,
      codeUpper: normalizedCode,
      isDeleted: false,
    });

    if (!coupon) {
      throw new AppError(
        "Coupon '" + couponCode.trim() + "' was not found.",
        404,
      );
    }

    if (coupon.status !== "active") {
      throw new AppError(
        "Coupon '" + coupon.code + "' is currently inactive.",
        400,
      );
    }

    const now = new Date();
    if (now < coupon.validFrom) {
      throw new AppError(
        "Coupon '" +
          coupon.code +
          "' is not valid yet (valid from " +
          coupon.validFrom.toISOString() +
          ").",
        400,
      );
    }
    if (now > coupon.validUntil) {
      throw new AppError("Coupon '" + coupon.code + "' has expired.", 400);
    }

    // Branch exclusion check
    const excludedBranchIds = (coupon.excludedBranchIds || []).map((b) =>
      b.toString(),
    );
    if (excludedBranchIds.includes(branchId.toString())) {
      throw new AppError(
        "Coupon '" +
          coupon.code +
          "' is not valid for redemption at this branch location.",
        400,
      );
    }

    // Total usage limit check (using activeUsageCount for active capacity)
    if (
      coupon.totalUsageLimit !== null &&
      coupon.totalUsageLimit !== undefined
    ) {
      if ((coupon.activeUsageCount || 0) >= coupon.totalUsageLimit) {
        throw new AppError(
          "Coupon '" +
            coupon.code +
            "' has reached its total usage limit (" +
            coupon.totalUsageLimit +
            ").",
          409,
        );
      }
    }

    // Per-customer limit check
    if (
      coupon.perCustomerLimit !== null &&
      coupon.perCustomerLimit !== undefined
    ) {
      if (!invoice.customerId) {
        throw new AppError(
          "A customer record is required to apply coupon '" +
            coupon.code +
            "' with a per-customer usage limit.",
          400,
        );
      }
      const custCounter = await CouponCustomerUsage.findOne({
        organizationId,
        couponId: coupon._id,
        customerId: invoice.customerId,
      });
      if (
        custCounter &&
        custCounter.activeUsageCount >= coupon.perCustomerLimit
      ) {
        throw new AppError(
          "Customer has reached the maximum allowed usage (" +
            coupon.perCustomerLimit +
            ") for coupon '" +
            coupon.code +
            "'.",
          409,
        );
      }
    }

    // Synthesize structured coupon item for invoice calculation using recalculateInvoiceFinancials
    const couponDiscountItem = {
      discountId: new mongoose.Types.ObjectId(),
      name: "Coupon (" + coupon.code + ")",
      discountType: coupon.discountType, // 'percentage' or 'fixed'
      enteredValue: coupon.discountValue,
      applicationType: "invoice",
      isCustom: false,
      reason: "Promotional coupon: " + coupon.code,
      code: coupon.code,
    };

    // Calculate invoice financials with the coupon applied via authoritative calculation engine
    const financials = this.recalculateInvoiceFinancials(
      invoice.lines,
      [couponDiscountItem],
      invoice.loyaltyDiscountAmount || 0,
      invoice.amountPaid || 0,
    );

    const discountAmount = financials.invoiceDiscountsTotal || 0;

    // Snapshot coupon on invoice
    invoice.coupon = {
      couponId: coupon._id,
      code: coupon.code,
      codeUpper: coupon.codeUpper,
      discountType: coupon.discountType,
      discountValue: coupon.discountValue,
      calculatedDiscountAmount: discountAmount,
      appliedAt: now,
      appliedBy: userId,
      usageLedgerId: null,
    };
    invoice.grossPayable = financials.grossPayable;

    // Update financial fields
    invoice.subtotal = financials.subtotal;
    invoice.subscriptionCoveredAmount = financials.subscriptionCoveredAmount;
    invoice.eligibleUncoveredAmount = financials.eligibleUncoveredAmount;
    invoice.lineDiscountTotal = financials.lineDiscountsTotal;
    invoice.invoiceDiscountTotal = financials.invoiceDiscountsTotal;
    invoice.discountTotal = financials.discountTotal;
    invoice.payableAmount = financials.payableAmount;
    invoice.amountDue = financials.amountDue;
    invoice.paymentStatus = financials.paymentStatus;
    invoice.grossPayable = financials.grossPayable;

    // Concurrency guard: Atomically persist only if invoice remains draft and has no coupon applied
    const updated = await Invoice.findOneAndUpdate(
      {
        _id: invoice._id,
        status: "draft",
        $or: [{ coupon: null }, { "coupon.couponId": null }],
      },
      {
        $set: {
          coupon: invoice.coupon,
          grossPayable: invoice.grossPayable,
          subtotal: invoice.subtotal,
          subscriptionCoveredAmount: invoice.subscriptionCoveredAmount,
          eligibleUncoveredAmount: invoice.eligibleUncoveredAmount,
          lineDiscountTotal: invoice.lineDiscountTotal,
          invoiceDiscountTotal: invoice.invoiceDiscountTotal,
          discountTotal: invoice.discountTotal,
          payableAmount: invoice.payableAmount,
          amountDue: invoice.amountDue,
          paymentStatus: invoice.paymentStatus,
        },
      },
      { returnDocument: "after" },
    );

    if (!updated) {
      throw new AppError(
        "Failed to apply coupon due to a concurrent modification. Invoice may already have a coupon applied or is no longer draft.",
        409,
      );
    }

    await this.auditLogService
      .createAuditLog(
        {
          action: AUDIT_ACTIONS.COUPON_REDEEMED,
          entityType: "Invoice",
          entityId: updated._id,
          branchId: updated.branchId || branchId,
          description: `Coupon '${coupon.code}' applied to invoice ${updated.invoiceNumber || updated._id}`,
          metadata: {
            couponId: coupon._id,
            couponCode: coupon.code,
            discountAmount,
          },
        },
        organizationId,
        userId,
      )
      .catch(() => {});

    return updated;
  }

  /**
   * COUPON INTEGRATION: Remove an applied coupon from a draft invoice
   */
  async removeCouponFromInvoice(id, organizationId, branchId, userId) {
    const invoice = await Invoice.findOne({
      _id: id,
      organizationId,
      isDeleted: false,
    });

    if (!invoice) {
      throw new AppError("Invoice not found", 404);
    }
    if (invoice.branchId.toString() !== branchId.toString()) {
      throw new AppError("Target branchId does not match invoice branch", 400);
    }
    if (invoice.status !== "draft") {
      throw new AppError(
        "Cannot remove coupon from an invoice with status '" +
          invoice.status +
          "'. Only draft invoices may be modified.",
        400,
      );
    }
    if (!invoice.coupon || !invoice.coupon.couponId) {
      throw new AppError("Invoice does not have a coupon applied.", 400);
    }

    const removedCouponCode = invoice.coupon.code;
    // Remove coupon snapshot
    invoice.coupon = null;

    // Recalculate invoice without the coupon
    const financials = this.recalculateInvoiceFinancials(
      invoice.lines,
      [],
      invoice.loyaltyDiscountAmount || 0,
      invoice.amountPaid || 0,
    );

    invoice.subtotal = financials.subtotal;
    invoice.subscriptionCoveredAmount = financials.subscriptionCoveredAmount;
    invoice.eligibleUncoveredAmount = financials.eligibleUncoveredAmount;
    invoice.lineDiscountTotal = financials.lineDiscountsTotal;
    invoice.invoiceDiscountTotal = financials.invoiceDiscountsTotal;
    invoice.discountTotal = financials.discountTotal;
    invoice.payableAmount = financials.payableAmount;
    invoice.amountDue = financials.amountDue;
    invoice.paymentStatus = financials.paymentStatus;

    await invoice.save();

    await this.auditLogService
      .createAuditLog(
        {
          action: AUDIT_ACTIONS.COUPON_REMOVED,
          entityType: "Invoice",
          entityId: invoice._id,
          branchId: invoice.branchId || branchId,
          description: `Coupon '${removedCouponCode}' removed from invoice ${invoice.invoiceNumber || invoice._id}`,
          metadata: { couponCode: removedCouponCode },
        },
        organizationId,
        userId,
      )
      .catch(() => {});

    return invoice;
  }

  async finalizeInvoice(id, payload, organizationId, branchId, userId) {
    return await this.executeTransaction(async (session) => {
      const invoice = await Invoice.findOne({
        _id: id,
        organizationId,
        isDeleted: false,
      }).session(session);

      if (!invoice) {
        throw new AppError("Invoice not found", 404);
      }

      if (invoice.branchId.toString() !== branchId.toString()) {
        throw new AppError(
          "Target branchId does not match invoice branch",
          400,
        );
      }

      if (invoice.status !== "draft") {
        throw new AppError(
          `Cannot finalize invoice with status '${invoice.status}'. Must be 'draft'.`,
          400,
        );
      }

      if (payload?.notes) {
        invoice.notes = payload.notes;
      }

      // If loyalty points were redeemed on this invoice, commit them atomically
      if (invoice.loyaltyRedeemedPoints && invoice.loyaltyRedeemedPoints > 0) {
        const redemptionTx = await loyaltyService.commitRedemption({
          organizationId,
          customerId: invoice.customerId,
          branchId,
          invoiceId: invoice._id,
          points: invoice.loyaltyRedeemedPoints,
          discountAmount: invoice.loyaltyDiscountAmount,
          actorId: userId,
          session,
        });

        if (redemptionTx) {
          invoice.loyaltyTransactionId = redemptionTx._id;
        }
      }

      invoice.status = "finalized";
      invoice.finalizedAt = new Date();
      invoice.finalizedBy = userId;
      invoice.paymentStatus = this.derivePaymentStatus(
        invoice.amountPaid,
        invoice.amountDue,
      );

      // Server-authoritative Marketing Campaign Attribution Snapshot
      // Resolves hierarchy: Verified Direct Promo > Valid Appointment Booking Source > Valid Manual POS Selection > Unassigned
      const attributionSnapshot =
        await CampaignAttributionService.resolveAttributionSnapshot({
          organizationId,
          branchId,
          promoCode: invoice.appliedCouponCode || payload?.promoCode,
          appointmentSource: invoice.appointmentCode || null,
          appointmentCreatedAt: invoice.createdAt,
          manualCampaignId: payload?.campaignId || null,
          finalizedAt: invoice.finalizedAt,
          session,
        });
      invoice.campaignAttribution = attributionSnapshot;

      // Capture historical Organization & Branch identity snapshots (never overwrite if already set)
      if (!invoice.organizationSnapshot || !invoice.branchSnapshot) {
        const branding = await this.resolveInvoiceBranding(
          organizationId,
          branchId,
          session,
        );
        if (!invoice.organizationSnapshot) {
          invoice.organizationSnapshot = branding.organization;
        }
        if (!invoice.branchSnapshot) {
          invoice.branchSnapshot = branding.branch;
        }
      }

      // If an invoice is fully covered by subscription / zero-due upon finalization, settle subscriptions atomically
      if (invoice.paymentStatus === "paid") {
        const existingCoveredLines = invoice.lines.filter(
          (l) =>
            l.lineType === "service" &&
            l.isCoveredBySubscription &&
            l.appliedSubscriptionId &&
            !l.subscriptionUsageId,
        );

        for (const ecLine of existingCoveredLines) {
          const targetSub = await Subscription.findOne({
            _id: ecLine.appliedSubscriptionId,
            organizationId,
            isDeleted: false,
          }).session(session);

          if (!targetSub) {
            throw new AppError(
              `Subscription ${ecLine.appliedSubscriptionId} referenced on service line '${ecLine.name}' was not found.`,
              404,
            );
          }

          const qtyToDeduct = ecLine.quantity || 1;
          let member = null;
          if (
            Array.isArray(targetSub.members) &&
            targetSub.members.length > 0 &&
            invoice.customerId
          ) {
            member = targetSub.members.find(
              (m) => m.customerId.toString() === invoice.customerId.toString(),
            );
          }

          const entList = member ? member.entitlements : targetSub.entitlements;
          const targetEnt = (entList || []).find(
            (e) =>
              e.serviceId &&
              e.serviceId.toString() === ecLine.serviceId.toString(),
          );

          if (!targetEnt || (targetEnt.remainingQuantity || 0) < qtyToDeduct) {
            throw new AppError(
              `Insufficient subscription entitlement balance for '${ecLine.name}'. Required: ${qtyToDeduct}, Available: ${targetEnt?.remainingQuantity ?? 0}. Entitlement may have been consumed by a concurrent transaction.`,
              409,
            );
          }

          if (member) {
            targetEnt.usedQuantity =
              (targetEnt.usedQuantity || 0) + qtyToDeduct;
            targetEnt.remainingQuantity = Math.max(
              0,
              targetEnt.remainingQuantity - qtyToDeduct,
            );
            if (member.entitlements.every((e) => e.remainingQuantity === 0)) {
              member.status = "exhausted";
            }
            // Also synchronize root entitlements if present
            const rootEnt = (targetSub.entitlements || []).find(
              (e) =>
                e.serviceId &&
                e.serviceId.toString() === ecLine.serviceId.toString(),
            );
            if (rootEnt) {
              rootEnt.usedQuantity = (rootEnt.usedQuantity || 0) + qtyToDeduct;
              rootEnt.remainingQuantity = Math.max(
                0,
                rootEnt.remainingQuantity - qtyToDeduct,
              );
            }
          } else {
            targetEnt.usedQuantity =
              (targetEnt.usedQuantity || 0) + qtyToDeduct;
            targetEnt.remainingQuantity = Math.max(
              0,
              targetEnt.remainingQuantity - qtyToDeduct,
            );
          }

          const allMemberEntsExhausted =
            Array.isArray(targetSub.members) && targetSub.members.length > 0
              ? targetSub.members.every((m) =>
                  (m.entitlements || []).every(
                    (e) => e.remainingQuantity === 0,
                  ),
                )
              : true;
          const allRootEntsExhausted =
            Array.isArray(targetSub.entitlements) &&
            targetSub.entitlements.length > 0
              ? targetSub.entitlements.every((e) => e.remainingQuantity === 0)
              : true;

          if (allMemberEntsExhausted && allRootEntsExhausted) {
            targetSub.status = "exhausted";
          }
          await targetSub.save({ session });

          const existingUsage = new SubscriptionUsage({
            organizationId,
            branchId: invoice.branchId,
            subscriptionId: targetSub._id,
            customerId: invoice.customerId,
            serviceId: ecLine.serviceId,
            serviceName: ecLine.name,
            quantity: qtyToDeduct,
            verifiedBy: userId,
            verificationMethod: "manual",
            reason: `Service coverage on Invoice #${invoice.invoiceNumber}`,
            appointmentId: invoice.appointmentId || null,
            appointmentServiceId: ecLine.appointmentServiceId || null,
            appointmentCode: invoice.appointmentCode || null,
            subscriptionInvoiceId: invoice._id,
          });
          await existingUsage.save({ session });
          ecLine.subscriptionUsageId = existingUsage._id;
        }
      }

      // If a coupon was applied to this invoice, atomically commit usage and ledger entry
      if (invoice.coupon && invoice.coupon.couponId) {
        const couponId = invoice.coupon.couponId;
        const now = new Date(Date.now());

        // Revalidate coupon conditions at finalization
        const targetCoupon = await Coupon.findOne({
          _id: couponId,
          organizationId,
          isDeleted: false,
        }).session(session);

        if (!targetCoupon) {
          throw new AppError("Applied coupon record no longer exists.", 404);
        }
        if (targetCoupon.status !== "active") {
          throw new AppError(
            "Applied coupon '" + targetCoupon.code + "' is no longer active.",
            400,
          );
        }
        if (now < targetCoupon.validFrom || now > targetCoupon.validUntil) {
          throw new AppError(
            "Applied coupon '" +
              targetCoupon.code +
              "' has expired or is not yet valid.",
            400,
          );
        }
        const excludedBranchIds = (targetCoupon.excludedBranchIds || []).map(
          (b) => b.toString(),
        );
        if (excludedBranchIds.includes(branchId.toString())) {
          throw new AppError(
            "Applied coupon '" +
              targetCoupon.code +
              "' is not valid at this branch location.",
            400,
          );
        }

        // 1. Atomically increment total usage counts on Coupon document with concurrency guard
        // usageCount is cumulative historical; activeUsageCount is current active capacity.
        const couponUpdateQuery = {
          _id: couponId,
          organizationId,
          status: "active",
          isDeleted: false,
          validFrom: { $lte: now },
          validUntil: { $gte: now },
        };

        if (
          targetCoupon.totalUsageLimit !== null &&
          targetCoupon.totalUsageLimit !== undefined
        ) {
          couponUpdateQuery.activeUsageCount = {
            $lt: targetCoupon.totalUsageLimit,
          };
        }

        const updatedCoupon = await Coupon.findOneAndUpdate(
          couponUpdateQuery,
          {
            $inc: { usageCount: 1, activeUsageCount: 1 },
            $set: { updatedBy: userId },
          },
          { session, new: true },
        );

        if (!updatedCoupon) {
          throw new AppError(
            "Coupon '" +
              targetCoupon.code +
              "' could not be finalized. Total usage limit reached or coupon state changed.",
            409,
          );
        }

        // 2. Atomically increment customer usage count if per-customer limit exists
        if (
          targetCoupon.perCustomerLimit !== null &&
          targetCoupon.perCustomerLimit !== undefined
        ) {
          if (!invoice.customerId) {
            throw new AppError(
              "A customer record is required to redeem coupon '" +
                targetCoupon.code +
                "' with a per-customer usage limit.",
              400,
            );
          }

          let custCounter = await CouponCustomerUsage.findOne({
            organizationId,
            couponId,
            customerId: invoice.customerId,
          }).session(session);

          if (!custCounter) {
            // Atomic upsert with $setOnInsert: eliminates transaction-aborting E11000 duplicate key exception in MongoDB transactions
            const upsertedCustCounter =
              await CouponCustomerUsage.findOneAndUpdate(
                {
                  organizationId,
                  couponId,
                  customerId: invoice.customerId,
                },
                {
                  $inc: { activeUsageCount: 1, historicalUsageCount: 1 },
                  $setOnInsert: {
                    organizationId,
                    couponId,
                    customerId: invoice.customerId,
                  },
                },
                {
                  session,
                  upsert: true,
                  returnDocument: "after",
                },
              );

            if (
              upsertedCustCounter.activeUsageCount >
              targetCoupon.perCustomerLimit
            ) {
              throw new AppError(
                "Customer has reached the limit (" +
                  targetCoupon.perCustomerLimit +
                  ") for coupon '" +
                  targetCoupon.code +
                  "'.",
                409,
              );
            }
          } else {
            const updatedCustCounter =
              await CouponCustomerUsage.findOneAndUpdate(
                {
                  _id: custCounter._id,
                  activeUsageCount: { $lt: targetCoupon.perCustomerLimit },
                },
                {
                  $inc: { activeUsageCount: 1, historicalUsageCount: 1 },
                },
                { session, returnDocument: "after" },
              );

            if (!updatedCustCounter) {
              throw new AppError(
                "Customer has reached the limit (" +
                  targetCoupon.perCustomerLimit +
                  ") for coupon '" +
                  targetCoupon.code +
                  "'.",
                409,
              );
            }
          }
        }

        // 3. Create durable CouponUsage ledger record (unique compound on organizationId + invoiceId)
        const usageLedger = new CouponUsage({
          organizationId,
          branchId,
          couponId,
          invoiceId: invoice._id,
          customerId: invoice.customerId,
          discountAmount: invoice.coupon.calculatedDiscountAmount,
          consumedAt: now,
          status: "consumed",
          createdBy: userId,
        });
        await usageLedger.save({ session });

        invoice.coupon.usageLedgerId = usageLedger._id;

        await emitCouponRedeemedOutboxEvent({
          invoice,
          coupon: updatedCoupon,
          usageLedgerId: usageLedger._id,
          session,
        });

        if (
          updatedCoupon.totalUsageLimit !== null &&
          updatedCoupon.totalUsageLimit !== undefined &&
          updatedCoupon.activeUsageCount >= updatedCoupon.totalUsageLimit
        ) {
          await emitCouponUsageLimitExhaustedOutboxEvent({
            coupon: updatedCoupon,
            organizationId,
            branchId,
            session,
          });
        }
      }

      await invoice.save({ session });

      const auditLog = new AuditLog({
        organizationId,
        branchId,
        actorId: userId,
        action: AUDIT_ACTIONS.INVOICE_FINALIZED,
        entityType: "Invoice",
        entityId: invoice._id,
        description: `Invoice ${invoice.invoiceNumber} finalized`,
        metadata: {
          invoiceNumber: invoice.invoiceNumber,
          payableAmount: invoice.payableAmount,
          loyaltyRedeemedPoints: invoice.loyaltyRedeemedPoints,
          loyaltyDiscountAmount: invoice.loyaltyDiscountAmount,
        },
      });
      await auditLog.save({ session });

      await emitBillingOutboxEvent({
        eventType: "invoice.created",
        invoice,
        operationId: String(invoice._id),
        amountInPaise: Math.round((invoice.payableAmount || 0) * 100),
        session,
      });

      return invoice;
    });
  }

  /**
   * 4. CANCEL INVOICE
   */
  async cancelInvoice(id, reason, organizationId, branchId, userId) {
    return await this.executeTransaction(async (session) => {
      const invoice = await Invoice.findOne({
        _id: id,
        organizationId,
        isDeleted: false,
      }).session(session);

      if (!invoice) {
        throw new AppError("Invoice not found", 404);
      }

      if (invoice.branchId.toString() !== branchId.toString()) {
        throw new AppError(
          "Target branchId does not match invoice branch",
          400,
        );
      }

      if (invoice.status === "cancelled") {
        throw new AppError("Invoice is already cancelled", 400);
      }

      if (invoice.amountPaid > 0) {
        throw new AppError(
          "Cannot cancel an invoice with recorded payments. Void all payments first.",
          400,
        );
      }

      // Restore redeemed loyalty points if any were consumed on finalization
      if (invoice.loyaltyRedeemedPoints && invoice.loyaltyRedeemedPoints > 0) {
        await loyaltyService.restoreRedemptionForCancelledInvoice({
          invoice,
          actorId: userId,
          reason,
          session,
        });
      }

      // Release any active stock reservations for retail product lines
      await inventoryService.releaseReservationsForInvoice(
        invoice._id,
        organizationId,
        session,
      );

      invoice.status = "cancelled";
      invoice.cancelledAt = new Date();
      invoice.cancelledBy = userId;
      invoice.cancellationReason = reason;

      await emitBillingOutboxEvent({
        eventType: "invoice.voided",
        invoice,
        operationId: String(invoice._id),
        amountInPaise: Math.round((invoice.amountDue || 0) * 100),
        session,
      });

      // Unlink invoice from any associated standalone subscription and record in invoiceHistory
      if (invoice.subscriptionId) {
        const subToUpdate = await Subscription.findOne({
          _id: invoice.subscriptionId,
          organizationId,
        }).session(session);

        if (subToUpdate) {
          // If the subscription's current active invoice is this cancelled invoice, clear invoiceId
          if (
            subToUpdate.invoiceId &&
            subToUpdate.invoiceId.toString() === invoice._id.toString()
          ) {
            subToUpdate.invoiceId = null;
          }

          // Update or push into subscription.invoiceHistory
          if (!Array.isArray(subToUpdate.invoiceHistory)) {
            subToUpdate.invoiceHistory = [];
          }

          const existingHistoryIdx = subToUpdate.invoiceHistory.findIndex(
            (entry) =>
              entry.invoiceId &&
              entry.invoiceId.toString() === invoice._id.toString(),
          );

          if (existingHistoryIdx !== -1) {
            subToUpdate.invoiceHistory[existingHistoryIdx].status = "cancelled";
            subToUpdate.invoiceHistory[existingHistoryIdx].cancelledAt =
              new Date();
          } else {
            subToUpdate.invoiceHistory.push({
              invoiceId: invoice._id,
              invoiceNumber: invoice.invoiceNumber,
              status: "cancelled",
              issuedAt: invoice.createdAt || new Date(),
              cancelledAt: new Date(),
            });
          }

          await subToUpdate.save({ session });
        }
      }

      // If a coupon was consumed on this invoice, atomically reverse active capacity and update ledger
      if (invoice.coupon && invoice.coupon.couponId) {
        const usageRecord = await CouponUsage.findOne({
          organizationId,
          invoiceId: invoice._id,
          status: "consumed",
        }).session(session);

        if (usageRecord) {
          usageRecord.status = "reversed";
          usageRecord.reversedAt = new Date();
          usageRecord.reversalReason = reason || "Invoice cancellation";
          usageRecord.reversedBy = userId;
          await usageRecord.save({ session });

          // Atomically decrement activeUsageCount ONLY (keeping historical cumulative usageCount intact)
          await Coupon.findOneAndUpdate(
            { _id: invoice.coupon.couponId, organizationId },
            {
              $inc: { activeUsageCount: -1 },
              $set: { updatedBy: userId },
            },
            { session },
          );

          // Atomically decrement customer active usage counter
          await CouponCustomerUsage.findOneAndUpdate(
            {
              organizationId,
              couponId: invoice.coupon.couponId,
              customerId: invoice.customerId,
            },
            {
              $inc: { activeUsageCount: -1 },
            },
            { session },
          );
        }
      }

      await invoice.save({ session });

      const auditLog = new AuditLog({
        organizationId,
        branchId,
        actorId: userId,
        action: AUDIT_ACTIONS.INVOICE_CANCELLED,
        entityType: "Invoice",
        entityId: invoice._id,
        description: `Invoice ${invoice.invoiceNumber} cancelled`,
        metadata: {
          invoiceNumber: invoice.invoiceNumber,
          reason,
          loyaltyRestored: invoice.loyaltyRedeemedPoints || 0,
        },
      });
      await auditLog.save({ session });

      return invoice;
    });
  }

  /**
   * 5. RECORD PAYMENT AGAINST FINALIZED INVOICE
   */
  async recordPayment(
    invoiceId,
    paymentData,
    organizationId,
    branchId,
    userId,
  ) {
    const { amount, referenceNote = "", idempotencyKey } = paymentData;
    const method = paymentData.method || paymentData.paymentMethod;
    const paymentAmount = Number(Number(amount).toFixed(2));

    if (paymentAmount <= 0) {
      throw new AppError("Payment amount must be greater than zero", 400);
    }
    if (!method) {
      throw new AppError("Payment method is required", 400);
    }

    // Canonical payload string to verify request fingerprint for idempotency
    const canonicalPayloadString = JSON.stringify({
      invoiceId: invoiceId.toString(),
      amount: paymentAmount,
      method,
    });
    const requestPayloadHash = crypto
      .createHash("sha256")
      .update(canonicalPayloadString)
      .digest("hex");

    // Idempotency lookup prior to starting transaction
    if (idempotencyKey) {
      const existingPayment = await Payment.findOne({
        organizationId,
        idempotencyKey,
        isDeleted: false,
      });

      if (existingPayment) {
        if (
          existingPayment.requestPayloadHash !== requestPayloadHash ||
          existingPayment.invoiceId.toString() !== invoiceId.toString()
        ) {
          throw new AppError(
            "Idempotency key reuse with differing payment parameters or target invoice",
            409,
          );
        }

        const invoice = await Invoice.findOne({
          _id: invoiceId,
          organizationId,
          isDeleted: false,
        });

        return {
          payment: existingPayment,
          invoice,
          isIdempotentReplay: true,
        };
      }
    }

    try {
      return await this.executeTransaction(async (session) => {
        // Re-check idempotency key within transaction to guard against concurrent attempts
      if (idempotencyKey) {
        const racePayment = await Payment.findOne({
          organizationId,
          idempotencyKey,
          isDeleted: false,
        }).session(session);

        if (racePayment) {
          if (
            racePayment.requestPayloadHash !== requestPayloadHash ||
            racePayment.invoiceId.toString() !== invoiceId.toString()
          ) {
            throw new AppError(
              "Idempotency key reuse with differing payment parameters or target invoice",
              409,
            );
          }
          const invoice = await Invoice.findOne({
            _id: invoiceId,
            organizationId,
            isDeleted: false,
          }).session(session);
          return {
            payment: racePayment,
            invoice,
            isIdempotentReplay: true,
          };
        }
      }

      // Load and verify invoice state
      const invoice = await Invoice.findOne({
        _id: invoiceId,
        organizationId,
        isDeleted: false,
      }).session(session);

      if (!invoice) {
        throw new AppError("Invoice not found", 404);
      }

      if (invoice.branchId.toString() !== branchId.toString()) {
        throw new AppError(
          "Target branchId does not match invoice branch",
          400,
        );
      }

      if (invoice.status !== "finalized") {
        throw new AppError(
          `Cannot record payment on invoice with status '${invoice.status}'. Must be 'finalized'.`,
          400,
        );
      }

      // If this is a subscription invoice, establish a shared transactional write boundary on Subscription.
      // Contending with cancellation ensures that if cancellation has claimed the subscription,
      // payment fails atomically; and if payment wins, cancellation's atomic claim or eligibility re-check will fail.
      if (invoice.invoiceType === "subscription" || invoice.subscriptionId) {
        const subId = invoice.subscriptionId;
        if (subId) {
          const SubscriptionModel = mongoose.model("Subscription");
          const lockedSub = await SubscriptionModel.findOneAndUpdate(
            {
              _id: subId,
              organizationId,
              status: { $in: ["active", "pending_payment", "exhausted"] },
              isDeleted: false,
            },
            {
              $set: {
                lastPaymentAttemptAt: new Date(),
              },
            },
            { session, new: true },
          );

          if (!lockedSub || lockedSub.status === "cancelled") {
            throw new AppError(
              "Cannot record payment for a cancelled or concurrently modified subscription invoice",
              400,
            );
          }
        }
      }

      if (paymentAmount > invoice.amountDue) {
        throw new AppError(
          `Payment amount (₹${paymentAmount}) exceeds outstanding balance (₹${invoice.amountDue})`,
          400,
        );
      }

      // Atomic conditional update to guard against race condition overpayment
      const updatedInvoice = await Invoice.findOneAndUpdate(
        {
          _id: invoiceId,
          organizationId,
          status: "finalized",
          amountDue: { $gte: paymentAmount },
        },
        {
          $inc: {
            amountPaid: paymentAmount,
            amountDue: -paymentAmount,
          },
        },
        { new: true, session },
      );

      if (!updatedInvoice) {
        throw new AppError(
          "Concurrent modification or payment exceeds remaining balance",
          409,
        );
      }

      // Derive payment status
      updatedInvoice.paymentStatus = this.derivePaymentStatus(
        updatedInvoice.amountPaid,
        updatedInvoice.amountDue,
      );
      await updatedInvoice.save({ session });

      const paymentNumber = await this.generatePaymentNumber(organizationId);

      const paymentDoc = new Payment({
        organizationId,
        branchId,
        invoiceId: invoice._id,
        customerId: invoice.customerId,
        paymentNumber,
        amount: paymentAmount,
        method,
        referenceNote,
        idempotencyKey: idempotencyKey || null,
        requestPayloadHash: idempotencyKey ? requestPayloadHash : null,
        status: "completed",
        recordedBy: userId,
        paymentDate: new Date(),
      });

      try {
        await paymentDoc.save({ session });
      } catch (err) {
        if (
          err.code === 11000 &&
          idempotencyKey &&
          err.keyPattern?.idempotencyKey
        ) {
          throw new AppError(
            "Concurrent payment submission with identical idempotency key detected",
            409,
          );
        }
        throw err;
      }

      // Audit log
      const auditLog = new AuditLog({
        organizationId,
        branchId,
        actorId: userId,
        action: AUDIT_ACTIONS.PAYMENT_RECORDED,
        entityType: "Payment",
        entityId: paymentDoc._id,
        description: `Payment ${paymentNumber} of ₹${paymentAmount} via ${method} recorded for invoice ${updatedInvoice.invoiceNumber}`,
        metadata: {
          invoiceNumber: updatedInvoice.invoiceNumber,
          paymentNumber,
          amount: paymentAmount,
          method,
          idempotencyKey: idempotencyKey || null,
          remainingDue: updatedInvoice.amountDue,
        },
      });
      await auditLog.save({ session });

      await emitBillingOutboxEvent({
        eventType: "invoice.payment_recorded",
        invoice: updatedInvoice,
        operationId: String(paymentDoc._id),
        amountInPaise: Math.round((paymentDoc.amount || 0) * 100),
        session,
      });

      // If invoice has now reached fully settled 'paid' status, award loyalty points atomically
      if (updatedInvoice.paymentStatus === "paid") {
        await loyaltyService.awardPointsForSettledInvoice({
          invoice: updatedInvoice,
          payment: paymentDoc,
          actorId: userId,
          session,
        });

        // If this invoice represents a subscription sale (or combined invoice with subscription), activate the subscription atomically
        if (
          (updatedInvoice.invoiceType === "subscription" ||
            updatedInvoice.invoiceType === "combined") &&
          updatedInvoice.subscriptionId
        ) {
          const targetSub = await Subscription.findOne({
            _id: updatedInvoice.subscriptionId,
            organizationId,
            isDeleted: false,
          }).session(session);

          if (targetSub && targetSub.status === "pending_payment") {
            targetSub.status = "active";
            if (Array.isArray(targetSub.members)) {
              for (const m of targetSub.members) {
                if (m.status === "pending_payment") {
                  m.status = "active";
                }
              }
            }
            await targetSub.save({ session });

            const subActAudit = new AuditLog({
              organizationId,
              branchId,
              actorId: userId,
              action: AUDIT_ACTIONS.SUBSCRIPTION_UPDATED,
              entityType: "Subscription",
              entityId: targetSub._id,
              description: `Subscription ${targetSub.subscriptionCode} activated upon full invoice payment settlement`,
              metadata: {
                subscriptionCode: targetSub.subscriptionCode,
                invoiceNumber: updatedInvoice.invoiceNumber,
                paymentNumber: paymentDoc.paymentNumber,
              },
            });
            await subActAudit.save({ session });

            // Automatically reassess upcoming scheduled/in_progress appointments for this customer
            try {
              const { subscriptionService } =
                await import("../subscriptions/subscription.service.js");
              if (
                subscriptionService &&
                typeof subscriptionService.reassessCustomerUpcomingAppointments ===
                  "function"
              ) {
                await subscriptionService.reassessCustomerUpcomingAppointments(
                  targetSub.customerId,
                  organizationId,
                  targetSub,
                  session,
                );
              }
            } catch (reassessErr) {
              // Non-blocking logger if circular or already reassessed
            }
          }
        }

        // If invoice contains newly purchased subscription plan lines, activate or instantiate the subscription atomically
        const subPlanLines = updatedInvoice.lines.filter(
          (l) => l.lineType === "subscription" && l.subscriptionPlanId,
        );
        for (const sLine of subPlanLines) {
          const plan = await SubscriptionPlan.findOne({
            _id: sLine.subscriptionPlanId,
            organizationId,
          }).session(session);

          if (plan) {
            const startDate = new Date();
            const endDate = new Date(startDate);
            endDate.setMonth(endDate.getMonth() + plan.validityMonths);

            // Compute same-appointment consumed quantity if this invoice waived an appointment service
            let consumedThisInvoice = 0;
            const waivedServiceLines = updatedInvoice.lines.filter(
              (l) => l.lineType === "service" && l.isCoveredBySubscription,
            );

            // Entitlement instantiation
            const memberEntitlements = (plan.entitlements || []).map((e) => {
              let used = 0;
              // If an appointment service matches this entitlement, deduct exactly 1 used session
              const matchingWaived = waivedServiceLines.filter(
                (wl) =>
                  wl.serviceId &&
                  wl.serviceId.toString() === e.serviceId.toString(),
              );
              if (matchingWaived.length > 0 && e.quantity > 0) {
                used = Math.min(e.quantity, matchingWaived.length);
                consumedThisInvoice += used;
              }
              return {
                serviceId: e.serviceId,
                serviceName: `Service entitlement`,
                totalQuantity: e.quantity,
                usedQuantity: used,
                remainingQuantity: Math.max(0, e.quantity - used),
              };
            });

            const subCode = `SUB-${Date.now().toString().slice(-6)}-${Math.floor(100 + Math.random() * 900)}`;
            const newSub = new Subscription({
              organizationId,
              branchId: updatedInvoice.branchId,
              payerCustomerId: updatedInvoice.customerId,
              customerId: updatedInvoice.customerId,
              subscriptionCode: subCode,
              planId: plan._id,
              price: sLine.unitPrice,
              attribution: sLine.attribution || {},
              members: [
                {
                  customerId: updatedInvoice.customerId,
                  status: memberEntitlements.every(
                    (e) => e.remainingQuantity === 0,
                  )
                    ? "exhausted"
                    : "active",
                  permittedBranchIds: plan.permittedBranchIds || [],
                  entitlements: memberEntitlements,
                  notes: `Activated upon payment of Invoice #${updatedInvoice.invoiceNumber}`,
                },
              ],
              entitlements: memberEntitlements,
              permittedBranchIds: plan.permittedBranchIds || [],
              startDate,
              endDate,
              status: memberEntitlements.every((e) => e.remainingQuantity === 0)
                ? "exhausted"
                : "active",
              invoiceId: updatedInvoice._id,
              notes: `Purchased via Invoice #${updatedInvoice.invoiceNumber}`,
            });

            await newSub.save({ session });
            sLine.subscriptionId = newSub._id;

            // If same-appointment service consumed an entitlement session, create an immutable SubscriptionUsage record
            for (const wl of waivedServiceLines) {
              if (wl.serviceId && !wl.appliedSubscriptionId) {
                const sUsage = new SubscriptionUsage({
                  organizationId,
                  branchId: updatedInvoice.branchId,
                  subscriptionId: newSub._id,
                  customerId: updatedInvoice.customerId,
                  serviceId: wl.serviceId,
                  serviceName: wl.name,
                  quantity: 1,
                  verifiedBy: userId,
                  verificationMethod: "manual",
                  attribution: {
                    performedBy: wl.attribution?.performedBy || null,
                  },
                  reason: `Same-appointment upsell coverage for Invoice #${updatedInvoice.invoiceNumber}`,
                  appointmentId: updatedInvoice.appointmentId || null,
                  appointmentServiceId: wl.appointmentServiceId || null,
                  appointmentCode: updatedInvoice.appointmentCode || null,
                  subscriptionInvoiceId: updatedInvoice._id,
                });
                await sUsage.save({ session });
                wl.subscriptionUsageId = sUsage._id;
                wl.appliedSubscriptionId = newSub._id;
              }
            }
          }
        }

        // If invoice covered services using PRE-EXISTING subscriptions, record usage and decrement entitlement
        const existingCoveredLines = updatedInvoice.lines.filter(
          (l) =>
            l.lineType === "service" &&
            l.isCoveredBySubscription &&
            l.appliedSubscriptionId &&
            !l.subscriptionUsageId,
        );

        // Validate and atomically decrement required entitlements
        for (const ecLine of existingCoveredLines) {
          const targetSub = await Subscription.findOne({
            _id: ecLine.appliedSubscriptionId,
            organizationId,
            isDeleted: false,
          }).session(session);

          if (!targetSub) {
            throw new AppError(
              `Subscription ${ecLine.appliedSubscriptionId} referenced on service line '${ecLine.name}' was not found.`,
              404,
            );
          }

          const qtyToDeduct = ecLine.quantity || 1;
          let member = null;
          if (
            Array.isArray(targetSub.members) &&
            targetSub.members.length > 0 &&
            updatedInvoice.customerId
          ) {
            member = targetSub.members.find(
              (m) =>
                m.customerId.toString() ===
                updatedInvoice.customerId.toString(),
            );
          }

          const entList = member ? member.entitlements : targetSub.entitlements;
          const targetEnt = (entList || []).find(
            (e) =>
              e.serviceId &&
              e.serviceId.toString() === ecLine.serviceId.toString(),
          );

          if (!targetEnt || (targetEnt.remainingQuantity || 0) < qtyToDeduct) {
            throw new AppError(
              `Insufficient subscription entitlement balance for '${ecLine.name}'. Required: ${qtyToDeduct}, Available: ${targetEnt?.remainingQuantity ?? 0}. Entitlement may have been consumed by a concurrent transaction.`,
              409,
            );
          }

          if (member) {
            targetEnt.usedQuantity =
              (targetEnt.usedQuantity || 0) + qtyToDeduct;
            targetEnt.remainingQuantity = Math.max(
              0,
              targetEnt.remainingQuantity - qtyToDeduct,
            );
            if (member.entitlements.every((e) => e.remainingQuantity === 0)) {
              member.status = "exhausted";
            }
            // Also synchronize root entitlements if present
            const rootEnt = (targetSub.entitlements || []).find(
              (e) =>
                e.serviceId &&
                e.serviceId.toString() === ecLine.serviceId.toString(),
            );
            if (rootEnt) {
              rootEnt.usedQuantity = (rootEnt.usedQuantity || 0) + qtyToDeduct;
              rootEnt.remainingQuantity = Math.max(
                0,
                rootEnt.remainingQuantity - qtyToDeduct,
              );
            }
          } else {
            targetEnt.usedQuantity =
              (targetEnt.usedQuantity || 0) + qtyToDeduct;
            targetEnt.remainingQuantity = Math.max(
              0,
              targetEnt.remainingQuantity - qtyToDeduct,
            );
          }

          const allMemberEntsExhausted =
            Array.isArray(targetSub.members) && targetSub.members.length > 0
              ? targetSub.members.every((m) =>
                  (m.entitlements || []).every(
                    (e) => e.remainingQuantity === 0,
                  ),
                )
              : true;
          const allRootEntsExhausted =
            Array.isArray(targetSub.entitlements) &&
            targetSub.entitlements.length > 0
              ? targetSub.entitlements.every((e) => e.remainingQuantity === 0)
              : true;

          if (allMemberEntsExhausted && allRootEntsExhausted) {
            targetSub.status = "exhausted";
          }
          await targetSub.save({ session });

          const existingUsage = new SubscriptionUsage({
            organizationId,
            branchId: updatedInvoice.branchId,
            subscriptionId: targetSub._id,
            customerId: updatedInvoice.customerId,
            serviceId: ecLine.serviceId,
            serviceName: ecLine.name,
            quantity: qtyToDeduct,
            verifiedBy: userId,
            verificationMethod: "manual",
            attribution: {
              performedBy: ecLine.attribution?.performedBy || null,
            },
            reason: `Service coverage on Invoice #${updatedInvoice.invoiceNumber}`,
            appointmentId: updatedInvoice.appointmentId || null,
            appointmentServiceId: ecLine.appointmentServiceId || null,
            appointmentCode: updatedInvoice.appointmentCode || null,
            subscriptionInvoiceId: updatedInvoice._id,
          });
          await existingUsage.save({ session });
          ecLine.subscriptionUsageId = existingUsage._id;
        }

        // If invoice contains newly purchased membership lines, instantiate CustomerMembership atomically for all beneficiaries
        const membershipLines = updatedInvoice.lines.filter(
          (l) => l.lineType === "membership" && l.membershipPlanId,
        );
        const allCreatedMemberships = [];
        for (const mLine of membershipLines) {
          // Check if memberships were already instantiated in pending_payment state (e.g. during standalone sell, appointment upsell or unified invoice draft creation)
          const candidateQueryIds = [];
          if (mLine.customerMembershipId)
            candidateQueryIds.push(mLine.customerMembershipId);
          if (Array.isArray(mLine.customerMembershipIds)) {
            candidateQueryIds.push(...mLine.customerMembershipIds);
          }
          const candidatePurchaseIds = [];
          if (mLine.membershipPurchaseId)
            candidatePurchaseIds.push(mLine.membershipPurchaseId);
          if (updatedInvoice.membershipPurchaseId)
            candidatePurchaseIds.push(updatedInvoice.membershipPurchaseId);

          const existingMemberships = await CustomerMembership.find({
            organizationId,
            $or: [
              ...(candidateQueryIds.length > 0
                ? [{ _id: { $in: candidateQueryIds } }]
                : []),
              ...(candidatePurchaseIds.length > 0
                ? [{ membershipPurchaseId: { $in: candidatePurchaseIds } }]
                : []),
              { invoiceId: updatedInvoice._id },
            ],
            isDeleted: false,
          }).session(session);

          if (existingMemberships.length > 0) {
            for (const em of existingMemberships) {
              if (em.status === "pending_payment") {
                em.status = "active";
                em.notes =
                  (em.notes ? em.notes + "; " : "") +
                  `Activated upon payment of Invoice #${updatedInvoice.invoiceNumber}`;
                await em.save({ session });
              }
            }
            const firstMembership = existingMemberships[0];
            mLine.customerMembershipId = firstMembership._id;
            mLine.customerMembershipIds = existingMemberships.map((m) => m._id);
            updatedInvoice.customerMembershipId = firstMembership._id;
            updatedInvoice.customerMembershipIds = existingMemberships.map(
              (m) => m._id,
            );
            updatedInvoice.membershipCode = firstMembership.membershipCode;
            allCreatedMemberships.push(...existingMemberships);

            // Link applied membership discount lines to the beneficiary who received the service
            for (const benefitLine of updatedInvoice.lines) {
              if (
                benefitLine.membershipBenefitSourceLineId?.toString() ===
                mLine._id.toString()
              ) {
                const matchingMembership =
                  existingMemberships.find(
                    (m) =>
                      m.customerId.toString() ===
                      updatedInvoice.customerId.toString(),
                  ) || firstMembership;
                benefitLine.appliedCustomerMembershipId =
                  matchingMembership._id;
                benefitLine.membershipBenefitSourceLineId = null;
              }
            }
            continue;
          }

          const plan = await MembershipPlan.findOne({
            _id: mLine.membershipPlanId,
            organizationId,
          }).session(session);

          if (plan) {
            const startDate = new Date();
            const endDate = new Date(startDate);
            endDate.setMonth(endDate.getMonth() + plan.validityMonths);

            const payerId = mLine.payerCustomerId || updatedInvoice.customerId;
            let beneficiaryIds = [payerId];
            if (
              Array.isArray(mLine.beneficiaryCustomerIds) &&
              mLine.beneficiaryCustomerIds.length > 0
            ) {
              beneficiaryIds = mLine.beneficiaryCustomerIds;
            }

            const membershipPurchaseId = new mongoose.Types.ObjectId();
            mLine.membershipPurchaseId = membershipPurchaseId;
            updatedInvoice.membershipPurchaseId = membershipPurchaseId;

            const createdMemberships = [];
            let primaryMembershipCode = null;

            for (let i = 0; i < beneficiaryIds.length; i++) {
              const bId = beneficiaryIds[i];
              const memCode = `MEM-${Date.now().toString().slice(-6)}-${Math.floor(100 + Math.random() * 900)}${i > 0 ? `-${i + 1}` : ""}`;
              if (!primaryMembershipCode) {
                primaryMembershipCode = memCode;
              }

              // Check if there is an overridden benefit configuration for this specific beneficiary
              const overrideConfig = Array.isArray(mLine.beneficiaryOverrides)
                ? mLine.beneficiaryOverrides.find(
                    (o) =>
                      (o.customerId?._id || o.customerId)?.toString() ===
                      bId.toString(),
                  )
                : null;
              const effectiveBenefits =
                overrideConfig?.benefits || plan.benefits;

              const newMembership = new CustomerMembership({
                organizationId,
                customerId: bId,
                payerCustomerId: payerId,
                membershipPurchaseId,
                membershipPlanId: plan._id,
                attribution: mLine.attribution || {},
                membershipCode: memCode,
                planSnapshot: {
                  name: plan.name,
                  tier: plan.tier || "Standard",
                  price: mLine.unitPrice,
                  validityMonths: plan.validityMonths,
                  maxBeneficiaries: plan.maxBeneficiaries || 1,
                  benefits: effectiveBenefits,
                },
                status: "active",
                startDate,
                endDate,
                permittedBranchIds: plan.permittedBranchIds || [],
                invoiceId: updatedInvoice._id,
                notes: `Activated upon payment of Invoice #${updatedInvoice.invoiceNumber}`,
              });

              await newMembership.save({ session });
              createdMemberships.push(newMembership);
              allCreatedMemberships.push(newMembership);
            }

            // Backward compatibility: link first created membership to customerMembershipId
            const firstMembership = createdMemberships[0];
            mLine.customerMembershipId = firstMembership._id;
            mLine.customerMembershipIds = createdMemberships.map((m) => m._id);
            updatedInvoice.customerMembershipId = firstMembership._id;
            updatedInvoice.customerMembershipIds = createdMemberships.map(
              (m) => m._id,
            );
            updatedInvoice.membershipCode = primaryMembershipCode;

            // Link applied membership discount lines to the beneficiary who received the service
            for (const benefitLine of updatedInvoice.lines) {
              if (
                benefitLine.membershipBenefitSourceLineId?.toString() ===
                mLine._id.toString()
              ) {
                // Find matching membership for the customer of this invoice
                const matchingMembership =
                  createdMemberships.find(
                    (m) =>
                      m.customerId.toString() ===
                      updatedInvoice.customerId.toString(),
                  ) || firstMembership;

                benefitLine.appliedCustomerMembershipId =
                  matchingMembership._id;
                benefitLine.membershipBenefitSourceLineId = null;
              }
            }
          }
        }

        await updatedInvoice.save({ session });

        if (updatedInvoice.paymentStatus === "partial") {
          await emitBillingOutboxEvent({
            eventType: "invoice.partial_payment",
            invoice: updatedInvoice,
            operationId: String(paymentDoc._id),
            amountInPaise: Math.round((paymentDoc.amount || 0) * 100),
            session,
          });
        } else if (updatedInvoice.paymentStatus === "paid") {
          await emitBillingOutboxEvent({
            eventType: "invoice.settled",
            invoice: updatedInvoice,
            operationId: String(paymentDoc._id),
            amountInPaise: Math.round((paymentDoc.amount || 0) * 100),
            session,
          });
        }

        // If invoice contains product lines, atomically commit stock reservations into `pos_sale` ledger movements
        const hasProductLines = updatedInvoice.lines.some(
          (l) => l.lineType === "product",
        );
        if (hasProductLines) {
          await inventoryService.commitReservationsForInvoice({
            invoice: updatedInvoice,
            actorId: userId,
            session,
          });
        }

        // Trigger Incentives & Settlement Hook (Dual-Gate Gate 1)
        try {
          await settlementFulfillmentEventService.handleInvoiceSettled({
            invoice: updatedInvoice,
            payment: paymentDoc,
            session,
            userId,
          });
        } catch (incentiveErr) {
          logger.error(
            "Incentive settlement hook failed; rolling back invoice payment: " +
              incentiveErr.message,
          );
          throw incentiveErr;
        }

        // Post-commit notification dispatch for created memberships (non-blocking)
        if (allCreatedMemberships.length > 0) {
          try {
            for (const cm of allCreatedMemberships) {
              const cust = await Customer.findById(cm.customerId)
                .session(session)
                .lean();
              if (cust?.phone && smsQueue?.add) {
                await smsQueue.add("sendMembershipActivatedSMS", {
                  phone: cust.phone,
                  customerName: cust.name,
                  membershipCode: cm.membershipCode,
                  planName: cm.planSnapshot?.name || "Salon Membership",
                  tier: cm.planSnapshot?.tier || "Standard",
                });
              }
            }
          } catch (smsErr) {
            logger.warn(
              "Non-fatal SMS notification dispatch failure for memberships: " +
                smsErr.message,
            );
          }
        }
      }

      return {
        payment: paymentDoc,
        invoice: updatedInvoice,
      };
      });
    } catch (err) {
      if (
        err?.code === 11000 &&
        idempotencyKey &&
        err?.keyPattern?.idempotencyKey
      ) {
        const existingPayment = await Payment.findOne({
          organizationId,
          idempotencyKey,
          isDeleted: false,
        });
        if (existingPayment) {
          if (
            existingPayment.requestPayloadHash !== requestPayloadHash ||
            existingPayment.invoiceId.toString() !== invoiceId.toString()
          ) {
            throw new AppError(
              "Idempotency key reuse with differing payment parameters or target invoice",
              409,
            );
          }
          const invoice = await Invoice.findOne({
            _id: invoiceId,
            organizationId,
            isDeleted: false,
          });
          return {
            payment: existingPayment,
            invoice,
            isIdempotentReplay: true,
          };
        }
      }
      throw err;
    }
  }

  /**
   * 6. VOID PAYMENT
   */
  async voidPayment(paymentId, reason, organizationId, branchId, userId) {
    return await this.executeTransaction(async (session) => {
      const payment = await Payment.findOne({
        _id: paymentId,
        organizationId,
        isDeleted: false,
      }).session(session);

      if (!payment) {
        throw new AppError("Payment not found", 404);
      }

      if (payment.branchId.toString() !== branchId.toString()) {
        throw new AppError(
          "Target branchId does not match payment branch",
          400,
        );
      }

      if (payment.status === "voided") {
        throw new AppError("Payment is already voided", 400);
      }

      const invoice = await Invoice.findOne({
        _id: payment.invoiceId,
        organizationId,
        isDeleted: false,
      }).session(session);

      if (!invoice) {
        throw new AppError("Associated invoice not found", 404);
      }

      // Mark payment voided
      payment.status = "voided";
      payment.voidedAt = new Date();
      payment.voidedBy = userId;
      payment.voidReason = reason;
      await payment.save({ session });

      // Atomically reverse financial effect on invoice
      const updatedInvoice = await Invoice.findOneAndUpdate(
        {
          _id: invoice._id,
          organizationId,
        },
        {
          $inc: {
            amountPaid: -payment.amount,
            amountDue: payment.amount,
          },
        },
        { new: true, session },
      );

      // Re-evaluate payment status
      updatedInvoice.paymentStatus = this.derivePaymentStatus(
        updatedInvoice.amountPaid,
        updatedInvoice.amountDue,
      );
      await updatedInvoice.save({ session });

      const auditLog = new AuditLog({
        organizationId,
        branchId,
        actorId: userId,
        action: AUDIT_ACTIONS.PAYMENT_VOIDED,
        entityType: "Payment",
        entityId: payment._id,
        description: `Payment ${payment.paymentNumber} of ₹${payment.amount} voided`,
        metadata: {
          paymentNumber: payment.paymentNumber,
          invoiceNumber: updatedInvoice.invoiceNumber,
          amount: payment.amount,
          reason,
        },
      });
      await auditLog.save({ session });

      await emitBillingOutboxEvent({
        eventType: "invoice.payment_reversed",
        invoice: updatedInvoice,
        operationId: String(payment._id),
        amountInPaise: Math.round((payment.amount || 0) * 100),
        session,
      });

      // Trigger Incentives Void/Unsettle Hook
      try {
        await settlementFulfillmentEventService.handlePaymentVoided({
          payment,
          invoice: updatedInvoice,
          session,
          userId,
          reason,
        });
      } catch (incentiveVoidErr) {
        logger.error(
          "Incentive void hook failed; rolling back payment void: " +
            incentiveVoidErr.message,
        );
        throw incentiveVoidErr;
      }

      // If the invoice was previously paid/settled, reverse any earned loyalty points atomically
      if (
        invoice.paymentStatus === "paid" &&
        updatedInvoice.paymentStatus !== "paid"
      ) {
        await loyaltyService.reverseEarningForVoidedPayment({
          invoice: updatedInvoice,
          payment,
          actorId: userId,
          session,
        });

        // If this is a subscription invoice, revert subscription status back to pending_payment
        if (
          updatedInvoice.invoiceType === "subscription" ||
          updatedInvoice.subscriptionId
        ) {
          const subId = updatedInvoice.subscriptionId;
          if (subId) {
            const subToRevert = await Subscription.findOne({
              _id: subId,
              organizationId,
            }).session(session);
            if (subToRevert && subToRevert.status !== "cancelled") {
              subToRevert.status = "pending_payment";
              if (Array.isArray(subToRevert.members)) {
                for (const m of subToRevert.members) {
                  if (m.status === "active") {
                    m.status = "pending_payment";
                  }
                }
              }
              await subToRevert.save({ session });
            }
          }
        }
      }

      return {
        payment,
        invoice: updatedInvoice,
      };
    });
  }

  /**
   * 7. GET INVOICE WITH PAYMENTS
   */
  async getInvoiceById(id, organizationId, branchId = null) {
    const query = { _id: id, organizationId, isDeleted: false };
    if (branchId) {
      query.branchId = branchId;
    }

    const invoice = await Invoice.findOne(query)
      .populate("branchId", "name")
      .populate("customerId", "name phone email")
      .populate("createdBy", "name")
      .populate("finalizedBy", "name")
      .populate("cancelledBy", "name");

    if (!invoice) {
      throw new AppError("Invoice not found", 404);
    }

    const payments = await Payment.find({
      invoiceId: invoice._id,
      organizationId,
      isDeleted: false,
    })
      .populate("recordedBy", "name")
      .populate("voidedBy", "name")
      .sort({ createdAt: 1 });

    return {
      invoice,
      payments,
    };
  }

  /**
   * 8. LIST INVOICES
   */
  async listInvoices(filter, pagination, organizationId, branchId = null) {
    const listFilter = { ...filter };

    // Respect branch timezone if configured (default Asia/Kolkata)
    if (listFilter.startDate || listFilter.endDate) {
      let timezone = "Asia/Kolkata";
      if (branchId && mongoose.Types.ObjectId.isValid(branchId)) {
        const branch = await Branch.findOne({ _id: branchId, organizationId })
          .select("timezone")
          .lean();
        if (branch?.timezone) {
          timezone = branch.timezone;
        }
      }

      const getTimezoneOffsetMs = (date, tz) => {
        try {
          const utcDate = new Date(
            date.toLocaleString("en-US", { timeZone: "UTC" }),
          );
          const tzDate = new Date(
            date.toLocaleString("en-US", { timeZone: tz }),
          );
          return tzDate.getTime() - utcDate.getTime();
        } catch {
          return 5.5 * 60 * 60 * 1000;
        }
      };

      const parseLocalToUTC = (dateStr, timeStr, tz) => {
        const [year, month, day] = dateStr.split("-").map(Number);
        const [hours, minutes, seconds = 0, ms = 0] = timeStr
          .split(/[:.]/)
          .map(Number);
        const nominalUtc = new Date(
          Date.UTC(year, month - 1, day, hours, minutes, seconds, ms),
        );
        const offsetMs = getTimezoneOffsetMs(nominalUtc, tz);
        return new Date(nominalUtc.getTime() - offsetMs);
      };

      if (listFilter.startDate) {
        listFilter.startDateBoundary = parseLocalToUTC(
          listFilter.startDate,
          "00:00:00.000",
          timezone,
        );
      }
      if (listFilter.endDate) {
        listFilter.endDateBoundary = parseLocalToUTC(
          listFilter.endDate,
          "23:59:59.999",
          timezone,
        );
      }
    }

    return await invoiceRepository.list(
      listFilter,
      pagination,
      organizationId,
      branchId,
    );
  }

  /**
   * 9. GET PAYMENTS FOR INVOICE
   */
  async getPaymentsByInvoiceId(invoiceId, organizationId, branchId = null) {
    const invoiceQuery = { _id: invoiceId, organizationId, isDeleted: false };
    if (branchId) {
      invoiceQuery.branchId = branchId;
    }

    const invoice = await Invoice.findOne(invoiceQuery);
    if (!invoice) {
      throw new AppError("Invoice not found", 404);
    }

    return await paymentRepository.findByInvoiceId(invoiceId, organizationId);
  }

  /**
   * 10. GENERATE INVOICE PDF
   */
  /**
   * Resolve authoritative organization and branch branding from persisted models.
   */
  async resolveInvoiceBranding(organizationId, branchId, session = null) {
    const orgQuery = Organization.findById(organizationId)
      .select("name logo")
      .lean();
    const orgSettingsQuery = OrganizationSettings.findOne({ organizationId })
      .select("profile regional.timezone")
      .lean();
    const branchQuery = branchId
      ? Branch.findOne({ _id: branchId, organizationId })
          .select("name address phone timezone")
          .lean()
      : Promise.resolve(null);

    if (session) {
      orgQuery.session(session);
      orgSettingsQuery.session(session);
      if (branchId) branchQuery.session(session);
    }

    const [orgDoc, orgSettingsDoc, branchDoc] = await Promise.all([
      orgQuery,
      orgSettingsQuery,
      branchQuery,
    ]);

    const profile = orgSettingsDoc?.profile || {};
    const orgName = orgDoc?.name || null;
    const displayName = profile.displayName || orgName;

    return {
      organization: {
        name: orgName,
        displayName,
        logo: orgDoc?.logo || null,
        address: profile.address || null,
        phone: profile.phone || null,
        email: profile.email || null,
        website: profile.website || null,
      },
      branch: {
        name: branchDoc?.name || null,
        address: branchDoc?.address || profile.address || null,
        phone: branchDoc?.phone || profile.phone || null,
        timezone:
          branchDoc?.timezone ||
          orgSettingsDoc?.regional?.timezone ||
          "Asia/Kolkata",
      },
    };
  }

  async generateInvoicePdf(invoiceId, organizationId, branchId = null) {
    const query = { _id: invoiceId, organizationId, isDeleted: false };
    if (branchId) {
      query.branchId = branchId;
    }

    const invoice = await Invoice.findOne(query)
      .populate("branchId", "name address phone timezone")
      .populate("customerId", "name phone email")
      .populate("lines.staffId", "name")
      .populate({
        path: "lines.appliedSubscriptionId",
        select: "subscriptionCode planId",
        populate: { path: "planId", select: "name" },
      });

    if (!invoice) {
      throw new AppError("Invoice not found", 404);
    }

    const isFinalized = invoice.status === "finalized";
    const hasOrgSnapshot = Boolean(
      invoice.organizationSnapshot?.name ||
      invoice.organizationSnapshot?.displayName,
    );
    const hasBranchSnapshot = Boolean(invoice.branchSnapshot?.name);

    let organization;
    let branch;

    if (isFinalized && hasOrgSnapshot && hasBranchSnapshot) {
      organization = invoice.organizationSnapshot;
      branch = invoice.branchSnapshot;
    } else {
      const liveBranding = await this.resolveInvoiceBranding(
        organizationId,
        invoice.branchId?._id || invoice.branchId,
      );
      organization =
        isFinalized && hasOrgSnapshot
          ? invoice.organizationSnapshot
          : liveBranding.organization;
      branch =
        isFinalized && hasBranchSnapshot
          ? invoice.branchSnapshot
          : liveBranding.branch;
    }

    // Fetch appointment with populated staff if invoice has appointmentId
    let appointment = null;
    if (invoice.appointmentId) {
      appointment = await Appointment.findOne({
        _id: invoice.appointmentId,
        organizationId,
      }).populate("staffId", "name phone");
    }

    // Fetch payments associated with this invoice
    const payments = await Payment.find({
      invoiceId: invoice._id,
      organizationId,
      isDeleted: false,
    }).sort({ createdAt: 1 });

    const pdfBuffer = await createInvoicePdf({
      invoice,
      payments,
      branch,
      appointment,
      organization,
    });

    return {
      pdfBuffer,
      invoice,
    };
  }

  /**
   * Authoritative POS Checkout Queue Aggregation.
   * Returns appointments waiting for billing at the counter (status in_progress or completed)
   * that do not have an active (non-cancelled, non-deleted) invoice.
   */
  async getCheckoutQueue({ organizationId, branchId, customerId, date }) {
    const matchStage = {
      organizationId: new mongoose.Types.ObjectId(organizationId),
      status: { $in: ["in_progress", "completed"] },
      isDeleted: { $ne: true },
    };

    if (branchId) {
      matchStage.branchId = new mongoose.Types.ObjectId(branchId);
    }

    if (customerId) {
      matchStage.customerId = new mongoose.Types.ObjectId(customerId);
    }

    if (date) {
      matchStage.$or = [{ appointmentDate: date }, { date: date }];
    } else {
      // Default to today's date in YYYY-MM-DD interpreted in Branch Timezone
      let tz = "Asia/Kolkata";
      if (branchId) {
        const branchDoc = await Branch.findOne({
          _id: branchId,
          organizationId,
        }).lean();
        if (branchDoc?.timezone) tz = branchDoc.timezone;
      }
      const formatter = new Intl.DateTimeFormat("en-CA", {
        timeZone: tz,
        year: "numeric",
        month: "2-digit",
        day: "2-digit",
      });
      const todayStr = formatter.format(new Date());
      matchStage.$or = [{ appointmentDate: todayStr }, { date: todayStr }];
    }

    const pipeline = [
      { $match: matchStage },

      // Left outer join against the Invoices collection
      {
        $lookup: {
          from: "invoices",
          let: { aptId: "$_id" },
          pipeline: [
            {
              $match: {
                $expr: {
                  $and: [
                    { $eq: ["$appointmentId", "$$aptId"] },
                    { $ne: ["$status", "cancelled"] },
                    { $ne: ["$isDeleted", true] },
                  ],
                },
              },
            },
            { $project: { _id: 1, status: 1, paymentStatus: 1 } },
          ],
          as: "activeInvoices",
        },
      },

      // Anti-join: Keep only appointments without any active invoice
      {
        $match: {
          activeInvoices: { $size: 0 },
        },
      },

      // Populate Customer info
      {
        $lookup: {
          from: "customers",
          localField: "customerId",
          foreignField: "_id",
          as: "customerDoc",
        },
      },
      { $unwind: { path: "$customerDoc", preserveNullAndEmptyArrays: true } },

      // Populate Staff info
      {
        $lookup: {
          from: "staffs",
          localField: "staffId",
          foreignField: "_id",
          as: "staffDoc",
        },
      },
      { $unwind: { path: "$staffDoc", preserveNullAndEmptyArrays: true } },

      // Populate applied subscriptions for services to retrieve subscriptionCode
      {
        $lookup: {
          from: "subscriptions",
          localField: "services.appliedSubscriptionId",
          foreignField: "_id",
          as: "appliedSubsDocs",
        },
      },

      // Sort: 'completed' first, then startTime descending
      {
        $addFields: {
          statusOrder: {
            $cond: [{ $eq: ["$status", "completed"] }, 0, 1],
          },
        },
      },
      {
        $sort: {
          statusOrder: 1,
          startTime: -1,
        },
      },

      // Format output fields according to API specification
      {
        $project: {
          _id: 1,
          appointmentCode: 1,
          status: 1,
          branchId: 1,
          bookingType: 1,
          date: { $ifNull: ["$appointmentDate", "$date"] },
          startTime: 1,
          customer: {
            $cond: [
              { $ifNull: ["$customerDoc", false] },
              {
                id: { $toString: "$customerDoc._id" },
                name: "$customerDoc.name",
                phone: "$customerDoc.phone",
              },
              null,
            ],
          },
          staff: {
            $cond: [
              { $ifNull: ["$staffDoc", false] },
              {
                id: { $toString: "$staffDoc._id" },
                name: "$staffDoc.name",
              },
              null,
            ],
          },
          services: {
            $map: {
              input: "$services",
              as: "svc",
              in: {
                serviceId: { $toString: "$$svc.serviceId" },
                name: "$$svc.name",
                duration: "$$svc.duration",
                price: "$$svc.price",
                appliedSubscriptionId: {
                  $cond: [
                    { $ifNull: ["$$svc.appliedSubscriptionId", false] },
                    { $toString: "$$svc.appliedSubscriptionId" },
                    null,
                  ],
                },
                subscriptionCode: {
                  $let: {
                    vars: {
                      matchedSub: {
                        $arrayElemAt: [
                          {
                            $filter: {
                              input: "$appliedSubsDocs",
                              as: "subDoc",
                              cond: {
                                $eq: [
                                  "$$subDoc._id",
                                  "$$svc.appliedSubscriptionId",
                                ],
                              },
                            },
                          },
                          0,
                        ],
                      },
                    },
                    in: { $ifNull: ["$$matchedSub.subscriptionCode", null] },
                  },
                },
                isRedeemedViaSubscription: {
                  $ifNull: ["$$svc.isRedeemedViaSubscription", false],
                },
              },
            },
          },
          pricing: {
            subtotal: "$pricing.subtotal",
            discount: "$pricing.discount",
            total: "$pricing.total",
          },
          estimatedPayable: {
            $ifNull: [
              "$pricing.total",
              {
                $subtract: [
                  "$pricing.subtotal",
                  { $ifNull: ["$pricing.discount", 0] },
                ],
              },
            ],
          },
        },
      },
    ];

    const results = await Appointment.aggregate(pipeline);

    let completedCount = 0;
    let inProgressCount = 0;

    const formattedData = results.map((item) => {
      if (item.status === "completed") {
        completedCount++;
      } else if (item.status === "in_progress") {
        inProgressCount++;
      }

      return {
        id: item._id.toString(),
        appointmentCode: item.appointmentCode,
        status: item.status,
        bookingType: item.bookingType,
        date: item.date,
        startTime: item.startTime,
        customer: item.customer,
        staff: item.staff,
        services: item.services,
        pricing: item.pricing,
        estimatedPayable: item.estimatedPayable,
        branchId: item.branchId
          ? item?.branchId?.toString()
          : branchId
            ? branchId.toString()
            : null,
      };
    });

    return {
      data: formattedData,
      meta: {
        total: formattedData.length,
        completedCount,
        inProgressCount,
      },
    };
  }

  /**
   * 8. PROCESS INVOICE RETURN & RESTOCK (SEPARATE FINANCIAL REFUND & PHYSICAL RESTOCK)
   */
  async refundUnusedMembershipLine(
    invoiceId,
    payload,
    organizationId,
    branchId,
    userId,
    idempotencyKey,
  ) {
    // Consolidated into authoritative RefundCase workflow
    const { refundService } = await import("./refund.service.js");
    const { lineId, refundPaymentMethod = "cash", reason } = payload;
    const created = await refundService.createPendingRefundCase(
      invoiceId,
      {
        refundMode: "item_linked",
        items: [{ lineId, quantity: 1 }],
        refundMethod: refundPaymentMethod,
        reason: reason || "Membership refund",
        branchId,
      },
      organizationId,
      branchId,
      userId,
      idempotencyKey,
    );
    const settled = await refundService.settleRefundCase(
      invoiceId,
      String(created.refundCase._id),
      { refundMethod: refundPaymentMethod, branchId },
      organizationId,
      branchId,
      userId,
      `${idempotencyKey}:settle`,
    );
    return {
      refundCase: settled.refundCase,
      refundPayment: settled.refundPayment,
      idempotentReplay: Boolean(created.idempotentReplay),
      consolidatedViaRefundCase: true,
    };
  }

  async _legacyRefundUnusedMembershipLineUnused(
    invoiceId,
    payload,
    organizationId,
    branchId,
    userId,
    idempotencyKey,
  ) {
    const { lineId, refundPaymentMethod = "cash", reason } = payload;
    if (!idempotencyKey || idempotencyKey.length > 200) {
      throw new AppError(
        "A valid Idempotency-Key header is required for membership refunds",
        400,
      );
    }

    const requestPayloadHash = crypto
      .createHash("sha256")
      .update(
        JSON.stringify({ lineId: String(lineId), refundPaymentMethod, reason }),
      )
      .digest("hex");
    const refundPaymentKey = `MEMBERSHIP_REFUND:${invoiceId}:${idempotencyKey}`;

    return this.executeTransaction(async (session) => {
      const invoice = await Invoice.findOne({
        _id: invoiceId,
        organizationId,
        isDeleted: false,
      }).session(session);
      if (!invoice) throw new AppError("Invoice not found", 404);
      if (invoice.branchId.toString() !== branchId.toString()) {
        throw new AppError(
          "Target branchId does not match invoice branch",
          400,
        );
      }

      const existingPayment = await Payment.findOne({
        organizationId,
        idempotencyKey: refundPaymentKey,
        type: "refund",
        isDeleted: false,
      }).session(session);
      if (existingPayment) {
        if (
          existingPayment.requestPayloadHash !== requestPayloadHash ||
          existingPayment.invoiceId.toString() !== invoice._id.toString()
        ) {
          throw new AppError(
            "Idempotency key was already used for a different membership refund",
            409,
          );
        }
        const refundEvent = await InvoiceSettlementEvent.findOne({
          organizationId,
          paymentId: existingPayment._id,
          eventType: "RETURN_PROCESSED",
        }).session(session);
        return {
          invoice,
          refundPayment: existingPayment,
          refundEvent,
          idempotentReplay: true,
          manualRefundRecord: true,
        };
      }

      if (invoice.status !== "finalized" || invoice.paymentStatus !== "paid") {
        throw new AppError(
          "Only fully paid, finalized membership invoices can be refunded",
          400,
        );
      }
      if (invoice.loyaltyDiscountAmount > 0) {
        throw new AppError(
          "Membership refund is blocked because loyalty discount allocation is not verifiable",
          409,
        );
      }

      const line = invoice.lines.find(
        (item) => item._id?.toString() === String(lineId),
      );
      if (
        !line ||
        line.lineType !== "membership" ||
        Number(line.quantity) !== 1
      ) {
        throw new AppError(
          "A single membership invoice line is required for refund",
          400,
        );
      }
      if (!line.customerMembershipId) {
        throw new AppError(
          "Membership issuance record is missing for this invoice line",
          409,
        );
      }

      const membership = await CustomerMembership.findOne({
        _id: line.customerMembershipId,
        organizationId,
        invoiceId: invoice._id,
        isDeleted: false,
      }).session(session);
      if (!membership || !["active", "expired"].includes(membership.status)) {
        throw new AppError(
          "Membership is not eligible for an unused-membership refund",
          409,
        );
      }

      const benefitUse = await Invoice.exists({
        organizationId,
        isDeleted: false,
        status: { $ne: "cancelled" },
        $or: [
          { "lines.appliedCustomerMembershipId": membership._id },
          { "lines.membershipBenefitSourceLineId": line._id },
        ],
      }).session(session);
      if (benefitUse) {
        throw new AppError(
          "Membership has been used or reserved on another invoice and cannot be refunded",
          409,
        );
      }

      const netAmountPaise = Math.round(
        Number(line.customerPayable ?? line.lineTotal) * 100,
      );
      if (!Number.isSafeInteger(netAmountPaise) || netAmountPaise <= 0) {
        throw new AppError("Membership refund amount is invalid", 409);
      }
      const refundAmount = netAmountPaise / 100;
      const paymentNumber = await this.generatePaymentNumber(organizationId);
      const refundPayment = await Payment.create(
        [
          {
            organizationId,
            branchId,
            invoiceId: invoice._id,
            customerId: invoice.customerId,
            paymentNumber,
            amount: -refundAmount,
            method: refundPaymentMethod,
            type: "refund",
            status: "completed",
            referenceNote: `Unused membership refund recorded: ${reason}`,
            recordedBy: userId,
            paymentDate: new Date(),
            idempotencyKey: refundPaymentKey,
            requestPayloadHash,
            isManualRefundRecord: true,
          },
        ],
        { session },
      );

      membership.status = "cancelled";
      membership.cancelledAt = new Date();
      membership.cancelledBy = userId;
      membership.cancellationReason = reason;
      membership.refundPaymentId = refundPayment[0]._id;
      await membership.save({ session });

      line.returnedQuantity = Number(line.quantity);
      const { refundEvent } =
        await settlementFulfillmentEventService.handlePurchaseRefundProcessed({
          invoice,
          refundPayment: refundPayment[0],
          refundAllocations: [
            {
              lineItemId: line._id.toString(),
              refundAmountInPaise: netAmountPaise,
            },
          ],
          customerMembershipId: membership._id,
          reason,
          organizationId,
          branchId,
          userId,
          session,
        });

      await emitBillingOutboxEvent({
        eventType: "invoice.refunded",
        invoice,
        operationId: String(refundPayment[0]._id),
        amountInPaise: netAmountPaise,
        session,
      });

      const grossLineAmount = Number(line.lineTotal || 0);
      const lineDiscountAmount = Math.max(
        0,
        Number((grossLineAmount - refundAmount).toFixed(2)),
      );
      invoice.subtotal = Math.max(
        0,
        Number((Number(invoice.subtotal || 0) - grossLineAmount).toFixed(2)),
      );
      invoice.discountTotal = Math.max(
        0,
        Number(
          (Number(invoice.discountTotal || 0) - lineDiscountAmount).toFixed(2),
        ),
      );
      invoice.grossPayable = Math.max(
        0,
        Number(
          (Number(invoice.grossPayable || 0) - grossLineAmount).toFixed(2),
        ),
      );
      invoice.payableAmount = Math.max(
        0,
        Number((Number(invoice.payableAmount || 0) - refundAmount).toFixed(2)),
      );
      invoice.amountPaid = Math.max(
        0,
        Number((Number(invoice.amountPaid || 0) - refundAmount).toFixed(2)),
      );
      invoice.amountDue = Math.max(
        0,
        Number((invoice.payableAmount - invoice.amountPaid).toFixed(2)),
      );
      invoice.paymentStatus = this.derivePaymentStatus(
        invoice.amountPaid,
        invoice.amountDue,
      );
      await invoice.save({ session });

      await new AuditLog({
        organizationId,
        branchId,
        actorId: userId,
        action: AUDIT_ACTIONS.INVOICE_RETURN_PROCESSED,
        entityType: "Invoice",
        entityId: invoice._id,
        description:
          "Unused membership refund recorded and membership cancelled",
        metadata: {
          invoiceId: invoice._id,
          lineId: line._id,
          paymentId: refundPayment[0]._id,
          refundEventId: refundEvent?._id || null,
          amount: refundAmount,
          reason,
          manualRefundRecord: true,
        },
      }).save({ session });

      return {
        invoice,
        refundPayment: refundPayment[0],
        refundEvent,
        idempotentReplay: false,
        manualRefundRecord: true,
      };
    }).catch(async (error) => {
      if (error?.code !== 11000) throw error;
      const existingPayment = await Payment.findOne({
        organizationId,
        idempotencyKey: refundPaymentKey,
        type: "refund",
        isDeleted: false,
      });
      if (!existingPayment) throw error;
      if (
        existingPayment.requestPayloadHash !== requestPayloadHash ||
        existingPayment.invoiceId.toString() !== String(invoiceId)
      ) {
        throw new AppError(
          "Idempotency key was already used for a different membership refund",
          409,
        );
      }
      const [invoice, refundEvent] = await Promise.all([
        Invoice.findOne({ _id: invoiceId, organizationId, isDeleted: false }),
        InvoiceSettlementEvent.findOne({
          organizationId,
          paymentId: existingPayment._id,
          eventType: "RETURN_PROCESSED",
        }),
      ]);
      return {
        invoice,
        refundPayment: existingPayment,
        refundEvent,
        idempotentReplay: true,
        manualRefundRecord: true,
      };
    });
  }

  async processInvoiceReturn(
    invoiceId,
    payload,
    organizationId,
    branchId,
    userId,
    idempotencyKey,
  ) {
    const { items = [], refundPaymentMethod = "cash", reason } = payload;
    if (!idempotencyKey || idempotencyKey.length > 200) {
      throw new AppError(
        "A valid Idempotency-Key header is required for invoice returns",
        400,
      );
    }

    const normalizedItems = items
      .map((item) => ({
        lineId: String(item.lineId),
        quantity: Number(item.quantity),
        condition: item.condition || "unopened",
        acceptPhysicalRestock: item.acceptPhysicalRestock === true,
        restockReason: item.restockReason || "",
      }))
      .sort((a, b) => a.lineId.localeCompare(b.lineId));
    if (
      new Set(normalizedItems.map((item) => item.lineId)).size !==
      normalizedItems.length
    ) {
      throw new AppError(
        "A return request cannot contain the same invoice line more than once",
        400,
      );
    }

    const createResult = await refundService.createPendingRefundCase(
      invoiceId,
      {
        branchId,
        refundMode: "item_linked",
        refundMethod: refundPaymentMethod,
        items: normalizedItems.map((item) => ({
          lineId: item.lineId,
          quantity: item.quantity,
          acceptPhysicalRestock: item.acceptPhysicalRestock,
        })),
        reason,
      },
      organizationId,
      branchId,
      userId,
      idempotencyKey,
    );

    const refundCaseId = createResult.refundCase._id;
    const settleResult = await refundService.settleRefundCase(
      invoiceId,
      refundCaseId,
      {
        branchId,
        settlementType: "refund",
        refundMethod: refundPaymentMethod,
        reason,
      },
      organizationId,
      branchId,
      userId,
      `SETTLE:${idempotencyKey}`,
    );

    const invoice = await Invoice.findOne({
      _id: invoiceId,
      organizationId,
      isDeleted: false,
    });

    const movementIds =
      settleResult.domainReversals?.inventory?.movementIds || [];
    const restockedMovements =
      movementIds.length > 0
        ? await StockMovement.find({
            _id: { $in: movementIds },
            organizationId,
          })
        : [];

    const settledAmountPaise = Number(
      settleResult.refundCase?.settledAmountPaise || 0,
    );

    return {
      invoice,
      totalRefundAmount: settledAmountPaise / 100,
      refundPayment: settleResult.refundPayment,
      restockedMovements,
      refundCase: settleResult.refundCase,
      domainReversals: settleResult.domainReversals,
      isIdempotentReplay: Boolean(
        createResult.isIdempotentReplay || settleResult.isIdempotentReplay,
      ),
    };
  }

  /**
   * List active membership plans for checkout catalog and membership upselling
   */
  async listMembershipPlans(organizationId, query = {}) {
    const filter = {
      organizationId,
      status: "active",
      isDeleted: false,
    };
    if (query.branchId && query.branchId !== "all") {
      filter.$or = [
        { permittedBranchIds: { $size: 0 } },
        { permittedBranchIds: query.branchId },
      ];
    }
    return MembershipPlan.find(filter).sort({ price: 1 }).lean();
  }
}

export const billingService = new BillingService();
