import { beforeEach, describe, expect, it, jest } from "@jest/globals";
import mongoose from "mongoose";
import { LeaveService } from "../../services/leaves/leave.service.js";
import { Sequence } from "../../models/sequence/sequence.model.js";
import { AppError } from "../../utils/errors.js";

const orgId = new mongoose.Types.ObjectId();
const branchId = new mongoose.Types.ObjectId();
const otherBranchId = new mongoose.Types.ObjectId();
const actorId = new mongoose.Types.ObjectId();
const managerId = new mongoose.Types.ObjectId();
const reviewerId = new mongoose.Types.ObjectId();
const actorStaffId = new mongoose.Types.ObjectId();
const targetStaffId = new mongoose.Types.ObjectId();
const leaveId = new mongoose.Types.ObjectId();

const baseLeave = (overrides = {}) => ({
  _id: leaveId,
  organizationId: orgId,
  branchId,
  staffId: actorStaffId,
  leaveCode: "LV-0001",
  leaveType: "Casual",
  startDate: new Date("2026-09-01T00:00:00.000Z"),
  endDate: new Date("2026-09-03T00:00:00.000Z"),
  dates: ["2026-09-01", "2026-09-02", "2026-09-03"],
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
  createdAt: new Date("2026-08-20T10:00:00.000Z"),
  updatedAt: new Date("2026-08-20T10:00:00.000Z"),
  ...overrides,
});

