import { Router } from "express";
import { authenticate } from "../../middleware/auth.js";
import { requireOrganizationScope, requireBranchScope } from "../../middleware/branchScope.js";
import { authorize } from "../../middleware/rbac.js";
import { validate } from "../../middleware/validate.js";
import * as settingsController from "../../controllers/settings/settings.controller.js";
import * as holidayController from "../../controllers/holidays/holiday.controller.js";
import * as leavePolicyController from "../../controllers/leavePolicies/leavePolicy.controller.js";
import * as exportController from "../../controllers/settings/export.controller.js";
import {
  createExportSchema,
  exportIdParamSchema,
} from "../../validation/settings/export.validation.js";
import {
  branchIdParamSchema,
  effectiveSettingsQuerySchema,
  updateBranchSettingsSchema,
  updateOrganizationSettingsSchema,
} from "../../validation/settings/settings.validation.js";
import {
  createHolidaySchema,
  holidayIdParamSchema,
  listHolidaysQuerySchema,
  resolveCalendarQuerySchema,
  updateHolidaySchema,
} from "../../validation/holidays/holiday.validation.js";
import {
  createLeavePolicySchema,
  leavePolicyIdParamSchema,
  listLeavePoliciesQuerySchema,
  updateLeavePolicySchema,
} from "../../validation/leavePolicies/leavePolicy.validation.js";

const router = Router();

router.use(authenticate);
router.use(requireOrganizationScope);

// Organization Settings (organization-scoped)
router.get(
  "/organization",
  authorize(["settings.view", "organizations.view"]),
  settingsController.getOrganizationSettings
);

router.put(
  "/organization",
  authorize(["settings.update", "organizations.update"]),
  validate(updateOrganizationSettingsSchema),
  settingsController.updateOrganizationSettings
);

// Branch Settings (organization + branch-scoped)
router.get(
  "/branches/:branchId",
  authorize("settings.view"),
  validate(branchIdParamSchema),
  settingsController.getBranchSettings
);

router.put(
  "/branches/:branchId",
  authorize("settings.update"),
  validate(updateBranchSettingsSchema),
  settingsController.updateBranchSettings
);

// Effective Settings (supports optional X-Branch-Id or ?branchId)
router.get(
  "/effective",
  authorize("settings.view"),
  requireBranchScope,
  validate(effectiveSettingsQuerySchema),
  settingsController.getEffectiveSettings
);

// Holiday Calendar & Resolver
router.get(
  "/holidays",
  authorize("settings.view"),
  validate(listHolidaysQuerySchema),
  holidayController.listHolidays
);

router.post(
  "/holidays",
  authorize("settings.update"),
  validate(createHolidaySchema),
  holidayController.createHoliday
);

router.put(
  "/holidays/:id",
  authorize("settings.update"),
  validate(updateHolidaySchema),
  holidayController.updateHoliday
);

router.delete(
  "/holidays/:id",
  authorize("settings.update"),
  validate(holidayIdParamSchema),
  holidayController.deleteHoliday
);

router.get(
  "/calendar/resolve",
  authorize("settings.view"),
  requireBranchScope,
  validate(resolveCalendarQuerySchema),
  holidayController.resolveCalendar
);

// Leave Policies
router.get(
  "/leave-policies",
  authorize(["settings.view", "employees.leaves.view"]),
  validate(listLeavePoliciesQuerySchema),
  leavePolicyController.listLeavePolicies
);

router.post(
  "/leave-policies",
  authorize("settings.update"),
  validate(createLeavePolicySchema),
  leavePolicyController.createLeavePolicy
);

router.put(
  "/leave-policies/:id",
  authorize("settings.update"),
  validate(updateLeavePolicySchema),
  leavePolicyController.updateLeavePolicy
);

router.delete(
  "/leave-policies/:id",
  authorize("settings.update"),
  validate(leavePolicyIdParamSchema),
  leavePolicyController.deactivateLeavePolicy
);

// Organization Data Exports & Infrastructure Backup Boundary
router.get(
  "/exports",
  authorize("settings.backups"),
  requireBranchScope,
  exportController.listExports
);

router.post(
  "/exports",
  authorize("settings.backups"),
  requireBranchScope,
  validate(createExportSchema),
  exportController.requestExport
);

router.get(
  "/exports/:id/download",
  authorize("settings.backups"),
  validate(exportIdParamSchema),
  exportController.downloadExport
);

router.get(
  "/backups/status",
  authorize("settings.backups"),
  exportController.getBackupStatus
);

export default router;
