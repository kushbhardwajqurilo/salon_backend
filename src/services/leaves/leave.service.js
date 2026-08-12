import mongoose from "mongoose";
import { LeaveRepository } from "../../repositories/leaves/leave.repository.js";
import { StaffRepository } from "../../repositories/staff/staff.repository.js";
import { StaffBranchRepository } from "../../repositories/staff/staffBranch.repository.js";
import { UserRepository } from "../../repositories/users/user.repository.js";
import { RoleRepository } from "../../repositories/roles/role.repository.js";
import { AuditLogService } from "../audit/auditLog.service.js";
import { Sequence } from "../../models/sequence/sequence.model.js";
import { AppError } from "../../utils/errors.js";
import { enumerateDates, toDateOnlyStr, toUTCDate, MAX_LEAVE_DAYS } from "../../utils/date.js";

const MANAGE_PERMISSION = "employees.leaves.manage";
const ACTIVE_STAFF_STATUS = "active";
const LEAVE_CODE_PREFIX = "LV-";
const LEAVE_CODE_RETRY_LIMIT = 3;
const MUTABLE_FIELDS = new Set(["leaveType", "startDate", "endDate", "reason"]);
const IMMUTABLE_FIELDS = [
  "status",
  "staffId",
  "branchId",
  "organizationId",
  "leaveCode",
  "dates",
  "submittedBy",
  "submittedFor",
  "reviewedBy",
  "reviewedAt",
  "reviewNote",
  "cancelledBy",
  "cancelledAt",
  "cancelReason",
];

const isObjectIdEqual = (left, right) => {
  if (!left || !right) {
    return false;
  }
  return left.toString() === right.toString();
};

const normalizeId = (value) => (value ? value.toString() : null);

const normalizeDateTime = (value) => {
  if (!value) {
    return null;
  }
  const date = value instanceof Date ? value : new Date(value);
  return Number.isNaN(date.getTime()) ? null : date.toISOString();
};

const isVersionConflict = (error) =>
  error instanceof mongoose.Error.VersionError || error?.name === "VersionError";

const isDuplicateKey = (error) => error?.code === 11000;

const isOverlapDuplicate = (error) => {
  const keyPattern = error?.keyPattern || {};
  if (keyPattern.dates) {
    return true;
  }
  const message = `${error?.message || ""} ${error?.errmsg || ""}`;
  return message.includes("dates");
};

const isLeaveCodeDuplicate = (error) => {
  const keyPattern = error?.keyPattern || {};
  if (keyPattern.leaveCode) {
    return true;
  }
  const message = `${error?.message || ""} ${error?.errmsg || ""}`;
  return message.includes("leaveCode");
};

export class LeaveService {
  constructor(deps = {}) {
    this.leaveRepo = deps.leaveRepo || new LeaveRepository();
    this.staffRepo = deps.staffRepo || new StaffRepository();
    this.staffBranchRepo = deps.staffBranchRepo || new StaffBranchRepository();
    this.userRepo = deps.userRepo || new UserRepository();
    this.roleRepo = deps.roleRepo || new RoleRepository();
    this.auditLogService = deps.auditLogService || new AuditLogService();
  }

  async runTransaction(operation) {
    let session = null;
    if (mongoose.connection.db && typeof mongoose.connection.startSession === "function") {
      try {
        session = await mongoose.connection.startSession();
        session.startTransaction();
        const result = await operation(session);
        await session.commitTransaction();
        session.endSession();
        return result;
      } catch (err) {
        if (session) {
          try {
            await session.abortTransaction();
            session.endSession();
          } catch (_) {}
        }
        const isSessionErr =
          err.message?.includes("Transaction numbers") ||
          err.message?.includes("does not support retryable writes") ||
          err.message?.includes("replica set") ||
          err.message?.includes("IllegalOperation");
        if (!isSessionErr) {
          throw err;
        }
        return operation(null);
      }
    }
    return operation(null);
  }

