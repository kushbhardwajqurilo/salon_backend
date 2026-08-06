import { Router } from "express";
import { authenticate } from "../../middleware/auth.js";
import { requireOrganizationScope } from "../../middleware/branchScope.js";
import { authorize } from "../../middleware/rbac.js";
import { validate } from "../../middleware/validate.js";
import * as controller from "../../controllers/users/user.controller.js";
import {
  createUserSchema,
  updateUserSchema,
  listUsersQuerySchema,
  updateUserStatusSchema,
} from "../../validation/users/user.validation.js";

const router = Router();

// All routes require authentication and organization scope
router.use(authenticate);
router.use(requireOrganizationScope);

router.post(
  "/",
  authorize("users.create"),
  validate(createUserSchema),
  controller.createUser
);

router.get(
  "/",
  authorize("users.view"),
  validate(listUsersQuerySchema),
  controller.listUsers
);

router.get(
  "/:id",
  authorize("users.view"),
  controller.getUserById
);

router.patch(
  "/:id",
  authorize("users.update"),
  validate(updateUserSchema),
  controller.updateUser
);

router.patch(
  "/:id/status",
  authorize("users.update"),
  validate(updateUserStatusSchema),
  controller.updateUserStatus
);

export default router;
