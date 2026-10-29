import mongoose from "mongoose";
import { AppError } from "../../utils/errors.js";
import { Invoice } from "../../models/billing/invoice.model.js";
import { Payment } from "../../models/billing/payment.model.js";
import { Appointment } from "../../models/appointments/appointment.model.js";
import { Subscription } from "../../models/subscriptions/subscription.model.js";
import { Customer } from "../../models/customers/customer.model.js";
import { Sequence } from "../../models/sequence/sequence.model.js";
import { AuditLog, AUDIT_ACTIONS } from "../../models/audit/auditLog.model.js";
import { invoiceRepository } from "../../repositories/billing/invoice.repository.js";
import { paymentRepository } from "../../repositories/billing/payment.repository.js";

import crypto from "crypto";
import { Branch } from "../../models/branches/branch.model.js";
import { Organization } from "../../models/organizations/organization.model.js";
import { generateInvoicePdf as createInvoicePdf } from "./invoicePdf.service.js";
import { runInTransaction } from "../../utils/transaction.js";
import { loyaltyService } from "../loyalty/loyalty.service.js";

export class BillingService {
  /**
   * Option B: Allocates discount only to uncovered, customer-payable services.
   * Enforces exact reconciliation between invoice header and line items.
   */
  calculateInvoiceTotals(lines, desiredDiscount) {
    let subtotal = 0;
    let totalSubscriptionCoverage = 0;
    let uncoveredTotal = 0;

    for (const line of lines) {
      subtotal = Number((subtotal + line.lineTotal).toFixed(2));
      if (line.isCoveredBySubscription) {
        totalSubscriptionCoverage = Number((totalSubscriptionCoverage + line.subscriptionCoveredAmount).toFixed(2));
      } else {
        uncoveredTotal = Number((uncoveredTotal + line.lineTotal).toFixed(2));
      }
    }

    // Discount applies strictly to uncovered services, capped at their total
    const effectiveDiscount = Math.min(
      uncoveredTotal,
      Math.max(0, Number(Number(desiredDiscount || 0).toFixed(2)))
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
          ((line.appointmentServiceId && uncoveredLines[uncoveredLines.length - 1].appointmentServiceId &&
            line.appointmentServiceId.toString() === uncoveredLines[uncoveredLines.length - 1].appointmentServiceId.toString()) ||
           i === lines.length - 1);

        if (uncoveredTotal === 0 || effectiveDiscount === 0) {
          line.discountAmount = 0;
          line.customerPayable = line.lineTotal;
        } else if (isLastUncovered) {
          line.discountAmount = Number(remainingDiscountToDistribute.toFixed(2));
          line.customerPayable = Math.max(0, Number((line.lineTotal - line.discountAmount).toFixed(2)));
          remainingDiscountToDistribute = 0;
        } else {
          const proportional = Number(((line.lineTotal / uncoveredTotal) * effectiveDiscount).toFixed(2));
          const allocated = Math.min(remainingDiscountToDistribute, proportional);
          line.discountAmount = allocated;
          line.customerPayable = Math.max(0, Number((line.lineTotal - allocated).toFixed(2)));
          remainingDiscountToDistribute = Number((remainingDiscountToDistribute - allocated).toFixed(2));
        }
      }
    }

    const grossPayable = Math.max(0, Number((subtotal - effectiveDiscount).toFixed(2)));
    const payableAmount = Math.max(0, Number((grossPayable - totalSubscriptionCoverage).toFixed(2)));

