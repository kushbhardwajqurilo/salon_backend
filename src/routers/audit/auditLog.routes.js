import { Router } from "express";
import { authenticate } from "../../middleware/auth.js";
import { requireBranchScope } from "../../middleware/branchScope.js";
import { authorize } from "../../middleware/rbac.js";
import { validate } from "../../middleware/validate.js";
import * as auditLogController from "../../controllers/audit/auditLog.controller.js";
import { queryAuditLogSchema } from "../../validation/audit/auditLog.validation.js";

const router = Router();

// Enforce authentication across all audit log operations
router.use(authenticate);

// List Audit Logs (Read-only, no update or delete routes)
router.get(
  "/",
  requireBranchScope,
  authorize("logs.view"),
  validate(queryAuditLogSchema),
  auditLogController.listAuditLogs
);

export default router;
