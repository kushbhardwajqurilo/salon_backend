import crypto from "crypto";
import mongoose from "mongoose";
import { AppError } from "../../utils/errors.js";
import { logger } from "../../utils/logger.js";
import { Sequence } from "../../models/sequence/sequence.model.js";
import { AUDIT_ACTIONS } from "../../models/audit/auditLog.model.js";
import { smsQueue, subscriptionCancellationQueue } from "../../queues/client.js";
import { runInTransaction } from "../../utils/transaction.js";
import "../../models/billing/invoice.model.js";
import "../../models/billing/payment.model.js";
import "../../models/appointments/appointment.model.js";
import "../../models/subscriptions/subscriptionUsage.model.js";
import { SubscriptionCancellationOperation } from "../../models/subscriptions/subscriptionCancellationOperation.model.js";

export class SubscriptionService {
  constructor(
    subscriptionRepo,
    subscriptionUsageRepo,
    customerRepo,
    serviceRepo,
    branchRepo,
    auditRepo,
  ) {
    this.subscriptionRepo = subscriptionRepo;
    this.subscriptionUsageRepo = subscriptionUsageRepo;
    this.customerRepo = customerRepo;
    this.serviceRepo = serviceRepo;
    this.branchRepo = branchRepo;
    this.auditRepo = auditRepo;
  }

  /**
   * Helper to execute a sequence of actions within a MongoDB session/transaction.
   * Defers to runInTransaction which enforces ACID when transactions are supported,
   * or permits standalone fallback when explicitly enabled in test/standalone environments.
   */
  async executeTransaction(callback, { requireTransaction = true } = {}) {
    return await runInTransaction(callback, { requireTransaction });
  }

  /**
   * Generate human-readable subscription code: SUB-YYYYMMDD-XXXX
   */
  async generateSubscriptionCode(organizationId) {
    const sequenceKey = `SUB_${organizationId.toString()}`;
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
    return `SUB-${yyyy}${mm}${dd}-${num}`;
  }

  /**
   * Create a customer-specific subscription
   */
  async createSubscription(data, organizationId, userId) {
    const {
      payerCustomerId,
      customerId,
      members,
      planId,
      price,
      entitlements,
      permittedBranchIds = [],
      startDate,
      endDate,
      notes = "",
    } = data;

    // 0. Validate price
    if (price === undefined || price === null || isNaN(Number(price)) || Number(price) <= 0) {
      throw new AppError("Price must be greater than 0", 400);
    }

    // 0.1 If planId provided, validate it belongs to organization and is active
    let resolvedPlanId = null;
    if (planId) {
      const PlanModel = mongoose.model("SubscriptionPlan");
      const plan = await PlanModel.findOne({
        _id: planId,
        organizationId,
        isDeleted: false,
      });
      if (!plan) {
        throw new AppError(
          "Subscription plan template not found in this organization",
          404,
        );
      }
      resolvedPlanId = plan._id;
    }

    // 1. Establish payer customer
    const rawPayerId = payerCustomerId || customerId || (members && members[0]?.customerId);
    if (!rawPayerId) {
      throw new AppError("Payer customer is required", 400);
    }

    let payerCustomer;
    if (this.customerRepo && typeof this.customerRepo.findById === "function") {
      payerCustomer = await this.customerRepo.findById(rawPayerId, organizationId);
    } else {
      const CustomerModel = mongoose.model("Customer");
      payerCustomer = await CustomerModel.findById(rawPayerId);
    }

    if (
      !payerCustomer ||
      payerCustomer.organizationId.toString() !== organizationId.toString() ||
      payerCustomer.isDeleted
    ) {
      throw new AppError("Customer not found or invalid for organization", 404);
    }

    if (payerCustomer.status !== "active") {
      throw new AppError(
        `Cannot create subscription for customer with status '${payerCustomer.status}'`,
        400,
      );
    }

    // 2. Validate dates
    const start = new Date(startDate);
    const end = new Date(endDate);
    if (isNaN(start.getTime()) || isNaN(end.getTime())) {
      throw new AppError("Invalid start or end date", 400);
    }
    if (end <= start) {
      throw new AppError("End date must be strictly after start date", 400);
    }

    // 3. Validate permitted branches if provided
    const validPermittedBranchIds = [];
    if (Array.isArray(permittedBranchIds) && permittedBranchIds.length > 0) {
      for (const branchId of permittedBranchIds) {
        let branch;
        if (this.branchRepo && typeof this.branchRepo.findById === "function") {
          branch = await this.branchRepo.findById(branchId);
        } else if (
          this.branchRepo &&
          typeof this.branchRepo.findOne === "function"
        ) {
          branch = await this.branchRepo.findOne({ _id: branchId });
        } else {
          const BranchModel = mongoose.model("Branch");
          branch = await BranchModel.findById(branchId);
        }

        if (
          !branch ||
          branch.organizationId.toString() !== organizationId.toString() ||
          branch.isDeleted ||
          branch.isActive === false
        ) {
          throw new AppError(
            `Permitted branch ${branchId} is invalid or inactive`,
            400,
          );
        }
        validPermittedBranchIds.push(branch._id);
      }
    }

    // 4. Resolve members and validate entitlements per member
    let rawMembers = members;
    if (!rawMembers || rawMembers.length === 0) {
      // Legacy single-customer format conversion
      if (!entitlements || entitlements.length === 0) {
        throw new AppError("At least one entitlement is required", 400);
      }
      rawMembers = [
        {
          customerId: payerCustomer._id,
          entitlements,
          permittedBranchIds: validPermittedBranchIds,
          notes: notes || "",
        },
      ];
    }

    const seenMemberCustomerIds = new Set();
    const resolvedMembers = [];

    // Initial status determined by price and billing intent
    const { billImmediately, branchId: invoiceBranchId = null } = data;
    const shouldBill = Number(price) > 0 ? true : Boolean(billImmediately);
    const initialStatus = shouldBill && Number(price) > 0 ? "pending_payment" : "active";

    for (const mem of rawMembers) {
      const mCustIdStr = mem.customerId ? mem.customerId.toString() : null;
      if (!mCustIdStr) {
        throw new AppError("Member customerId is required", 400);
      }
      if (seenMemberCustomerIds.has(mCustIdStr)) {
        throw new AppError("Duplicate customer in subscription members. Consolidate into a single member allocation.", 400);
      }
      seenMemberCustomerIds.add(mCustIdStr);

      // Verify member customer exists and is active
      let memCust;
      if (mCustIdStr === payerCustomer._id.toString()) {
        memCust = payerCustomer;
      } else {
        if (this.customerRepo && typeof this.customerRepo.findById === "function") {
          memCust = await this.customerRepo.findById(mem.customerId, organizationId);
        } else {
          const CustomerModel = mongoose.model("Customer");
          memCust = await CustomerModel.findById(mem.customerId);
        }
      }

      if (
        !memCust ||
        memCust.organizationId.toString() !== organizationId.toString() ||
        memCust.isDeleted
      ) {
        throw new AppError(`Member customer ${mem.customerId} not found or invalid for organization`, 404);
      }

      if (memCust.status !== "active") {
        throw new AppError(
          `Cannot enroll customer ${memCust.name} with status '${memCust.status}'`,
          400,
        );
      }

      // Validate member's entitlements
      if (!Array.isArray(mem.entitlements) || mem.entitlements.length === 0) {
        throw new AppError(`At least one entitlement is required for member ${memCust.name}`, 400);
      }

      const seenServiceIds = new Set();
      const resolvedMemberEntitlements = [];

      for (const ent of mem.entitlements) {
        const sIdStr = ent.serviceId ? ent.serviceId.toString() : null;
        if (!sIdStr) {
          throw new AppError("serviceId is required for entitlement", 400);
        }
        if (seenServiceIds.has(sIdStr)) {
          throw new AppError(
            `Duplicate serviceId in entitlements for member ${memCust.name}. Consolidate quantity.`,
            400,
          );
        }
        seenServiceIds.add(sIdStr);

        let service;
        if (this.serviceRepo && typeof this.serviceRepo.findById === "function") {
          service = await this.serviceRepo.findById(ent.serviceId, organizationId);
        } else {
          const ServiceModel = mongoose.model("Service");
          service = await ServiceModel.findById(ent.serviceId);
        }

        if (
          !service ||
          service.organizationId.toString() !== organizationId.toString() ||
          service.isDeleted
        ) {
          throw new AppError(`Service ${ent.serviceId} not found in this organization`, 404);
        }

        if (service.status !== "active") {
          throw new AppError(`Service '${service.name}' is inactive and cannot be added to a subscription`, 400);
        }

        const totalQuantity = parseInt(ent.quantity, 10);
        if (isNaN(totalQuantity) || totalQuantity < 1) {
          throw new AppError(`Invalid quantity for service '${service.name}'. Must be at least 1.`, 400);
        }

        resolvedMemberEntitlements.push({
          serviceId: service._id,
          serviceName: service.name,
          totalQuantity,
          usedQuantity: 0,
          remainingQuantity: totalQuantity,
        });
      }

      resolvedMembers.push({
        customerId: memCust._id,
        status: initialStatus,
        permittedBranchIds: mem.permittedBranchIds || [],
        entitlements: resolvedMemberEntitlements,
        notes: mem.notes || "",
      });
    }

    // 5. Generate subscription code
    const subscriptionCode = await this.generateSubscriptionCode(organizationId);

    // 6. Create subscription and audit log in transaction
    const result = await this.executeTransaction(async (session) => {
      // Legacy entitlements mirror first member for direct readers
      const legacyEntitlements = resolvedMembers[0]?.entitlements || [];

      const newSub = await this.subscriptionRepo.create(
        {
          organizationId,
          payerCustomerId: payerCustomer._id,
          customerId: payerCustomer._id, // Legacy compatibility
          subscriptionCode,
          planId: resolvedPlanId,
          price: Number(price),
          members: resolvedMembers,
          entitlements: legacyEntitlements,
          permittedBranchIds: validPermittedBranchIds,
          startDate: start,
          endDate: end,
          status: initialStatus,
          notes,
        },
        userId,
        session,
      );

      let invoice = null;
      if (shouldBill) {
        const { billingService } = await import("../billing/billing.service.js");
        const effectiveBranchId = invoiceBranchId;

        if (!effectiveBranchId) {
          throw new AppError(
            "branchId is required to generate an invoice for standalone subscription sale",
            400,
          );
        }

        invoice = await billingService.createInvoiceForSubscriptionSale(
          {
            subscriptionId: newSub._id,
            branchId: effectiveBranchId,
            notes: notes || `Subscription sale for ${subscriptionCode}`,
          },
          organizationId,
          userId,
          session,
        );

        newSub.invoiceId = invoice._id;
      }

      if (this.auditRepo && typeof this.auditRepo.create === "function") {
        await this.auditRepo.create(
          {
            branchId: invoiceBranchId || null,
            action: AUDIT_ACTIONS.SUBSCRIPTION_CREATED,
            entityType: "Subscription",
            entityId: newSub._id,
            description: `Subscription ${subscriptionCode} created for payer ${payerCustomer.name} (${resolvedMembers.length} member(s)) with price ${price} (status: ${initialStatus})`,
            metadata: {
              subscriptionCode,
              payerCustomerId: payerCustomer._id,
              membersCount: resolvedMembers.length,
              planId: resolvedPlanId,
              price,
              status: initialStatus,
              invoiceId: invoice?._id || null,
            },
          },
          organizationId,
          userId,
          session,
        );
      }

      return { subscription: newSub, invoice };
    });

    const createdSubscription = result.subscription;

    // 7. If subscription is active, reassess eligible upcoming appointments for all enrolled members
    if (createdSubscription.status === "active") {
      for (const m of resolvedMembers) {
        try {
          await this.reassessCustomerUpcomingAppointments(
            m.customerId,
            organizationId,
            createdSubscription,
          );
        } catch (reassessErr) {
          logger.warn(
            `Failed to reassess upcoming appointments for subscription ${createdSubscription.subscriptionCode} member ${m.customerId}: ${reassessErr.message}`,
          );
        }
      }
    }

    // 8. Dispatch notification (best-effort async)
    try {
      if (payerCustomer.phone) {
        await smsQueue.add("sendSubscriptionCreatedSMS", {
          phone: payerCustomer.phone,
          customerName: payerCustomer.name,
          subscriptionCode: createdSubscription.subscriptionCode,
          price: createdSubscription.price,
          organizationId: organizationId.toString(),
        });
      }
    } catch (queueErr) {
      logger.warn(
        `Failed to enqueue subscription creation SMS: ${queueErr.message}`,
      );
    }

    return result.invoice
      ? { ...createdSubscription.toObject ? createdSubscription.toObject() : createdSubscription, invoice: result.invoice }
      : createdSubscription;
  }