    return {
      subtotal: Number(subtotal.toFixed(2)),
      discountTotal: Number(effectiveDiscount.toFixed(2)),
      grossPayable,
      subscriptionCoveredAmount: Number(totalSubscriptionCoverage.toFixed(2)),
      payableAmount,
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
      { new: true, upsert: true }
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
      { new: true, upsert: true }
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
  async executeTransaction(callback, { requireTransaction = false } = {}) {
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
  async createInvoiceFromAppointment(data, organizationId, userId, session = null) {
    const { appointmentId, branchId, discount, redeemLoyaltyPoints, notes = "" } = data;

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
      throw new AppError("Target branchId does not match appointment branch", 400);
    }

    // Appointment status validation: cannot bill cancelled or no_show appointments
    if (["cancelled", "no_show"].includes(appointment.status)) {
      throw new AppError(`Cannot create invoice for appointment in '${appointment.status}' status`, 400);
    }

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
        400
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
    const appointmentPricingSnapshot = {
      subtotal: appointment.pricing?.subtotal ?? 0,
      discount: appointment.pricing?.discount ?? 0,
      total: appointment.pricing?.total ?? 0,
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
          const isCorrectOrg = sub.organizationId.toString() === organizationId.toString();
          
          let member = null;
          let isCustomerEnrolled = false;
          if (Array.isArray(sub.members) && sub.members.length > 0) {
            member = sub.members.find(
              (m) => m.customerId.toString() === appointment.customerId.toString()
            );
            isCustomerEnrolled = Boolean(member) && ["active", "pending_payment"].includes(member.status);
          } else {
            isCustomerEnrolled = sub.customerId.toString() === appointment.customerId.toString();
          }

          const isAllowedStatus = ["active", "pending_payment"].includes(sub.status);
          const isWithinDates =
            (!sub.startDate || new Date(sub.startDate) <= now) &&
            (!sub.endDate || new Date(sub.endDate) >= now);

          const branchRestrictions = member && Array.isArray(member.permittedBranchIds) && member.permittedBranchIds.length > 0
            ? member.permittedBranchIds
            : sub.permittedBranchIds;

          let isPermittedBranch = true;
          if (Array.isArray(branchRestrictions) && branchRestrictions.length > 0) {
            isPermittedBranch = branchRestrictions.some(
              (b) => b.toString() === aptBranchIdStr
            );
          }

          if (isCorrectOrg && isCustomerEnrolled && isAllowedStatus && isWithinDates && isPermittedBranch) {
            const sIdStr = s.serviceId ? s.serviceId.toString() : null;
            const entitlementsList = member ? member.entitlements : sub.entitlements;
            const entitlement = (entitlementsList || []).find(
              (e) => e.serviceId && e.serviceId.toString() === sIdStr
            );
            if (entitlement && (entitlement.remainingQuantity || 0) > 0) {
              const allocKey = `${sub._id.toString()}_${sIdStr}`;
              const currentlyAllocated = allocatedEntitlementCounts.get(allocKey) || 0;
              if (currentlyAllocated < entitlement.remainingQuantity) {
                isCovered = true;
                allocatedEntitlementCounts.set(allocKey, currentlyAllocated + 1);
              }
            }
          }
        }
      }

      const subscriptionCoveredAmount = isCovered ? lineTotal : 0;

      return {
        serviceType: s.serviceType || "registered",
        serviceId: s.serviceId || null,
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
        customerPayable: Math.max(0, Number((lineTotal - subscriptionCoveredAmount).toFixed(2))),
      };
    });

    // Discount resolution: use override if explicitly provided, else seed from appointment
    const effectiveDiscountInput = discount !== undefined && discount !== null ? discount : data.discountTotal;
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
      const preTotals = this.calculateInvoiceTotals(invoiceLines, standardDiscount);
      const eligibleAmount = preTotals.payableAmount;

      const preview = await loyaltyService.previewRedemption(
        customer._id,
        eligibleAmount,
        redeemLoyaltyPoints,
        organizationId
      );

      loyaltyRedeemedPoints = preview.appliedPoints;
      loyaltyDiscountAmount = preview.appliedDiscount;
    }

    const totalDiscountToAllocate = Number((standardDiscount + loyaltyDiscountAmount).toFixed(2));

    // Calculate totals and allocate discount to uncovered lines strictly
    const totals = this.calculateInvoiceTotals(invoiceLines, totalDiscountToAllocate);

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
    } catch (err) {
      if (err.code === 11000) {
        throw new AppError("An active invoice already exists for this appointment", 409);
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

    return invoiceDoc;
  }

  /**
   * 1b. CREATE DRAFT OR FINALIZED INVOICE FOR SUBSCRIPTION SALE
   */
  async createInvoiceForSubscriptionSale(data, organizationId, userId, session = null) {
    const { subscriptionId, branchId, discount = 0, redeemLoyaltyPoints = 0, notes = "" } = data;

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
        400
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
      throw new AppError("Customer record not found for this subscription", 404);
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

    let standardDiscount = Number(Number(discount || 0).toFixed(2));
    if (standardDiscount < 0) {
      throw new AppError("Discount cannot be negative", 400);
    }

    let loyaltyRedeemedPoints = 0;
    let loyaltyDiscountAmount = 0;

    if (redeemLoyaltyPoints && Number(redeemLoyaltyPoints) > 0) {
      const preTotals = this.calculateInvoiceTotals(invoiceLines, standardDiscount);
      const eligibleAmount = preTotals.payableAmount;

      const preview = await loyaltyService.previewRedemption(
        customer._id,
        eligibleAmount,
        redeemLoyaltyPoints,
        organizationId
      );

      loyaltyRedeemedPoints = preview.appliedPoints;
      loyaltyDiscountAmount = preview.appliedDiscount;
    }

    const totalDiscountToAllocate = Number((standardDiscount + loyaltyDiscountAmount).toFixed(2));
    const totals = this.calculateInvoiceTotals(invoiceLines, totalDiscountToAllocate);

    const amountPaid = 0;
    const amountDue = totals.payableAmount;
    const paymentStatus = this.derivePaymentStatus(amountPaid, amountDue);

    const invoiceNumber = await this.generateInvoiceNumber(organizationId);

    const invoiceDoc = new Invoice({
      organizationId,
      branchId,
      invoiceNumber,
      invoiceType: "subscription",
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
    } catch (err) {
      if (err.code === 11000) {
        throw new AppError("An active invoice already exists for this subscription", 409);
      }
      throw err;
    }

    // Link invoiceId to subscription document
    subscription.invoiceId = invoiceDoc._id;
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
      throw new AppError(`Cannot modify invoice with status '${invoice.status}'. Only draft invoices may be modified.`, 400);
    }

    if (updates.notes !== undefined) {
      invoice.notes = updates.notes;
    }

    if (updates.discountTotal !== undefined || updates.redeemLoyaltyPoints !== undefined) {
      let standardDiscount = updates.discountTotal !== undefined
        ? Number(Number(updates.discountTotal).toFixed(2))
        : (invoice.discountTotal - (invoice.loyaltyDiscountAmount || 0));

      if (standardDiscount < 0) {
        throw new AppError("Discount cannot be negative", 400);
      }

      let pointsToRedeem = updates.redeemLoyaltyPoints !== undefined
        ? Number(updates.redeemLoyaltyPoints)
        : (invoice.loyaltyRedeemedPoints || 0);

      let loyaltyDiscountAmount = 0;
      let loyaltyRedeemedPoints = 0;

      const lines = invoice.lines.map((l) => (l.toObject ? l.toObject() : { ...l }));

      if (pointsToRedeem > 0) {
        const preTotals = this.calculateInvoiceTotals(lines, standardDiscount);
        const eligibleAmount = preTotals.payableAmount;

        const preview = await loyaltyService.previewRedemption(
          invoice.customerId,
          eligibleAmount,
          pointsToRedeem,
          organizationId
        );

        loyaltyRedeemedPoints = preview.appliedPoints;
        loyaltyDiscountAmount = preview.appliedDiscount;
      }

      const totalDiscount = Number((standardDiscount + loyaltyDiscountAmount).toFixed(2));
      const totals = this.calculateInvoiceTotals(lines, totalDiscount);

      invoice.lines = lines;
      invoice.discountTotal = totals.discountTotal;
      invoice.loyaltyRedeemedPoints = loyaltyRedeemedPoints;
      invoice.loyaltyDiscountAmount = loyaltyDiscountAmount;
      invoice.grossPayable = totals.grossPayable;
      invoice.subscriptionCoveredAmount = totals.subscriptionCoveredAmount;
      invoice.payableAmount = totals.payableAmount;
      invoice.amountDue = Math.max(0, Number((invoice.payableAmount - invoice.amountPaid).toFixed(2)));
      invoice.paymentStatus = this.derivePaymentStatus(invoice.amountPaid, invoice.amountDue);
    }

    await invoice.save();
    return invoice;
  }

  /**
   * 3. FINALIZE INVOICE (FREEZE FINANCIAL TOTALS)
   */
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
        throw new AppError("Target branchId does not match invoice branch", 400);
      }

      if (invoice.status !== "draft") {
        throw new AppError(`Cannot finalize invoice with status '${invoice.status}'. Must be 'draft'.`, 400);
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
      invoice.paymentStatus = this.derivePaymentStatus(invoice.amountPaid, invoice.amountDue);

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
        throw new AppError("Target branchId does not match invoice branch", 400);
      }

      if (invoice.status === "cancelled") {
        throw new AppError("Invoice is already cancelled", 400);
      }

      if (invoice.amountPaid > 0) {
        throw new AppError("Cannot cancel an invoice with recorded payments. Void all payments first.", 400);
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

      invoice.status = "cancelled";
      invoice.cancelledAt = new Date();
      invoice.cancelledBy = userId;
      invoice.cancellationReason = reason;

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
  async recordPayment(invoiceId, paymentData, organizationId, branchId, userId) {
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
        if (existingPayment.requestPayloadHash !== requestPayloadHash || existingPayment.invoiceId.toString() !== invoiceId.toString()) {
          throw new AppError("Idempotency key reuse with differing payment parameters or target invoice", 409);
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

    return await this.executeTransaction(async (session) => {
      // Re-check idempotency key within transaction to guard against concurrent attempts
      if (idempotencyKey) {
        const racePayment = await Payment.findOne({
          organizationId,
          idempotencyKey,
          isDeleted: false,
        }).session(session);

        if (racePayment) {
          if (racePayment.requestPayloadHash !== requestPayloadHash || racePayment.invoiceId.toString() !== invoiceId.toString()) {
            throw new AppError("Idempotency key reuse with differing payment parameters or target invoice", 409);
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
        throw new AppError("Target branchId does not match invoice branch", 400);
      }

      if (invoice.status !== "finalized") {
        throw new AppError(`Cannot record payment on invoice with status '${invoice.status}'. Must be 'finalized'.`, 400);
      }

      if (paymentAmount > invoice.amountDue) {
        throw new AppError(`Payment amount (₹${paymentAmount}) exceeds outstanding balance (₹${invoice.amountDue})`, 400);
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
        { new: true, session }
      );

      if (!updatedInvoice) {
        throw new AppError("Concurrent modification or payment exceeds remaining balance", 409);
      }

      // Derive payment status
      updatedInvoice.paymentStatus = this.derivePaymentStatus(
        updatedInvoice.amountPaid,
        updatedInvoice.amountDue
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
        if (err.code === 11000 && idempotencyKey && err.keyPattern?.idempotencyKey) {
          throw new AppError("Concurrent payment submission with identical idempotency key detected", 409);
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

      // If invoice has now reached fully settled 'paid' status, award loyalty points atomically
      if (updatedInvoice.paymentStatus === "paid") {
        await loyaltyService.awardPointsForSettledInvoice({
          invoice: updatedInvoice,
          payment: paymentDoc,
          actorId: userId,
          session,
        });

        // If this invoice represents a subscription sale, activate the subscription atomically
        if (updatedInvoice.invoiceType === "subscription" && updatedInvoice.subscriptionId) {
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
              const { subscriptionService } = await import("../subscriptions/subscription.service.js");
              if (subscriptionService && typeof subscriptionService.reassessCustomerUpcomingAppointments === "function") {
                await subscriptionService.reassessCustomerUpcomingAppointments(
                  targetSub.customerId,
                  organizationId,
                  targetSub,
                  session
                );
              }
            } catch (reassessErr) {
              // Non-blocking logger if circular or already reassessed
            }
          }
        }
      }

      return {
        payment: paymentDoc,
        invoice: updatedInvoice,
      };
    });
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
        throw new AppError("Target branchId does not match payment branch", 400);
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
        { new: true, session }
      );

      // Re-evaluate payment status
      updatedInvoice.paymentStatus = this.derivePaymentStatus(
        updatedInvoice.amountPaid,
        updatedInvoice.amountDue
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

      // If the invoice was previously paid/settled, reverse any earned loyalty points atomically
      if (invoice.paymentStatus === "paid" && updatedInvoice.paymentStatus !== "paid") {
        await loyaltyService.reverseEarningForVoidedPayment({
          invoice: updatedInvoice,
          payment,
          actorId: userId,
          session,
        });

        // If this is a subscription invoice, revert subscription status back to pending_payment
        if (updatedInvoice.invoiceType === "subscription" || updatedInvoice.subscriptionId) {
          const subId = updatedInvoice.subscriptionId;
          if (subId) {
            const subToRevert = await Subscription.findOne({ _id: subId, organizationId }).session(session);
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
        const branch = await Branch.findOne({ _id: branchId, organizationId }).select("timezone").lean();
        if (branch?.timezone) {
          timezone = branch.timezone;
        }
      }

      const getTimezoneOffsetMs = (date, tz) => {
        try {
          const utcDate = new Date(date.toLocaleString("en-US", { timeZone: "UTC" }));
          const tzDate = new Date(date.toLocaleString("en-US", { timeZone: tz }));
          return tzDate.getTime() - utcDate.getTime();
        } catch {
          return 5.5 * 60 * 60 * 1000;
        }
      };

      const parseLocalToUTC = (dateStr, timeStr, tz) => {
        const [year, month, day] = dateStr.split("-").map(Number);
        const [hours, minutes, seconds = 0, ms = 0] = timeStr.split(/[:.]/).map(Number);
        const nominalUtc = new Date(Date.UTC(year, month - 1, day, hours, minutes, seconds, ms));
        const offsetMs = getTimezoneOffsetMs(nominalUtc, tz);
        return new Date(nominalUtc.getTime() - offsetMs);
      };

      if (listFilter.startDate) {
        listFilter.startDateBoundary = parseLocalToUTC(listFilter.startDate, "00:00:00.000", timezone);
      }
      if (listFilter.endDate) {
        listFilter.endDateBoundary = parseLocalToUTC(listFilter.endDate, "23:59:59.999", timezone);
      }
    }

    return await invoiceRepository.list(listFilter, pagination, organizationId, branchId);
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
  async generateInvoicePdf(invoiceId, organizationId, branchId = null) {
    const query = { _id: invoiceId, organizationId, isDeleted: false };
    if (branchId) {
      query.branchId = branchId;
    }

    const invoice = await Invoice.findOne(query)
      .populate("branchId", "name address phone timezone")
      .populate("customerId", "name phone email")
      .populate({
        path: "lines.appliedSubscriptionId",
        select: "subscriptionCode planId",
        populate: { path: "planId", select: "name" },
      });

    if (!invoice) {
      throw new AppError("Invoice not found", 404);
    }

    // Branch document
    const branch = invoice.branchId || (await Branch.findById(invoice.branchId));

    // Organization document
    const organization = await Organization.findById(organizationId);

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
    })
      .sort({ createdAt: 1 });

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
  async getCheckoutQueue({ organizationId, branchId, date }) {
    const matchStage = {
      organizationId: new mongoose.Types.ObjectId(organizationId),
      status: { $in: ["in_progress", "completed"] },
      isDeleted: { $ne: true },
    };

    if (branchId) {
      matchStage.branchId = new mongoose.Types.ObjectId(branchId);
    }

    if (date) {
      matchStage.$or = [{ appointmentDate: date }, { date: date }];
    } else {
      // Default to today's date in YYYY-MM-DD interpreted in Branch Timezone
      let tz = "Asia/Kolkata";
      if (branchId) {
        const branchDoc = await Branch.findOne({ _id: branchId, organizationId }).lean();
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
              { $subtract: ["$pricing.subtotal", { $ifNull: ["$pricing.discount", 0] }] },
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
        branchId: item.branchId ? item?.branchId?.toString() : (branchId ? branchId.toString() : null),
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
}

export const billingService = new BillingService();
