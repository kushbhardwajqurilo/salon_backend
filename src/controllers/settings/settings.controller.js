import { asyncHandler } from "../../utils/errors.js";
import { sendResponse } from "../../utils/response.js";
import { OrganizationSettingsService } from "../../services/settings/organizationSettings.service.js";
import { BranchSettingsService } from "../../services/settings/branchSettings.service.js";
import { SettingsResolverService } from "../../services/settings/settingsResolver.service.js";
import { AuditLogService } from "../../services/audit/auditLog.service.js";
import { AUDIT_ACTIONS } from "../../models/audit/auditLog.model.js";

const auditLogService = new AuditLogService();

const orgSettingsService = new OrganizationSettingsService();
const branchSettingsService = new BranchSettingsService();
const resolverService = new SettingsResolverService();

export const getOrganizationSettings = asyncHandler(async (req, res) => {
  const result = await orgSettingsService.getOrganizationSettings(req.organizationId);
  return sendResponse(res, 200, "Organization settings retrieved successfully", result);
});

export const updateOrganizationSettings = asyncHandler(async (req, res) => {
  const result = await orgSettingsService.updateOrganizationSettings(
    req.organizationId,
    req.body,
    req.user.id
  );
  await auditLogService
    .createAuditLog(
      {
        action: AUDIT_ACTIONS.ORGANIZATION_SETTINGS_UPDATED,
        entityType: "OrganizationSettings",
        entityId: result?._id || req.organizationId,
        description: "Updated organization settings",
        metadata: req.body,
      },
      req.organizationId,
      req.user.id
    )
    .catch(() => {});
  return sendResponse(res, 200, "Organization settings updated successfully", result);
});

export const getBranchSettings = asyncHandler(async (req, res) => {
  const result = await branchSettingsService.getBranchSettings(
    req.organizationId,
    req.params.branchId,
    req.user
  );
  return sendResponse(res, 200, "Branch settings retrieved successfully", result);
});

export const updateBranchSettings = asyncHandler(async (req, res) => {
  const result = await branchSettingsService.updateBranchSettings(
    req.organizationId,
    req.params.branchId,
    req.body,
    req.user
  );
  await auditLogService
    .createAuditLog(
      {
        action: AUDIT_ACTIONS.BRANCH_SETTINGS_UPDATED,
        entityType: "BranchSettings",
        entityId: result?._id || req.params.branchId,
        branchId: req.params.branchId,
        description: `Updated branch settings for branch ${req.params.branchId}`,
        metadata: req.body,
      },
      req.organizationId,
      req.user.id
    )
    .catch(() => {});
  return sendResponse(res, 200, "Branch settings updated successfully", result);
});

export const getEffectiveSettings = asyncHandler(async (req, res) => {
  const branchId = req.branchId || req.query.branchId || null;
  if (branchId) {
    branchSettingsService.assertBranchAuthorized(req.user, branchId);
  }
  const result = await resolverService.resolveEffectiveSettings(req.organizationId, branchId);
  return sendResponse(res, 200, "Effective settings resolved successfully", result);
});