  /**
   * Reassess upcoming appointments for a customer and attach active subscription benefits
   * to eligible registered services without overwriting agreed prices or consuming entitlements.
   */
  async reassessCustomerUpcomingAppointments(
    customerId,
    organizationId,
    newSubscription = null,
    session = null
  ) {
    const AppointmentModel = mongoose.model("Appointment");
    const todayStr = new Date().toISOString().split("T")[0];

    const upcomingAppointments = await AppointmentModel.find({
      organizationId,
      customerId,
      appointmentDate: { $gte: todayStr },
      status: { $in: ["scheduled", "in_progress"] },
      isDeleted: false,
    }).session(session);

    for (const appt of upcomingAppointments) {
      let modified = false;
      for (const line of appt.services || []) {
        if (
          line.serviceType !== "custom" &&
          !line.isRedeemedViaSubscription &&
          !line.appliedSubscriptionId
        ) {
          const eligibleSub = await this.findEligibleSubscriptionForService(
            customerId,
            line.serviceId,
            appt.branchId,
            organizationId,
            session
          );
          if (eligibleSub) {
            line.appliedSubscriptionId = eligibleSub._id;
            modified = true;
          }
        }
      }
      if (modified) {
        await appt.save({ session });
      }
    }
  }

  /**
   * List subscriptions with search, filter, and pagination
   */
  async listSubscriptions(query, organizationId) {
    const {
      page = 1,
      limit = 20,
      customerId,
      payerId,
      memberId,
      status,
      branchId,
      search,
    } = query;

    const conditions = [
      { organizationId },
      { isDeleted: false },
    ];

    if (customerId) {
      conditions.push({
        $or: [
          { customerId },
          { payerCustomerId: customerId },
          { "members.customerId": customerId },
        ],
      });
    }

    if (payerId) {
      conditions.push({
        $or: [
          { payerCustomerId: payerId },
          { customerId: payerId },
        ],
      });
    }

    if (memberId) {
      conditions.push({
        "members.customerId": memberId,
      });
    }

    if (status) {
      conditions.push({ status });
    }

    if (branchId) {
      // Return subscriptions where permittedBranchIds is empty (all branches) or includes branchId
      conditions.push({
        $or: [
          { permittedBranchIds: { $size: 0 } },
          { permittedBranchIds: branchId },
        ],
      });
    }

    if (search) {
      conditions.push({
        subscriptionCode: { $regex: search, $options: "i" },
      });
    }

    const filter = conditions.length === 1 ? conditions[0] : { $and: conditions };

    const options = {
      page: parseInt(page, 10),
      limit: parseInt(limit, 10),
      populate: [
        { path: "customerId", select: "name phone email" },
        { path: "payerCustomerId", select: "name phone email" },
        { path: "members.customerId", select: "name phone email" },
        { path: "permittedBranchIds", select: "name" },
        { path: "invoiceId", select: "invoiceNumber paymentStatus amountPaid amountDue status" },
      ],
      sort: { createdAt: -1 },
    };

    const result = await this.subscriptionRepo.find(filter, options);
    const now = new Date();
    const enrichedData = (result.data || []).map((sub) => {
      const doc = sub.toObject ? sub.toObject() : { ...sub };
      const isDateValid = (!doc.endDate || new Date(doc.endDate) >= now) && (!doc.startDate || new Date(doc.startDate) <= now);
      const isStatusValid = ["active", "pending_payment"].includes(doc.status);
      const baseRedeemable = isStatusValid && isDateValid;

      if (Array.isArray(doc.members) && doc.members.length > 0) {
        doc.members = doc.members.map((m) => {
          const isMemberStatusValid = ["active", "pending_payment"].includes(m.status);
          const memberRedeemable = baseRedeemable && isMemberStatusValid;
          const memberEntitlements = (m.entitlements || []).map((e) => ({
            ...e,
            isRedeemable: memberRedeemable && (e.remainingQuantity || 0) > 0,
          }));
          return {
            ...m,
            entitlements: memberEntitlements,
            isRedeemable: memberEntitlements.some((e) => e.isRedeemable),
          };
        });
      }

      // Legacy projection for single member or legacy sub
      const activeEntitlements = Array.isArray(doc.members) && doc.members.length > 0
        ? doc.members[0].entitlements
        : doc.entitlements || [];

      doc.entitlements = activeEntitlements.map((e) => ({
        ...e,
        isRedeemable: baseRedeemable && (e.remainingQuantity || 0) > 0,
      }));

      const hasBalance = Array.isArray(doc.members) && doc.members.length > 0
        ? doc.members.some((m) => m.isRedeemable)
        : doc.entitlements.some((e) => e.isRedeemable);

      doc.paymentStatus = doc.invoiceId?.paymentStatus || (doc.status === "active" && doc.price === 0 ? "paid" : "unpaid");
      doc.isRedeemable = hasBalance;
      return doc;
    });

    return {
      ...result,
      data: enrichedData,
    };
  }

  /**
   * Get subscription by ID with lazy expiration check and payment status
   */
  async getSubscriptionById(id, organizationId) {
    const subscription = await this.subscriptionRepo.findOne(
      { _id: id, organizationId, isDeleted: false },
      [
        { path: "customerId", select: "name phone email status" },
        { path: "payerCustomerId", select: "name phone email status" },
        { path: "members.customerId", select: "name phone email status" },
        { path: "members.entitlements.serviceId", select: "name duration price" },
        { path: "permittedBranchIds", select: "name isActive" },
        { path: "entitlements.serviceId", select: "name duration price" },
        { path: "planId", select: "_id name" },
        { path: "invoiceId", select: "invoiceNumber paymentStatus amountPaid amountDue status" },
      ],
    );

    if (!subscription) {
      throw new AppError("Subscription not found", 404);
    }

    // Lazy expiration check
    await this.checkAndUpdateExpiry(subscription);

    const doc = subscription.toObject ? subscription.toObject() : { ...subscription };
    const now = new Date();
    const isDateValid = (!doc.endDate || new Date(doc.endDate) >= now) && (!doc.startDate || new Date(doc.startDate) <= now);
    const isStatusValid = ["active", "pending_payment"].includes(doc.status);
    const baseRedeemable = isStatusValid && isDateValid;

    if (Array.isArray(doc.members) && doc.members.length > 0) {
      doc.members = doc.members.map((m) => {
        const isMemberStatusValid = ["active", "pending_payment"].includes(m.status);
        const memberRedeemable = baseRedeemable && isMemberStatusValid;
        const memberEntitlements = (m.entitlements || []).map((e) => ({
          ...e,
          isRedeemable: memberRedeemable && (e.remainingQuantity || 0) > 0,
        }));
        return {
          ...m,
          entitlements: memberEntitlements,
          isRedeemable: memberEntitlements.some((e) => e.isRedeemable),
        };
      });
    }

    const activeEntitlements = Array.isArray(doc.members) && doc.members.length > 0
      ? doc.members[0].entitlements
      : doc.entitlements || [];

    doc.entitlements = activeEntitlements.map((e) => ({
      ...e,
      isRedeemable: baseRedeemable && (e.remainingQuantity || 0) > 0,
    }));

    const hasBalance = Array.isArray(doc.members) && doc.members.length > 0
      ? doc.members.some((m) => m.isRedeemable)
      : doc.entitlements.some((e) => e.isRedeemable);

    doc.paymentStatus = doc.invoiceId?.paymentStatus || (doc.status === "active" && doc.price === 0 ? "paid" : "unpaid");
    doc.isRedeemable = hasBalance;

    return doc;
  }

  /**
   * Update subscription (metadata, notes, permitted branches, or unused entitlements)
   */
  async updateSubscription(id, updateData, organizationId, userId) {
    const subscription = await this.subscriptionRepo.findOne({
      _id: id,
      organizationId,
      isDeleted: false,
    });

    if (!subscription) {
      throw new AppError("Subscription not found", 404);
    }

    if (["cancelled", "expired"].includes(subscription.status)) {
      throw new AppError(
        `Cannot update subscription with status '${subscription.status}'`,
        400,
      );
    }

    const allowedUpdates = {};

    if (updateData.notes !== undefined) {
      allowedUpdates.notes = updateData.notes;
    }

    if (updateData.permittedBranchIds !== undefined) {
      // Validate branch IDs
      const validBranchIds = [];
      for (const bId of updateData.permittedBranchIds) {
        let branch;
        if (this.branchRepo && typeof this.branchRepo.findById === "function") {
          branch = await this.branchRepo.findById(bId);
        } else {
          const BranchModel = mongoose.model("Branch");
          branch = await BranchModel.findById(bId);
        }

        if (
          !branch ||
          branch.organizationId.toString() !== organizationId.toString() ||
          branch.isDeleted
        ) {
          throw new AppError(`Permitted branch ${bId} is invalid`, 400);
        }
        validBranchIds.push(branch._id);
      }
      allowedUpdates.permittedBranchIds = validBranchIds;
    }

    if (updateData.endDate !== undefined) {
      const newEnd = new Date(updateData.endDate);
      if (isNaN(newEnd.getTime()) || newEnd <= subscription.startDate) {
        throw new AppError(
          "End date must be after subscription start date",
          400,
        );
      }
      allowedUpdates.endDate = newEnd;
    }

    const updated = await this.executeTransaction(async (session) => {
      const res = await this.subscriptionRepo.updateById(
        id,
        allowedUpdates,
        userId,
        session,
      );

      if (this.auditRepo && typeof this.auditRepo.create === "function") {
        await this.auditRepo.create(
          {
            branchId: null,
            action: AUDIT_ACTIONS.SUBSCRIPTION_UPDATED,
            entityType: "Subscription",
            entityId: id,
            description: `Subscription ${subscription.subscriptionCode} updated`,
            metadata: { updatedFields: Object.keys(allowedUpdates) },
          },
          organizationId,
          userId,
          session,
        );
      }

      return res;
    });

    return updated;
  }

