import { Router } from "express";
import { z } from "zod";
import { authenticate } from "../../middleware/auth.js";
import { requireBranchScope } from "../../middleware/branchScope.js";
import { authorize } from "../../middleware/rbac.js";
import { validate } from "../../middleware/validate.js";
import { requireOnBehalfManage } from "../../middleware/leaveScope.js";
import * as leaveController from "../../controllers/leaves/leave.controller.js";
import {
  approveLeaveSchema,
  cancelLeaveSchema,
  createLeaveSchema,
  queryLeaveSchema,
  rejectLeaveSchema,
  updateLeaveSchema,
} from "../../validation/leaves/leave.validation.js";

const router = Router();

const objectIdRegex = /^[0-9a-fA-F]{24}$/;
const objectIdSchema = z.string().regex(objectIdRegex, "Invalid ObjectId format");

const leaveIdParamsSchema = z.object({
  params: z.object({
    id: objectIdSchema,
  }),
});

const withIdParams = (schema) =>
  schema.extend({
    params: z.object({
      id: objectIdSchema,
    }),
  });

router.post(
  "/",
  authenticate,
  requireBranchScope,
  authorize("employees.leaves.view"),
  validate(createLeaveSchema),
  requireOnBehalfManage,
  leaveController.createLeave
);

router.get(
  "/",
  authenticate,
  requireBranchScope,
  authorize("employees.leaves.view"),
  validate(queryLeaveSchema),
  leaveController.listLeaves
);

router.get(
  "/:id",
  authenticate,
  requireBranchScope,
  authorize("employees.leaves.view"),
  validate(leaveIdParamsSchema),
  leaveController.getLeaveById
);

router.put(
  "/:id",
  authenticate,
  requireBranchScope,
  authorize("employees.leaves.view"),
  validate(withIdParams(updateLeaveSchema)),
  leaveController.updateLeave
);

router.post(
  "/:id/approve",
  authenticate,
  requireBranchScope,
  authorize("employees.leaves.manage"),
  validate(withIdParams(approveLeaveSchema)),
  leaveController.approveLeave
);

router.post(
  "/:id/reject",
  authenticate,
  requireBranchScope,
  authorize("employees.leaves.manage"),
  validate(withIdParams(rejectLeaveSchema)),
  leaveController.rejectLeave
);

router.post(
  "/:id/cancel",
  authenticate,
  requireBranchScope,
  authorize("employees.leaves.view"),
  validate(withIdParams(cancelLeaveSchema)),
  leaveController.cancelLeave
);

export default router;
