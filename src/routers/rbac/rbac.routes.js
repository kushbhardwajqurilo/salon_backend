import { Router } from "express";
import { authenticate } from "../../middleware/auth.js";
import { authorize } from "../../middleware/rbac.js";
import { validate } from "../../middleware/validate.js";
import * as rbacController from "../../controllers/rbac/rbac.controller.js";
import * as rbacValidation from "../../validation/rbac/rbac.validation.js";

const router = Router();

// All RBAC routes require authentication and admin permissions
// router.use(authenticate);

router.post(
  "/permissions",
  authorize("rbac:manage"),
  validate(rbacValidation.createPermissionSchema),
  rbacController.createPermission
);

router.get(
  "/permissions",
  authorize("rbac:manage"),
  rbacController.listPermissions
);

router.post(
  "/roles",
  // authorize("rbac:manage"),
  validate(rbacValidation.createRoleSchema),
  rbacController.createRole
);

router.get(
  "/roles",
  authorize("rbac:manage"),
  rbacController.listRoles
);

router.post(
  "/roles/:roleId/permissions",
  authorize("rbac:manage"),
  validate(rbacValidation.assignPermissionsSchema),
  rbacController.assignPermissionsToRole
);

export default router;