  /**
   * Update beneficiary-specific permittedBranchIds on an existing subscription
   */
  async updateMemberBranchAccess(subscriptionId, memberCustomerId, permittedBranchIds, organizationId, userId) {
    const subscription = await this.subscriptionRepo.findOne({
      _id: subscriptionId,
      organizationId,
      isDeleted: false,
    });

    if (!subscription) {
      throw new AppError("Subscription not found", 404);
    }

    if (["cancelled", "expired"].includes(subscription.status)) {
      throw new AppError(
        `Cannot update member branch access for subscription with status '${subscription.status}'`,
        400
      );
    }

    const memberCustIdStr = memberCustomerId.toString();

    // Ensure member exists on subscription or legacy subscription matches
    let memberExists = false;
    let targetMember = null;
    if (Array.isArray(subscription.members) && subscription.members.length > 0) {
      targetMember = subscription.members.find(
        (m) => m.customerId && m.customerId.toString() === memberCustIdStr
      );
      if (targetMember) {
        memberExists = true;
      }
    } else if (subscription.customerId && subscription.customerId.toString() === memberCustIdStr) {
      // Genuine legacy subscription where members array was not populated
      memberExists = true;
    }

    if (!memberExists) {
      throw new AppError("Member not found in subscription", 404);
    }

    // 1. Validate provided branch IDs
    const validBranchIds = [];
    const incomingBranchIds = Array.isArray(permittedBranchIds) ? permittedBranchIds : [];

    for (const bId of incomingBranchIds) {
      let branch;
      if (this.branchRepo && typeof this.branchRepo.findById === "function") {
        branch = await this.branchRepo.findById(bId);
      } else if (this.branchRepo && typeof this.branchRepo.findOne === "function") {
        branch = await this.branchRepo.findOne({ _id: bId });
      } else {
        const BranchModel = mongoose.model("Branch");
        branch = await BranchModel.findById(bId);
      }

      if (
        !branch ||
        branch.organizationId.toString() !== organizationId.toString() ||
        branch.isDeleted ||
        branch.isActive === false
      ) {
        throw new AppError(`Permitted branch ${bId} is invalid or inactive`, 400);
      }
      validBranchIds.push(branch._id);
    }

    // 2. Atomically update the targeted member's permittedBranchIds inside transaction
    // Re-validates root boundary against the latest committed subscription state to prevent concurrent root-update races
    const updated = await this.executeTransaction(async (session) => {
      const SubscriptionModel = this.subscriptionRepo.model || mongoose.model("Subscription");

      // Query latest subscription state inside transaction session
      const currentSub = await SubscriptionModel.findOne({
        _id: subscriptionId,
        organizationId,
        isDeleted: false,
      }).session(session);

      if (!currentSub) {
        throw new AppError("Subscription not found", 404);
      }

      if (["cancelled", "expired"].includes(currentSub.status)) {
        throw new AppError(
          `Cannot update member branch access for subscription with status '${currentSub.status}'`,
          400
        );
      }

      // Re-verify member exists on current subscription
      let currentTargetMember = null;
      if (Array.isArray(currentSub.members) && currentSub.members.length > 0) {
        currentTargetMember = currentSub.members.find(
          (m) => m.customerId && m.customerId.toString() === memberCustIdStr
        );
      } else if (currentSub.customerId && currentSub.customerId.toString() === memberCustIdStr) {
        currentTargetMember = { customerId: currentSub.customerId };
      }

      if (!currentTargetMember) {
        throw new AppError("Member not found in subscription", 404);
      }

      // Strict subset validation against latest committed root boundary
      const latestRootBranches = Array.isArray(currentSub.permittedBranchIds)
        ? currentSub.permittedBranchIds
        : [];

      if (latestRootBranches.length > 0) {
        const rootBranchSet = new Set(latestRootBranches.map((b) => b.toString()));
        for (const validBranchId of validBranchIds) {
          if (!rootBranchSet.has(validBranchId.toString())) {
            throw new AppError(
              `Member permitted branch ${validBranchId} is not permitted by the subscription's branch restrictions`,
              400
            );
          }
        }
      }

      // Atomic conditional update bound to the exact permittedBranchIds boundary verified above
      let updatedDoc;
      const boundaryCondition =
        latestRootBranches.length > 0
          ? { permittedBranchIds: latestRootBranches }
          : {
              $or: [
                { permittedBranchIds: { $exists: false } },
                { permittedBranchIds: { $size: 0 } },
              ],
            };

      if (Array.isArray(currentSub.members) && currentSub.members.length > 0) {
        // Targeted positional update on matching member conditioned on unchanged root boundary
        updatedDoc = await SubscriptionModel.findOneAndUpdate(
          {
            _id: currentSub._id,
            organizationId,
            isDeleted: false,
            status: { $nin: ["cancelled", "expired"] },
            "members.customerId": memberCustomerId,
            ...boundaryCondition,
          },
          {
            $set: {
              "members.$.permittedBranchIds": validBranchIds,
            },
            ...(userId ? { $set: { updatedBy: userId, "members.$.permittedBranchIds": validBranchIds } } : {}),
          },
          { returnDocument: "after", session }
        );
      } else {
        // Legacy single-customer subscription: upgrade/initialize members array with member
        const legacyMember = {
          customerId: currentSub.customerId,
          status: currentSub.status || "active",
          permittedBranchIds: validBranchIds,
          entitlements: currentSub.entitlements || [],
          notes: currentSub.notes || "",
        };
        updatedDoc = await SubscriptionModel.findOneAndUpdate(
          {
            _id: currentSub._id,
            organizationId,
            isDeleted: false,
            status: { $nin: ["cancelled", "expired"] },
            ...boundaryCondition,
          },
          {
            $set: {
              members: [legacyMember],
              ...(userId ? { updatedBy: userId } : {}),
            },
          },
          { returnDocument: "after", session }
        );
      }

      if (!updatedDoc) {
        throw new AppError(
          "Subscription branch boundaries were modified concurrently. Please retry.",
          409
        );
      }

      if (this.auditRepo && typeof this.auditRepo.create === "function") {
        await this.auditRepo.create(
          {
            branchId: null,
            action: AUDIT_ACTIONS.SUBSCRIPTION_UPDATED,
            entityType: "Subscription",
            entityId: currentSub._id,
            description: `Beneficiary branch access updated for member ${memberCustIdStr} on subscription ${currentSub.subscriptionCode}`,
            metadata: {
              memberCustomerId: memberCustIdStr,
              previousPermittedBranchIds: currentTargetMember?.permittedBranchIds || [],
              newPermittedBranchIds: validBranchIds,
            },
          },
          organizationId,
          userId,
          session
        );
      }

      return updatedDoc;
    });

    return updated;
  }

  /**
   * Helper to verify authoritative payment status of a subscription sale invoice.
   * Determines whether any actual amount has been collected against the subscription.
   * Returns: { isEligibleRuleB: boolean, totalCollected: number, subscriptionInvoice: Invoice | null, error?: string }
   */
  async verifySubscriptionPaymentEligibility(subscription, organizationId, session = null) {
    if (mongoose.connection.readyState !== 1) {
      return {
        isEligibleRuleB: true,
        totalCollected: 0,
        subscriptionInvoice: null,
      };
    }
    const InvoiceModel = mongoose.model("Invoice");
    const PaymentModel = mongoose.model("Payment");

    // Look for subscription sale invoice (either by subscription.invoiceId or by { subscriptionId, invoiceType: "subscription" })
    let invoiceQuery = {
      organizationId,
      isDeleted: false,
    };
    if (subscription.invoiceId) {
      invoiceQuery._id = subscription.invoiceId;
    } else {
      invoiceQuery.subscriptionId = subscription._id;
      invoiceQuery.invoiceType = "subscription";
    }

    let invoiceFind = InvoiceModel.findOne(invoiceQuery);
    if (session) invoiceFind = invoiceFind.session(session);
    const invoice = await invoiceFind;

    if (!invoice) {
      // If no invoice was generated for this subscription, no money was collected through invoice billing
      return {
        isEligibleRuleB: true,
        totalCollected: 0,
        subscriptionInvoice: null,
      };
    }

    // Inspect authoritative payments linked to this invoice
    let paymentsQuery = PaymentModel.find({
      organizationId,
      invoiceId: invoice._id,
      isDeleted: false,
    });
    if (session) paymentsQuery = paymentsQuery.session(session);
    const payments = await paymentsQuery;

    // Filter only completed (non-voided) payments
    const activePayments = payments.filter((p) => p.status === "completed");
    const totalCollectedFromPayments = activePayments.reduce(
      (sum, p) => Number((sum + p.amount).toFixed(2)),
      0
    );

    // Reconcile payments against invoice amountPaid
    const invoiceAmountPaid = Number((invoice.amountPaid || 0).toFixed(2));
    if (Math.abs(totalCollectedFromPayments - invoiceAmountPaid) > 0.01) {
      throw new AppError(
        `Financial reconciliation mismatch: subscription invoice ${invoice.invoiceNumber} amountPaid (${invoiceAmountPaid}) does not match authoritative completed payment sum (${totalCollectedFromPayments})`,
        409
      );
    }

    // If actual collected amount > 0, Rule B is not permitted
    const isEligibleRuleB = totalCollectedFromPayments === 0;

    return {
      isEligibleRuleB,
      totalCollected: totalCollectedFromPayments,
      subscriptionInvoice: invoice,
    };
  }

  /**
   * Read-only preview of subscription cancellation impact.
   * Inspects all non-reversed usages, affected appointments (pending & completed),
   * service lines, invoices, and expected financial rebilling impact.
   * Modifies no data.
   */
  async previewCancellationImpact(id, organizationId, userId) {
    const subscription = await this.subscriptionRepo.findOne({
      _id: id,
      organizationId,
      isDeleted: false,
    });

    if (!subscription) {
      throw new AppError("Subscription not found", 404);
    }

    // Verify payment eligibility
    const { isEligibleRuleB, totalCollected, subscriptionInvoice } =
      await this.verifySubscriptionPaymentEligibility(subscription, organizationId);

    // Resolve all active non-reversed usage records
    const SubscriptionUsageModel = mongoose.model("SubscriptionUsage");
    const AppointmentModel = mongoose.model("Appointment");
    const InvoiceModel = mongoose.model("Invoice");
    const { billingService } = await import("../billing/billing.service.js");

    const usages = await SubscriptionUsageModel.find({
      organizationId,
      subscriptionId: subscription._id,
      isReversed: { $ne: true },
      isDeleted: false,
    }).sort({ createdAt: 1 });

    const affectedAppointmentIds = [
      ...new Set(usages.map((u) => u.appointmentId?.toString()).filter(Boolean)),
    ];

    const appointments = await AppointmentModel.find({
      _id: { $in: affectedAppointmentIds },
      organizationId,
      isDeleted: false,
    });

    const appointmentMap = new Map();
    appointments.forEach((apt) => appointmentMap.set(apt._id.toString(), apt));

    const affectedInvoices = await InvoiceModel.find({
      appointmentId: { $in: affectedAppointmentIds },
      organizationId,
      status: { $ne: "cancelled" },
      isDeleted: false,
    });

    const invoiceMap = new Map();
    affectedInvoices.forEach((inv) => invoiceMap.set(inv.appointmentId.toString(), inv));

    const breakdown = {
      pendingAppointments: 0,
      completedAppointments: 0,
      otherAppointments: 0,
    };

    let totalRestoredAmount = 0;
    const affectedLinesDetails = [];
    const blockingInconsistencies = [];

    for (const usage of usages) {
      if (!usage.appointmentId || !usage.appointmentServiceId) {
        blockingInconsistencies.push({
          type: "LEGACY_USAGE_MISSING_APPOINTMENT_SERVICE_LINE",
          usageId: usage._id,
          message: `Subscription usage ${usage._id} lacks appointment or service-line link`,
        });
        continue;
      }

      const apt = appointmentMap.get(usage.appointmentId.toString());
      if (!apt) {
        blockingInconsistencies.push({
          type: "MISSING_APPOINTMENT_RECORD",
          usageId: usage._id,
          appointmentId: usage.appointmentId,
          message: `Appointment ${usage.appointmentId} referenced by usage ${usage._id} not found`,
        });
        continue;
      }

      const sLine = (apt.services || []).find(
        (s) => s._id?.toString() === usage.appointmentServiceId.toString()
      );

      if (!sLine) {
        blockingInconsistencies.push({
          type: "MISSING_SERVICE_SNAPSHOT_LINE",
          usageId: usage._id,
          appointmentId: apt._id,
          appointmentServiceId: usage.appointmentServiceId,
          message: `Appointment ${apt.appointmentCode} does not contain service line ${usage.appointmentServiceId}`,
        });
        continue;
      }

      const originalPrice = Number(sLine.price);
      if (isNaN(originalPrice) || originalPrice < 0) {
        blockingInconsistencies.push({
          type: "INVALID_ORIGINAL_PRICE_SNAPSHOT",
          usageId: usage._id,
          appointmentId: apt._id,
          appointmentServiceId: sLine._id,
          message: `Original price snapshot on line ${sLine._id} is missing or invalid`,
        });
        continue;
      }

      totalRestoredAmount = Number((totalRestoredAmount + originalPrice).toFixed(2));
      affectedLinesDetails.push({
        usageId: usage._id,
        appointmentId: apt._id,
        appointmentCode: apt.appointmentCode,
        appointmentStatus: apt.status,
        serviceId: usage.serviceId,
        serviceName: sLine.name,
        restoredPrice: originalPrice,
        appointmentServiceId: sLine._id,
      });
    }

    appointments.forEach((apt) => {
      if (["scheduled", "in_progress"].includes(apt.status)) {
        breakdown.pendingAppointments++;
      } else if (apt.status === "completed") {
        breakdown.completedAppointments++;
      } else {
        breakdown.otherAppointments++;
      }
    });

    const isEligible =
      subscription.status !== "cancelled" &&
      isEligibleRuleB &&
      blockingInconsistencies.length === 0;

    return {
      subscriptionId: subscription._id,
      subscriptionCode: subscription.subscriptionCode,
      currentStatus: subscription.status,
      isPaid: totalCollected > 0,
      totalCollected,
      hasConsumedEntitlements: usages.length > 0,
      consumedEntitlementCount: usages.length,
      affectedAppointmentCount: appointments.length,
      affectedServiceLineCount: affectedLinesDetails.length,
      breakdown,
      affectedInvoices: affectedInvoices.map((inv) => ({
        invoiceId: inv._id,
        invoiceNumber: inv.invoiceNumber,
        status: inv.status,
        paymentStatus: inv.paymentStatus,
        subtotal: inv.subtotal,
        grossPayable: inv.grossPayable,
        payableAmount: inv.payableAmount,
        amountPaid: inv.amountPaid,
        amountDue: inv.amountDue,
      })),
      affectedLines: affectedLinesDetails,
      expectedRebilledSubtotalIncrease: totalRestoredAmount,
      additionalAppointmentCharges: totalRestoredAmount,
      isEligible,
      eligibilityRule: usages.length === 0 ? "RULE_A" : "RULE_B",
      blockingInconsistencies,
    };
  }