  async createLeave(data, organizationId, branchId, actorId) {
    this.assertBranchScope(branchId);

    let retries = LEAVE_CODE_RETRY_LIMIT;
    while (retries > 0) {
      try {
        return await this.runTransaction(async (session) => {
          const actorUser = await this.getActorUser(actorId, organizationId, session);
          const actorPermissions = await this.getActorPermissions(actorUser, session);
          const { staffId, submittedFor } = await this.resolveTargetStaff(
            data.staffId,
            organizationId,
            actorId,
            actorPermissions,
            session
          );

          await this.validateStaffEligibility(staffId, organizationId, branchId, session);
          const { startDate, endDate, dates } = this.buildDateRange(data.startDate, data.endDate);

          const overlap = await this.leaveRepo.findOverlapping(
            staffId,
            startDate,
            endDate,
            organizationId,
            null,
            session
          );
          if (overlap) {
            throw new AppError("Leave request overlaps with an existing leave", 400);
          }

          const leaveCode = await this.generateLeaveCode(organizationId, session);
          const leave = await this.leaveRepo.create(
            {
              branchId,
              staffId,
              leaveCode,
              leaveType: data.leaveType,
              startDate,
              endDate,
              dates,
              reason: data.reason,
              status: "pending",
              submittedBy: actorId,
              submittedFor,
            },
            organizationId,
            actorId,
            session
          );

          await this.auditLogService.createAuditLog(
            {
              entityType: "Leave",
              entityId: leave._id,
              action: "LEAVE_REQUESTED",
              description: `Leave requested with code ${leaveCode}`,
              metadata: {
                leaveCode,
                staffId,
                branchId,
                startDate: toDateOnlyStr(startDate),
                endDate: toDateOnlyStr(endDate),
                leaveType: data.leaveType,
                submittedFor,
              },
              branchId,
              actorId,
            },
            organizationId,
            actorId,
            session
          );

          return this.toLeaveDTO(leave);
        });
      } catch (error) {
        if (isDuplicateKey(error) && isOverlapDuplicate(error)) {
          throw new AppError("Leave request overlaps with an existing leave", 400);
        }
        if (isDuplicateKey(error) && isLeaveCodeDuplicate(error) && retries > 1) {
          retries -= 1;
          continue;
        }
        if (isVersionConflict(error)) {
          throw new AppError("Concurrent leave update conflict", 409);
        }
        throw error;
      }
    }

    throw new AppError("Unable to generate a unique leave code", 500);
  }

  async listLeaves(filter = {}, options = {}, organizationId, branchId) {
    const queryFilter = { ...filter };
    if (branchId) {
      queryFilter.branchId = branchId;
    }

    const result = await this.leaveRepo.find(
      queryFilter,
      { ...options, select: "-dates -__v -isDeleted -deletedAt -deletedBy" },
      organizationId
    );

    return {
      data: result.data.map((leave) => this.toLeaveDTO(leave)),
      meta: result.meta,
    };
  }

  async getLeaveById(id, organizationId, branchId) {
    const leave = await this.leaveRepo.findById(
      id,
      organizationId,
      [],
      "-dates -__v -isDeleted -deletedAt -deletedBy"
    );
    if (!leave) {
      throw new AppError("Leave not found", 404);
    }

    this.assertLeaveBranchVisibility(leave, branchId);
    return this.toLeaveDTO(leave);
  }

