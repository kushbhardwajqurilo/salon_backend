import { StaffService } from "../../services/staff/staff.service.js";
import { sendResponse } from "../../utils/response.js";
import { asyncHandler } from "../../utils/errors.js";

const staffService = new StaffService();

export const createStaff = asyncHandler(async (req, res) => {
  const staff = await staffService.createStaff(req.body, req.organizationId, req.user.id);
  return sendResponse(res, 201, "Staff created successfully", staff);
});

export const listStaff = asyncHandler(async (req, res) => {
  const result = await staffService.listStaff(req.query, req.query, req.organizationId);
  return sendResponse(res, 200, "Staff listed successfully", result.data, result.meta);
});

export const getStaff = asyncHandler(async (req, res) => {
  const staff = await staffService.getStaffById(req.params.id, req.organizationId);
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
