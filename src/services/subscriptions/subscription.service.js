import crypto from "crypto";
import mongoose from "mongoose";
import { AppError } from "../../utils/errors.js";
import { logger } from "../../utils/logger.js";
import { Sequence } from "../../models/sequence/sequence.model.js";
import { AUDIT_ACTIONS } from "../../models/audit/auditLog.model.js";
import { smsQueue } from "../../queues/client.js";

export class SubscriptionService {
  constructor(
    subscriptionRepo,
    subscriptionUsageRepo,
    customerRepo,
    serviceRepo,
    branchRepo,
    auditRepo
  ) {
    this.subscriptionRepo = subscriptionRepo;
    this.subscriptionUsageRepo = subscriptionUsageRepo;
    this.customerRepo = customerRepo;
    this.serviceRepo = serviceRepo;
    this.branchRepo = branchRepo;
    this.auditRepo = auditRepo;
  }

  /**
   * Helper to execute a sequence of actions within a MongoDB session/transaction,
   * with graceful fallback for standalone replica-less environments.
   */
  async executeTransaction(callback) {
    let session = null;
    try {
      if (
        mongoose.connection.db &&
        typeof mongoose.connection.startSession === "function"
      ) {
        session = await mongoose.connection.startSession();
        session.startTransaction();

        const result = await callback(session);

        await session.commitTransaction();
        session.endSession();
        return result;
      }
    } catch (err) {
      if (session) {
        try {
          await session.abortTransaction();
          session.endSession();
        } catch (_) {}
      }

      const isSessionError =
        err.message &&
        (err.message.includes("Transaction numbers") ||
          err.message.includes("does not support retryable writes") ||
          err.message.includes("replica set") ||
          err.message.includes("IllegalOperation"));

      if (!isSessionError) {
        throw err;
      }
    }

    // Fallback: run without transaction if MongoDB doesn't support transactions
    return await callback(null);
  }

  /**
   * Generate human-readable subscription code: SUB-YYYYMMDD-XXXX
   */
  async generateSubscriptionCode(organizationId) {
    const sequenceKey = `SUB_${organizationId.toString()}`;
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
    return `SUB-${yyyy}${mm}${dd}-${num}`;
  }

  /**
   * Create a customer-specific subscription
   */
  async createSubscription(data, organizationId, userId) {
    const {
      customerId,
      planId,
      price,
      entitlements,
      permittedBranchIds = [],
      startDate,
      endDate,
      notes = "",
    } = data;

    // 0. If planId provided, validate it belongs to organization and is active
    let resolvedPlanId = null;
    if (planId) {
      const PlanModel = mongoose.model("SubscriptionPlan");
      const plan = await PlanModel.findOne({
        _id: planId,
        organizationId,
        isDeleted: false,
      });
      if (!plan) {
        throw new AppError("Subscription plan template not found in this organization", 404);
      }
      resolvedPlanId = plan._id;
    }

    // 1. Verify customer exists, belongs to org, and is active
    let customer;
    if (this.customerRepo && typeof this.customerRepo.findById === "function") {
      customer = await this.customerRepo.findById(customerId, organizationId);
    } else {
      const CustomerModel = mongoose.model("Customer");
      customer = await CustomerModel.findById(customerId);
    }

    if (
      !customer ||
      customer.organizationId.toString() !== organizationId.toString() ||
      customer.isDeleted
    ) {
      throw new AppError("Customer not found or invalid for organization", 404);
    }

    if (customer.status !== "active") {
      throw new AppError(
        `Cannot create subscription for customer with status '${customer.status}'`,
        400
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
        } else if (this.branchRepo && typeof this.branchRepo.findOne === "function") {
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
          throw new AppError(`Permitted branch ${branchId} is invalid or inactive`, 400);
        }
        validPermittedBranchIds.push(branch._id);
      }
    }

    // 4. Validate entitlements: no duplicates, services must exist, be active, belong to org
    if (!Array.isArray(entitlements) || entitlements.length === 0) {
      throw new AppError("At least one entitlement is required", 400);
    }

    const seenServiceIds = new Set();
    const resolvedEntitlements = [];