  async updateLeave(id, data, organizationId, branchId, actorId) {
    this.assertBranchScope(branchId);
    this.assertNoImmutableFieldChanges(data);

    try {
      return await this.runTransaction(async (session) => {
        const leave = await this.leaveRepo.findById(id, organizationId, [], null, session);
        if (!leave) {
          throw new AppError("Leave not found", 404);
        }

        this.assertLeaveBranchVisibility(leave, branchId);
        this.assertPendingStatus(leave, "Only pending leaves can be updated");

        const actorUser = await this.getActorUser(actorId, organizationId, session);
        const actorPermissions = await this.getActorPermissions(actorUser, session);
        if (!isObjectIdEqual(leave.submittedBy, actorId) && !actorPermissions.includes(MANAGE_PERMISSION)) {
          throw new AppError("Access denied. You do not have the required permissions.", 403);
        }

        await this.validateStaffEligibility(leave.staffId, organizationId, leave.branchId, session);

        const merged = {
          leaveType: data.leaveType ?? leave.leaveType,
          startDate: data.startDate ?? toDateOnlyStr(leave.startDate),
          endDate: data.endDate ?? toDateOnlyStr(leave.endDate),
          reason: data.reason ?? leave.reason,
        };
        const { startDate, endDate, dates } = this.buildDateRange(merged.startDate, merged.endDate);

        const overlap = await this.leaveRepo.findOverlapping(
          leave.staffId,
          startDate,
          endDate,
          organizationId,
          leave._id,
          session
        );
        if (overlap) {
          throw new AppError("Leave request overlaps with an existing leave", 400);
        }

        const updatedFields = [];
        for (const field of MUTABLE_FIELDS) {
          if (field in data) {
            updatedFields.push(field);
          }
        }

        const updatedLeave = await this.leaveRepo.updateById(
          id,
          {
            leaveType: merged.leaveType,
            startDate,
            endDate,
            dates,
            reason: merged.reason,
          },
          organizationId,
          actorId,
          session
        );

        await this.auditLogService.createAuditLog(
          {
            entityType: "Leave",
            entityId: updatedLeave._id,
            action: "LEAVE_UPDATED",
            description: `Leave updated for code ${updatedLeave.leaveCode}`,
            metadata: {
              leaveCode: updatedLeave.leaveCode,
              updatedFields,
            },
            branchId: updatedLeave.branchId,
            actorId,
          },
          organizationId,
          actorId,
          session
        );

        return this.toLeaveDTO(updatedLeave);
      });
    } catch (error) {
      if (isDuplicateKey(error) && isOverlapDuplicate(error)) {
        throw new AppError("Leave request overlaps with an existing leave", 400);
      }
      if (isVersionConflict(error)) {
        throw new AppError("Concurrent leave update conflict", 409);
      }
      throw error;
    }
  }

  async approveLeave(id, reviewNote, organizationId, actorId) {
    try {
      return await this.runTransaction(async (session) => {
        const leave = await this.leaveRepo.findById(id, organizationId, [], null, session);
        if (!leave) {
          throw new AppError("Leave not found", 404);
        }

        const actorUser = await this.getActorUser(actorId, organizationId, session);
        const actorPermissions = await this.getActorPermissions(actorUser, session);
        this.assertManagePermission(actorPermissions);
        this.assertPendingStatus(leave, "Only pending leaves can be approved");

        if (isObjectIdEqual(leave.submittedBy, actorId)) {
          throw new AppError("You cannot approve/reject your own leave request", 403);
        }

        const now = new Date();
        const updatedLeave = await this.leaveRepo.updateById(
          id,
          {
            status: "approved",
            reviewedBy: actorId,
            reviewedAt: now,
            reviewNote: reviewNote || null,
          },
          organizationId,
          actorId,
          session
        );

        await this.auditLogService.createAuditLog(
          {
            entityType: "Leave",
            entityId: updatedLeave._id,
            action: "LEAVE_APPROVED",
            description: `Leave approved for code ${updatedLeave.leaveCode}`,
            metadata: {
              leaveCode: updatedLeave.leaveCode,
              reviewedBy: actorId,
              reviewNote: reviewNote || null,
            },
            branchId: updatedLeave.branchId,
            actorId,
          },
          organizationId,
          actorId,
          session
        );

        return this.toLeaveDTO(updatedLeave);
      });
    } catch (error) {
      if (isVersionConflict(error)) {
        throw new AppError("Concurrent leave update conflict", 409);
      }
      throw error;
    }
  }

  async rejectLeave(id, reviewNote, organizationId, actorId) {
    try {
      return await this.runTransaction(async (session) => {
        const leave = await this.leaveRepo.findById(id, organizationId, [], null, session);
        if (!leave) {
          throw new AppError("Leave not found", 404);
        }

        const actorUser = await this.getActorUser(actorId, organizationId, session);
        const actorPermissions = await this.getActorPermissions(actorUser, session);
        this.assertManagePermission(actorPermissions);
        this.assertPendingStatus(leave, "Only pending leaves can be rejected");

        if (isObjectIdEqual(leave.submittedBy, actorId)) {
          throw new AppError("You cannot approve/reject your own leave request", 403);
        }
        if (!reviewNote?.trim()) {
          throw new AppError("Review note is required", 400);
        }

        const now = new Date();
        const updatedLeave = await this.leaveRepo.updateById(
          id,
          {
            status: "rejected",
            reviewedBy: actorId,
            reviewedAt: now,
            reviewNote: reviewNote.trim(),
          },
          organizationId,
          actorId,
          session
        );

        await this.auditLogService.createAuditLog(
          {
            entityType: "Leave",
            entityId: updatedLeave._id,
            action: "LEAVE_REJECTED",
            description: `Leave rejected for code ${updatedLeave.leaveCode}`,
            metadata: {
              leaveCode: updatedLeave.leaveCode,
              reviewedBy: actorId,
              reviewNote: reviewNote.trim(),
            },
            branchId: updatedLeave.branchId,
            actorId,
          },
          organizationId,
          actorId,
          session
        );

        return this.toLeaveDTO(updatedLeave);
      });
    } catch (error) {
      if (isVersionConflict(error)) {
        throw new AppError("Concurrent leave update conflict", 409);
      }
      throw error;
    }
  }

