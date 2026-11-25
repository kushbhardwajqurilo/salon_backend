import mongoose from "mongoose";
import { Branch } from "../../models/branches/branch.model.js";
import { LeavePolicy } from "../../models/leavePolicies/leavePolicy.model.js";
import { AuditLogService } from "../audit/auditLog.service.js";
import { runInTransaction, isTransactionSupported } from "../../utils/transaction.js";
import { AppError } from "../../utils/errors.js";

const IMMUTABLE_FIELDS = ["organizationId", "branchId", "code", "_id", "id", "createdAt", "updatedAt"];

export class LeavePolicyService {
  constructor(deps = {}) {
    this.auditLogService = deps.auditLogService || new AuditLogService();
  }

  async executeTx(operation) {
    return runInTransaction(operation, { requireTransaction: isTransactionSupported() });
  }

  assertBranchAuthorized(user, branchId) {
    if (!mongoose.Types.ObjectId.isValid(branchId)) {
      throw new AppError("Invalid branch ID format", 400);
    }
    if (user?.hasOrgWideAccess === true) {
      return;
    }
    const allowed = (user?.branchAccess || []).some(
      (b) => b.branchId?.toString() === branchId.toString() && b.isActive
    );
    if (!allowed) {
      throw new AppError("Access denied. You do not have access to this branch.", 403);
    }
  }

  toDTO(doc) {
    return {
      id: doc._id.toString(),
      organizationId: doc.organizationId.toString(),
      branchId: doc.branchId ? doc.branchId.toString() : null,
      code: doc.code,
      name: doc.name,
      description: doc.description ?? null,
      isPaid: Boolean(doc.isPaid),
      annualEntitlement: doc.annualEntitlement,
      carryForwardLimit: doc.carryForwardLimit ?? 0,
      allowHalfDay: Boolean(doc.allowHalfDay),
      maxConsecutiveDays: doc.maxConsecutiveDays ?? null,
      excludeHolidays: Boolean(doc.excludeHolidays),
      excludeWeeklyOffs: Boolean(doc.excludeWeeklyOffs),
      excessBehavior: doc.excessBehavior,
      allowNegativeBalance: Boolean(doc.allowNegativeBalance),
      negativeBalancePayrollTreatment: doc.negativeBalancePayrollTreatment || "unpaid_deduction",
      effectiveFrom: doc.effectiveFrom ? doc.effectiveFrom.toISOString() : null,
      effectiveTo: doc.effectiveTo ? doc.effectiveTo.toISOString() : null,
      isActive: Boolean(doc.isActive),
      createdAt: doc.createdAt ? doc.createdAt.toISOString() : null,
      updatedAt: doc.updatedAt ? doc.updatedAt.toISOString() : null,
    };
  }

  async listPolicies(organizationId, query = {}, user) {
    const filter = {
      organizationId,
      isActive: query.includeInactive === "true" ? { $in: [true, false] } : true,
    };

    if (query.branchId) {
      this.assertBranchAuthorized(user, query.branchId);
      filter.branchId = { $in: [null, query.branchId] };
    } else if (!user?.hasOrgWideAccess) {
      const accessibleBranchIds = (user?.branchAccess || [])
        .filter((b) => b.isActive)
        .map((b) => b.branchId);
      filter.branchId = { $in: [null, ...accessibleBranchIds] };
    }

    const docs = await LeavePolicy.find(filter).sort({ branchId: 1, code: 1 }).lean();
    return docs.map((d) => this.toDTO(d));
  }

  async createPolicy(organizationId, data, user) {
    const branchId = data.branchId || null;
    if (branchId) {
      this.assertBranchAuthorized(user, branchId);
      const branch = await Branch.findOne({ _id: branchId, organizationId, isActive: true }).lean();
      if (!branch) {
        throw new AppError("Active branch not found in organization", 404);
      }
    } else if (!user?.hasOrgWideAccess) {
      throw new AppError("Organization-wide access is required to create organization leave policies", 403);
    }

    try {
      return await this.executeTx(async (session) => {
        const created = await LeavePolicy.create(
          [
            {
              organizationId,
              branchId,
              code: data.code.trim().toUpperCase(),
              name: data.name.trim(),
              description: data.description?.trim() || null,
              isPaid: data.isPaid,
              annualEntitlement: data.annualEntitlement,
              carryForwardLimit: data.carryForwardLimit ?? 0,
              allowHalfDay: data.allowHalfDay ?? true,
              maxConsecutiveDays: data.maxConsecutiveDays ?? null,
              excludeHolidays: data.excludeHolidays ?? true,
              excludeWeeklyOffs: data.excludeWeeklyOffs ?? true,
              excessBehavior: data.excessBehavior ?? "reject",
              allowNegativeBalance: data.allowNegativeBalance ?? false,
              negativeBalancePayrollTreatment: data.negativeBalancePayrollTreatment ?? "unpaid_deduction",
              effectiveFrom: data.effectiveFrom ? new Date(data.effectiveFrom) : new Date(),
              effectiveTo: data.effectiveTo ? new Date(data.effectiveTo) : null,
              isActive: true,
              createdBy: user.id,
              updatedBy: user.id,
            },
          ],
          { session }
        );
        const doc = created[0];

        await this.auditLogService.createAuditLog(
          {
            entityType: "LeavePolicy",
            entityId: doc._id,
            action: "LEAVE_POLICY_CREATED",
            description: `Leave policy '${doc.code}' created`,
            metadata: {
              code: doc.code,
              isPaid: doc.isPaid,
              annualEntitlement: doc.annualEntitlement,
              excessBehavior: doc.excessBehavior,
              branchId: branchId ? branchId.toString() : null,
            },
            branchId,
            actorId: user.id,
          },
          organizationId,
          user.id,
          session
        );

        return this.toDTO(doc);
      });
    } catch (error) {
      if (error?.code === 11000) {
        throw new AppError("An active leave policy with this code already exists for this scope", 409);
      }
      throw error;
    }
  }

