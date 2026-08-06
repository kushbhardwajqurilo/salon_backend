import mongoose from "mongoose";
import { StaffRepository } from "../../repositories/staff/staff.repository.js";
import { StaffBranchRepository } from "../../repositories/staff/staffBranch.repository.js";
import { StaffServiceRepository } from "../../repositories/staff/staffService.repository.js";
import { UserRepository } from "../../repositories/users/user.repository.js";
import { AuditLogService } from "../audit/auditLog.service.js";
import { Sequence } from "../../models/sequence/sequence.model.js";
import { AppError } from "../../utils/errors.js";

export class StaffService {
  constructor() {
    this.staffRepo = new StaffRepository();
    this.staffBranchRepo = new StaffBranchRepository();
    this.staffServiceRepo = new StaffServiceRepository();
    this.userRepo = new UserRepository();
    this.auditLogService = new AuditLogService();
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
        // Fallback to running without transaction
        return operation(null);
      }
    }
    return operation(null);
  }

  async createStaff(data, organizationId, actorId) {
    let retries = 3;
    while (retries > 0) {
      try {
        return await this.runTransaction(async (session) => {
          // Validate uniqueness of phone and email
          const existingEmail = await this.staffRepo.findByEmail(data.email, organizationId);
          if (existingEmail) {
            throw new AppError("Duplicate email address. Please use another value!", 400);
          }

          const existingPhone = await this.staffRepo.findByPhone(data.phone, organizationId);
          if (existingPhone) {
            throw new AppError("Duplicate phone number. Please use another value!", 400);
          }

          // Atomic sequence increment
          const seqDoc = await Sequence.findOneAndUpdate(
            { key: `staffCode:${organizationId}` },
            { $inc: { seq: 1 } },
            { new: true, upsert: true, session }
          );

          const staffCode = `STF-${String(seqDoc.seq).padStart(4, "0")}`;

          // Create staff record
          const staff = await this.staffRepo.create(
            { ...data, staffCode },
            organizationId,
            actorId,
            session
          );

          // Log audit
          await this.auditLogService.createAuditLog(
            {
              entityType: "Staff",
              entityId: staff._id,
              action: "STAFF_CREATED",
              description: `Staff member created with code ${staffCode}`,
              metadata: { staffCode },
              branchId: data.branchId || new mongoose.Types.ObjectId(), // Default fallback if no branch header
              actorId,
            },
            organizationId,
            actorId,
            session
          );
          return staff;
        });
      } catch (error) {
        if (error.code === 11000 && retries > 1) {
          retries--;
          continue; // Retry on duplicate key collision
        }
        throw error;
      }
    }
  }

  async getStaffById(id, organizationId) {
    const staff = await this.staffRepo.findById(id, organizationId);
    if (!staff) {
      throw new AppError("Staff not found", 404);
    }
    return staff;
  }

  async updateStaff(id, data, organizationId, actorId) {
    return this.runTransaction(async (session) => {
      const staff = await this.staffRepo.findById(id, organizationId);
      if (!staff) {
        throw new AppError("Staff not found", 404);
      }

      if (data.email) {
        const existingEmail = await this.staffRepo.findByEmail(data.email, organizationId);
        if (existingEmail && existingEmail._id.toString() !== id.toString()) {
          throw new AppError("Duplicate email address. Please use another value!", 400);
        }
      }

      if (data.phone) {
        const existingPhone = await this.staffRepo.findByPhone(data.phone, organizationId);
        if (existingPhone && existingPhone._id.toString() !== id.toString()) {
          throw new AppError("Duplicate phone number. Please use another value!", 400);
        }
      }

      // Lifecycle status transitions
      if (data.status && data.status !== staff.status) {
        const current = staff.status;
        const target = data.status;

        // Block invalid lifecycle states
        if (current === "inactive" && target === "suspended") {
          throw new AppError("Invalid lifecycle transition", 400);
        }

        // Update linked User status if needed
        if (staff.userId) {
          const linkedUser = await this.userRepo.findById(staff.userId, organizationId);
          if (linkedUser) {
            if (target === "inactive") {
              linkedUser.status = "inactive";
              await linkedUser.save({ session });
            } else if (target === "suspended") {
              linkedUser.status = "suspended";
              await linkedUser.save({ session });
            }
          }
        }
      }

      const updatedStaff = await this.staffRepo.updateById(id, data, organizationId, actorId, session);

      // Audit status changes
      if (data.status && data.status !== staff.status) {
        await this.auditLogService.createAuditLog(
          {
            entityType: "Staff",
            entityId: id,
            action: "STAFF_STATUS_UPDATED",
            description: `Staff status updated from ${staff.status} to ${data.status}`,
            metadata: { oldStatus: staff.status, newStatus: data.status },
            branchId: new mongoose.Types.ObjectId(),
            actorId,
          },
          organizationId,
          actorId,
          session
        );
      } else {
        await this.auditLogService.createAuditLog(
          {
            entityType: "Staff",
            entityId: id,
            action: "STAFF_UPDATED",
            description: "Staff profile details updated",
            metadata: { updatedFields: Object.keys(data) },
            branchId: new mongoose.Types.ObjectId(),
            actorId,
          },
          organizationId,
          actorId,
          session
        );
      }
      return updatedStaff;
    });
  }

  async deleteStaff(id, organizationId, actorId) {
    return this.runTransaction(async (session) => {
      const staff = await this.staffRepo.findById(id, organizationId);
      if (!staff) {
        throw new AppError("Staff not found", 404);
      }

      // Soft delete primary document
      await staff.softDelete(actorId);

      // Set status to inactive
      staff.status = "inactive";
      await staff.save({ session });

      // Deactivate user account linkage
      if (staff.userId) {
        const linkedUser = await this.userRepo.findById(staff.userId, organizationId);
        if (linkedUser) {
          linkedUser.status = "inactive";
          await linkedUser.save({ session });
        }
      }

      // Deactivate relationships
      await mongoose.model("StaffBranch").updateMany(
        { staffId: id, organizationId },
        { $set: { isActive: false } },
        { session }
      );

      await mongoose.model("StaffService").updateMany(
        { staffId: id, organizationId },
        { $set: { isActive: false } },
        { session }
      );

      // Audit log
      await this.auditLogService.createAuditLog(
        {
          entityType: "Staff",
          entityId: id,
          action: "STAFF_DELETED",
          description: "Staff member soft deleted",
          branchId: new mongoose.Types.ObjectId(),
          actorId,
        },
        organizationId,
        actorId,
        session
      );
      return true;
    });
  }

  async restoreStaff(id, organizationId, actorId) {
    return this.runTransaction(async (session) => {
      const staff = await this.staffRepo.findByIdIncludeDeleted(id, organizationId);
      if (!staff) {
        throw new AppError("Staff not found", 404);
      }

      // Check phone, email, and staffCode uniqueness
      const existingEmail = await this.staffRepo.findByEmail(staff.email, organizationId);
      if (existingEmail && existingEmail._id.toString() !== id.toString()) {
        throw new AppError("Email is already in use by another active record", 400);
      }

      const existingPhone = await this.staffRepo.findByPhone(staff.phone, organizationId);
      if (existingPhone && existingPhone._id.toString() !== id.toString()) {
        throw new AppError("Phone is already in use by another active record", 400);
      }

      const existingCode = await this.staffRepo.findByCode(staff.staffCode, organizationId);
      if (existingCode && existingCode._id.toString() !== id.toString()) {
        throw new AppError("StaffCode is already in use by another active record", 400);
      }

      const restored = await this.staffRepo.reactivateById(id, organizationId, actorId);

      await this.auditLogService.createAuditLog(
        {
          entityType: "Staff",
          entityId: id,
          action: "STAFF_REACTIVATED",
          description: "Staff member restored and reactivated",
          branchId: new mongoose.Types.ObjectId(),
          actorId,
        },
        organizationId,
        actorId,
        session
      );
      return restored;
    });
  }

  async listStaff(filter = {}, options = {}, organizationId) {
    const queryFilter = { ...filter };
    if (options.branchId) {
      const branchAssignments = await this.staffBranchRepo.find(
        { branchId: options.branchId, isActive: true },
        { limit: 9999 },
        organizationId
      );
      const staffIds = branchAssignments.data.map((b) => b.staffId);
      queryFilter._id = { $in: staffIds };
    }
    return this.staffRepo.find(queryFilter, options, organizationId);
  }

  async linkUser(id, userId, organizationId, actorId) {
    return this.runTransaction(async (session) => {
      const staff = await this.staffRepo.findById(id, organizationId);
      if (!staff) {
        throw new AppError("Staff not found", 404);
      }

      const user = await this.userRepo.findById(userId, organizationId);
      if (!user) {
        throw new AppError("User not found", 404);
      }

      if (user.status === "suspended") {
        throw new AppError("User is suspended and cannot be linked", 400);
      }
      if (user.status === "locked") {
        throw new AppError("User is locked and cannot be linked", 400);
      }
      if (user.status === "inactive") {
        throw new AppError("User is inactive and cannot be linked", 400);
      }

      if (user.organizationId.toString() !== organizationId.toString()) {
        throw new AppError("Cross-organization linkage is prohibited", 400);
      }

      // Verify User is not linked to another active Staff
      const linkedStaff = await this.staffRepo.findOne({ userId, isDeleted: false }, organizationId);
      if (linkedStaff && linkedStaff._id.toString() !== id.toString()) {
        throw new AppError("User is already linked to another active Staff", 400);
      }

      staff.userId = userId;
      await staff.save({ session });

      await this.auditLogService.createAuditLog(
        {
          entityType: "Staff",
          entityId: id,
          action: "USER_LINKED",
          description: `User linked to Staff profile`,
          metadata: { userId },
          branchId: new mongoose.Types.ObjectId(),
          actorId,
        },
        organizationId,
        actorId,
        session
      );
      return staff;
    });
  }

  async unlinkUser(id, organizationId, actorId) {
    return this.runTransaction(async (session) => {
      const staff = await this.staffRepo.findById(id, organizationId);
      if (!staff) {
        throw new AppError("Staff not found", 404);
      }

      if (!staff.userId) {
        throw new AppError("Staff is not linked to any User", 400);
      }

      const oldUserId = staff.userId;
      staff.userId = null;
      await staff.save({ session });

      await this.auditLogService.createAuditLog(
        {
          entityType: "Staff",
          entityId: id,
          action: "USER_UNLINKED",
          description: `User unlinked from Staff profile`,
          metadata: { userId: oldUserId },
          branchId: new mongoose.Types.ObjectId(),
          actorId,
        },
        organizationId,
        actorId,
        session
      );
      return staff;
    });
  }

  async assignBranch(id, branchId, isPrimary, organizationId, actorId) {
    return this.runTransaction(async (session) => {
      const staff = await this.staffRepo.findById(id, organizationId);
      if (!staff) {
        throw new AppError("Staff not found", 404);
      }

      const branch = await mongoose.model("Branch").findOne({ _id: branchId, organizationId });
      if (!branch) {
        throw new AppError("Branch not found", 404);
      }

      const existingAssignment = await this.staffBranchRepo.findOne(
        { staffId: id, branchId, isActive: true },
        organizationId
      );
      if (existingAssignment) {
        throw new AppError("Branch is already assigned to Staff", 400);
      }

      // Check count of active branch assignments
      const activeCount = await mongoose.model("StaffBranch").countDocuments({
        staffId: id,
        organizationId,
        isActive: true
      }).session(session);

      let primaryToAssign = isPrimary;
      if (activeCount === 0) {
        primaryToAssign = true;
      }

      if (primaryToAssign) {
        await mongoose.model("StaffBranch").updateMany(
          { staffId: id, organizationId },
          { $set: { isPrimary: false } },
          { session }
        );
      }

      const assignment = await this.staffBranchRepo.create(
        { staffId: id, branchId, isPrimary: primaryToAssign, isActive: true },
        organizationId,
        actorId,
        session
      );

      await this.auditLogService.createAuditLog(
        {
          entityType: "StaffBranch",
          entityId: assignment._id,
          action: "BRANCH_ASSIGNED",
          description: `Branch assigned to Staff member`,
          metadata: { branchId },
          branchId,
          actorId,
        },
        organizationId,
        actorId,
        session
      );
      return assignment;
    });
  }

  async removeBranch(id, branchId, organizationId, actorId) {
    return this.runTransaction(async (session) => {
      const staff = await this.staffRepo.findById(id, organizationId);
      if (!staff) {
        throw new AppError("Staff not found", 404);
      }

      const assignment = await this.staffBranchRepo.findOne(
        { staffId: id, branchId, isActive: true },
        organizationId
      );
      if (!assignment) {
        throw new AppError("Branch assignment not found", 404);
      }

      const wasPrimary = assignment.isPrimary;
      assignment.isActive = false;
      assignment.isPrimary = false;
      await assignment.save({ session });

      if (wasPrimary) {
        // Promote the oldest remaining active branch assignment
        const remaining = await mongoose.model("StaffBranch")
          .find({ staffId: id, organizationId, isActive: true })
          .sort({ createdAt: 1 })
          .session(session);

        if (remaining.length > 0) {
          const nextPrimary = remaining[0];
          nextPrimary.isPrimary = true;
          await nextPrimary.save({ session });
        }
      }

      await this.auditLogService.createAuditLog(
        {
          entityType: "StaffBranch",
          entityId: assignment._id,
          action: "BRANCH_REMOVED",
          description: `Branch assignment deactivated`,
          metadata: { branchId },
          branchId,
          actorId,
        },
        organizationId,
        actorId,
        session
      );
      return true;
    });
  }

  async assignService(id, serviceId, organizationId, actorId) {
    return this.runTransaction(async (session) => {
      const staff = await this.staffRepo.findById(id, organizationId);
      if (!staff) {
        throw new AppError("Staff not found", 404);
      }

      const service = await mongoose.model("Service").findOne({ _id: serviceId, organizationId });
      if (!service) {
        throw new AppError("Service not found", 404);
      }

      const existingMapping = await this.staffServiceRepo.findOne(
        { staffId: id, serviceId, isActive: true },
        organizationId
      );
      if (existingMapping) {
        throw new AppError("Service capability already assigned", 400);
      }

      const mapping = await this.staffServiceRepo.create(
        { staffId: id, serviceId, isActive: true },
        organizationId,
        actorId,
        session
      );

      await this.auditLogService.createAuditLog(
        {
          entityType: "StaffService",
          entityId: mapping._id,
          action: "SERVICE_ASSIGNED",
          description: `Service capability assigned to Staff member`,
          metadata: { serviceId },
          branchId: new mongoose.Types.ObjectId(),
          actorId,
        },
        organizationId,
        actorId,
        session
      );
      return mapping;
    });
  }

  async removeService(id, serviceId, organizationId, actorId) {
    return this.runTransaction(async (session) => {
      const staff = await this.staffRepo.findById(id, organizationId);
      if (!staff) {
        throw new AppError("Staff not found", 404);
      }

      const mapping = await this.staffServiceRepo.findOne(
        { staffId: id, serviceId, isActive: true },
        organizationId
      );
      if (!mapping) {
        throw new AppError("Service capability mapping not found", 404);
      }

      mapping.isActive = false;
      await mapping.save({ session });

      await this.auditLogService.createAuditLog(
        {
          entityType: "StaffService",
          entityId: mapping._id,
          action: "SERVICE_REMOVED",
          description: `Service capability mapping deactivated`,
          metadata: { serviceId },
          branchId: new mongoose.Types.ObjectId(),
          actorId,
        },
        organizationId,
        actorId,
        session
      );
      return true;
    });
  }

  async getStaffBranches(id, organizationId) {
    const staff = await this.staffRepo.findById(id, organizationId);
    if (!staff) {
      throw new AppError("Staff not found", 404);
    }
    const result = await this.staffBranchRepo.find(
      { staffId: id, isActive: true },
      { limit: 9999, populate: ["branchId"] },
      organizationId
    );
    return result.data;
  }

  async getStaffServices(id, organizationId) {
    const staff = await this.staffRepo.findById(id, organizationId);
    if (!staff) {
      throw new AppError("Staff not found", 404);
    }
    const result = await this.staffServiceRepo.find(
      { staffId: id, isActive: true },
      { limit: 9999, populate: ["serviceId"] },
      organizationId
    );
    return result.data;
  }
}