  async cancelLeave(id, cancelReason, organizationId, actorId) {
    try {
      return await this.runTransaction(async (session) => {
        const leave = await this.leaveRepo.findById(id, organizationId, [], null, session);
        if (!leave) {
          throw new AppError("Leave not found", 404);
        }

        const actorUser = await this.getActorUser(actorId, organizationId, session);
        const actorPermissions = await this.getActorPermissions(actorUser, session);
        const canManage = actorPermissions.includes(MANAGE_PERMISSION);

        if (!cancelReason?.trim()) {
          throw new AppError("Cancel reason is required", 400);
        }

        if (leave.status === "pending") {
          if (!isObjectIdEqual(leave.submittedBy, actorId) && !canManage) {
            throw new AppError("Access denied. You do not have the required permissions.", 403);
          }
        } else if (leave.status === "approved") {
          if (!canManage) {
            throw new AppError("Access denied. You do not have the required permissions.", 403);
          }
        } else {
          throw new AppError("Invalid leave status transition", 400);
        }

        const previousStatus = leave.status;
        const now = new Date();
        const updatedLeave = await this.leaveRepo.updateById(
          id,
          {
            status: "cancelled",
            cancelledBy: actorId,
            cancelledAt: now,
            cancelReason: cancelReason.trim(),
          },
          organizationId,
          actorId,
          session
        );

        await this.auditLogService.createAuditLog(
          {
            entityType: "Leave",
            entityId: updatedLeave._id,
            action: "LEAVE_CANCELLED",
            description: `Leave cancelled for code ${updatedLeave.leaveCode}`,
            metadata: {
              leaveCode: updatedLeave.leaveCode,
              cancelReason: cancelReason.trim(),
              previousStatus,
            },
            branchId: updatedLeave.branchId,
            actorId,
          },
          organizationId,
          actorId,
          session
        );

        return this.toLeaveDTO(updatedLeave);
      });
    } catch (error) {
      if (isVersionConflict(error)) {
        throw new AppError("Concurrent leave update conflict", 409);
      }
      throw error;
    }
  }

  async getActorUser(actorId, organizationId, session) {
    const actorUser = await this.userRepo.findById(actorId, organizationId, [], null, session);
    if (!actorUser) {
      throw new AppError("Access denied. Actor user not found.", 403);
    }
    return actorUser;
  }

  async getActorPermissions(actorUser, session) {
    const roleId = actorUser.role?._id || actorUser.role;
    const role = await this.roleRepo.findOne({ _id: roleId }, ["permissions"], null, session);
    if (!role) {
      throw new AppError("Access denied. Role not found.", 403);
    }
    return (role.permissions || []).map((permission) => permission.name);
  }

  async resolveTargetStaff(inputStaffId, organizationId, actorId, actorPermissions, session) {
    const actorStaff = await this.staffRepo.findOne(
      { userId: actorId, isDeleted: false },
      organizationId,
      [],
      null,
      session
    );

    if (!inputStaffId) {
      if (!actorStaff) {
        throw new AppError(
          "This account is not linked to an active staff profile. Please contact an administrator.",
          403
        );
      }
      return { staffId: actorStaff._id, submittedFor: "self" };
    }

    const targetStaff = await this.staffRepo.findById(inputStaffId, organizationId, [], null, session);
    if (!targetStaff) {
      throw new AppError("Staff not found", 404);
    }

    const isSelf = actorStaff && isObjectIdEqual(actorStaff._id, targetStaff._id);
    if (!isSelf && !actorPermissions.includes(MANAGE_PERMISSION)) {
      throw new AppError("Access denied. You do not have the required permissions.", 403);
    }

    return {
      staffId: targetStaff._id,
      submittedFor: isSelf ? "self" : "staff",
    };
  }

