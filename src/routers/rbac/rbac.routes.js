import { Router } from "express";
import { authenticate } from "../../middleware/auth.js";
import { requireOrganizationScope } from "../../middleware/branchScope.js";
import { authorize } from "../../middleware/rbac.js";
import { validate } from "../../middleware/validate.js";
import * as rbacController from "../../controllers/rbac/rbac.controller.js";
import * as rbacValidation from "../../validation/rbac/rbac.validation.js";

const router = Router();

// All RBAC routes require authentication and organization scope
router.use(authenticate);
router.use(requireOrganizationScope);

router.post(
  "/permissions",
  authorize("roles.create"),
  validate(rbacValidation.createPermissionSchema),
  rbacController.createPermission
);

router.get(
  "/permissions",
  authorize("roles.view"),
  validate(rbacValidation.listPermissionsQuerySchema),
  rbacController.listPermissions
);

router.get(
  "/modules",
  authorize("roles.view"),
  rbacController.listModules
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

router.get(
  "/roles/:roleId",
  authorize("roles.view"),
  validate(rbacValidation.roleIdParamSchema),
  rbacController.getRoleById
);

router.put(
  "/roles/:roleId/permissions",
  authorize("roles.update"),
  validate(rbacValidation.assignPermissionsSchema),
  rbacController.assignPermissionsToRole
);

router.post(
  "/roles/:roleId/permissions",
  authorize("roles.update"),
  validate(rbacValidation.assignPermissionsSchema),
  rbacController.assignPermissionsToRole
);

router.delete(
  "/roles/:roleId",
  authorize("roles.delete"),
  validate(rbacValidation.roleIdParamSchema),
  rbacController.deleteRole
);

export default router;
