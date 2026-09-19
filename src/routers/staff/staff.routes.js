import express from "express";
import * as controller from "../../controllers/staff/staff.controller.js";
import { authenticate } from "../../middleware/auth.js";
import { requireBranchScope, requireOrganizationScope } from "../../middleware/branchScope.js";
import { authorize } from "../../middleware/rbac.js";
import { validate } from "../../middleware/validate.js";
import {
  createStaffSchema,
  updateStaffSchema,
  queryStaffSchema,
  linkUserSchema,
  assignBranchSchema,
  assignServiceSchema,
} from "../../validation/staff/staff.validation.js";

const router = express.Router();

router.post(
  "/",
  authenticate,
  requireOrganizationScope,
  requireBranchScope,
  authorize("employees.create"),
  validate(createStaffSchema),
  controller.createStaff
);

router.get(
  "/",
  authenticate,
  requireOrganizationScope,
  requireBranchScope,
  authorize("employees.view"),
  validate(queryStaffSchema),
  controller.listStaff
);

router.get(
  "/:id",
  authenticate,
  requireOrganizationScope,
  requireBranchScope,
  authorize("employees.view"),
  controller.getStaff
);

router.put(
  "/:id",
  authenticate,
  requireOrganizationScope,
  requireBranchScope,
  authorize("employees.update"),
  validate(updateStaffSchema),
  controller.updateStaff
);

router.delete(
  "/:id",
  authenticate,
  requireOrganizationScope,
  requireBranchScope,
  authorize("employees.delete"),
  controller.deleteStaff
);

router.post(
  "/:id/restore",
  authenticate,
  requireOrganizationScope,
  requireBranchScope,
  authorize("employees.update"),
  controller.restoreStaff
);

router.post(
  "/:id/user",
  authenticate,
  requireOrganizationScope,
  requireBranchScope,
  authorize("employees.update"),
  validate(linkUserSchema),
  controller.linkUser
);

router.delete(
  "/:id/user",
  authenticate,
  requireOrganizationScope,
  requireBranchScope,
  authorize("employees.update"),
  controller.unlinkUser
);

router.post(
  "/:id/branches",
  authenticate,
  requireOrganizationScope,
  requireBranchScope,
  authorize("employees.assign_branch"),
  validate(assignBranchSchema),
  controller.assignBranch
);

router.delete(
  "/:id/branches/:branchId",
  authenticate,
  requireOrganizationScope,
  requireBranchScope,
  authorize("employees.assign_branch"),
  controller.removeBranch
);

router.post(
  "/:id/services",
  authenticate,
  requireOrganizationScope,
  requireBranchScope,
  authorize("employees.assign_service"),
  validate(assignServiceSchema),
  controller.assignService
);

router.delete(
  "/:id/services/:serviceId",
  authenticate,
  requireOrganizationScope,
  requireBranchScope,
  authorize("employees.assign_service"),
  controller.removeService
);

router.get(
  "/:id/branches",
  authenticate,
  requireOrganizationScope,
  requireBranchScope,
  authorize("employees.view"),
  controller.getStaffBranches
);

router.get(
  "/:id/services",
  authenticate,
  requireOrganizationScope,
  requireBranchScope,
  authorize("employees.view"),
  controller.getStaffServices
);

export default router;
