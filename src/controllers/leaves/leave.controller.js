import { LeaveService } from "../../services/leaves/leave.service.js";
import { sendResponse } from "../../utils/response.js";
import { asyncHandler } from "../../utils/errors.js";
import { AuditLogService } from "../../services/audit/auditLog.service.js";
import { AUDIT_ACTIONS } from "../../models/audit/auditLog.model.js";

const leaveService = new LeaveService();
const auditLogService = new AuditLogService();
const logLeaveAudit = (req, payload) =>
  auditLogService
    .createAuditLog(
      {
        branchId: req.branchId || null,
        entityType: "Leave",
        ...payload,
      },
      req.organizationId,
      req.user.id
    )
    .catch(() => {});

export const createLeave = asyncHandler(async (req, res) => {
  const leave = await leaveService.createLeave(
    req.body,
    req.organizationId,
    req.branchId,
    req.user.id
  );
  void logLeaveAudit(req, {
    action: AUDIT_ACTIONS.LEAVE_REQUESTED,
    entityId: leave?._id || null,
    description: `Requested leave for staff ${leave?.staffId || req.body?.staffId || ""}`,
    metadata: { staffId: req.body?.staffId, leaveType: req.body?.leaveType, startDate: req.body?.startDate, endDate: req.body?.endDate },
  });
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

export const getLeaveConflicts = asyncHandler(async (req, res) => {
  const result = await leaveService.getLeaveConflicts(
    req.params.id,
    req.organizationId,
    req.branchId,
    req.user.id
  );
  return sendResponse(res, 200, "Leave conflicts retrieved successfully", result);
});

export const updateLeave = asyncHandler(async (req, res) => {
  const leave = await leaveService.updateLeave(
    req.params.id,
    req.body,
    req.organizationId,
    req.branchId,
    req.user.id
  );
  void logLeaveAudit(req, {
    action: AUDIT_ACTIONS.LEAVE_UPDATED,
    entityId: req.params.id,
    description: `Updated leave request ${req.params.id}`,
    metadata: req.body,
  });
  return sendResponse(res, 200, "Leave updated successfully", leave);
});

export const approveLeave = asyncHandler(async (req, res) => {
  const leave = await leaveService.approveLeave(
    req.params.id,
    req.body.reviewNote,
    req.organizationId,
    req.user.id,
    { confirmSplit: Boolean(req.body.confirmSplit) }
  );
  void logLeaveAudit(req, {
    action: AUDIT_ACTIONS.LEAVE_APPROVED,
    entityId: req.params.id,
    description: `Approved leave request ${req.params.id}`,
    metadata: { reviewNote: req.body.reviewNote, confirmSplit: Boolean(req.body.confirmSplit) },
  });
  return sendResponse(res, 200, "Leave approved successfully", leave);
});

export const rejectLeave = asyncHandler(async (req, res) => {
  const leave = await leaveService.rejectLeave(
    req.params.id,
    req.body.reviewNote,
    req.organizationId,
    req.user.id,
    { confirmSplit: Boolean(req.body.confirmSplit) }
  );
  void logLeaveAudit(req, {
    action: AUDIT_ACTIONS.LEAVE_REJECTED,
    entityId: req.params.id,
    description: `Rejected leave request ${req.params.id}`,
    metadata: { reviewNote: req.body.reviewNote, confirmSplit: Boolean(req.body.confirmSplit) },
  });
  return sendResponse(res, 200, "Leave rejected successfully", leave);
});

export const cancelLeave = asyncHandler(async (req, res) => {
  const leave = await leaveService.cancelLeave(
    req.params.id,
    req.body.cancelReason,
    req.organizationId,
    req.user.id
  );
  void logLeaveAudit(req, {
    action: AUDIT_ACTIONS.LEAVE_CANCELLED,
    entityId: req.params.id,
    description: `Cancelled leave request ${req.params.id}`,
    metadata: { cancelReason: req.body.cancelReason },
  });
  return sendResponse(res, 200, "Leave cancelled successfully", leave);
});