    for (const ent of entitlements) {
      const sIdStr = ent.serviceId.toString();
      if (seenServiceIds.has(sIdStr)) {
        throw new AppError(
          "Duplicate serviceId in entitlements. Consolidate into a single entitlement with total quantity.",
          400
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
        throw new AppError(
          `Service '${service.name}' is inactive and cannot be added to a subscription`,
          400
        );
      }

      const totalQuantity = parseInt(ent.quantity, 10);
      if (isNaN(totalQuantity) || totalQuantity < 1) {
        throw new AppError(
          `Invalid quantity for service '${service.name}'. Must be at least 1.`,
          400
        );
      }

      resolvedEntitlements.push({
        serviceId: service._id,
        serviceName: service.name,
        totalQuantity,
        usedQuantity: 0,
        remainingQuantity: totalQuantity,
      });
    }

    // 5. Generate subscription code
    const subscriptionCode = await this.generateSubscriptionCode(organizationId);

    // 6. Create subscription and audit log in transaction
    const subscription = await this.executeTransaction(async (session) => {
      const newSub = await this.subscriptionRepo.create(
        {
          organizationId,
          customerId: customer._id,
          subscriptionCode,
          planId: resolvedPlanId,
          price: Number(price),
          entitlements: resolvedEntitlements,
          permittedBranchIds: validPermittedBranchIds,
          startDate: start,
          endDate: end,
          status: "active",
          notes,
        },
        userId,
        session
      );

      if (this.auditRepo && typeof this.auditRepo.create === "function") {
        await this.auditRepo.create(
          {
            branchId: null,
            action: AUDIT_ACTIONS.SUBSCRIPTION_CREATED,
            entityType: "Subscription",
            entityId: newSub._id,
            description: `Subscription ${subscriptionCode} created for customer ${customer.name} with price ${price}`,
            metadata: {
              subscriptionCode,
              customerId: customer._id,
              planId: resolvedPlanId,
              price,
              entitlementsCount: resolvedEntitlements.length,
            },
          },
          organizationId,
          userId,
          session
        );
      }

      return newSub;
    });

    // 7. Dispatch notification (best-effort async)
    try {
      if (customer.phone) {
        await smsQueue.add("sendSubscriptionCreatedSMS", {
          phone: customer.phone,
          customerName: customer.name,
          subscriptionCode: subscription.subscriptionCode,
          price: subscription.price,
          organizationId: organizationId.toString(),
        });
      }
    } catch (queueErr) {
      logger.warn(`Failed to enqueue subscription creation SMS: ${queueErr.message}`);
    }

    return subscription;
  }

  /**
   * List subscriptions with search, filter, and pagination
   */
  async listSubscriptions(query, organizationId) {
    const {
      page = 1,
      limit = 20,
      customerId,
      status,
      branchId,
      search,
    } = query;

    const filter = {
      organizationId,
      isDeleted: false,
    };

    if (customerId) {
      filter.customerId = customerId;
    }

    if (status) {
      filter.status = status;
    }

    if (branchId) {
      // Return subscriptions where permittedBranchIds is empty (all branches) or includes branchId
      filter.$or = [
        { permittedBranchIds: { $size: 0 } },
        { permittedBranchIds: branchId },
      ];
    }

    if (search) {
      filter.subscriptionCode = { $regex: search, $options: "i" };
    }

    const options = {
      page: parseInt(page, 10),
      limit: parseInt(limit, 10),
      populate: [
        { path: "customerId", select: "name phone email" },
        { path: "permittedBranchIds", select: "name" },
      ],
      sort: { createdAt: -1 },
    };

    return this.subscriptionRepo.find(filter, options);
  }