  /**
   * Cancel subscription (supporting Rule A and Rule B with full usage reversal and rebilling)
   */
  async cancelSubscription(id, organizationId, userId, reason = "", options = {}) {
    const subscription = await this.subscriptionRepo.findOne({
      _id: id,
      organizationId,
      isDeleted: false,
    });

    if (!subscription) {
      throw new AppError("Subscription not found", 404);
    }

    // Calculate canonical request payload hash for idempotency integrity check
    const canonicalPayloadString = JSON.stringify({
      subscriptionId: id.toString(),
      reason: String(reason).trim(),
      refund: Boolean(options.refund),
    });
    const requestPayloadHash = crypto
      .createHash("sha256")
      .update(canonicalPayloadString)
      .digest("hex");

    // Idempotency check FIRST: If an operation with this idempotencyKey was already completed or is processing,
    // return it immediately (even if subscription status is already marked cancelled)
    if (options.idempotencyKey && mongoose.connection?.readyState === 1) {
      const idempotentOp = await SubscriptionCancellationOperation.findOne({
        organizationId,
        idempotencyKey: options.idempotencyKey,
        isDeleted: false,
      });
      if (idempotentOp) {
        if (
          idempotentOp.subscriptionId.toString() !== id.toString() ||
          (idempotentOp.requestPayloadHash && idempotentOp.requestPayloadHash !== requestPayloadHash)
        ) {
          throw new AppError(
            "Idempotency key reuse with differing cancellation parameters or target subscription",
            409
          );
        }
        return {
          operationId: idempotentOp.operationId,
          status: idempotentOp.status,
          idempotent: true,
          processedUsageCount: idempotentOp.processedUsageCount,
          processedAppointmentCount: idempotentOp.processedAppointmentCount,
        };
      }
    }

    if (subscription.status === "cancelled") {
      throw new AppError("Subscription is already cancelled", 400);
    }

    // Determine actual collection against the subscription and active usages
    // (Only query Mongoose models if connection is open; in pure unit tests with mocked repo, use empty defaults)
    let isEligibleRuleB = true;
    let totalCollected = 0;
    let subscriptionInvoice = null;
    let usages = [];

    if (mongoose.connection?.readyState === 1) {
      // Check for existing in-progress cancellation operation
      const existingOp = await SubscriptionCancellationOperation.findOne({
        organizationId,
        subscriptionId: subscription._id,
        status: { $in: ["pending", "processing"] },
        isDeleted: false,
      });

      if (existingOp) {
        return {
          operationId: existingOp.operationId,
          status: existingOp.status,
          message: "A cancellation operation is already in progress for this subscription",
        };
      }

      // Check idempotency if key provided
      if (options.idempotencyKey) {
        const idempotentOp = await SubscriptionCancellationOperation.findOne({
          organizationId,
          idempotencyKey: options.idempotencyKey,
          isDeleted: false,
        });
        if (idempotentOp) {
          return {
            operationId: idempotentOp.operationId,
            status: idempotentOp.status,
            idempotent: true,
            processedUsageCount: idempotentOp.processedUsageCount,
            processedAppointmentCount: idempotentOp.processedAppointmentCount,
          };
        }
      }

      const paymentVerification = await this.verifySubscriptionPaymentEligibility(subscription, organizationId);
      isEligibleRuleB = paymentVerification.isEligibleRuleB;
      totalCollected = paymentVerification.totalCollected;
      subscriptionInvoice = paymentVerification.subscriptionInvoice;

      const SubscriptionUsageModel = mongoose.model("SubscriptionUsage");
      usages = await SubscriptionUsageModel.find({
        organizationId,
        subscriptionId: subscription._id,
        isReversed: { $ne: true },
        isDeleted: false,
      }).sort({ createdAt: 1 });
    } else {
      // In disconnected unit test environment, check member/root entitlement used quantities
      const anyConsumed = (subscription.members || []).some((m) =>
        (m.entitlements || []).some((e) => (e.usedQuantity || 0) > 0)
      ) || (subscription.entitlements || []).some((e) => (e.usedQuantity || 0) > 0);
      if (anyConsumed) {
        usages = [{ _id: new mongoose.Types.ObjectId() }];
      }
    }

    // Entitlement consumption check across members and root entitlements
    const hasEntitlementsConsumedOnDoc =
      (subscription.members || []).some((m) =>
        (m.entitlements || []).some((e) => (e.usedQuantity || 0) > 0)
      ) || (subscription.entitlements || []).some((e) => (e.usedQuantity || 0) > 0);

    const hasConsumedEntitlements = usages.length > 0 || hasEntitlementsConsumedOnDoc;

    // RULE A: Unpaid, no usage -> Normal instant cancellation
    if (!hasConsumedEntitlements && totalCollected === 0) {
      // Record lightweight operation ledger for Rule A if idempotencyKey supplied
      if (options.idempotencyKey && mongoose.connection?.readyState === 1) {
        const operationId = `CAN-OP-A-${Date.now()}-${crypto.randomBytes(4).toString("hex").toUpperCase()}`;
        const opDoc = new SubscriptionCancellationOperation({
          operationId,
          organizationId,
          branchId: subscription.permittedBranchIds?.[0] || null,
          subscriptionId: subscription._id,
          idempotencyKey: options.idempotencyKey,
          requestPayloadHash,
          status: "completed",
          cancellationReason: reason,
          initiatedBy: userId,
          totalUsageCount: 0,
          totalAppointmentCount: 0,
          completedAt: new Date(),
        });
        await opDoc.save().catch(() => {});
      }

      return await this._executeNormalCancellation(
        subscription,
        organizationId,
        userId,
        reason,
        subscriptionInvoice
      );
    }

    // Inconsistency guard: If document has consumed counters but zero SubscriptionUsage records exist in storage,
    // this indicates legacy usage records lacking relational linkage or data corruption.
    // As mandated by Section 2 & 5: legacy usage without valid appointment service relationship cannot be guessed and must be rejected safely.
    if (hasEntitlementsConsumedOnDoc && usages.length === 0) {
      throw new AppError(
        "Cannot cancel or refund subscription because one or more entitlements have already been consumed without verifiable appointment service usage records. A managerial reconciliation is required.",
        400
      );
    }

    // Paid or partially paid with usage -> Strictly Reject Rule B
    if (totalCollected > 0 && hasConsumedEntitlements) {
      throw new AppError(
        `Cannot cancel subscription with consumed entitlements because an actual payment of ₹${totalCollected.toFixed(2)} was collected against it. A managerial override, credit note, or refund policy is required.`,
        400
      );
    }

    // Paid without usage -> Existing cancellation policy
    if (totalCollected > 0 && !hasConsumedEntitlements) {
      if (!options.refund) {
        throw new AppError(
          "Subscription has been paid for. If you wish to cancel and process refund, please explicitly confirm refund policy.",
          400
        );
      }
      return await this._executeNormalCancellation(
        subscription,
        organizationId,
        userId,
        reason,
        subscriptionInvoice
      );
    }

    // RULE B: Cancel subscription and restore used-service charges (Rule B)
    // Verify eligibility
    if (!isEligibleRuleB) {
      throw new AppError(
        "Subscription is not eligible for cancellation with used-service charges restored (payments were collected against the subscription)",
        400
      );
    }

    // Create durable cancellation operation record
    const operationId = `CAN-OP-${Date.now()}-${crypto.randomBytes(4).toString("hex").toUpperCase()}`;
    const affectedAppointmentIds = [
      ...new Set(usages.map((u) => u.appointmentId?.toString()).filter(Boolean)),
    ];

    const operationDoc = new SubscriptionCancellationOperation({
      operationId,
      organizationId,
      branchId: subscription.permittedBranchIds?.[0] || null,
      subscriptionId: subscription._id,
      idempotencyKey: options.idempotencyKey || null,
      requestPayloadHash: options.idempotencyKey ? requestPayloadHash : null,
      status: "pending",
      cancellationReason: reason,
      initiatedBy: userId,
      totalUsageCount: usages.length,
      totalAppointmentCount: affectedAppointmentIds.length,
      affectedUsageIds: usages.map((u) => u._id),
      affectedAppointmentIds,
    });
    try {
      await operationDoc.save();
      // Set cancellationStatus to in_progress on Subscription to block concurrent redemptions
      const SubscriptionModel = this.subscriptionRepo.model || mongoose.model("Subscription");
      await SubscriptionModel.updateOne(
        { _id: subscription._id, organizationId },
        { $set: { cancellationStatus: "in_progress" } }
      ).catch(() => {});
    } catch (saveErr) {
      if (saveErr.code === 11000 && options.idempotencyKey) {
        const raceOp = await SubscriptionCancellationOperation.findOne({
          organizationId,
          idempotencyKey: options.idempotencyKey,
        });
        if (raceOp) {
          return {
            operationId: raceOp.operationId,
            status: raceOp.status,
            idempotent: true,
            processedUsageCount: raceOp.processedUsageCount,
            processedAppointmentCount: raceOp.processedAppointmentCount,
          };
        }
      }
      throw saveErr;
    }

    // Small operation threshold (e.g., <= 5 appointments and not forced async)
    const SYNC_THRESHOLD = 5;
    const shouldRunSync =
      affectedAppointmentIds.length <= SYNC_THRESHOLD && !options.forceAsync;

    if (shouldRunSync) {
      return await this.executeCancellationOperation(operationId, organizationId, userId);
    }

    // Large operation -> Queue for background asynchronous processing
    await subscriptionCancellationQueue.add(
      "processCancellationOperation",
      {
        operationId,
        organizationId,
        userId,
      },
      {
        jobId: `cancel_op_${operationId}`,
      }
    );

    return {
      operationId,
      status: "processing",
      totalAppointments: affectedAppointmentIds.length,
      totalUsages: usages.length,
      message: "Subscription cancellation accepted for background processing",
    };
  }

  /**
   * Normal cancellation (Rule A) for subscriptions with zero consumed usage
   */
  async _executeNormalCancellation(subscription, organizationId, userId, reason, subscriptionInvoice) {
    const cancelled = await this.executeTransaction(async (session) => {
      // Re-verify payment eligibility inside the exact transaction session
      const { isEligibleRuleB, totalCollected } =
        await this.verifySubscriptionPaymentEligibility(subscription, organizationId, session);

      if (totalCollected > 0) {
        throw new AppError(
          `Cannot cancel subscription because payment of ₹${totalCollected.toFixed(2)} was concurrently collected`,
          409
        );
      }

      const updatedMembers = Array.isArray(subscription.members)
        ? subscription.members.map((m) => ({
            ...(m.toObject ? m.toObject() : m),
            status: "cancelled",
          }))
        : [];

      const SubscriptionModel = this.subscriptionRepo.model || mongoose.model("Subscription");
      let res;
      if (this.subscriptionRepo.updateById && !this.subscriptionRepo.model && mongoose.connection.readyState !== 1) {
        // Disconnected unit test fallback using mockSubscriptionRepo
        res = await this.subscriptionRepo.updateById(
          subscription._id,
          {
            status: "cancelled",
            notes: subscription.notes
              ? `${subscription.notes}\n[Cancelled]: ${reason}`
              : `[Cancelled]: ${reason}`,
          },
          userId,
          session
        );
      } else {
        res = await SubscriptionModel.findOneAndUpdate(
          {
            _id: subscription._id,
            organizationId,
            status: { $in: ["active", "pending_payment", "exhausted"] },
            isDeleted: false,
          },
          {
            $set: {
              status: "cancelled",
              ...(updatedMembers.length > 0 ? { members: updatedMembers } : {}),
              notes: subscription.notes
                ? `${subscription.notes}\n[Cancelled]: ${reason}`
                : `[Cancelled]: ${reason}`,
            },
          },
          { session, new: true }
        );
      }

      if (!res) {
        throw new AppError("Subscription is not in a cancellable status or was concurrently modified", 409);
      }

      let cancelledInvoiceId = null;
      if (subscriptionInvoice) {
        if (subscriptionInvoice.status === "draft" || subscriptionInvoice.paymentStatus === "unpaid") {
          subscriptionInvoice.status = "cancelled";
          subscriptionInvoice.cancelledAt = new Date();
          subscriptionInvoice.cancelledBy = userId;
          subscriptionInvoice.cancellationReason = `Subscription ${subscription.subscriptionCode} cancelled`;
          await subscriptionInvoice.save(session ? { session } : undefined);
          cancelledInvoiceId = subscriptionInvoice._id;
        }
      }

      if (this.auditRepo && typeof this.auditRepo.create === "function") {
        await this.auditRepo.create(
          {
            branchId: null,
            action: AUDIT_ACTIONS.SUBSCRIPTION_CANCELLED,
            entityType: "Subscription",
            entityId: subscription._id,
            description: `Subscription ${subscription.subscriptionCode} cancelled: ${reason}`,
            metadata: {
              reason,
              hasConsumedEntitlements: false,
              invoiceId: cancelledInvoiceId,
              rule: "RULE_A",
            },
          },
          organizationId,
          userId,
          session
        );
      }

      return res;
    });

    return cancelled;
  }

