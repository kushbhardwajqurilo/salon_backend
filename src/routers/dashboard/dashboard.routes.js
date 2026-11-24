import { Router } from "express";
import { authenticate } from "../../middleware/auth.js";
import {
  requireOrganizationScope,
  requireBranchScope,
} from "../../middleware/branchScope.js";
import { authorize } from "../../middleware/rbac.js";
import { validate } from "../../middleware/validate.js";
import * as dashboardController from "../../controllers/dashboard/dashboard.controller.js";
import { dashboardOverviewQuerySchema } from "../../validation/dashboard/dashboard.validation.js";

const router = Router();

// Global middleware pipeline for all dashboard routes
router.use(authenticate);
router.use(requireOrganizationScope);
router.use(requireBranchScope);
router.use(authorize("dashboard.view"));

/**
 * @route   GET /api/v1/dashboard/overview
 * @desc    Executive BI overview, KPIs, revenue trends, and permission-gated domain summaries
 * @access  Protected (Requires dashboard.view + domain-specific permissions for modular sections)
 */
router.get(
  "/overview",
  validate(dashboardOverviewQuerySchema),
  dashboardController.getOverview
);

/**
 * @route   GET /api/v1/dashboard/operations
 * @desc    Today's live operations command centre (timeline, attendance, staff availability)
 * @access  Protected (Requires dashboard.view)
 */
router.get("/operations", dashboardController.getOperations);

/**
 * @route   GET /api/v1/dashboard/alerts
 * @desc    Actionable business exception alerts across modules
 * @access  Protected (Requires dashboard.view)
 */
router.get("/alerts", dashboardController.getAlerts);

export default router;