  /**
   * Get subscription by ID with lazy expiration check
   */
  async getSubscriptionById(id, organizationId) {
    const subscription = await this.subscriptionRepo.findOne(
      { _id: id, organizationId, isDeleted: false },
      [
        { path: "customerId", select: "name phone email status" },
        { path: "permittedBranchIds", select: "name isActive" },
        { path: "entitlements.serviceId", select: "name duration price" },
      ]
    );

    if (!subscription) {
      throw new AppError("Subscription not found", 404);
    }

    // Lazy expiration check
    await this.checkAndUpdateExpiry(subscription);

    return subscription;
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
        400
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
        throw new AppError("End date must be after subscription start date", 400);
      }
      allowedUpdates.endDate = newEnd;
    }

    const updated = await this.executeTransaction(async (session) => {
      const res = await this.subscriptionRepo.updateById(
        id,
        allowedUpdates,
        userId,
        session
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
          session
        );
      }

      return res;
    });

    return updated;
  }

  /**
   * Cancel subscription
   */
  async cancelSubscription(id, organizationId, userId, reason = "") {
    const subscription = await this.subscriptionRepo.findOne({
      _id: id,
      organizationId,
      isDeleted: false,
    });

    if (!subscription) {
      throw new AppError("Subscription not found", 404);
    }

    if (subscription.status === "cancelled") {
      throw new AppError("Subscription is already cancelled", 400);
    }

    const cancelled = await this.executeTransaction(async (session) => {
      const res = await this.subscriptionRepo.updateById(
        id,
        {
          status: "cancelled",
          notes: subscription.notes
            ? `${subscription.notes}\n[Cancelled]: ${reason}`
            : `[Cancelled]: ${reason}`,
        },
        userId,
        session
      );

      if (this.auditRepo && typeof this.auditRepo.create === "function") {
        await this.auditRepo.create(
          {
            branchId: null,
            action: AUDIT_ACTIONS.SUBSCRIPTION_CANCELLED,
            entityType: "Subscription",
            entityId: id,
            description: `Subscription ${subscription.subscriptionCode} cancelled: ${reason}`,
            metadata: { reason },
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
   * Send OTP for redemption verification
   */
  async sendRedemptionOTP(subscriptionId, branchId, organizationId, userId) {
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

    if (subscription.status !== "active") {
      throw new AppError(
        `Subscription is not active (current status: '${subscription.status}')`,
        400
      );
    }

    // Branch permission check
    this.validateBranchPermission(subscription, branchId);

    // Load customer
    let customer;
    if (this.customerRepo && typeof this.customerRepo.findById === "function") {
      customer = await this.customerRepo.findById(subscription.customerId, organizationId);
    } else {
      const CustomerModel = mongoose.model("Customer");
      customer = await CustomerModel.findById(subscription.customerId);
    }

    if (!customer || customer.isDeleted || customer.status !== "active") {
      throw new AppError("Customer is inactive or not found", 400);
    }

    if (!customer.phone) {
      throw new AppError("Customer does not have a registered phone number for OTP delivery", 400);
    }

    // Rate limiting: 60s cooldown
    if (customer.otpResendUntil && customer.otpResendUntil > new Date()) {
      const waitSeconds = Math.ceil((customer.otpResendUntil - new Date()) / 1000);
      throw new AppError(
        `Too many OTP requests. Please wait ${waitSeconds} seconds before requesting a new OTP.`,
        429
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
        userId
      );
    }

    logger.info(`[SECURITY] SUBSCRIPTION_REDEMPTION_OTP_SENT for subscription ${subscriptionId}`);

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
  async redeemSubscription(
    subscriptionId,
    branchId,
    otp,
    services,
    appointmentId,
    organizationId,
    userId
  ) {
    if (!otp) {
      throw new AppError("OTP is required to redeem subscription", 400);
    }

    if (!Array.isArray(services) || services.length === 0) {
      throw new AppError("At least one service to redeem must be specified", 400);
    }

    // 1. Fetch subscription
    const subscription = await this.subscriptionRepo.findOne({
      _id: subscriptionId,
      organizationId,
      isDeleted: false,
    });

    if (!subscription) {
      throw new AppError("Subscription not found", 404);
    }

    await this.checkAndUpdateExpiry(subscription);

    if (subscription.status !== "active") {
      throw new AppError(
        `Cannot redeem from a subscription with status '${subscription.status}'`,
        400
      );
    }

    // 2. Validate branch permission
    this.validateBranchPermission(subscription, branchId);

    // 3. Load customer and verify OTP
    let customer;
    if (this.customerRepo && typeof this.customerRepo.findById === "function") {
      customer = await this.customerRepo.findById(subscription.customerId, organizationId);
    } else {
      const CustomerModel = mongoose.model("Customer");
      customer = await CustomerModel.findById(subscription.customerId);
    }

    if (!customer || customer.isDeleted) {
      throw new AppError("Customer not found", 404);
    }

    // OTP verification
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
      throw new AppError("Too many incorrect OTP attempts. Please request a new OTP.", 429);
    }

    const hashedInputOtp = crypto.createHash("sha256").update(otp.toString()).digest("hex");
    if (hashedInputOtp !== customer.otp) {
      customer.otpAttempts = (customer.otpAttempts || 0) + 1;
      await customer.save();
      const remainingAttempts = 5 - customer.otpAttempts;
      throw new AppError(`Invalid OTP. ${remainingAttempts} attempts remaining.`, 400);
    }

    // OTP matches! Clear customer OTP
    customer.otp = null;
    customer.otpExpires = null;
    customer.otpAttempts = 0;
    await customer.save();

    // 4. Validate requested services against entitlements
    for (const reqService of services) {
      const qty = parseInt(reqService.quantity || 1, 10);
      if (isNaN(qty) || qty < 1) {
        throw new AppError("Invalid redemption quantity", 400);
      }

      const entitlement = subscription.entitlements.find(
        (e) => e.serviceId.toString() === reqService.serviceId.toString()
      );

      if (!entitlement) {
        throw new AppError(
          `Service ${reqService.serviceId} is not included in this subscription's entitlements`,
          400
        );
      }

      if (entitlement.remainingQuantity < qty) {
        throw new AppError(
          `Insufficient balance for service '${entitlement.serviceName}'. Available: ${entitlement.remainingQuantity}, Requested: ${qty}`,
          409
        );
      }
    }

    // 5. Atomic decrements and usage logging in transaction
    const redemptionResult = await this.executeTransaction(async (session) => {
      const createdUsageRecords = [];
      let latestSubscription = subscription;

      for (const reqService of services) {
        const qty = parseInt(reqService.quantity || 1, 10);

        // Atomic decrement with balance guard
        const updatedSub = await this.subscriptionRepo.atomicDecrementEntitlement(
          subscription._id,
          organizationId,
          reqService.serviceId,
          qty,
          session
        );

        if (!updatedSub) {
          throw new AppError(
            `Concurrent modification or insufficient balance while redeeming service ${reqService.serviceId}`,
            409
          );
        }

        latestSubscription = updatedSub;

        // Find service name snapshot
        const matchingEnt = updatedSub.entitlements.find(
          (e) => e.serviceId.toString() === reqService.serviceId.toString()
        );
        const serviceName = matchingEnt ? matchingEnt.serviceName : "Service";

        // Create SubscriptionUsage record
        const usageRecord = await this.subscriptionUsageRepo.create(
          {
            organizationId,
            subscriptionId: subscription._id,
            customerId: subscription.customerId,
            serviceId: reqService.serviceId,
            serviceName,
            quantity: qty,
            branchId,
            verifiedBy: userId,
            verificationMethod: "otp",
            appointmentId: appointmentId || null,
          },
          userId,
          session
        );

        createdUsageRecords.push(usageRecord);

        // If appointmentId provided, update the Appointment's service line item status
        if (appointmentId) {
          const AppointmentModel = mongoose.model("Appointment");
          await AppointmentModel.updateOne(
            {
              _id: appointmentId,
              organizationId,
              "services.serviceId": reqService.serviceId,
            },
            {
              $set: {
                "services.$.isRedeemedViaSubscription": true,
                "services.$.subscriptionUsageId": usageRecord._id,
              },
            },
            { session }
          );
        }
      }

      // Check if all entitlements are exhausted
      const allExhausted = latestSubscription.entitlements.every(
        (e) => e.remainingQuantity === 0
      );

      if (allExhausted) {
        latestSubscription.status = "exhausted";
        await latestSubscription.save({ session });
      }

      // Audit Log
      if (this.auditRepo && typeof this.auditRepo.create === "function") {
        await this.auditRepo.create(
          {
            branchId,
            action: AUDIT_ACTIONS.SUBSCRIPTION_REDEEMED,
            entityType: "Subscription",
            entityId: subscription._id,
            description: `Redeemed ${services.length} service(s) from subscription ${subscription.subscriptionCode} at branch ${branchId}`,
            metadata: {
              subscriptionCode: subscription.subscriptionCode,
              servicesRedeemed: services,
              appointmentId: appointmentId || null,
              newStatus: latestSubscription.status,
            },
          },
          organizationId,
          userId,
          session
        );
      }

      return {
        subscription: latestSubscription,
        usage: createdUsageRecords,
      };
    });

    // 6. Best effort notification
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

    return this.subscriptionUsageRepo.findBySubscriptionId(
      subscriptionId,
      organizationId
    );
  }

  /**
   * Helper: Check if branch is permitted for this subscription
   */
  validateBranchPermission(subscription, branchId) {
    if (
      Array.isArray(subscription.permittedBranchIds) &&
      subscription.permittedBranchIds.length > 0
    ) {
      const isPermitted = subscription.permittedBranchIds.some(
        (b) => b.toString() === branchId.toString()
      );
      if (!isPermitted) {
        throw new AppError(
          "Subscription is not valid for redemption at this branch",
          403
        );
      }
    }
    // If empty array, permitted at all branches
  }

  /**
   * Helper: Lazy expiration check
   */
  async checkAndUpdateExpiry(subscription) {
    if (
      subscription.status === "active" &&
      subscription.endDate &&
      new Date(subscription.endDate) < new Date()
    ) {
      subscription.status = "expired";
      await subscription.save();
    }
  }
}