  async updatePolicy(organizationId, id, data, user) {
    for (const key of IMMUTABLE_FIELDS) {
      if (key in data) {
        throw new AppError(`Immutable field '${key}' cannot be modified`, 400);
      }
    }

    const existing = await LeavePolicy.findOne({ _id: id, organizationId });
    if (!existing) {
      throw new AppError("Leave policy not found", 404);
    }

    if (existing.branchId) {
      this.assertBranchAuthorized(user, existing.branchId.toString());
    } else if (!user?.hasOrgWideAccess) {
      throw new AppError("Organization-wide access is required to update organization leave policies", 403);
    }

    return this.executeTx(async (session) => {
      if (data.name !== undefined) existing.name = data.name.trim();
      if (data.description !== undefined) existing.description = data.description?.trim() || null;
      if (data.isPaid !== undefined) existing.isPaid = data.isPaid;
      if (data.annualEntitlement !== undefined) existing.annualEntitlement = data.annualEntitlement;
      if (data.carryForwardLimit !== undefined) existing.carryForwardLimit = data.carryForwardLimit;
      if (data.allowHalfDay !== undefined) existing.allowHalfDay = data.allowHalfDay;
      if (data.maxConsecutiveDays !== undefined) existing.maxConsecutiveDays = data.maxConsecutiveDays;
      if (data.excludeHolidays !== undefined) existing.excludeHolidays = data.excludeHolidays;
      if (data.excludeWeeklyOffs !== undefined) existing.excludeWeeklyOffs = data.excludeWeeklyOffs;
      if (data.excessBehavior !== undefined) existing.excessBehavior = data.excessBehavior;
      if (data.allowNegativeBalance !== undefined) existing.allowNegativeBalance = data.allowNegativeBalance;
      if (data.negativeBalancePayrollTreatment !== undefined) {
        existing.negativeBalancePayrollTreatment = data.negativeBalancePayrollTreatment;
      }
      if (data.effectiveTo !== undefined) {
        existing.effectiveTo = data.effectiveTo ? new Date(data.effectiveTo) : null;
      }
      existing.updatedBy = user.id;

      await existing.save({ session });

      await this.auditLogService.createAuditLog(
        {
          entityType: "LeavePolicy",
          entityId: existing._id,
          action: "LEAVE_POLICY_UPDATED",
          description: `Leave policy '${existing.code}' updated`,
          metadata: {
            code: existing.code,
            updatedFields: Object.keys(data),
          },
          branchId: existing.branchId,
          actorId: user.id,
        },
        organizationId,
        user.id,
        session
      );

      return this.toDTO(existing);
    });
  }

  async deactivatePolicy(organizationId, id, user) {
    const existing = await LeavePolicy.findOne({ _id: id, organizationId });
    if (!existing) {
      throw new AppError("Leave policy not found", 404);
    }

    if (existing.branchId) {
      this.assertBranchAuthorized(user, existing.branchId.toString());
    } else if (!user?.hasOrgWideAccess) {
      throw new AppError("Organization-wide access is required to deactivate organization leave policies", 403);
    }

    return this.executeTx(async (session) => {
      existing.isActive = false;
      existing.updatedBy = user.id;
      await existing.save({ session });

      await this.auditLogService.createAuditLog(
        {
          entityType: "LeavePolicy",
          entityId: existing._id,
          action: "LEAVE_POLICY_DEACTIVATED",
          description: `Leave policy '${existing.code}' deactivated`,
          metadata: {
            code: existing.code,
          },
          branchId: existing.branchId,
          actorId: user.id,
        },
        organizationId,
        user.id,
        session
      );

      return this.toDTO(existing);
    });
  }
}
