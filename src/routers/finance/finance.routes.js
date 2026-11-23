import { Router } from "express";
import { authenticate } from "../../middleware/auth.js";
import {
  requireBranchScope,
  requireOrganizationScope,
  requireActiveBranch,
} from "../../middleware/branchScope.js";
import { authorize } from "../../middleware/rbac.js";
import { validate } from "../../middleware/validate.js";
import * as financeController from "../../controllers/finance/finance.controller.js";
import * as financeValidation from "../../validation/finance/finance.validation.js";

const router = Router();

router.use(authenticate);
router.use(requireOrganizationScope);

// ==========================================
// Day-End Register Closures
// ==========================================
router.get(
  "/day-closure/system-totals",
  requireActiveBranch,
  authorize("finance.view"),
  validate(financeValidation.getSystemTotalsQuerySchema),
  financeController.getSystemTotals
);

router.post(
  "/day-closure",
  requireActiveBranch,
  authorize("finance.create"),
  validate(financeValidation.submitDayClosureSchema),
  financeController.submitDayClosure
);

router.patch(
  "/day-closure/:id/approve",
  requireActiveBranch,
  authorize("finance.edit"),
  validate(financeValidation.approveDayClosureSchema),
  financeController.approveDayClosure
);

router.get(
  "/day-closure/:id",
  requireBranchScope,
  authorize("finance.view"),
  financeController.getDayClosureById
);

router.get(
  "/day-closure",
  requireBranchScope,
  authorize("finance.view"),
  validate(financeValidation.listDayClosuresQuerySchema),
  financeController.listDayClosures
);

// ==========================================
// Financial Alerts & Obligations
// ==========================================
router.get(
  "/overview-alerts",
  requireBranchScope,
  authorize("finance.view"),
  financeController.getFinancialAlertsAndObligations
);

// ==========================================
// Operating Profit (P&L MVP)
// ==========================================
router.get(
  "/operating-profit",
  requireBranchScope,
  authorize("finance.view"),
  validate(financeValidation.getOperatingProfitQuerySchema),
  financeController.getOperatingProfit
);

// ==========================================
// Branch Performance Matrix
// ==========================================
router.get(
  "/branch-performance",
  requireBranchScope,
  authorize("finance.view"),
  validate(financeValidation.getBranchPerformanceQuerySchema),
  financeController.getBranchPerformance
);

// ==========================================
// Unified Financial Transactions Explorer
// ==========================================
router.get(
  "/transactions",
  requireBranchScope,
  authorize("finance.transactions.view"),
  validate(financeValidation.getTransactionsQuerySchema),
  financeController.getTransactions
);

// ==========================================
// Financial Audit History
// ==========================================
router.get(
  "/audit-history",
  requireBranchScope,
  authorize("finance.audit.view"),
  validate(financeValidation.getAuditHistoryQuerySchema),
  financeController.getAuditHistory
);

// ==========================================
// Financial Reports & CSV Export
// ==========================================
router.get(
  "/reports/summary",
  requireBranchScope,
  authorize("finance.view"),
  validate(financeValidation.getReportsQuerySchema),
  financeController.getFinancialReports
);

router.get(
  "/reports/export",
  requireBranchScope,
  authorize("finance.reports.export"),
  validate(financeValidation.getReportsQuerySchema),
  financeController.exportFinancialReport
);

export default router;
