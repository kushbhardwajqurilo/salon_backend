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
  const payload = {
    ...req.body,
    branchId: req.branchId || req.body?.branchId,
  };
  const result = await subscriptionService.createSubscription(
    payload,
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

export const updateSubscriptionMemberBranchAccess = asyncHandler(async (req, res) => {
  const { id, memberCustomerId } = req.params;
  const { permittedBranchIds } = req.body;
  const result = await subscriptionService.updateMemberBranchAccess(
    id,
    memberCustomerId,
    permittedBranchIds,
    req.organizationId,
    req.user?.id || req.user?._id
  );
  return sendResponse(res, 200, "Subscription member branch access updated successfully", result);
});

export const cancelSubscription = asyncHandler(async (req, res) => {
  const reason = req.body.reason || "";
  const headerKey = req.headers["idempotency-key"] || req.headers["x-idempotency-key"];
  const bodyKey = req.body.idempotencyKey;

  // Conflict check if both header and body keys are provided but do not match
  if (headerKey && bodyKey && String(headerKey).trim() !== String(bodyKey).trim()) {
    return res.status(400).json({
      success: false,
      message: "Conflicting idempotency keys provided in header and body",
    });
  }

  const idempotencyKey = (headerKey ? String(headerKey).trim() : null) || (bodyKey ? String(bodyKey).trim() : null);
  const forceAsync = Boolean(req.body.forceAsync);
  const result = await subscriptionService.cancelSubscription(
    req.params.id,
    req.organizationId,
    req.user?.id || req.user?._id,
    reason,
    {
      refund: req.body.refund,
      idempotencyKey,
      forceAsync,
    }
  );

  const statusCode = result.status === "processing" ? 202 : 200;
  const message =
    result.status === "processing"
      ? "Subscription cancellation accepted for background processing"
      : "Subscription cancelled successfully";

  return sendResponse(res, statusCode, message, result);
});

export const previewCancellationImpact = asyncHandler(async (req, res) => {
  const result = await subscriptionService.previewCancellationImpact(
    req.params.id,
    req.organizationId,
    req.user?.id || req.user?._id
  );
  return sendResponse(res, 200, "Subscription cancellation impact preview generated successfully", result);
});

export const getCancellationOperationStatus = asyncHandler(async (req, res) => {
  const { id, operationId } = req.params;
  const result = await subscriptionService.getCancellationOperationStatus(
    id,
    operationId,
    req.organizationId
  );
  return sendResponse(res, 200, "Cancellation operation status retrieved successfully", result);
});

export const retryCancellationOperation = asyncHandler(async (req, res) => {
  const { id, operationId } = req.params;
  const result = await subscriptionService.retryCancellationOperation(
    id,
    operationId,
    req.organizationId,
    req.user?.id || req.user?._id
  );
  return sendResponse(res, 200, "Cancellation operation retry triggered successfully", result);
});

export const renewSubscription = asyncHandler(async (req, res) => {
  const payload = {
    ...req.body,
    branchId: req.branchId || req.body?.branchId,
  };
  const result = await subscriptionService.renewSubscription(
    req.params.id,
    payload,
    req.organizationId,
    req.user?.id || req.user?._id
  );
  return sendResponse(res, 201, "Subscription renewed successfully", result);
});

export const sendRedemptionOTP = asyncHandler(async (req, res) => {
  const branchId = req.body.branchId || req.branchId || req.headers["x-branch-id"];
  const memberCustomerId = req.body.memberCustomerId || null;
  const result = await subscriptionService.sendRedemptionOTP(
    req.params.id,
    branchId,
    req.organizationId,
    req.user?.id || req.user?._id,
    memberCustomerId
  );
  return sendResponse(res, 200, result.message, result.data);
});

export const redeemSubscription = asyncHandler(async (req, res) => {
  const branchId = req.body.branchId || req.branchId || req.headers["x-branch-id"];
  const { otp, services, appointmentId, isManual, reason, idempotencyKey, memberCustomerId } = req.body;
  const result = await subscriptionService.redeemSubscription(
    req.params.id,
    branchId,
    otp,
    services,
    appointmentId,
    req.organizationId,
    req.user?.id || req.user?._id,
    { isManual, reason, idempotencyKey, memberCustomerId }
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