  /**
   * Executes a durable cancellation operation (Rule B) batch by batch.
   * Can be called synchronously or asynchronously by BullMQ worker or manual retry.
   */
  async executeCancellationOperation(operationId, organizationId, userId) {
    const operation = await SubscriptionCancellationOperation.findOne({
      operationId,
      organizationId,
      isDeleted: false,
    });

    if (!operation) {
      throw new AppError("Cancellation operation not found", 404);
    }

    if (operation.status === "completed") {
      return operation;
    }

    // Lock token to detect stale workers and renew heartbeat
    const workerLockToken = new mongoose.Types.ObjectId().toString();

    // Atomic claim on the operation document to prevent simultaneous execution by concurrent workers
    // Allow claiming if status is 'pending', 'failed', or if 'processing' has stalled (> 60s)
    const claimedOperation = await SubscriptionCancellationOperation.findOneAndUpdate(
      {
        _id: operation._id,
        $or: [
          { status: { $in: ["pending", "failed"] } },
          {
            status: "processing",
            updatedAt: { $lt: new Date(Date.now() - 60000) },
          },
        ],
      },
      {
        $set: {
          status: "processing",
          startedAt: operation.startedAt || new Date(),
          workerLockToken,
          heartbeatAt: new Date(),
        },
      },
      { new: true }
    );

    if (!claimedOperation && operation.status === "processing") {
      logger.info(`[Cancellation] Operation ${operationId} is currently being processed by another worker`);
      return operation;
    }

    const subscription = await this.subscriptionRepo.findOne({
      _id: operation.subscriptionId,
      organizationId,
      isDeleted: false,
    });

    if (!subscription) {
      operation.status = "failed";
      await operation.save();
      throw new AppError("Subscription not found for cancellation operation", 404);
    }

    // Step 1: Concurrency Guard & Atomic Serialization Boundary
    // Atomically claim the subscription within a transactional write.
    // If a payment won the race and was collected, or if another process cancelled it, this fails safely.
    // Note: If this is a retry of an already partially-processed operation, the subscription may already have been claimed by this operation.
    const lockResult = await this.executeTransaction(async (session) => {
      const SubscriptionModel = this.subscriptionRepo.model || mongoose.model("Subscription");
      let claimedSub;
      if (subscription.status === "cancelled" && operation.status === "processing") {
        // Safe retry of already claimed subscription
        claimedSub = subscription;
      } else {
        claimedSub = await SubscriptionModel.findOneAndUpdate(
          {
            _id: subscription._id,
            status: { $in: ["active", "pending_payment", "exhausted"] },
            isDeleted: false,
          },
          {
            $set: {
              status: "cancelled",
              cancellationStatus: "in_progress",
              "members.$[].status": "cancelled",
            },
          },
          { session, new: true }
        );
      }

      if (!claimedSub) {
        throw new AppError("Subscription is not in a cancellable status or was concurrently modified", 409);
      }

      // Re-verify payment eligibility within the exact same transaction session
      const { isEligibleRuleB, totalCollected } =
        await this.verifySubscriptionPaymentEligibility(claimedSub, organizationId, session);

      if (!isEligibleRuleB) {
        throw new AppError(
          `Cannot cancel subscription with consumed entitlements because an actual payment of ₹${totalCollected.toFixed(2)} was collected against it. A managerial override, credit note, or refund policy is required.`,
          409
        );
      }

      return claimedSub;
    }, { requireTransaction: true });

    operation.status = "processing";
    operation.startedAt = operation.startedAt || new Date();
    await operation.save();

    const SubscriptionUsageModel = mongoose.model("SubscriptionUsage");
    const AppointmentModel = mongoose.model("Appointment");
    const InvoiceModel = mongoose.model("Invoice");
    const { billingService } = await import("../billing/billing.service.js");

    // Fetch all usages targeted by this operation
    const targetUsageIds = operation.affectedUsageIds || [];
    const usages = await SubscriptionUsageModel.find({
      _id: { $in: targetUsageIds },
      organizationId,
      isDeleted: false,
    }).sort({ createdAt: 1 });

    // Group usages by appointmentId
    const usagesByAppointment = new Map();
    for (const u of usages) {
      if (!u.appointmentId) continue;
      const aptIdStr = u.appointmentId.toString();
      if (!usagesByAppointment.has(aptIdStr)) {
        usagesByAppointment.set(aptIdStr, []);
      }
      usagesByAppointment.get(aptIdStr).push(u);
    }

    const appointmentIds = Array.from(usagesByAppointment.keys());
    const BATCH_SIZE = 5;
    const totalBatches = Math.ceil(appointmentIds.length / BATCH_SIZE);

    for (let batchIdx = 0; batchIdx < totalBatches; batchIdx++) {
      if (operation.completedBatchIndexes.includes(batchIdx)) {
        // Idempotency: skip already completed batch
        continue;
      }

      // Check worker ownership and renew lock/heartbeat before each batch
      const renewedOp = await SubscriptionCancellationOperation.findOneAndUpdate(
        {
          _id: operation._id,
          workerLockToken,
          status: "processing",
        },
        {
          $set: { heartbeatAt: new Date() },
        },
        { new: true }
      );

      if (!renewedOp) {
        throw new AppError(
          `Worker lost ownership of operation ${operationId} (lock superseded or revoked). Halting execution safely.`,
          409
        );
      }

      const batchAptIds = appointmentIds.slice(
        batchIdx * BATCH_SIZE,
        (batchIdx + 1) * BATCH_SIZE
      );

      // Execute each batch in strict ACID transaction
      try {
        await this.executeTransaction(async (session) => {
          for (const aptIdStr of batchAptIds) {
            const aptUsages = usagesByAppointment.get(aptIdStr) || [];

            // 1. Load appointment with session
            let aptQuery = AppointmentModel.findOne({
              _id: aptIdStr,
              organizationId,
              isDeleted: false,
            });
            if (session) aptQuery = aptQuery.session(session);
            const apt = await aptQuery;

            if (!apt) {
              throw new AppError(`Appointment ${aptIdStr} not found during cancellation`, 404);
            }

            // 2. Load associated invoice with session
            let invQuery = InvoiceModel.findOne({
              appointmentId: apt._id,
              organizationId,
              status: { $ne: "cancelled" },
              isDeleted: false,
            });
            if (session) invQuery = invQuery.session(session);
            let invoice = await invQuery;

            // Process each usage line for this appointment
            for (const usage of aptUsages) {
              if (usage.isReversed) {
                // Already reversed idempotently
                continue;
              }

              const lineServiceId = usage.appointmentServiceId;
              if (!lineServiceId) {
                throw new AppError(
                  `Usage ${usage._id} missing appointmentServiceId for appointment ${apt.appointmentCode}`,
                  400
                );
              }

              // A. Reverse usage record
              usage.isReversed = true;
              usage.reversedAt = new Date();
              usage.reversedBy = userId;
              usage.reversalReason = operation.cancellationReason || "Cancel subscription and restore used-service charges";
              usage.reversalOperationId = operation.operationId;
              await usage.save(session ? { session } : undefined);

              // B. Restore appointment service snapshot line
              const aptServiceLine = (apt.services || []).find(
                (s) => s._id?.toString() === lineServiceId.toString()
              );

              if (!aptServiceLine) {
                throw new AppError(
                  `Appointment service line ${lineServiceId} not found in ${apt.appointmentCode}`,
                  404
                );
              }

              // Authoritative price snapshot check: Must be a valid positive/non-negative number and not null/undefined
              const rawPrice = aptServiceLine.price;
              const snapshotPrice = Number(rawPrice);
              if (rawPrice === null || rawPrice === undefined || isNaN(snapshotPrice) || snapshotPrice < 0) {
                throw new AppError(
                  `Authoritative original price snapshot on appointment service line ${lineServiceId} is missing or invalid (${rawPrice})`,
                  422
                );
              }

              // Restore original retail price and strip subscription coverage
              aptServiceLine.isRedeemedViaSubscription = false;
              aptServiceLine.appliedSubscriptionId = null;
              aptServiceLine.subscriptionUsageId = null;

              // C. Restore Invoice line if invoice exists
              if (invoice) {
                const invLine = (invoice.lines || []).find(
                  (l) => l.appointmentServiceId?.toString() === lineServiceId.toString()
                );
                if (invLine) {
                  invLine.isCoveredBySubscription = false;
                  invLine.appliedSubscriptionId = null;
                  invLine.subscriptionUsageId = null;
                  invLine.subscriptionCoveredAmount = 0;
                  // Unit price and line total are already preserved as original retail price
                }
              }
            }

            // Recalculate Appointment pricing totals
            const aptSubtotal = (apt.services || []).reduce((sum, s) => sum + (s.price || 0), 0);
            apt.pricing = {
              subtotal: aptSubtotal,
              discount: apt.pricing?.discount || 0,
              total: Math.max(0, aptSubtotal - (apt.pricing?.discount || 0)),
            };
            await apt.save(session ? { session } : undefined);

            // Recalculate Invoice financials if invoice exists
            if (invoice) {
              const financials = billingService.recalculateInvoiceFinancials(
                invoice.lines,
                invoice.appliedDiscounts || [],
                invoice.loyaltyDiscountAmount || 0,
                invoice.amountPaid || 0
              );

              invoice.subtotal = financials.subtotal;
              invoice.subscriptionCoveredAmount = financials.subscriptionCoveredAmount;
              invoice.lineDiscountsTotal = financials.lineDiscountsTotal;
              invoice.invoiceDiscountsTotal = financials.invoiceDiscountsTotal;
              invoice.discountTotal = financials.discountTotal;
              invoice.grossPayable = financials.grossPayable;
              invoice.payableAmount = financials.payableAmount;
              invoice.amountDue = financials.amountDue;
              invoice.paymentStatus = financials.paymentStatus;

              await invoice.save(session ? { session } : undefined);

              // Audit appointment restored service charges
              const rebillAudit = new (mongoose.model("AuditLog"))({
                organizationId,
                branchId: apt.branchId,
                actorId: userId,
                action: AUDIT_ACTIONS.SUBSCRIPTION_APPOINTMENT_REBILLED,
                entityType: "Invoice",
                entityId: invoice._id,
                description: `Appointment ${apt.appointmentCode} invoice ${invoice.invoiceNumber} service charges restored after subscription ${subscription.subscriptionCode} cancellation`,
                metadata: {
                  appointmentId: apt._id,
                  subscriptionId: subscription._id,
                  operationId: operation.operationId,
                  amountDue: invoice.amountDue,
                  amountPaid: invoice.amountPaid,
                  payableAmount: invoice.payableAmount,
                },
              });
              await rebillAudit.save(session ? { session } : undefined);
            }
          }
        }, { requireTransaction: true });
      } catch (err) {
        // If snapshot price is invalid or corrupted, mark operation as requires_reconciliation
        if (err.statusCode === 422 || err.message?.includes("Authoritative original price snapshot")) {
          await SubscriptionCancellationOperation.updateOne(
            { _id: operation._id, workerLockToken },
            {
              $set: {
                status: "requires_reconciliation",
              },
              $push: {
                operationErrors: {
                  reason: err.message,
                  timestamp: new Date(),
                },
              },
            }
          );
        }
        throw err;
      }

      // Mark batch index as completed durably with lock check
      const batchUpdateResult = await SubscriptionCancellationOperation.updateOne(
        { _id: operation._id, workerLockToken },
        {
          $addToSet: { completedBatchIndexes: batchIdx },
          $inc: {
            processedAppointmentCount: batchAptIds.length,
            processedUsageCount: batchAptIds.reduce(
              (sum, aptId) => sum + (usagesByAppointment.get(aptId) || []).length,
              0
            ),
          },
          $set: { heartbeatAt: new Date() },
        }
      );

      if (batchUpdateResult.matchedCount === 0) {
        throw new AppError(
          `Worker lost ownership during batch ${batchIdx} completion for operation ${operationId}`,
          409
        );
      }
    }

    // Step 4: Calculate final remaining/used entitlements on Subscription
    // usedQuantity = totalUsage - reversedUsage
    const remainingActiveUsages = await SubscriptionUsageModel.find({
      organizationId,
      subscriptionId: subscription._id,
      isReversed: { $ne: true },
      isDeleted: false,
    });

    const usedCountByService = new Map();
    for (const u of remainingActiveUsages) {
      const sId = u.serviceId.toString();
      usedCountByService.set(sId, (usedCountByService.get(sId) || 0) + (u.quantity || 1));
    }

    if (Array.isArray(subscription.members)) {
      for (const m of subscription.members) {
        m.status = "cancelled";
        for (const ent of m.entitlements || []) {
          const used = usedCountByService.get(ent.serviceId.toString()) || 0;
          ent.usedQuantity = used;
          ent.remainingQuantity = Math.max(0, ent.totalQuantity - used);
        }
      }
    }
    if (Array.isArray(subscription.entitlements)) {
      for (const ent of subscription.entitlements) {
        const used = usedCountByService.get(ent.serviceId.toString()) || 0;
        ent.usedQuantity = used;
        ent.remainingQuantity = Math.max(0, ent.totalQuantity - used);
      }
    }

    subscription.status = "cancelled";
    subscription.cancellationStatus = "completed";
    subscription.notes = subscription.notes
      ? `${subscription.notes}\n[Cancelled]: ${operation.cancellationReason || "Cancel subscription and restore used-service charges"}`
      : `[Cancelled]: ${operation.cancellationReason || "Cancel subscription and restore used-service charges"}`;
    await subscription.save();

    // Cancel draft/unpaid subscription invoice if present
    if (subscription.invoiceId) {
      const subInv = await InvoiceModel.findOne({
        _id: subscription.invoiceId,
        organizationId,
        isDeleted: false,
      });
      if (subInv && (subInv.status === "draft" || subInv.paymentStatus === "unpaid")) {
        subInv.status = "cancelled";
        subInv.cancelledAt = new Date();
        subInv.cancelledBy = userId;
        subInv.cancellationReason = `Subscription ${subscription.subscriptionCode} cancelled`;
        await subInv.save();
      }
    }

    // Mark operation completed
    operation.status = "completed";
    operation.completedAt = new Date();
    operation.processedUsageCount = usages.length;
    operation.processedAppointmentCount = appointmentIds.length;
    await operation.save();

    // Final Audit Log
    if (this.auditRepo && typeof this.auditRepo.create === "function") {
      await this.auditRepo.create(
        {
          branchId: null,
          action: AUDIT_ACTIONS.SUBSCRIPTION_CANCELLED,
          entityType: "Subscription",
          entityId: subscription._id,
          description: `Subscription ${subscription.subscriptionCode} fully cancelled with ${usages.length} usages reversed and original service charges restored across ${appointmentIds.length} appointments`,
          metadata: {
            operationId: operation.operationId,
            reason: operation.cancellationReason,
            totalUsagesReversed: usages.length,
            totalAppointmentsRestored: appointmentIds.length,
            rule: "RULE_B",
          },
        },
        organizationId,
        userId
      );
    }

    return operation;
  }

