import mongoose from "mongoose";
import { StaffService } from "../../services/staff/staff.service.js";
import { sendResponse } from "../../utils/response.js";
import { asyncHandler, AppError } from "../../utils/errors.js";

const staffService = new StaffService();

/**
 * Helper to retrieve and validate active branch context from request headers.
 */
const getActiveBranchContext = async (req) => {
  const activeBranchId = req.headers
    ? (req.headers["x-branch-id"] || req.headers["X-Branch-Id"] || req.branchId)
    : req.branchId;
  const { hasOrgWideAccess, branchAccess, organizationId } = req.user || {};

  // Reject the frontend-only UI sentinel "all"
  if (activeBranchId === "all") {
    throw new AppError("Invalid branch ID format.", 400);
  }

  // Handle case where header is omitted
  if (!activeBranchId) {
    if (!hasOrgWideAccess) {
      throw new AppError("X-Branch-Id header is required for this request.", 400);
    }
    return null; // Organization-wide scope
  }

  // Validate format
  if (!mongoose.Types.ObjectId.isValid(activeBranchId)) {
    throw new AppError("Invalid branch ID format.", 400);
  }

  // Validate active status and tenant ownership
  const branch = await mongoose.model("Branch").findOne({
    _id: activeBranchId,
    organizationId,
    isActive: true,
  });

  if (!branch) {
    throw new AppError("Resource not found", 404);
  }

  // Validate user branch authorization
  if (!hasOrgWideAccess) {
    const isAuthorized = (branchAccess || []).some(
      (b) => b.branchId.toString() === activeBranchId.toString() && b.isActive
    );
    if (!isAuthorized) {
      throw new AppError("Access denied. You do not have access to this branch.", 403);
    }
  }

  return activeBranchId;
};

export const createStaff = asyncHandler(async (req, res) => {
  const staff = await staffService.createStaff(req.body, req.organizationId, req.user.id);
  return sendResponse(res, 201, "Staff created successfully", staff);
});

export const listStaff = asyncHandler(async (req, res) => {
  const result = await staffService.listStaff(req.query, req.query, req.organizationId);
  return sendResponse(res, 200, "Staff listed successfully", result.data, result.meta);
});

export const getStaff = asyncHandler(async (req, res) => {
  const activeBranchId = await getActiveBranchContext(req);
  const staff = await staffService.getStaffById(req.params.id, req.organizationId, activeBranchId);
  return sendResponse(res, 200, "Staff retrieved successfully", staff);
});

export const updateStaff = asyncHandler(async (req, res) => {
  const staff = await staffService.updateStaff(req.params.id, req.body, req.organizationId, req.user.id);
  return sendResponse(res, 200, "Staff updated successfully", staff);
});

export const deleteStaff = asyncHandler(async (req, res) => {
  await staffService.deleteStaff(req.params.id, req.organizationId, req.user.id);
  return sendResponse(res, 200, "Staff soft deleted successfully");
});

export const restoreStaff = asyncHandler(async (req, res) => {
  const staff = await staffService.restoreStaff(req.params.id, req.organizationId, req.user.id);
  return sendResponse(res, 200, "Staff reactivated successfully", staff);
});

export const linkUser = asyncHandler(async (req, res) => {
  const staff = await staffService.linkUser(req.params.id, req.body.userId, req.organizationId, req.user.id);
  return sendResponse(res, 200, "User linked successfully", staff);
});

export const unlinkUser = asyncHandler(async (req, res) => {
  const staff = await staffService.unlinkUser(req.params.id, req.organizationId, req.user.id);
  return sendResponse(res, 200, "User unlinked successfully", staff);
});

export const assignBranch = asyncHandler(async (req, res) => {
  const result = await staffService.assignBranch(
    req.params.id,
    req.body.branchId,
    req.body.isPrimary,
    req.organizationId,
    req.user.id
  );
  return sendResponse(res, 201, "Branch assigned successfully", result);
});

export const removeBranch = asyncHandler(async (req, res) => {
  await staffService.removeBranch(req.params.id, req.params.branchId, req.organizationId, req.user.id);
  return sendResponse(res, 200, "Branch assignment removed successfully");
});

export const assignService = asyncHandler(async (req, res) => {
  const result = await staffService.assignService(
    req.params.id,
    req.body.serviceId,
    req.organizationId,
    req.user.id
  );
  return sendResponse(res, 201, "Service capability assigned successfully", result);
});

export const removeService = asyncHandler(async (req, res) => {
  await staffService.removeService(req.params.id, req.params.serviceId, req.organizationId, req.user.id);
  return sendResponse(res, 200, "Service capability mapping removed successfully");
});

export const getStaffBranches = asyncHandler(async (req, res) => {
  const branches = await staffService.getStaffBranches(req.params.id, req.organizationId);
  return sendResponse(res, 200, "Staff branch assignments retrieved successfully", branches);
});

export const getStaffServices = asyncHandler(async (req, res) => {
  const services = await staffService.getStaffServices(req.params.id, req.organizationId);
  return sendResponse(res, 200, "Staff service capabilities retrieved successfully", services);
});
