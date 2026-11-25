import { asyncHandler } from "../../utils/errors.js";
import { sendResponse } from "../../utils/response.js";
import { LeavePolicyService } from "../../services/leavePolicies/leavePolicy.service.js";

const leavePolicyService = new LeavePolicyService();

export const listLeavePolicies = asyncHandler(async (req, res) => {
  const result = await leavePolicyService.listPolicies(req.organizationId, req.query, req.user);
  return sendResponse(res, 200, "Leave policies retrieved successfully", result);
});

export const createLeavePolicy = asyncHandler(async (req, res) => {
  const result = await leavePolicyService.createPolicy(req.organizationId, req.body, req.user);
  return sendResponse(res, 201, "Leave policy created successfully", result);
});

export const updateLeavePolicy = asyncHandler(async (req, res) => {
  const result = await leavePolicyService.updatePolicy(
    req.organizationId,
    req.params.id,
    req.body,
    req.user
  );
  return sendResponse(res, 200, "Leave policy updated successfully", result);
});

export const deactivateLeavePolicy = asyncHandler(async (req, res) => {
  const result = await leavePolicyService.deactivatePolicy(
    req.organizationId,
    req.params.id,
    req.user
  );
  return sendResponse(res, 200, "Leave policy deactivated successfully", result);
});
