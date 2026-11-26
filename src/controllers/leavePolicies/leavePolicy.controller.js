import { asyncHandler } from "../../utils/errors.js";
import { sendResponse } from "../../utils/response.js";
import { LeavePolicyService } from "../../services/leavePolicies/leavePolicy.service.js";
import { AuditLogService } from "../../services/audit/auditLog.service.js";
import { AUDIT_ACTIONS } from "../../models/audit/auditLog.model.js";

const auditLogService = new AuditLogService();

const leavePolicyService = new LeavePolicyService();

export const listLeavePolicies = asyncHandler(async (req, res) => {
  const result = await leavePolicyService.listPolicies(req.organizationId, req.query, req.user);
  return sendResponse(res, 200, "Leave policies retrieved successfully", result);
});

export const createLeavePolicy = asyncHandler(async (req, res) => {
  const result = await leavePolicyService.createPolicy(req.organizationId, req.body, req.user);
  await auditLogService
    .createAuditLog(
      {
        action: AUDIT_ACTIONS.LEAVE_POLICY_CREATED,
        entityType: "LeavePolicy",
        entityId: result?._id || null,
        description: `Created leave policy ${result?.name || req.body?.name || ""}`,
        metadata: req.body,
      },
      req.organizationId,
      req.user.id
    )
    .catch(() => {});
  return sendResponse(res, 201, "Leave policy created successfully", result);
});

export const updateLeavePolicy = asyncHandler(async (req, res) => {
  const result = await leavePolicyService.updatePolicy(
    req.organizationId,
    req.params.id,
    req.body,
    req.user
  );
  await auditLogService
    .createAuditLog(
      {
        action: AUDIT_ACTIONS.LEAVE_POLICY_UPDATED,
        entityType: "LeavePolicy",
        entityId: req.params.id,
        description: `Updated leave policy ${req.params.id}`,
        metadata: req.body,
      },
      req.organizationId,
      req.user.id
    )
    .catch(() => {});
  return sendResponse(res, 200, "Leave policy updated successfully", result);
});

export const deactivateLeavePolicy = asyncHandler(async (req, res) => {
  const result = await leavePolicyService.deactivatePolicy(
    req.organizationId,
    req.params.id,
    req.user
  );
  await auditLogService
    .createAuditLog(
      {
        action: AUDIT_ACTIONS.LEAVE_POLICY_DEACTIVATED,
        entityType: "LeavePolicy",
        entityId: req.params.id,
        description: `Deactivated leave policy ${req.params.id}`,
      },
      req.organizationId,
      req.user.id
    )
    .catch(() => {});
  return sendResponse(res, 200, "Leave policy deactivated successfully", result);
});