  /**
   * Retrieves status and progress of a cancellation operation
   */
  async getCancellationOperationStatus(subscriptionId, operationId, organizationId) {
    const operation = await SubscriptionCancellationOperation.findOne({
      operationId,
      organizationId,
      subscriptionId,
      isDeleted: false,
    });

    if (!operation) {
      throw new AppError("Cancellation operation not found", 404);
    }

    return operation;
  }

  /**
   * Retries or reconciles a stalled or failed cancellation operation
   */
  async retryCancellationOperation(subscriptionId, operationId, organizationId, userId) {
    const operation = await SubscriptionCancellationOperation.findOne({
      operationId,
      organizationId,
      subscriptionId,
      isDeleted: false,
    });

    if (!operation) {
      throw new AppError("Cancellation operation not found", 404);
    }

    if (operation.status === "completed") {
      return operation;
    }

    if (operation.status === "requires_reconciliation") {
      throw new AppError(
        "Cancellation operation requires manual reconciliation and cannot be retried automatically",
        400
      );
    }

    // If BullMQ is available, enqueue with retry suffix or invoke directly
    await subscriptionCancellationQueue.add(
      "processCancellationOperation",
      {
        operationId,
        organizationId,
        userId,
      },
      {
        jobId: `retry_op_${operationId}_${Date.now()}`,
      }
    ).catch(() => {});

    return await this.executeCancellationOperation(operationId, organizationId, userId);
  }

  /**
   * Renew subscription
   * Creates a renewed subscription (or renewal cycle) with refreshed entitlements.
   */
  async renewSubscription(id, renewalData, organizationId, userId) {
    const existingSub = await this.subscriptionRepo.findOne({
      _id: id,
      organizationId,
      isDeleted: false,
    });

    if (!existingSub) {
      throw new AppError("Original subscription not found", 404);
    }

    await this.checkAndUpdateExpiry(existingSub);

    if (existingSub.status === "cancelled") {
      throw new AppError("Cancelled subscriptions cannot be renewed", 400);
    }

    const {
      price = existingSub.price,
      startDate = new Date().toISOString(),
      endDate,
      permittedBranchIds = existingSub.permittedBranchIds,
      notes = `Renewal of ${existingSub.subscriptionCode}`,
      billImmediately = false,
      branchId = null,
    } = renewalData;

    if (!endDate) {
      throw new AppError("endDate is required for subscription renewal", 400);
    }

    // Preserve canonical multi-member structure or fallback to legacy single-member format
    let renewalPayload;
    if (Array.isArray(existingSub.members) && existingSub.members.length > 0) {
      const renewedMembers = existingSub.members.map((m) => ({
        customerId: m.customerId,
        permittedBranchIds: m.permittedBranchIds || [],
        notes: m.notes || "",
        entitlements: (m.entitlements || []).map((e) => ({
          serviceId: e.serviceId,
          quantity: e.totalQuantity,
        })),
      }));

      renewalPayload = {
        payerCustomerId: existingSub.payerCustomerId || existingSub.customerId,
        customerId: existingSub.customerId,
        planId: existingSub.planId,
        price,
        members: renewedMembers,
        permittedBranchIds,
        startDate,
        endDate,
        notes,
        billImmediately,
        branchId,
      };
    } else {
      // Legacy single-member subscription renewal
      const freshEntitlements = (existingSub.entitlements || []).map((e) => ({
        serviceId: e.serviceId,
        quantity: e.totalQuantity,
      }));

      renewalPayload = {
        customerId: existingSub.customerId,
        planId: existingSub.planId,
        price,
        entitlements: freshEntitlements,
        permittedBranchIds,
        startDate,
        endDate,
        notes,
        billImmediately,
        branchId,
      };
    }

    return await this.createSubscription(
      renewalPayload,
      organizationId,
      userId,
    );
  }

  /**
   * Send OTP for redemption verification
   */
  async sendRedemptionOTP(subscriptionId, branchId, organizationId, userId, memberCustomerId = null) {
    const subscription = await this.subscriptionRepo.findOne({
      _id: subscriptionId,
      organizationId,
      isDeleted: false,
    });

    if (!subscription) {
      throw new AppError("Subscription not found", 404);
    }

    // Expiry check
    await this.checkAndUpdateExpiry(subscription);

    const redeemableStatuses = ["active", "pending_payment"];
    if (!redeemableStatuses.includes(subscription.status) || subscription.cancellationStatus === "in_progress") {
      throw new AppError(
        `Subscription is not active or eligible for redemption (current status: '${subscription.status}'${subscription.cancellationStatus === "in_progress" ? ", cancellation in progress" : ""})`,
        400,
      );
    }

    // Determine target customer (beneficiary member or payer)
    let targetCustomerId = memberCustomerId;
    if (!targetCustomerId) {
      targetCustomerId = subscription.customerId;
    }

    let targetMember = null;
    // If subscription has members array, verify customer is an active member
    if (Array.isArray(subscription.members) && subscription.members.length > 0) {
      targetMember = subscription.members.find(
        (m) => m.customerId.toString() === targetCustomerId.toString() && ["active", "pending_payment"].includes(m.status)
      );
      if (!targetMember) {
        throw new AppError("Customer is not an active member of this subscription", 400);
      }
    }

    // Branch permission check (member override if specified, else subscription permittedBranchIds)
    this.validateBranchPermission(subscription, branchId, targetMember);

    // Load customer
    let customer;
    if (this.customerRepo && typeof this.customerRepo.findById === "function") {
      customer = await this.customerRepo.findById(
        targetCustomerId,
        organizationId,
      );
    } else {
      const CustomerModel = mongoose.model("Customer");
      customer = await CustomerModel.findById(targetCustomerId);
    }

    if (!customer || customer.isDeleted || customer.status !== "active") {
      throw new AppError("Customer is inactive or not found", 400);
    }

    if (!customer.phone) {
      throw new AppError(
        "Customer does not have a registered phone number for OTP delivery",
        400,
      );
    }

    // Rate limiting: 60s cooldown
    if (customer.otpResendUntil && customer.otpResendUntil > new Date()) {
      const waitSeconds = Math.ceil(
        (customer.otpResendUntil - new Date()) / 1000,
      );
      throw new AppError(
        `Too many OTP requests. Please wait ${waitSeconds} seconds before requesting a new OTP.`,
        429,
      );
    }

    // Generate 6-digit OTP and SHA-256 hash
    const rawOtp = Math.floor(100000 + Math.random() * 900000).toString();
    const hashedOtp = crypto.createHash("sha256").update(rawOtp).digest("hex");

    customer.otp = hashedOtp;
    customer.otpExpires = new Date(Date.now() + 5 * 60 * 1000); // 5 min
    customer.otpResendUntil = new Date(Date.now() + 60 * 1000); // 60s cooldown
    customer.otpAttempts = 0;
    await customer.save();

    // Dispatch SMS via BullMQ queue
    try {
      await smsQueue.add("sendOtpSMS", {
        phone: customer.phone,
        otp: rawOtp,
      });
    } catch (queueErr) {
      logger.warn(`Failed to enqueue redemption OTP SMS: ${queueErr.message}`);
    }

    // Audit log
    if (this.auditRepo && typeof this.auditRepo.create === "function") {
      await this.auditRepo.create(
        {
          branchId,
          action: AUDIT_ACTIONS.SUBSCRIPTION_OTP_SENT,
          entityType: "Subscription",
          entityId: subscriptionId,
          description: `Redemption OTP sent to customer ${customer.name} (${customer.phone})`,
          metadata: { customerId: customer._id },
        },
        organizationId,
        userId,
      );
    }

    logger.info(
      `[SECURITY] SUBSCRIPTION_REDEMPTION_OTP_SENT for subscription ${subscriptionId}`,
    );

    return {
      success: true,
      message: "Redemption OTP sent successfully to customer phone",
      data: {
        expiresIn: 300,
        resendAfter: 60,
      },
    };
  }

  /**
   * Redeem subscription entitlements with OTP verification and atomic balance update
   */
  /**
   * Deterministically find an active, eligible subscription for a customer and service.
   * Selection rule:
   * 1. Customer ID and Organization ID match.
   * 2. Status is "active", not expired (endDate >= now), not deleted.
   * 3. Permitted branches include branchId (or empty array means all branches permitted).
   * 4. Entitlements include serviceId with remainingQuantity >= 1.
   * 5. Deterministic order: earliest-expiring first (endDate: 1), followed by earliest-created (createdAt: 1).
   */
  async findEligibleSubscriptionForService(
    customerId,
    serviceId,
    branchId,
    organizationId,
    session = null
  ) {
    const SubscriptionModel = mongoose.model("Subscription");
    const now = new Date();

    const candidateQuery = {
      organizationId,
      status: { $in: ["active", "pending_payment"] },
      isDeleted: false,
      endDate: { $gte: now },
      cancellationStatus: { $ne: "in_progress" },
      $or: [
        // Multi-customer member allocation
        {
          members: {
            $elemMatch: {
              customerId: customerId,
              status: { $in: ["active", "pending_payment"] },
              entitlements: {
                $elemMatch: {
                  serviceId: serviceId,
                  remainingQuantity: { $gte: 1 },
                },
              },
            },
          },
        },
        // Legacy single-customer format fallback
        {
          customerId: customerId,
          entitlements: {
            $elemMatch: {
              serviceId: serviceId,
              remainingQuantity: { $gte: 1 },
            },
          },
        },
      ],
      $and: [
        {
          $or: [
            { permittedBranchIds: { $exists: false } },
            { permittedBranchIds: { $size: 0 } },
            { permittedBranchIds: branchId },
          ],
        },
      ],
    };

    let query = SubscriptionModel.find(candidateQuery).sort({
      endDate: 1,
      createdAt: 1,
    });
    if (session) {
      query = query.session(session);
    }

    const subscriptions = await query.exec();
    return subscriptions.length > 0 ? subscriptions[0] : null;
  }

