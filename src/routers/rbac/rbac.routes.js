import { Router } from "express";
import { authenticate } from "../../middleware/auth.js";
import { authorize } from "../../middleware/rbac.js";
import { validate } from "../../middleware/validate.js";
import * as rbacController from "../../controllers/rbac/rbac.controller.js";
import * as rbacValidation from "../../validation/rbac/rbac.validation.js";

const router = Router();

// All RBAC routes require authentication and admin permissions
router.use(authenticate);

router.post(
  "/permissions",
  authorize("roles.create"),
  validate(rbacValidation.createPermissionSchema),
  rbacController.createPermission
);

router.get(
  "/permissions",
  authorize("roles.view"),
  rbacController.listPermissions
);

router.post(
  "/roles",
  authorize("roles.create"),
  validate(rbacValidation.createRoleSchema),
  rbacController.createRole
);

router.get(
  "/roles",
  authorize("roles.view"),
  rbacController.listRoles
);

router.post(
  "/roles/:roleId/permissions",
  authorize("roles.update"),
  validate(rbacValidation.assignPermissionsSchema),
  rbacController.assignPermissionsToRole
);

export default router;
