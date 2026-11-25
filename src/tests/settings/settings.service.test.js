import { beforeEach, describe, expect, it, jest } from "@jest/globals";
import mongoose from "mongoose";
import { OrganizationSettingsService } from "../../services/settings/organizationSettings.service.js";
import { BranchSettingsService } from "../../services/settings/branchSettings.service.js";
import { Organization } from "../../models/organizations/organization.model.js";
import { Branch } from "../../models/branches/branch.model.js";
import { AppError } from "../../utils/errors.js";

describe("OrganizationSettingsService & BranchSettingsService", () => {
  const orgId = new mongoose.Types.ObjectId();
  const branchId = new mongoose.Types.ObjectId();
  const otherBranchId = new mongoose.Types.ObjectId();
  const actorId = new mongoose.Types.ObjectId();

  let orgSettingsRepo;
  let branchSettingsRepo;
  let auditLogService;
  let orgService;
  let branchService;

  beforeEach(() => {
    jest.restoreAllMocks();
    orgSettingsRepo = {
      findByOrganizationId: jest.fn(),
      upsertByOrganizationId: jest.fn(),
    };
    branchSettingsRepo = {
      findByBranch: jest.fn(),
      upsertByBranch: jest.fn(),
    };
    auditLogService = {
      createAuditLog: jest.fn().mockResolvedValue({}),
    };

    orgService = new OrganizationSettingsService({ orgSettingsRepo, auditLogService });
    orgService.executeTx = jest.fn(async (op) => op(null));

    branchService = new BranchSettingsService({ branchSettingsRepo, auditLogService });
    branchService.executeTx = jest.fn(async (op) => op(null));
  });

  it("reads organization settings with safe defaults when no OrganizationSettings doc exists", async () => {
    jest.spyOn(Organization, "findOne").mockReturnValue({
      lean: jest.fn().mockResolvedValue({
        _id: orgId,
        name: "Glam Studio",
        isActive: true,
        expenseApprovalThreshold: 5000,
        allowedExpenseCategories: ["utilities"],
      }),
    });
    orgSettingsRepo.findByOrganizationId.mockResolvedValue(null);

    const dto = await orgService.getOrganizationSettings(orgId);
    expect(dto.organizationId).toBe(orgId.toString());
    expect(dto.organization.name).toBe("Glam Studio");
    expect(dto.regional.timezone).toBe("Asia/Kolkata");
    expect(dto.defaults.defaultWeeklyOffDays).toEqual([0]);
  });

  it("updates organization settings and emits ORGANIZATION_SETTINGS_UPDATED audit log", async () => {
    const orgDoc = {
      _id: orgId,
      name: "Glam Studio",
      isActive: true,
      expenseApprovalThreshold: 5000,
      allowedExpenseCategories: ["utilities"],
      save: jest.fn().mockResolvedValue(true),
    };
    jest.spyOn(Organization, "findOne").mockReturnValue({
      session: jest.fn().mockResolvedValue(orgDoc),
    });
    orgSettingsRepo.findByOrganizationId.mockResolvedValue(null);
    const savedId = new mongoose.Types.ObjectId();
    orgSettingsRepo.upsertByOrganizationId.mockResolvedValue({
      _id: savedId,
      organizationId: orgId,
      regional: { timezone: "Asia/Dubai", currency: "AED" },
      defaults: { attendanceGraceMinutes: 10 },
      updatedAt: new Date("2026-11-25T00:00:00Z"),
    });

    const dto = await orgService.updateOrganizationSettings(
      orgId,
      { regional: { timezone: "Asia/Dubai", currency: "AED" } },
      actorId
    );

    expect(dto.regional.timezone).toBe("Asia/Dubai");
    expect(auditLogService.createAuditLog).toHaveBeenCalledWith(
      expect.objectContaining({
        action: "ORGANIZATION_SETTINGS_UPDATED",
        entityType: "OrganizationSettings",
        entityId: savedId,
      }),
      orgId,
      actorId,
      null
    );
  });

  it("rejects immutable organizationId in updateOrganizationSettings without auditing", async () => {
    await expect(
      orgService.updateOrganizationSettings(orgId, { organizationId: new mongoose.Types.ObjectId() }, actorId)
    ).rejects.toThrow(AppError);
    expect(auditLogService.createAuditLog).not.toHaveBeenCalled();
  });

  it("rejects unauthorized branch access for branch-scoped user", async () => {
    const restrictedUser = {
      id: actorId,
      hasOrgWideAccess: false,
      branchAccess: [{ branchId: otherBranchId, isActive: true }],
    };

    await expect(branchService.getBranchSettings(orgId, branchId.toString(), restrictedUser)).rejects.toThrow(
      "Access denied"
    );
  });

  it("updates branch settings with explicit false/0/[] overrides and emits BRANCH_SETTINGS_UPDATED", async () => {
    const branchDoc = {
      _id: branchId,
      organizationId: orgId,
      name: "Downtown",
      isActive: true,
      timezone: "Asia/Kolkata",
      bufferMinutes: 0,
      operatingHours: {},
      save: jest.fn().mockResolvedValue(true),
    };
    jest.spyOn(Branch, "findOne").mockReturnValue({
      session: jest.fn().mockResolvedValue(branchDoc),
    });
    branchSettingsRepo.findByBranch.mockResolvedValue(null);
    const savedId = new mongoose.Types.ObjectId();
    branchSettingsRepo.upsertByBranch.mockResolvedValue({
      _id: savedId,
      organizationId: orgId,
      branchId,
      weeklyOffDays: [],
      appointmentOverrides: { allowWalkIns: false, bufferMinutes: 0 },
      updatedAt: new Date("2026-11-25T00:00:00Z"),
    });

    const user = { id: actorId, hasOrgWideAccess: true, branchAccess: [] };
    const dto = await branchService.updateBranchSettings(
      orgId,
      branchId.toString(),
      {
        weeklyOffDays: [],
        appointmentOverrides: { allowWalkIns: false, bufferMinutes: 0 },
      },
      user
    );

    expect(dto.weeklyOffDays).toEqual([]);
    expect(dto.appointmentOverrides.allowWalkIns).toBe(false);
    expect(dto.appointmentOverrides.bufferMinutes).toBe(0);
    expect(auditLogService.createAuditLog).toHaveBeenCalledWith(
      expect.objectContaining({
        action: "BRANCH_SETTINGS_UPDATED",
        entityType: "BranchSettings",
        branchId,
      }),
      orgId,
      actorId,
      null
    );
  });
});
