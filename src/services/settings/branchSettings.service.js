import mongoose from "mongoose";
import { Branch } from "../../models/branches/branch.model.js";
import { BranchSettingsRepository } from "../../repositories/settings/branchSettings.repository.js";
import { AuditLogService } from "../audit/auditLog.service.js";
import { normalizeOperatingHours } from "../../utils/operatingHours.js";
import { runInTransaction, isTransactionSupported } from "../../utils/transaction.js";
import { AppError } from "../../utils/errors.js";

const BRANCH_IMMUTABLE_FIELDS = ["organizationId", "branchId", "_id", "id", "createdAt", "updatedAt"];

export class BranchSettingsService {
  constructor(deps = {}) {
    this.branchSettingsRepo = deps.branchSettingsRepo || new BranchSettingsRepository();
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

  toDTO(branch, branchSettings) {
    const normalizedHours = normalizeOperatingHours(branch.operatingHours);
    const breakWindowsObj =
      branchSettings?.breakWindows instanceof Map
        ? Object.fromEntries(branchSettings.breakWindows.entries())
        : branchSettings?.breakWindows || {};

    return {
      id: branchSettings?._id?.toString() || null,
      organizationId: branch.organizationId.toString(),
      branchId: branch._id.toString(),
      branch: {
        id: branch._id.toString(),
        name: branch.name,
        address: branch.address ?? null,
        phone: branch.phone ?? null,
        isActive: branch.isActive,
        timezone: branch.timezone || "Asia/Kolkata",
        bufferMinutes: branch.bufferMinutes ?? 0,
        operatingHoursConfigured: normalizedHours.isConfigured,
        operatingHours: normalizedHours.schedule,
      },
      breakWindows: breakWindowsObj,
      weeklyOffDays: branchSettings?.weeklyOffDays !== undefined ? branchSettings.weeklyOffDays : null,
      appointmentOverrides: {
        bufferMinutes: branchSettings?.appointmentOverrides?.bufferMinutes ?? null,
        allowWalkIns: branchSettings?.appointmentOverrides?.allowWalkIns ?? null,
        allowAdvanceBookings: branchSettings?.appointmentOverrides?.allowAdvanceBookings ?? null,
        reminderDefaultOffsetMinutes:
          branchSettings?.appointmentOverrides?.reminderDefaultOffsetMinutes ?? null,
      },
      attendanceOverrides: {
        graceMinutes: branchSettings?.attendanceOverrides?.graceMinutes ?? null,
        autoMarkAbsentAfterCutoff: branchSettings?.attendanceOverrides?.autoMarkAbsentAfterCutoff ?? null,
      },
      leaveOverrides: {
        allowHalfDay: branchSettings?.leaveOverrides?.allowHalfDay ?? null,
        allowBranchPolicyOverrides: branchSettings?.leaveOverrides?.allowBranchPolicyOverrides ?? null,
      },
      updatedAt: branchSettings?.updatedAt ? branchSettings.updatedAt.toISOString() : null,
    };
  }

  async getBranchSettings(organizationId, branchId, user) {
    this.assertBranchAuthorized(user, branchId);
    const branch = await Branch.findOne({ _id: branchId, organizationId }).lean();
    if (!branch) {
      throw new AppError("Branch not found", 404);
    }
    const branchSettings = await this.branchSettingsRepo.findByBranch(organizationId, branchId);
    return this.toDTO(branch, branchSettings);
  }

  async updateBranchSettings(organizationId, branchId, data, user) {
    this.assertBranchAuthorized(user, branchId);
    for (const key of BRANCH_IMMUTABLE_FIELDS) {
      if (key in data) {
        throw new AppError(`Immutable field '${key}' cannot be modified`, 400);
      }
    }

    return this.executeTx(async (session) => {
      const branch = await Branch.findOne({ _id: branchId, organizationId, isActive: true }).session(session);
      if (!branch) {
        throw new AppError("Active branch not found", 404);
      }

      if (data.branch) {
        if (data.branch.timezone !== undefined) branch.timezone = data.branch.timezone.trim();
        if (data.branch.bufferMinutes !== undefined) branch.bufferMinutes = data.branch.bufferMinutes;
        if (data.branch.address !== undefined) branch.address = data.branch.address;
        if (data.branch.phone !== undefined) branch.phone = data.branch.phone;
        if (data.branch.operatingHours !== undefined) {
          const normalized = normalizeOperatingHours(data.branch.operatingHours);
          branch.operatingHours = normalized.schedule || {};
        }
        await branch.save({ session });
      }

      const existing = await this.branchSettingsRepo.findByBranch(organizationId, branchId, session);
      const updatePayload = {};
      if (data.breakWindows !== undefined) updatePayload.breakWindows = data.breakWindows;
      if (data.weeklyOffDays !== undefined) updatePayload.weeklyOffDays = data.weeklyOffDays;

      if (data.appointmentOverrides !== undefined) {
        updatePayload.appointmentOverrides = {
          ...(existing?.appointmentOverrides?.toObject
            ? existing.appointmentOverrides.toObject()
            : existing?.appointmentOverrides || {}),
          ...data.appointmentOverrides,
        };
      }
      if (data.attendanceOverrides !== undefined) {
        updatePayload.attendanceOverrides = {
          ...(existing?.attendanceOverrides?.toObject
            ? existing.attendanceOverrides.toObject()
            : existing?.attendanceOverrides || {}),
          ...data.attendanceOverrides,
        };
      }
      if (data.leaveOverrides !== undefined) {
        updatePayload.leaveOverrides = {
          ...(existing?.leaveOverrides?.toObject
            ? existing.leaveOverrides.toObject()
            : existing?.leaveOverrides || {}),
          ...data.leaveOverrides,
        };
      }

      const updatedSettings = await this.branchSettingsRepo.upsertByBranch(
        organizationId,
        branchId,
        updatePayload,
        user.id,
        session
      );

      await this.auditLogService.createAuditLog(
        {
          entityType: "BranchSettings",
          entityId: updatedSettings._id,
          action: "BRANCH_SETTINGS_UPDATED",
          description: `Branch settings updated for ${branch.name}`,
          metadata: {
            branchId: branch._id.toString(),
            updatedSections: Object.keys(data),
          },
          branchId: branch._id,
          actorId: user.id,
        },
        organizationId,
        user.id,
        session
      );

      return this.toDTO(branch, updatedSettings);
    });
  }
}
