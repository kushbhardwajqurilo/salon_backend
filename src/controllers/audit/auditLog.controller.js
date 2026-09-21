import mongoose from "mongoose";
import { asyncHandler } from "../../utils/errors.js";
import { sendResponse } from "../../utils/response.js";
import { AuditLogService } from "../../services/audit/auditLog.service.js";

const auditLogService = new AuditLogService();

const toObjectIdIfValid = (val) => {
  if (!val) return val;
  if (typeof val === "string" && /^[0-9a-fA-F]{24}$/.test(val)) {
    return new mongoose.Types.ObjectId(val);
  }
  return val;
};

/**
 * Controller to list audit logs with tenant and branch scoping.
 */
export const listAuditLogs = asyncHandler(async (req, res) => {
  const {
    page = 1,
    limit = 10,
    sort = "-createdAt",
    branchId: queryBranchId,
    entityType,
    action,
    actorId,
    startDate,
    endDate,
  } = req.query;

  // Branch scoping:
  // If user operates within a specific active branch context (req.branchId is set by requireBranchScope),
  // enforce req.branchId.
  // If org-wide mode (req.branchId undefined), allow filtering by optional query.branchId.
  let effectiveBranchId = req.branchId;
  if (!effectiveBranchId && queryBranchId) {
    // If user has organization-wide access, they can specify queryBranchId.
    // If user does not have org-wide access, requireBranchScope would have already enforced req.branchId.
    effectiveBranchId = queryBranchId;
  }

  const branchIdVal = toObjectIdIfValid(effectiveBranchId);
  const actorIdVal = toObjectIdIfValid(actorId);

  const filter = {
    ...(branchIdVal ? { branchId: branchIdVal } : {}),
    ...(entityType ? { entityType } : {}),
    ...(action ? { action } : {}),
    ...(actorIdVal ? { actorId: actorIdVal } : {}),
    ...(startDate ? { startDate } : {}),
    ...(endDate ? { endDate } : {}),
  };

  const options = {
    page: Number(page),
    limit: Number(limit),
    sort,
  };

  const result = await auditLogService.getAuditLogs(
    filter,
    options,
    req.organizationId
  );

  return sendResponse(
    res,
    200,
    "Audit logs retrieved successfully",
    result.data,
    result.meta
  );
});