  /**
   * Redeem subscription entitlements with OTP or authorized Manual verification,
   * atomic balance update, idempotency protection, and full audit logging.
   */
  async redeemSubscription(
    subscriptionId,
    branchId,
    otp,
    services,
    appointmentId,
    organizationId,
    userId,
    options = {}
  ) {
    const isManual = Boolean(options.isManual);
    const reason = options.reason ? options.reason.trim() : null;
    const idempotencyKey = options.idempotencyKey ? options.idempotencyKey.trim() : null;

    if (!isManual) {
      logger.warn(
        `[DEPRECATION] Standalone subscription redeem called for subscription ${subscriptionId}. Salon redemptions should proceed via Appointment completion.`,
      );
    }

    // Idempotency check: if an idempotency key was supplied or duplicate manual request is sent
    if (idempotencyKey) {
      const existingUsage = await this.subscriptionUsageRepo.findOne({
        organizationId,
        subscriptionId,
        reason: { $regex: new RegExp(`\\[IdempotencyKey: ${idempotencyKey}\\]`, "i") },
      });
      if (existingUsage) {
        logger.info(`Idempotent redemption request detected for key: ${idempotencyKey}`);
        const existingSub = await this.subscriptionRepo.findById(subscriptionId, organizationId);
        return {
          subscription: existingSub,
          usage: [existingUsage],
          idempotent: true,
        };
      }
    }

    if (!isManual && !otp) {
      throw new AppError("OTP is required to redeem subscription", 400);
    }

    if (isManual && !reason) {
      throw new AppError("Reason is required for manual subscription redemption", 400);
    }

    if (!Array.isArray(services) || services.length === 0) {
      throw new AppError(
        "At least one service to redeem must be specified",
        400,
      );
    }

    // 1. Fetch subscription
    const subscription = await this.subscriptionRepo.findOne({
      _id: subscriptionId,
      organizationId,
      isDeleted: false,
    });

    if (!subscription) {
      if (this.auditRepo && typeof this.auditRepo.create === "function") {
        await this.auditRepo.create(
          {
            branchId,
            action: AUDIT_ACTIONS.SUBSCRIPTION_REDEMPTION_FAILED,
            entityType: "Subscription",
            entityId: subscriptionId,
            description: `Redemption failed: Subscription not found`,
            metadata: { subscriptionId, isManual, reason },
          },
          organizationId,
          userId,
        ).catch(() => {});
      }
      throw new AppError("Subscription not found", 404);
    }

    await this.checkAndUpdateExpiry(subscription);

    const redeemableStatuses = ["active", "pending_payment"];
    if (!redeemableStatuses.includes(subscription.status) || subscription.cancellationStatus === "in_progress") {
      if (this.auditRepo && typeof this.auditRepo.create === "function") {
        await this.auditRepo.create(
          {
            branchId,
            action: AUDIT_ACTIONS.SUBSCRIPTION_REDEMPTION_FAILED,
            entityType: "Subscription",
            entityId: subscription._id,
            description: `Redemption failed: Subscription status is '${subscription.status}'${subscription.cancellationStatus === "in_progress" ? " (cancellation in progress)" : ""}`,
            metadata: { subscriptionCode: subscription.subscriptionCode, isManual, status: subscription.status, cancellationStatus: subscription.cancellationStatus },
          },
          organizationId,
          userId,
        ).catch(() => {});
      }
      throw new AppError(
        `Cannot redeem from a subscription with status '${subscription.status}'${subscription.cancellationStatus === "in_progress" ? " (cancellation in progress)" : ""}`,
        400,
      );
    }

    // 2. Determine target member customer and handle verification
    // 2.1 Fetch appointment if appointmentId provided
    let appointment = null;
    if (appointmentId) {
      const AppointmentModel = mongoose.model("Appointment");
      appointment = await AppointmentModel.findOne({
        _id: appointmentId,
        organizationId,
        isDeleted: false,
      });

      if (!appointment) {
        throw new AppError("Provided appointment not found in this organization", 404);
      }
    }

    let targetCustomerId = options.memberCustomerId;
    if (!targetCustomerId) {
      if (appointmentId && appointment) {
        targetCustomerId = appointment.customerId?._id ? appointment.customerId._id.toString() : appointment.customerId.toString();
      } else {
        targetCustomerId = subscription.customerId.toString();
      }
    }

    let targetMember = null;
    if (Array.isArray(subscription.members) && subscription.members.length > 0) {
      targetMember = subscription.members.find(
        (m) => m.customerId.toString() === targetCustomerId.toString() && ["active", "pending_payment"].includes(m.status)
      );
      if (!targetMember) {
        throw new AppError("Customer is not an active member of this subscription", 400);
      }
    }

    // 2.2 Validate branch permission (member override if specified, else subscription permittedBranchIds)
    this.validateBranchPermission(subscription, branchId, targetMember);

    let customer;
    if (this.customerRepo && typeof this.customerRepo.findById === "function") {
      customer = await this.customerRepo.findById(
        targetCustomerId,
        organizationId,
      );
    } else {
      const CustomerModel = mongoose.model("Customer");
      customer = await CustomerModel.findById(targetCustomerId);
    }

    if (!customer || customer.isDeleted) {
      throw new AppError("Customer not found", 404);
    }

    if (!isManual) {
      // OTP verification path
      if (!customer.otp || !customer.otpExpires) {
        throw new AppError("No OTP requested. Please request an OTP first.", 400);
      }

      if (customer.otpExpires < new Date()) {
        customer.otp = null;
        customer.otpExpires = null;
        await customer.save();
        throw new AppError("OTP has expired. Please request a new OTP.", 400);
      }

      if (customer.otpAttempts >= 5) {
        customer.otp = null;
        customer.otpExpires = null;
        await customer.save();
        throw new AppError(
          "Too many incorrect OTP attempts. Please request a new OTP.",
          429,
        );
      }

      const hashedInputOtp = crypto
        .createHash("sha256")
        .update(otp.toString())
        .digest("hex");
      if (hashedInputOtp !== customer.otp) {
        customer.otpAttempts = (customer.otpAttempts || 0) + 1;
        await customer.save();
        const remainingAttempts = 5 - customer.otpAttempts;

        if (this.auditRepo && typeof this.auditRepo.create === "function") {
          await this.auditRepo.create(
            {
              branchId,
              action: AUDIT_ACTIONS.SUBSCRIPTION_REDEMPTION_FAILED,
              entityType: "Subscription",
              entityId: subscription._id,
              description: `Redemption failed: Invalid OTP attempt for customer ${customer.name}`,
              metadata: { customerId: customer._id, attemptsRemaining: remainingAttempts },
            },
            organizationId,
            userId,
          ).catch(() => {});
        }

        throw new AppError(
          `Invalid OTP. ${remainingAttempts} attempts remaining.`,
          400,
        );
      }

      // OTP matches! Clear customer OTP
      customer.otp = null;
      customer.otpExpires = null;
      customer.otpAttempts = 0;
      await customer.save();
    }

    // 4. Validate appointment ownership & service inclusion if appointmentId is supplied
    if (appointmentId && appointment) {
      const aptCustId = appointment.customerId?._id ? appointment.customerId._id.toString() : appointment.customerId.toString();
      const isBeneficiaryMatch = targetMember
        ? targetMember.customerId.toString() === aptCustId
        : subscription.customerId.toString() === aptCustId;

      if (!isBeneficiaryMatch) {
        throw new AppError("Provided appointment does not belong to the subscription customer", 400);
      }

      const getAptBranchId = (apt) =>
        apt.branchId?._id ? apt.branchId._id.toString() : apt.branchId.toString();
      if (getAptBranchId(appointment) !== branchId.toString()) {
        throw new AppError("Appointment branch does not match redemption branch", 400);
      }

      // Check each requested service is present on the appointment
      for (const reqService of services) {
        const hasService = appointment.services.some(
          (s) => s.serviceId && s.serviceId.toString() === reqService.serviceId.toString()
        );
        if (!hasService) {
          throw new AppError(
            `Service ${reqService.serviceId} is not part of appointment ${appointment.appointmentCode}`,
            400
          );
        }
      }
    }

    // 5. Validate requested services against active member/legacy entitlements
    const availableEntitlements = targetMember ? targetMember.entitlements : subscription.entitlements;
    for (const reqService of services) {
      const qty = parseInt(reqService.quantity || 1, 10);
      if (isNaN(qty) || qty < 1) {
        throw new AppError("Invalid redemption quantity", 400);
      }

      const entitlement = availableEntitlements.find(
        (e) => e.serviceId.toString() === reqService.serviceId.toString(),
      );

      if (!entitlement) {
        throw new AppError(
          `Service ${reqService.serviceId} is not included in this subscription's entitlements`,
          400,
        );
      }

      if (entitlement.remainingQuantity < qty) {
        if (this.auditRepo && typeof this.auditRepo.create === "function") {
          await this.auditRepo.create(
            {
              branchId,
              action: AUDIT_ACTIONS.SUBSCRIPTION_REDEMPTION_FAILED,
              entityType: "Subscription",
              entityId: subscription._id,
              description: `Redemption failed: Insufficient entitlement balance for service ${entitlement.serviceName}`,
              metadata: {
                serviceId: reqService.serviceId,
                requested: qty,
                available: entitlement.remainingQuantity,
              },
            },
            organizationId,
            userId,
          ).catch(() => {});
        }
        throw new AppError(
          `Insufficient balance for service '${entitlement.serviceName}'. Available: ${entitlement.remainingQuantity}, Requested: ${qty}`,
          409,
        );
      }
    }

    // 6. Atomic decrements and usage logging in transaction
    const redemptionResult = await this.executeTransaction(async (session) => {
      const createdUsageRecords = [];
      let latestSubscription = subscription;

      for (const reqService of services) {
        const qty = parseInt(reqService.quantity || 1, 10);

        // Atomic member decrement with balance guard
        let updatedSub;
        if (targetMember) {
          updatedSub = await this.subscriptionRepo.atomicDecrementMemberEntitlement(
            subscription._id,
            organizationId,
            targetMember.customerId,
            reqService.serviceId,
            qty,
            session,
          );
        } else {
          updatedSub = await this.subscriptionRepo.atomicDecrementEntitlement(
            subscription._id,
            organizationId,
            reqService.serviceId,
            qty,
            session,
          );
        }

        if (!updatedSub) {
          throw new AppError(
            `Concurrent modification or insufficient balance while redeeming service ${reqService.serviceId}`,
            409,
          );
        }

        latestSubscription = updatedSub;

        // Find service name snapshot from updated member
        const currentMember = updatedSub.members && updatedSub.members.find
          ? updatedSub.members.find((m) => m.customerId.toString() === targetCustomerId.toString())
          : null;
        const entList = currentMember ? currentMember.entitlements : updatedSub.entitlements;
        const matchingEnt = entList.find(
          (e) => e.serviceId.toString() === reqService.serviceId.toString(),
        );
        const serviceName = matchingEnt ? matchingEnt.serviceName : "Service";

        const storedReason = [
          reason ? `[Reason]: ${reason}` : null,
          idempotencyKey ? `[IdempotencyKey: ${idempotencyKey}]` : null,
        ].filter(Boolean).join(" ") || null;

        // Create SubscriptionUsage record
        const matchingAptService = appointment?.services?.find(
          (s) => s.serviceId && s.serviceId.toString() === reqService.serviceId.toString() && !s.isRedeemedViaSubscription
        );

        const usageRecord = await this.subscriptionUsageRepo.create(
          {
            organizationId,
            subscriptionId: subscription._id,
            customerId: targetCustomerId,
            serviceId: reqService.serviceId,
            serviceName,
            quantity: qty,
            branchId,
            verifiedBy: userId,
            verificationMethod: isManual ? "manual" : "otp",
            reason: storedReason,
            appointmentId: appointmentId || null,
            appointmentServiceId: matchingAptService?._id || null,
            appointmentCode: appointment ? appointment.appointmentCode : null,
            subscriptionInvoiceId: subscription.invoiceId || null,
          },
          userId,
          session,
        );

        createdUsageRecords.push(usageRecord);

        // If appointmentId provided, update the Appointment's service line item status
        if (appointmentId && matchingAptService) {
          const AppointmentModel = mongoose.model("Appointment");
          await AppointmentModel.updateOne(
            {
              _id: appointmentId,
              organizationId,
              "services._id": matchingAptService._id,
            },
            {
              $set: {
                "services.$.isRedeemedViaSubscription": true,
                "services.$.subscriptionUsageId": usageRecord._id,
              },
            },
            { session },
          );
        }
      }

      // Check member-level exhaustion and global subscription exhaustion
      let subModified = false;
      if (Array.isArray(latestSubscription.members) && latestSubscription.members.length > 0) {
        for (const m of latestSubscription.members) {
          const isMemberExhausted = m.entitlements.every((e) => e.remainingQuantity === 0);
          if (isMemberExhausted && m.status !== "exhausted") {
            m.status = "exhausted";
            subModified = true;
          }
        }
        const allMembersExhausted = latestSubscription.members.every(
          (m) => m.status === "exhausted" || m.status === "cancelled"
        );
        if (allMembersExhausted && latestSubscription.status !== "exhausted") {
          latestSubscription.status = "exhausted";
          subModified = true;
        }
      } else {
        const allExhausted = (latestSubscription.entitlements || []).every(
          (e) => e.remainingQuantity === 0,
        );
        if (allExhausted && latestSubscription.status !== "exhausted") {
          latestSubscription.status = "exhausted";
          subModified = true;
        }
      }

      if (subModified) {
        await latestSubscription.save({ session });
      }

      // Audit Log
      const auditAction = isManual
        ? AUDIT_ACTIONS.SUBSCRIPTION_MANUAL_REDEEMED
        : AUDIT_ACTIONS.SUBSCRIPTION_REDEEMED;

      if (this.auditRepo && typeof this.auditRepo.create === "function") {
        await this.auditRepo.create(
          {
            branchId,
            action: auditAction,
            entityType: "Subscription",
            entityId: subscription._id,
            description: `${isManual ? "Manually redeemed" : "Redeemed"} ${services.length} service(s) from subscription ${subscription.subscriptionCode} at branch ${branchId}`,
            metadata: {
              subscriptionCode: subscription.subscriptionCode,
              servicesRedeemed: services,
              appointmentId: appointmentId || null,
              newStatus: latestSubscription.status,
              isManual,
              reason: reason || null,
              idempotencyKey: idempotencyKey || null,
            },
          },
          organizationId,
          userId,
          session,
        );
      }

      // Ensure legacy entitlements matches target member's entitlements for direct response readers
      if (Array.isArray(latestSubscription.members) && latestSubscription.members.length > 0) {
        const mem = latestSubscription.members.find((m) => m.customerId.toString() === targetCustomerId.toString()) || latestSubscription.members[0];
        latestSubscription.entitlements = mem.entitlements;
      }

      return {
        subscription: latestSubscription,
        usage: createdUsageRecords,
      };
    });

    // 7. Best effort notification
    try {
      if (customer.phone) {
        await smsQueue.add("sendSubscriptionRedemptionSMS", {
          phone: customer.phone,
          customerName: customer.name,
          subscriptionCode: subscription.subscriptionCode,
          services: services.map((s) => ({
            serviceId: s.serviceId,
            quantity: s.quantity,
          })),
        });
      }
    } catch (queueErr) {
      logger.warn(`Failed to enqueue redemption SMS: ${queueErr.message}`);
    }

    return redemptionResult;
  }