describe("LeaveService Phase 4", () => {
  let leaveRepo;
  let staffRepo;
  let staffBranchRepo;
  let userRepo;
  let roleRepo;
  let auditLogService;
  let service;

  beforeEach(() => {
    jest.restoreAllMocks();

    leaveRepo = {
      create: jest.fn(),
      find: jest.fn(),
      findById: jest.fn(),
      findOverlapping: jest.fn(),
      updateById: jest.fn(),
    };
    staffRepo = {
      findOne: jest.fn(),
      findById: jest.fn(),
    };
    staffBranchRepo = {
      findOne: jest.fn(),
    };
    userRepo = {
      findById: jest.fn(),
    };
    roleRepo = {
      findOne: jest.fn(),
    };
    auditLogService = {
      createAuditLog: jest.fn().mockResolvedValue({}),
    };

    service = new LeaveService({
      leaveRepo,
      staffRepo,
      staffBranchRepo,
      userRepo,
      roleRepo,
      auditLogService,
    });

    service.runTransaction = jest.fn(async (operation) => operation("session-1"));

    userRepo.findById.mockImplementation(async (id) => {
      if (id?.toString() === actorId.toString()) {
        return { _id: actorId, role: "stylist-role", organizationId: orgId };
      }
      if (id?.toString() === managerId.toString()) {
        return { _id: managerId, role: "manager-role", organizationId: orgId };
      }
      if (id?.toString() === reviewerId.toString()) {
        return { _id: reviewerId, role: "manager-role", organizationId: orgId };
      }
      return null;
    });

    roleRepo.findOne.mockImplementation(async (filter) => {
      if (filter._id === "manager-role") {
        return { permissions: [{ name: "employees.leaves.manage" }] };
      }
      return { permissions: [{ name: "employees.leaves.view" }] };
    });

    staffRepo.findOne.mockResolvedValue({
      _id: actorStaffId,
      organizationId: orgId,
      status: "active",
      userId: actorId,
    });

    staffRepo.findById.mockImplementation(async (id) => {
      if (id?.toString() === actorStaffId.toString()) {
        return { _id: actorStaffId, organizationId: orgId, status: "active", userId: actorId };
      }
      if (id?.toString() === targetStaffId.toString()) {
        return { _id: targetStaffId, organizationId: orgId, status: "active" };
      }
      return null;
    });

    staffBranchRepo.findOne.mockResolvedValue({
      _id: new mongoose.Types.ObjectId(),
      staffId: actorStaffId,
      branchId,
      isActive: true,
    });

    jest.spyOn(Sequence, "findOneAndUpdate").mockResolvedValue({ seq: 1 });
  });

  it("creates a self leave request with server-derived branch/org and no dates in DTO", async () => {
    const created = baseLeave();
    leaveRepo.findOverlapping.mockResolvedValue(null);
    leaveRepo.create.mockResolvedValue(created);

    const result = await service.createLeave(
      {
        leaveType: "Casual",
        startDate: "2026-09-01",
        endDate: "2026-09-03",
        reason: "Family event",
      },
      orgId,
      branchId,
      actorId
    );

    expect(leaveRepo.create).toHaveBeenCalledWith(
      expect.objectContaining({
        branchId,
        staffId: actorStaffId,
        leaveCode: "LV-0001",
        submittedBy: actorId,
        submittedFor: "self",
        dates: ["2026-09-01", "2026-09-02", "2026-09-03"],
      }),
      orgId,
      actorId,
      "session-1"
    );
    expect(result.dates).toBeUndefined();
    expect(result.startDate).toBe("2026-09-01");
    expect(auditLogService.createAuditLog).toHaveBeenCalledWith(
      expect.objectContaining({ action: "LEAVE_REQUESTED" }),
      orgId,
      actorId,
      "session-1"
    );
  });

  it("creates an on-behalf leave when actor has manage permission", async () => {
    leaveRepo.findOverlapping.mockResolvedValue(null);
    leaveRepo.create.mockResolvedValue(
      baseLeave({ staffId: targetStaffId, submittedBy: managerId, submittedFor: "staff" })
    );

    const result = await service.createLeave(
      {
        staffId: targetStaffId,
        leaveType: "Sick",
        startDate: "2026-09-10",
        endDate: "2026-09-10",
        reason: "Medical",
      },
      orgId,
      branchId,
      managerId
    );

    expect(leaveRepo.create).toHaveBeenCalledWith(
      expect.objectContaining({
        staffId: targetStaffId,
        submittedFor: "staff",
      }),
      orgId,
      managerId,
      "session-1"
    );
    expect(result.staffId).toBe(targetStaffId.toString());
  });

  it("rejects unauthorized on-behalf creation", async () => {
    await expect(
      service.createLeave(
        {
          staffId: targetStaffId,
          leaveType: "Casual",
          startDate: "2026-09-01",
          endDate: "2026-09-01",
          reason: "Test",
        },
        orgId,
        branchId,
        actorId
      )
    ).rejects.toThrow(new AppError("Access denied. You do not have the required permissions.", 403));
  });

  it("rejects staff org mismatch or missing staff", async () => {
    staffRepo.findById.mockResolvedValueOnce(null);

    await expect(
      service.createLeave(
        {
          staffId: targetStaffId,
          leaveType: "Casual",
          startDate: "2026-09-01",
          endDate: "2026-09-01",
          reason: "Test",
        },
        orgId,
        branchId,
        managerId
      )
    ).rejects.toThrow(new AppError("Staff not found", 404));
  });

  it("rejects inactive staff", async () => {
    staffRepo.findById.mockImplementation(async (id) => ({
      _id: id,
      organizationId: orgId,
      status: "inactive",
    }));

    await expect(
      service.createLeave(
        {
          leaveType: "Casual",
          startDate: "2026-09-01",
          endDate: "2026-09-01",
          reason: "Test",
        },
        orgId,
        branchId,
        actorId
      )
    ).rejects.toThrow(new AppError("Staff is not active", 400));
  });

  it("rejects staff not assigned to branch", async () => {
    staffBranchRepo.findOne.mockResolvedValue(null);

    await expect(
      service.createLeave(
        {
          leaveType: "Casual",
          startDate: "2026-09-01",
          endDate: "2026-09-01",
          reason: "Test",
        },
        orgId,
        branchId,
        actorId
      )
    ).rejects.toThrow(new AppError("Staff is not assigned to this branch", 403));
  });

  it("rejects friendly overlap on first, middle, or last shared dates", async () => {
    leaveRepo.findOverlapping.mockResolvedValue(baseLeave({ _id: new mongoose.Types.ObjectId() }));

    await expect(
      service.createLeave(
        {
          leaveType: "Casual",
          startDate: "2026-09-03",
          endDate: "2026-09-05",
          reason: "Overlap",
        },
        orgId,
        branchId,
        actorId
      )
    ).rejects.toThrow(new AppError("Leave request overlaps with an existing leave", 400));
  });

  it("allows adjacent dates", async () => {
    leaveRepo.findOverlapping.mockResolvedValue(null);
    leaveRepo.create.mockResolvedValue(
      baseLeave({
        startDate: new Date("2026-09-04T00:00:00.000Z"),
        endDate: new Date("2026-09-05T00:00:00.000Z"),
        dates: ["2026-09-04", "2026-09-05"],
      })
    );

    const result = await service.createLeave(
      {
        leaveType: "Casual",
        startDate: "2026-09-04",
        endDate: "2026-09-05",
        reason: "Adjacent",
      },
      orgId,
      branchId,
      actorId
    );

    expect(result.startDate).toBe("2026-09-04");
    expect(leaveRepo.findOverlapping).toHaveBeenCalledWith(
      actorStaffId,
      new Date("2026-09-04T00:00:00.000Z"),
      new Date("2026-09-05T00:00:00.000Z"),
      orgId,
      null,
      "session-1"
    );
  });

  it("retries leaveCode duplicates up to the sequence retry limit", async () => {
    leaveRepo.findOverlapping.mockResolvedValue(null);
    leaveRepo.create
      .mockRejectedValueOnce({
        code: 11000,
        keyPattern: { organizationId: 1, leaveCode: 1 },
      })
      .mockResolvedValueOnce(baseLeave({ leaveCode: "LV-0002" }));

    Sequence.findOneAndUpdate
      .mockResolvedValueOnce({ seq: 1 })
      .mockResolvedValueOnce({ seq: 2 });

    const result = await service.createLeave(
      {
        leaveType: "Casual",
        startDate: "2026-09-01",
        endDate: "2026-09-01",
        reason: "Retry",
      },
      orgId,
      branchId,
      actorId
    );

    expect(leaveRepo.create).toHaveBeenCalledTimes(2);
    expect(result.leaveCode).toBe("LV-0002");
  });

  it("maps duplicate dates index errors to overlap without retry", async () => {
    leaveRepo.findOverlapping.mockResolvedValue(null);
    leaveRepo.create.mockRejectedValue({
      code: 11000,
      keyPattern: { organizationId: 1, staffId: 1, dates: 1 },
    });

    await expect(
      service.createLeave(
        {
          leaveType: "Casual",
          startDate: "2026-09-01",
          endDate: "2026-09-03",
          reason: "Overlap",
        },
        orgId,
        branchId,
        actorId
      )
    ).rejects.toThrow(new AppError("Leave request overlaps with an existing leave", 400));

    expect(leaveRepo.create).toHaveBeenCalledTimes(1);
  });

  it("enforces 365-day limit and rejects 366 days", async () => {
    leaveRepo.findOverlapping.mockResolvedValue(null);
    leaveRepo.create.mockResolvedValue(baseLeave());

    await expect(
      service.createLeave(
        {
          leaveType: "Long",
          startDate: "2028-01-01",
          endDate: "2028-12-31",
          reason: "Too long",
        },
        orgId,
        branchId,
        actorId
      )
    ).rejects.toThrow(new AppError("Leave range cannot exceed 365 calendar days", 400));
  });

  it("rejects create when startDate is before todayUTC", async () => {
    await expect(
      service.createLeave(
        {
          leaveType: "Casual",
          startDate: "2026-08-10",
          endDate: "2026-08-11",
          reason: "Past leave",
        },
        orgId,
        branchId,
        actorId
      )
    ).rejects.toThrow(new AppError("startDate cannot be in the past", 400));
  });

  it("approves a pending leave and writes audit", async () => {
    const pending = baseLeave({ submittedBy: actorId });
    const approved = baseLeave({
      status: "approved",
      submittedBy: actorId,
      reviewedBy: reviewerId,
      reviewedAt: new Date("2026-08-21T10:00:00.000Z"),
      reviewNote: "Approved",
    });
    leaveRepo.findById.mockResolvedValue(pending);
    leaveRepo.updateById.mockResolvedValue(approved);

    const result = await service.approveLeave(leaveId, "Approved", orgId, reviewerId);

    expect(result.status).toBe("approved");
    expect(leaveRepo.updateById).toHaveBeenCalledWith(
      leaveId,
      expect.objectContaining({ status: "approved", reviewedBy: reviewerId }),
      orgId,
      reviewerId,
      "session-1"
    );
    expect(auditLogService.createAuditLog).toHaveBeenCalledWith(
      expect.objectContaining({ action: "LEAVE_APPROVED" }),
      orgId,
      reviewerId,
      "session-1"
    );
  });

  it("rejects self approval and invalid transitions", async () => {
    leaveRepo.findById.mockResolvedValue(baseLeave({ submittedBy: reviewerId }));

    await expect(service.approveLeave(leaveId, null, orgId, reviewerId)).rejects.toThrow(
      new AppError("You cannot approve/reject your own leave request", 403)
    );

    leaveRepo.findById.mockResolvedValue(baseLeave({ status: "approved", submittedBy: actorId }));

    await expect(service.approveLeave(leaveId, null, orgId, reviewerId)).rejects.toThrow(
      new AppError("Only pending leaves can be approved", 400)
    );
  });

  it("rejects a pending leave with required review note", async () => {
    const rejected = baseLeave({
      status: "rejected",
      reviewedBy: reviewerId,
      reviewedAt: new Date("2026-08-21T10:00:00.000Z"),
      reviewNote: "Insufficient coverage",
    });
    leaveRepo.findById.mockResolvedValue(baseLeave({ submittedBy: actorId }));
    leaveRepo.updateById.mockResolvedValue(rejected);

    const result = await service.rejectLeave(
      leaveId,
      "Insufficient coverage",
      orgId,
      reviewerId
    );

    expect(result.status).toBe("rejected");
    expect(auditLogService.createAuditLog).toHaveBeenCalledWith(
      expect.objectContaining({ action: "LEAVE_REJECTED" }),
      orgId,
      reviewerId,
      "session-1"
    );
  });

  it("cancels pending leave for submitter and approved leave for manager only", async () => {
    const cancelledPending = baseLeave({
      status: "cancelled",
      cancelledBy: actorId,
      cancelledAt: new Date("2026-08-21T10:00:00.000Z"),
      cancelReason: "Plans changed",
    });
    leaveRepo.findById.mockResolvedValue(baseLeave());
    leaveRepo.updateById.mockResolvedValue(cancelledPending);

    const ownResult = await service.cancelLeave(leaveId, "Plans changed", orgId, actorId);
    expect(ownResult.status).toBe("cancelled");

    const approved = baseLeave({ status: "approved" });
    const cancelledApproved = baseLeave({
      status: "cancelled",
      cancelledBy: managerId,
      cancelledAt: new Date("2026-08-21T10:00:00.000Z"),
      cancelReason: "Override",
    });
    leaveRepo.findById.mockResolvedValue(approved);
    leaveRepo.updateById.mockResolvedValue(cancelledApproved);

    const managerResult = await service.cancelLeave(leaveId, "Override", orgId, managerId);
    expect(managerResult.status).toBe("cancelled");

    await expect(service.cancelLeave(leaveId, "Nope", orgId, actorId)).rejects.toThrow(
      new AppError("Access denied. You do not have the required permissions.", 403)
    );
  });

  it("updates pending leaves, recomputes full dates, excludes self from overlap query, and audits", async () => {
    leaveRepo.findById.mockResolvedValue(baseLeave());
    leaveRepo.findOverlapping.mockResolvedValue(null);
    leaveRepo.updateById.mockResolvedValue(
      baseLeave({
        startDate: new Date("2026-09-04T00:00:00.000Z"),
        endDate: new Date("2026-09-06T00:00:00.000Z"),
        dates: ["2026-09-04", "2026-09-05", "2026-09-06"],
        reason: "Updated reason",
      })
    );

    const result = await service.updateLeave(
      leaveId,
      { startDate: "2026-09-04", endDate: "2026-09-06", reason: "Updated reason" },
      orgId,
      branchId,
      actorId
    );

    expect(leaveRepo.findOverlapping).toHaveBeenCalledWith(
      actorStaffId,
      new Date("2026-09-04T00:00:00.000Z"),
      new Date("2026-09-06T00:00:00.000Z"),
      orgId,
      leaveId,
      "session-1"
    );
    expect(leaveRepo.updateById).toHaveBeenCalledWith(
      leaveId,
      expect.objectContaining({
        dates: ["2026-09-04", "2026-09-05", "2026-09-06"],
      }),
      orgId,
      actorId,
      "session-1"
    );
    expect(result.dates).toBeUndefined();
    expect(auditLogService.createAuditLog).toHaveBeenCalledWith(
      expect.objectContaining({ action: "LEAVE_UPDATED" }),
      orgId,
      actorId,
      "session-1"
    );
  });

  it("rejects update when startDate is before todayUTC", async () => {
    leaveRepo.findById.mockResolvedValue(baseLeave());

    await expect(
      service.updateLeave(
        leaveId,
        { startDate: "2026-08-10", endDate: "2026-08-12" },
        orgId,
        branchId,
        actorId
      )
    ).rejects.toThrow(new AppError("startDate cannot be in the past", 400));
  });

  it("maps optimistic concurrency errors to 409", async () => {
    leaveRepo.findById.mockResolvedValue(baseLeave());
    leaveRepo.findOverlapping.mockResolvedValue(null);
    const versionError = new Error("stale version");
    versionError.name = "VersionError";
    leaveRepo.updateById.mockRejectedValue(versionError);

    await expect(
      service.updateLeave(
        leaveId,
        { reason: "Conflict" },
        orgId,
        branchId,
        actorId
      )
    ).rejects.toThrow(new AppError("Concurrent leave update conflict", 409));
  });

  it("returns list/get DTOs without dates and enforces branch isolation", async () => {
    leaveRepo.find.mockResolvedValue({
      data: [baseLeave()],
      meta: { total: 1, page: 1, limit: 10, totalPages: 1 },
    });
    leaveRepo.findById.mockResolvedValue(baseLeave({ branchId: otherBranchId }));

    const listResult = await service.listLeaves({ status: "pending" }, { page: 1 }, orgId, branchId);
    expect(listResult.data[0].dates).toBeUndefined();
    expect(leaveRepo.find).toHaveBeenCalledWith(
      expect.objectContaining({ status: "pending", branchId }),
      expect.objectContaining({ select: "-dates -__v -isDeleted -deletedAt -deletedBy" }),
      orgId
    );

    await expect(service.getLeaveById(leaveId, orgId, branchId)).rejects.toThrow(
      new AppError("Access denied. Leave is not visible within your active branch scope.", 403)
    );
  });

  it("propagates transaction sessions to create/update/audit paths", async () => {
    leaveRepo.findOverlapping.mockResolvedValue(null);
    leaveRepo.create.mockResolvedValue(baseLeave());

    await service.createLeave(
      {
        leaveType: "Casual",
        startDate: "2026-09-01",
        endDate: "2026-09-01",
        reason: "Test",
      },
      orgId,
      branchId,
      actorId
    );

    expect(service.runTransaction).toHaveBeenCalled();
    expect(leaveRepo.create.mock.calls[0][3]).toBe("session-1");
    expect(auditLogService.createAuditLog.mock.calls[0][3]).toBe("session-1");
  });
});
