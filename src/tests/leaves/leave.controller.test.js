import { beforeEach, describe, expect, it, jest } from "@jest/globals";
import mongoose from "mongoose";
import { AppError } from "../../utils/errors.js";
import { LeaveService } from "../../services/leaves/leave.service.js";
import {
  approveLeave,
  cancelLeave,
  createLeave,
  getLeaveById,
  listLeaves,
  rejectLeave,
  updateLeave,
} from "../../controllers/leaves/leave.controller.js";

describe("Leave Controller Phase 5", () => {
  let req;
  let res;
  let next;
  let orgId;
  let branchId;
  let actorId;
  let leaveId;
  let leaveDto;

  beforeEach(() => {
    jest.clearAllMocks();

    orgId = new mongoose.Types.ObjectId().toString();
    branchId = new mongoose.Types.ObjectId().toString();
    actorId = new mongoose.Types.ObjectId().toString();
    leaveId = new mongoose.Types.ObjectId().toString();

    req = {
      organizationId: orgId,
      branchId,
      user: {
        id: actorId,
      },
      params: {
        id: leaveId,
      },
      query: {
        page: 1,
        limit: 10,
        status: "pending",
      },
      body: {
        leaveType: "Casual",
        startDate: "2026-09-01",
        endDate: "2026-09-03",
        reason: "Family event",
      },
    };

    res = {
      status: jest.fn().mockReturnThis(),
      json: jest.fn().mockReturnThis(),
    };

    next = jest.fn();

    leaveDto = {
      id: leaveId,
      branchId,
      staffId: new mongoose.Types.ObjectId().toString(),
      leaveCode: "LV-0001",
      leaveType: "Casual",
      startDate: "2026-09-01",
      endDate: "2026-09-03",
      reason: "Family event",
      status: "pending",
      submittedBy: actorId,
      submittedFor: "self",
      reviewedBy: null,
      reviewedAt: null,
      reviewNote: null,
      cancelledBy: null,
      cancelledAt: null,
      cancelReason: null,
      createdAt: "2026-08-20T10:00:00.000Z",
      updatedAt: "2026-08-20T10:00:00.000Z",
    };
  });

  it("delegates createLeave with org, branch, and authenticated actor and returns standard success response", async () => {
    LeaveService.prototype.createLeave = jest.fn().mockResolvedValue(leaveDto);

    await createLeave(req, res, next);

    expect(LeaveService.prototype.createLeave).toHaveBeenCalledWith(
      req.body,
      orgId,
      branchId,
      actorId
    );
    expect(res.status).toHaveBeenCalledWith(201);
    expect(res.json).toHaveBeenCalledWith({
      success: true,
      status: "success",
      message: "Leave requested successfully",
      data: leaveDto,
      meta: null,
    });
    expect(res.json.mock.calls[0][0].data.dates).toBeUndefined();
  });

  it("delegates listLeaves and preserves org-wide branch semantics when req.branchId is undefined", async () => {
    req.branchId = undefined;
    const result = {
      data: [leaveDto],
      meta: { total: 1, page: 1, limit: 10, totalPages: 1 },
    };
    LeaveService.prototype.listLeaves = jest.fn().mockResolvedValue(result);

    await listLeaves(req, res, next);

    expect(LeaveService.prototype.listLeaves).toHaveBeenCalledWith(
      req.query,
      req.query,
      orgId,
      undefined
    );
    expect(res.status).toHaveBeenCalledWith(200);
    expect(res.json).toHaveBeenCalledWith({
      success: true,
      status: "success",
      message: "Leaves listed successfully",
      data: result.data,
      meta: result.meta,
    });
  });

  it("delegates getLeaveById with organization and branch context", async () => {
    LeaveService.prototype.getLeaveById = jest.fn().mockResolvedValue(leaveDto);

    await getLeaveById(req, res, next);

    expect(LeaveService.prototype.getLeaveById).toHaveBeenCalledWith(
      leaveId,
      orgId,
      branchId
    );
    expect(res.status).toHaveBeenCalledWith(200);
    expect(res.json.mock.calls[0][0].data.dates).toBeUndefined();
  });

  it("delegates updateLeave with actor context and returns standard success response", async () => {
    LeaveService.prototype.updateLeave = jest.fn().mockResolvedValue(leaveDto);

    await updateLeave(req, res, next);

    expect(LeaveService.prototype.updateLeave).toHaveBeenCalledWith(
      leaveId,
      req.body,
      orgId,
      branchId,
      actorId
    );
    expect(res.status).toHaveBeenCalledWith(200);
    expect(res.json).toHaveBeenCalledWith({
      success: true,
      status: "success",
      message: "Leave updated successfully",
      data: leaveDto,
      meta: null,
    });
  });

  it("delegates approve/reject/cancel using validated body fields only", async () => {
    LeaveService.prototype.approveLeave = jest.fn().mockResolvedValue({
      ...leaveDto,
      status: "approved",
    });
    LeaveService.prototype.rejectLeave = jest.fn().mockResolvedValue({
      ...leaveDto,
      status: "rejected",
      reviewNote: "Insufficient coverage",
    });
    LeaveService.prototype.cancelLeave = jest.fn().mockResolvedValue({
      ...leaveDto,
      status: "cancelled",
      cancelReason: "Plans changed",
    });

    req.body = { reviewNote: "Approved" };
    await approveLeave(req, res, next);
    expect(LeaveService.prototype.approveLeave).toHaveBeenCalledWith(
      leaveId,
      "Approved",
      orgId,
      actorId
    );

    req.body = { reviewNote: "Insufficient coverage" };
    await rejectLeave(req, res, next);
    expect(LeaveService.prototype.rejectLeave).toHaveBeenCalledWith(
      leaveId,
      "Insufficient coverage",
      orgId,
      actorId
    );

    req.body = { cancelReason: "Plans changed" };
    await cancelLeave(req, res, next);
    expect(LeaveService.prototype.cancelLeave).toHaveBeenCalledWith(
      leaveId,
      "Plans changed",
      orgId,
      actorId
    );
  });

  it("propagates service AppError instances to next without rewriting them", async () => {
    const error = new AppError("Leave not found", 404);
    LeaveService.prototype.getLeaveById = jest.fn().mockRejectedValue(error);

    await getLeaveById(req, res, next);

    expect(next).toHaveBeenCalledWith(error);
    expect(res.status).not.toHaveBeenCalled();
  });
});