  async validateStaffEligibility(staffId, organizationId, branchId, session) {
    const staff = await this.staffRepo.findById(staffId, organizationId, [], null, session);
    if (!staff) {
      throw new AppError("Staff not found", 404);
    }
    if (staff.status !== ACTIVE_STAFF_STATUS) {
      throw new AppError("Staff is not active", 400);
    }

    const assignment = await this.staffBranchRepo.findOne(
      { staffId, branchId, isActive: true },
      organizationId
    );
    if (!assignment) {
      throw new AppError("Staff is not assigned to this branch", 403);
    }

    return staff;
  }

  buildDateRange(startDateInput, endDateInput) {
    const startDate = toUTCDate(startDateInput);
    const endDate = toUTCDate(endDateInput);

    if (endDate < startDate) {
      throw new AppError("endDate must be greater than or equal to startDate", 400);
    }

    const todayUtc = toDateOnlyStr(new Date());
    if (startDateInput < todayUtc) {
      throw new AppError("startDate cannot be in the past", 400);
    }

    let dates;
    try {
      dates = enumerateDates(startDateInput, endDateInput);
    } catch (error) {
      if (error.message.includes("endDate must be greater than or equal to startDate")) {
        throw new AppError("endDate must be greater than or equal to startDate", 400);
      }
      if (error.message.includes("MAX_LEAVE_DAYS")) {
        throw new AppError(`Leave range cannot exceed ${MAX_LEAVE_DAYS} calendar days`, 400);
      }
      throw error;
    }

    return { startDate, endDate, dates };
  }

  async generateLeaveCode(organizationId, session) {
    const seqDoc = await Sequence.findOneAndUpdate(
      { key: `leaveCode:${organizationId}` },
      { $inc: { seq: 1 } },
      { new: true, upsert: true, session }
    );
    return `${LEAVE_CODE_PREFIX}${String(seqDoc.seq).padStart(4, "0")}`;
  }

  assertBranchScope(branchId) {
    if (!branchId) {
      throw new AppError("Branch scope is required for this operation", 400);
    }
  }

  assertLeaveBranchVisibility(leave, branchId) {
    if (branchId && !isObjectIdEqual(leave.branchId, branchId)) {
      throw new AppError("Access denied. Leave is not visible within your active branch scope.", 403);
    }
  }

  assertManagePermission(permissions) {
    if (!permissions.includes(MANAGE_PERMISSION)) {
      throw new AppError("Access denied. You do not have the required permissions.", 403);
    }
  }

  assertPendingStatus(leave, message) {
    if (leave.status !== "pending") {
      throw new AppError(message || "Invalid leave status transition", 400);
    }
  }

  assertNoImmutableFieldChanges(data) {
    const forbidden = IMMUTABLE_FIELDS.filter((field) => field in data);
    if (forbidden.length > 0) {
      throw new AppError(`Immutable fields cannot be updated: ${forbidden.join(", ")}`, 400);
    }
  }

  toLeaveDTO(leave) {
    return {
      id: normalizeId(leave._id),
      branchId: normalizeId(leave.branchId),
      staffId: normalizeId(leave.staffId),
      leaveCode: leave.leaveCode,
      leaveType: leave.leaveType,
      startDate: leave.startDate ? toDateOnlyStr(leave.startDate) : null,
      endDate: leave.endDate ? toDateOnlyStr(leave.endDate) : null,
      reason: leave.reason,
      status: leave.status,
      submittedBy: normalizeId(leave.submittedBy),
      submittedFor: leave.submittedFor,
      reviewedBy: normalizeId(leave.reviewedBy),
      reviewedAt: normalizeDateTime(leave.reviewedAt),
      reviewNote: leave.reviewNote ?? null,
      cancelledBy: normalizeId(leave.cancelledBy),
      cancelledAt: normalizeDateTime(leave.cancelledAt),
      cancelReason: leave.cancelReason ?? null,
      createdAt: normalizeDateTime(leave.createdAt),
      updatedAt: normalizeDateTime(leave.updatedAt),
    };
  }
}
