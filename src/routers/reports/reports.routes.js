import { Router } from "express";
import { authenticate } from "../../middleware/auth.js";
import {
  requireBranchScope,
  requireOrganizationScope,
} from "../../middleware/branchScope.js";
import { authorize } from "../../middleware/rbac.js";
import { validate } from "../../middleware/validate.js";
import * as reportsController from "../../controllers/reports/reports.controller.js";
import * as reportsValidation from "../../validation/reports/reports.validation.js";

const router = Router();

router.use(authenticate);
router.use(requireOrganizationScope);
router.use(requireBranchScope);

// ==========================================
// 1. Reports Overview (Authorized with ANY report permission)
// ==========================================
router.get(
  "/overview",
  authorize([
    "reports.revenue.view",
    "reports.performance.view",
    "reports.retention.view",
    "reports.services.view",
    "reports.inventory.view",
  ]),
  validate(reportsValidation.reportQuerySchema),
  reportsController.getReportsOverview
);

// ==========================================
// 2. Revenue & Sales Report
// ==========================================
router.get(
  "/revenue",
  authorize("reports.revenue.view"),
  validate(reportsValidation.reportQuerySchema),
  reportsController.getRevenueReport
);

// ==========================================
// 3. Employee Performance Report
// ==========================================
router.get(
  "/staff-performance",
  authorize("reports.performance.view"),
  validate(reportsValidation.reportQuerySchema),
  reportsController.getStaffPerformanceReport
);

// ==========================================
// 4. Customer Retention Report
// ==========================================
router.get(
  "/customer-retention",
  authorize("reports.retention.view"),
  validate(reportsValidation.reportQuerySchema),
  reportsController.getCustomerRetentionReport
);

// ==========================================
// 5. Service Analytics Report
// ==========================================
router.get(
  "/service-analytics",
  authorize("reports.services.view"),
  validate(reportsValidation.reportQuerySchema),
  reportsController.getServiceAnalyticsReport
);

// ==========================================
// 6. Inventory Report
// ==========================================
router.get(
  "/inventory",
  authorize("reports.inventory.view"),
  validate(reportsValidation.inventoryReportQuerySchema),
  reportsController.getInventoryReport
);

// ==========================================
// 7. CSV Export Route (Authorized per specific report type)
// ==========================================
const authorizeReportExport = (req, res, next) => {
  const mapping = {
    revenue: "reports.revenue.view",
    "staff-performance": "reports.performance.view",
    "customer-retention": "reports.retention.view",
    "service-analytics": "reports.services.view",
    inventory: "reports.inventory.view",
  };
  const perm = mapping[req.params.reportType];
  if (!perm) {
    return res.status(404).json({ success: false, message: "Invalid report export type" });
  }
  return authorize(perm)(req, res, next);
};

router.get(
  "/:reportType/export",
  authorizeReportExport,
  validate(reportsValidation.exportReportQuerySchema),
  reportsController.exportReportCSV
);

export default router;
