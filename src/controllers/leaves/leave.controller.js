import { LeaveService } from "../../services/leaves/leave.service.js";
import { sendResponse } from "../../utils/response.js";
import { asyncHandler } from "../../utils/errors.js";

const leaveService = new LeaveService();

export const createLeave = asyncHandler(async (req, res) => {
  const leave = await leaveService.createLeave(
    req.body,
    req.organizationId,
    req.branchId,
    req.user.id
  );
  return sendResponse(res, 201, "Leave requested successfully", leave);
});

export const listLeaves = asyncHandler(async (req, res) => {
  const result = await leaveService.listLeaves(
    req.query,
    req.query,
    req.organizationId,
    req.branchId
  );
  return sendResponse(res, 200, "Leaves listed successfully", result.data, result.meta);
});

export const getLeaveById = asyncHandler(async (req, res) => {
  const leave = await leaveService.getLeaveById(
    req.params.id,
    req.organizationId,
    req.branchId
  );
  return sendResponse(res, 200, "Leave retrieved successfully", leave);
});

export const updateLeave = asyncHandler(async (req, res) => {
  const leave = await leaveService.updateLeave(
    req.params.id,
    req.body,
    req.organizationId,
    req.branchId,
    req.user.id
  );
  return sendResponse(res, 200, "Leave updated successfully", leave);
});

export const approveLeave = asyncHandler(async (req, res) => {
  const leave = await leaveService.approveLeave(
    req.params.id,
    req.body.reviewNote,
    req.organizationId,
    req.user.id
  );
  return sendResponse(res, 200, "Leave approved successfully", leave);
});

export const rejectLeave = asyncHandler(async (req, res) => {
  const leave = await leaveService.rejectLeave(
    req.params.id,
    req.body.reviewNote,
    req.organizationId,
    req.user.id
  );
  return sendResponse(res, 200, "Leave rejected successfully", leave);
});

export const cancelLeave = asyncHandler(async (req, res) => {
  const leave = await leaveService.cancelLeave(
    req.params.id,
    req.body.cancelReason,
    req.organizationId,
    req.user.id
  );
  return sendResponse(res, 200, "Leave cancelled successfully", leave);
});