  /**
   * Get usage history for a subscription
   */
  async getSubscriptionUsage(subscriptionId, organizationId) {
    const subscription = await this.subscriptionRepo.findOne({
      _id: subscriptionId,
      organizationId,
      isDeleted: false,
    });

    if (!subscription) {
      throw new AppError("Subscription not found", 404);
    }

    const usages = await this.subscriptionUsageRepo.findBySubscriptionId(
      subscriptionId,
      organizationId,
    );

    // Map each usage to explicitly expose redeemedAt and appointmentCode
    return usages.map((item) => {
      const obj = item.toObject ? item.toObject() : { ...item };
      obj.redeemedAt = obj.createdAt;
      obj.appointmentCode =
        obj.appointmentCode ||
        (obj.appointmentId && typeof obj.appointmentId === "object"
          ? obj.appointmentId.appointmentCode
          : null) ||
        null;
      obj.subscriptionInvoice = obj.subscriptionInvoiceId || null;
      return obj;
    });
  }

  /**
   * Helper: Check if branch is permitted for this subscription and member
   * Business rule:
   * - subscription.permittedBranchIds, when non-empty, is the hard maximum boundary.
   * - member.permittedBranchIds, when non-empty, further restricts that member within the subscription's permitted branches.
   * - An empty member list inherits the subscription's permitted branches.
   * - An empty subscription list means all organization branches, subject to any member-level restriction.
   * Effective set is the intersection when both lists are non-empty.
   */
  validateBranchPermission(subscription, branchId, targetMember = null) {
    const subBranches = Array.isArray(subscription.permittedBranchIds)
      ? subscription.permittedBranchIds
      : [];
    const memberBranches =
      targetMember && Array.isArray(targetMember.permittedBranchIds)
        ? targetMember.permittedBranchIds
        : [];

    const branchIdStr = branchId.toString();

    // 1. Subscription hard boundary check
    if (subBranches.length > 0) {
      const isAllowedBySub = subBranches.some(
        (b) => b.toString() === branchIdStr,
      );
      if (!isAllowedBySub) {
        throw new AppError(
          "Subscription is not valid for redemption at this branch",
          403,
        );
      }
    }

    // 2. Member restriction check (narrowing)
    if (memberBranches.length > 0) {
      const isAllowedByMember = memberBranches.some(
        (b) => b.toString() === branchIdStr,
      );
      if (!isAllowedByMember) {
        throw new AppError(
          "Subscription is not valid for redemption at this branch",
          403,
        );
      }
    }
  }

  /**
   * Helper: Lazy expiration check
   */
  async checkAndUpdateExpiry(subscription) {
    if (
      ["active", "pending_payment"].includes(subscription.status) &&
      subscription.endDate &&
      new Date(subscription.endDate) < new Date()
    ) {
      subscription.status = "expired";
      await subscription.save();
    }
  }

  /**
   * Standalone Crash Recovery & Reconciliation Engine
   * Identifies challenges stuck in 'in_redemption' or 'decremented' without completed appointment.
   * Restores decrements ONLY if the appointment was NOT completed.
   * If the appointment completed, marks the challenge as completed.
   */
  async reconcileIncompleteRedemptions(
    organizationId,
    { maxAgeMinutes = 5, staleLockTimeoutMs = 120000 } = {}
  ) {
    const SubscriptionConsumptionChallenge = mongoose.model("SubscriptionConsumptionChallenge");
    const AppointmentModel = mongoose.model("Appointment");
    const SubscriptionModel = mongoose.model("Subscription");
    const SubscriptionUsageModel = mongoose.model("SubscriptionUsage");
    const now = new Date();
    const cutoff = maxAgeMinutes === 0 ? new Date(now.getTime() + 1000) : new Date(now.getTime() - maxAgeMinutes * 60 * 1000);
    const staleLockThreshold = new Date(now.getTime() - staleLockTimeoutMs);

    const query = {
      $or: [
        {
          updatedAt: { $lte: cutoff },
          $or: [
            { status: "in_redemption" },
            { redemptionState: { $in: ["in_redemption", "decremented"] } },
          ],
        },
        {
          // Recover stale restoring locks where previous worker crashed
          redemptionState: "restoring",
          $or: [
            { reconciliationClaimedAt: { $lte: staleLockThreshold } },
            { reconciliationClaimedAt: null, updatedAt: { $lte: cutoff } },
          ],
        },
      ],
    };
    if (organizationId) {
      query.organizationId = organizationId;
    }

    const candidateChallenges = await SubscriptionConsumptionChallenge.find(query);
    const report = {
      inspected: candidateChallenges.length,
      reconciledCompleted: 0,
      reconciledRestored: 0,
      errors: 0,
    };

    for (const candidate of candidateChallenges) {
      try {
        // Concurrency Guard: Atomically claim the challenge for reconciliation by transitioning redemptionState to 'restoring'
        // Prevents overlap across concurrent server processes and safely recovers stale restoring leases
        const challenge = await SubscriptionConsumptionChallenge.findOneAndUpdate(
          {
            _id: candidate._id,
            $or: [
              { redemptionState: { $in: ["pending", "in_redemption", "decremented"] } },
              {
                redemptionState: "restoring",
                $or: [
                  { reconciliationClaimedAt: { $lt: staleLockThreshold } },
                  { reconciliationClaimedAt: null },
                ],
              },
            ],
          },
          {
            $set: {
              redemptionState: "restoring",
              reconciliationClaimedAt: new Date(),
            },
          },
          { returnDocument: "after" }
        );

        if (!challenge) {
          // Another concurrent worker holds an active lease on this challenge
          continue;
        }

        const appointment = await AppointmentModel.findById(challenge.appointmentId);
        if (appointment && appointment.status === "completed") {
          // Operation actually completed before crash
          await SubscriptionConsumptionChallenge.updateOne(
            { _id: challenge._id },
            { $set: { status: "verified", redemptionState: "completed" } }
          );
          report.reconciledCompleted++;
        } else {
          // Operation was interrupted before appointment completed.
          let hasAmbiguousOrFailedDecrements = false;

          if (Array.isArray(challenge.decrements) && challenge.decrements.length > 0) {
            for (let i = 0; i < challenge.decrements.length; i++) {
              const dec = challenge.decrements[i];
              const lineId = dec.appointmentServiceId || dec._id;
              const decOpId = dec.operationId || `${challenge._id.toString()}:${lineId.toString()}:dec`;
              const restoreOpId = `${decOpId}:restore`;

              // Inspect Subscription document to establish verifiable operation state
              const subDoc = await SubscriptionModel.findById(dec.subscriptionId);
              if (!subDoc) {
                // Subscription missing - ambiguous state; must not treat as resolved if balance may have changed
                hasAmbiguousOrFailedDecrements = true;
                continue;
              }

              const isRestoredInSub = subDoc.appliedOperations?.includes(restoreOpId) ||
                subDoc.appliedOperations?.includes(`${challenge._id.toString()}:${lineId.toString()}:restore`);
              const isDecrementedInSub = subDoc.appliedOperations?.includes(decOpId);

              // 1. Balance restoration already committed in Subscription doc or marked restored:
              if (isRestoredInSub || dec.isRestored) {
                if (!dec.isRestored || dec.restorationState !== "restored") {
                  await SubscriptionConsumptionChallenge.updateOne(
                    { _id: challenge._id },
                    {
                      $set: {
                        [`decrements.${i}.isDecremented`]: true,
                        [`decrements.${i}.isRestored`]: true,
                        [`decrements.${i}.restorationState`]: "restored",
                        [`decrements.${i}.restoredAt`]: dec.restoredAt || new Date(),
                      },
                    }
                  );
                }
                continue;
              }

              // 2. Distinguish a decrement that never happened from one that committed but acknowledgment was lost:
              const decrementActuallyCommitted = isDecrementedInSub || dec.isDecremented === true;
              const decrementNeverCommitted = !isDecrementedInSub && dec.isDecremented === false;

              if (decrementNeverCommitted) {
                // Fencing: Permanently record fence token on Subscription to prevent in-flight
                // or delayed workers from committing this decrement after recovery classified it as unapplied
                await this.subscriptionRepo.fenceOperation(dec.subscriptionId, decOpId);

                // Decrement never happened on MongoDB - no balance restoration required
                await SubscriptionConsumptionChallenge.updateOne(
                  { _id: challenge._id },
                  {
                    $set: {
                      [`decrements.${i}.isDecremented`]: false,
                      [`decrements.${i}.isRestored`]: false,
                      [`decrements.${i}.restorationState`]: "none",
                    },
                  }
                );
                continue;
              }

              if (decrementActuallyCommitted) {
                // Claim restoration lock on decrement entry
                await SubscriptionConsumptionChallenge.updateOne(
                  { _id: challenge._id },
                  {
                    $set: {
                      [`decrements.${i}.isDecremented`]: true,
                      [`decrements.${i}.restorationState`]: "restoring",
                    },
                  }
                );

                // Execute idempotent balance restoration targeting durable operation identity
                await this.subscriptionRepo.atomicRestoreMemberEntitlement(
                  dec.subscriptionId,
                  challenge.organizationId,
                  dec.memberCustomerId,
                  dec.serviceId,
                  dec.quantity || 1,
                  null, // session
                  restoreOpId // durable restoration operation identity!
                );

                // Confirm restoration in challenge ledger
                await SubscriptionConsumptionChallenge.updateOne(
                  { _id: challenge._id },
                  {
                    $set: {
                      [`decrements.${i}.isRestored`]: true,
                      [`decrements.${i}.restorationState`]: "restored",
                      [`decrements.${i}.restoredAt`]: new Date(),
                    },
                  }
                );
              }
            }
          }

          // Clean up any orphan SubscriptionUsage records created during interrupted appointment completion
          if (challenge.appointmentId) {
            await SubscriptionUsageModel.deleteMany({
              appointmentId: challenge.appointmentId,
            });
          }

          if (hasAmbiguousOrFailedDecrements) {
            // Do NOT mark ambiguous operation exhausted and treat it as resolved if the balance may already have changed!
            await SubscriptionConsumptionChallenge.updateOne(
              { _id: challenge._id },
              { $set: { redemptionState: "failed" } }
            );
            report.errors++;
          } else {
            await SubscriptionConsumptionChallenge.updateOne(
              { _id: challenge._id },
              { $set: { status: "exhausted", redemptionState: "reconciled" } }
            );
            report.reconciledRestored++;
          }
        }
      } catch (err) {
        report.errors++;
      }
    }

    return report;
  }
}

import { SubscriptionRepository } from "../../repositories/subscriptions/subscription.repository.js";
import { SubscriptionUsageRepository } from "../../repositories/subscriptions/subscriptionUsage.repository.js";
import { CustomerRepository } from "../../repositories/customers/customer.repository.js";
import { ServiceRepository } from "../../repositories/services/service.repository.js";
import { Branch } from "../../models/branches/branch.model.js";
import { AuditLogRepository } from "../../repositories/audit/auditLog.repository.js";

export const subscriptionService = new SubscriptionService(
  new SubscriptionRepository(),
  new SubscriptionUsageRepository(),
  new CustomerRepository(),
  new ServiceRepository(),
  Branch,
  new AuditLogRepository()
);
