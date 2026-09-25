import { asyncHandler } from "../../utils/errors.js";
import { sendResponse } from "../../utils/response.js";
import { SubscriptionPlanService } from "../../services/subscriptions/subscriptionPlan.service.js";
import { SubscriptionPlanRepository } from "../../repositories/subscriptions/subscriptionPlan.repository.js";
import { ServiceRepository } from "../../repositories/services/service.repository.js";
import { Branch } from "../../models/branches/branch.model.js";
import { AuditLogRepository } from "../../repositories/audit/auditLog.repository.js";

const planRepo = new SubscriptionPlanRepository();
const serviceRepo = new ServiceRepository();
const auditRepo = new AuditLogRepository();

const planService = new SubscriptionPlanService(
  planRepo,
  serviceRepo,
  Branch,
  auditRepo
);

export const createPlan = asyncHandler(async (req, res) => {
  const result = await planService.createPlan(
    req.body,
    req.organizationId,
    req.user?.id || req.user?._id
  );
  return sendResponse(res, 201, "Subscription plan created successfully", result);
});

export const listPlans = asyncHandler(async (req, res) => {
  const result = await planService.listPlans(req.query, req.organizationId);
  return sendResponse(
    res,
    200,
    "Subscription plans retrieved successfully",
    result.data || result,
    result.meta
  );
});

export const getPlanById = asyncHandler(async (req, res) => {
  const result = await planService.getPlanById(req.params.id, req.organizationId);
  return sendResponse(res, 200, "Subscription plan retrieved successfully", result);
});

export const updatePlan = asyncHandler(async (req, res) => {
  const result = await planService.updatePlan(
    req.params.id,
    req.body,
    req.organizationId,
    req.user?.id || req.user?._id
  );
  return sendResponse(res, 200, "Subscription plan updated successfully", result);
});

export const deletePlan = asyncHandler(async (req, res) => {
  const result = await planService.deletePlan(
    req.params.id,
    req.organizationId,
    req.user?.id || req.user?._id
  );
  return sendResponse(res, 200, "Subscription plan deleted successfully", result);
});
