import express from "express";
import { authenticateUser } from "../../middleware/auth.js";
import { requireOrganizationScope, requireBranchScope } from "../../middleware/branchScope.js";
import { requirePermission } from "../../middleware/rbac.js";
import { validate } from "../../middleware/validate.js";
import { PayrollController } from "../../controllers/payroll/payroll.controller.js";
import {
  createSalaryStructureSchema,
  createPayrollPeriodSchema,
  calculatePayrollSchema,
  approvePayrollRecordSchema,
  payPayrollRecordSchema,
  confirmPayrollPaymentSchema,
  failPayrollPaymentSchema,
  reversePayrollRecordSchema,
  addAdjustmentSchema,
} from "../../validation/payroll/payroll.validation.js";

const router = express.Router();

// Apply base authentication and organization isolation to all payroll endpoints
router.use(authenticateUser);
router.use(requireOrganizationScope);

// Salary Configuration Endpoints
router.post(
  "/structures",
  requirePermission("payroll.structure.manage"),
  requireBranchScope,
  validate(createSalaryStructureSchema),
  PayrollController.setSalaryStructure
);

router.get(
  "/structures/:staffId",
  requirePermission("payroll.view"),
  requireBranchScope,
  PayrollController.getEffectiveSalaryStructure
);

router.get(
  "/structures/:staffId/history",
  requirePermission("payroll.view"),
  requireBranchScope,
  PayrollController.getSalaryStructureHistory
);

// Payroll Period Management Endpoints
router.post(
  "/periods",
  requirePermission("payroll.calculate"),
  validate(createPayrollPeriodSchema),
  PayrollController.createPayrollPeriod
);

router.get(
  "/periods",
  requirePermission("payroll.view"),
  PayrollController.listPayrollPeriods
);

// Calculation & Processing
router.post(
  "/calculate",
  requirePermission("payroll.calculate"),
  requireBranchScope,
  validate(calculatePayrollSchema),
  PayrollController.calculatePayroll
);

// Adjustments on Draft Records
router.post(
  "/records/:id/adjust",
  requirePermission("payroll.adjust"),
  requireBranchScope,
  validate(addAdjustmentSchema),
  PayrollController.addAdjustment
);

// Approval & Payment Lifecycle
router.post(
  "/records/:id/submit",
  requirePermission("payroll.calculate"),
  requireBranchScope,
  PayrollController.submitForApproval
);

router.post(
  "/records/:id/approve",
  requirePermission("payroll.approve"),
  requireBranchScope,
  validate(approvePayrollRecordSchema),
  PayrollController.approvePayrollRecord
);

router.post(
  "/records/:id/pay",
  requirePermission("payroll.disburse"),
  requireBranchScope,
  validate(payPayrollRecordSchema),
  PayrollController.recordPayment
);

router.post(
  "/records/:id/payments/:paymentId/confirm",
  requirePermission("payroll.disburse"),
  requireBranchScope,
  validate(confirmPayrollPaymentSchema),
  PayrollController.confirmPayment
);

router.post(
  "/records/:id/payments/:paymentId/fail",
  requirePermission("payroll.disburse"),
  requireBranchScope,
  validate(failPayrollPaymentSchema),
  PayrollController.failPayment
);

router.post(
  "/records/:id/reverse",
  requirePermission("payroll.reverse"),
  requireBranchScope,
  validate(reversePayrollRecordSchema),
  PayrollController.reversePayment
);

// Query Records & Payslips
router.get(
  "/records",
  requirePermission("payroll.view"),
  requireBranchScope,
  PayrollController.listPayrollRecords
);

router.get(
  "/records/:id",
  requirePermission("payroll.view"),
  requireBranchScope,
  PayrollController.getPayrollRecordById
);

router.get(
  "/records/:id/payslip-pdf",
  requirePermission("payroll.export"),
  requireBranchScope,
  PayrollController.downloadPayslipPdf
);

export default router;
