import { Organization } from "../../models/organizations/organization.model.js";
import { OrganizationSettingsRepository } from "../../repositories/settings/organizationSettings.repository.js";
import { AuditLogService } from "../audit/auditLog.service.js";
import { runInTransaction, isTransactionSupported } from "../../utils/transaction.js";
import { AppError } from "../../utils/errors.js";

const ORG_IMMUTABLE_FIELDS = ["organizationId", "_id", "id", "createdAt", "updatedAt"];

export class OrganizationSettingsService {
  constructor(deps = {}) {
    this.orgSettingsRepo = deps.orgSettingsRepo || new OrganizationSettingsRepository();
    this.auditLogService = deps.auditLogService || new AuditLogService();
  }

  async executeTx(operation) {
    return runInTransaction(operation, { requireTransaction: isTransactionSupported() });
  }

  toDTO(organization, orgSettings) {
    return {
      id: orgSettings?._id?.toString() || null,
      organizationId: organization._id.toString(),
      organization: {
        id: organization._id.toString(),
        name: organization.name,
        logo: organization.logo ?? null,
        isActive: organization.isActive,
        expenseApprovalThreshold: organization.expenseApprovalThreshold,
        allowedExpenseCategories: organization.allowedExpenseCategories || [],
      },
      profile: {
        displayName: orgSettings?.profile?.displayName ?? null,
        email: orgSettings?.profile?.email ?? null,
        phone: orgSettings?.profile?.phone ?? null,
        address: orgSettings?.profile?.address ?? null,
        website: orgSettings?.profile?.website ?? null,
      },
      regional: {
        timezone: orgSettings?.regional?.timezone ?? "Asia/Kolkata",
        currency: orgSettings?.regional?.currency ?? "INR",
        locale: orgSettings?.regional?.locale ?? "en-IN",
        dateFormat: orgSettings?.regional?.dateFormat ?? "YYYY-MM-DD",
        timeFormat: orgSettings?.regional?.timeFormat ?? "HH:mm",
        firstDayOfWeek: orgSettings?.regional?.firstDayOfWeek ?? 1,
      },
      defaults: {
        appointmentBufferMinutes: orgSettings?.defaults?.appointmentBufferMinutes ?? 0,
        allowWalkIns: orgSettings?.defaults?.allowWalkIns ?? true,
        allowAdvanceBookings: orgSettings?.defaults?.allowAdvanceBookings ?? true,
        reminderDefaultOffsetMinutes: orgSettings?.defaults?.reminderDefaultOffsetMinutes ?? 60,
        attendanceGraceMinutes: orgSettings?.defaults?.attendanceGraceMinutes ?? 15,
        autoMarkAbsentAfterCutoff: orgSettings?.defaults?.autoMarkAbsentAfterCutoff ?? false,
        defaultWeeklyOffDays: orgSettings?.defaults?.defaultWeeklyOffDays ?? [0],
        defaultHalfDayEligible: orgSettings?.defaults?.defaultHalfDayEligible ?? true,
        exportRetentionHours: orgSettings?.defaults?.exportRetentionHours ?? 24,
      },
      updatedAt: orgSettings?.updatedAt ? orgSettings.updatedAt.toISOString() : null,
    };
  }

  async getOrganizationSettings(organizationId) {
    const organization = await Organization.findOne({ _id: organizationId }).lean();
    if (!organization) {
      throw new AppError("Organization not found", 404);
    }
    const orgSettings = await this.orgSettingsRepo.findByOrganizationId(organizationId);
    return this.toDTO(organization, orgSettings);
  }

  async updateOrganizationSettings(organizationId, data, actorId) {
    for (const key of ORG_IMMUTABLE_FIELDS) {
      if (key in data) {
        throw new AppError(`Immutable field '${key}' cannot be modified`, 400);
      }
    }

    return this.executeTx(async (session) => {
      const organization = await Organization.findOne({ _id: organizationId }).session(session);
      if (!organization) {
        throw new AppError("Organization not found", 404);
      }

      if (data.organization) {
        if (data.organization.name !== undefined) organization.name = data.organization.name.trim();
        if (data.organization.logo !== undefined) organization.logo = data.organization.logo;
        if (data.organization.expenseApprovalThreshold !== undefined) {
          organization.expenseApprovalThreshold = data.organization.expenseApprovalThreshold;
        }
        if (data.organization.allowedExpenseCategories !== undefined) {
          organization.allowedExpenseCategories = data.organization.allowedExpenseCategories;
        }
        await organization.save({ session });
      }

      const existing = await this.orgSettingsRepo.findByOrganizationId(organizationId, session);
      const mergedPayload = {
        profile: {
          ...(existing?.profile?.toObject ? existing.profile.toObject() : existing?.profile || {}),
          ...(data.profile || {}),
        },
        regional: {
          ...(existing?.regional?.toObject ? existing.regional.toObject() : existing?.regional || {}),
          ...(data.regional || {}),
        },
        defaults: {
          ...(existing?.defaults?.toObject ? existing.defaults.toObject() : existing?.defaults || {}),
          ...(data.defaults || {}),
        },
      };

      const updatedSettings = await this.orgSettingsRepo.upsertByOrganizationId(
        organizationId,
        mergedPayload,
        actorId,
        session
      );

      await this.auditLogService.createAuditLog(
        {
          entityType: "OrganizationSettings",
          entityId: updatedSettings._id,
          action: "ORGANIZATION_SETTINGS_UPDATED",
          description: "Organization settings updated",
          metadata: {
            updatedSections: Object.keys(data),
          },
          actorId,
        },
        organizationId,
        actorId,
        session
      );

      return this.toDTO(organization, updatedSettings);
    });
  }
}
