import { asyncHandler } from "../../utils/errors.js";
import { sendResponse } from "../../utils/response.js";
import { SubscriptionService } from "../../services/subscriptions/subscription.service.js";
import { SubscriptionRepository } from "../../repositories/subscriptions/subscription.repository.js";
import { SubscriptionUsageRepository } from "../../repositories/subscriptions/subscriptionUsage.repository.js";
import { CustomerRepository } from "../../repositories/customers/customer.repository.js";
import { ServiceRepository } from "../../repositories/services/service.repository.js";
import { Branch } from "../../models/branches/branch.model.js";
import { AuditLogRepository } from "../../repositories/audit/auditLog.repository.js";

const subscriptionRepo = new SubscriptionRepository();
const subscriptionUsageRepo = new SubscriptionUsageRepository();
const customerRepo = new CustomerRepository();
const serviceRepo = new ServiceRepository();
const auditRepo = new AuditLogRepository();

const subscriptionService = new SubscriptionService(
  subscriptionRepo,
  subscriptionUsageRepo,
  customerRepo,
  serviceRepo,
  Branch, // Branch model directly
  auditRepo
);

export const createSubscription = asyncHandler(async (req, res) => {
  const result = await subscriptionService.createSubscription(
    req.body,
    req.organizationId,
    req.user?.id || req.user?._id
  );
  return sendResponse(res, 201, "Subscription created successfully", result);
});

export const listSubscriptions = asyncHandler(async (req, res) => {
  const result = await subscriptionService.listSubscriptions(
    req.query,
    req.organizationId
  );
  return sendResponse(
    res,
    200,
    "Subscriptions retrieved successfully",
    result.data || result,
    result.meta
  );
});

export const getSubscriptionById = asyncHandler(async (req, res) => {
  const result = await subscriptionService.getSubscriptionById(
    req.params.id,
    req.organizationId
  );
  return sendResponse(res, 200, "Subscription retrieved successfully", result);
});

export const updateSubscription = asyncHandler(async (req, res) => {
  const result = await subscriptionService.updateSubscription(
    req.params.id,
    req.body,
    req.organizationId,
    req.user?.id || req.user?._id
  );
  return sendResponse(res, 200, "Subscription updated successfully", result);
});

export const cancelSubscription = asyncHandler(async (req, res) => {
  const reason = req.body.reason || "";
  const result = await subscriptionService.cancelSubscription(
    req.params.id,
    req.organizationId,
    req.user?.id || req.user?._id,
    reason
  );
  return sendResponse(res, 200, "Subscription cancelled successfully", result);
});

export const sendRedemptionOTP = asyncHandler(async (req, res) => {
  const branchId = req.body.branchId || req.branchId || req.headers["x-branch-id"];
  const result = await subscriptionService.sendRedemptionOTP(
    req.params.id,
    branchId,
    req.organizationId,
    req.user?.id || req.user?._id
  );
  return sendResponse(res, 200, result.message, result.data);
});

export const redeemSubscription = asyncHandler(async (req, res) => {
  const branchId = req.body.branchId || req.branchId || req.headers["x-branch-id"];
  const { otp, services, appointmentId } = req.body;
  const result = await subscriptionService.redeemSubscription(
    req.params.id,
    branchId,
    otp,
    services,
    appointmentId,
    req.organizationId,
    req.user?.id || req.user?._id
  );
  return sendResponse(res, 200, "Subscription services redeemed successfully", result);
});

export const getSubscriptionUsage = asyncHandler(async (req, res) => {
  const result = await subscriptionService.getSubscriptionUsage(
    req.params.id,
    req.organizationId
  );
  return sendResponse(res, 200, "Subscription usage history retrieved successfully", result);
});
