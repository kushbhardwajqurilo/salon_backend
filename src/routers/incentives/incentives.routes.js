import { Router } from "express";
import { authenticate } from "../../middleware/auth.js";
import { authorize } from "../../middleware/rbac.js";
import {
  requireActiveBranch,
  requireBranchScope,
} from "../../middleware/branchScope.js";
import { validate } from "../../middleware/validate.js";
import * as incentivesController from "../../controllers/incentives/incentives.controller.js";
import {
  createSchemeSchema,
  updateSchemeSchema,
  listSchemesSchema,
  createAssignmentSchema,
  listAssignmentsSchema,
  listSummarySchema,
  previewCalculationSchema,
  listLedgerSchema,
  listRecoveryObligationsSchema,
  recordRecoveryPaymentSchema,
  confirmRecoveryPaymentSchema,
  failRecoveryPaymentSchema,
  reverseRecoveryPaymentSchema,
  confirmWalkInFulfillmentSchema,
  listWalkInFulfillmentSchema,
  computeAttendanceEvaluationSchema,
  finalizeAttendanceEvaluationSchema,
  objectIdSchema,
} from "../../validation/incentives/incentives.validation.js";
import { z } from "zod";

const router = Router();

const withIdParam = (schema = z.object({})) =>
  z.object({
    params: z.object({
      id: objectIdSchema,
    }),
  });

// ---------------------------------------------------------
// INCENTIVE SCHEME ROUTES
// ---------------------------------------------------------

// List schemes (view or view.all)
router.get(
  "/schemes",
  authenticate,
  authorize(["incentives.view", "incentives.view.all"]),
  validate(listSchemesSchema),
  incentivesController.listSchemes
);

// Create scheme (rules.manage)
router.post(
  "/schemes",
  authenticate,
  authorize("incentives.rules.manage"),
  validate(createSchemeSchema),
  incentivesController.createScheme
);

// Get scheme by id
router.get(
  "/schemes/:id",
  authenticate,
  authorize(["incentives.view", "incentives.view.all"]),
  validate(withIdParam()),
  incentivesController.getSchemeById
);

// Update scheme
router.patch(
  "/schemes/:id",
  authenticate,
  authorize("incentives.rules.manage"),
  validate(updateSchemeSchema),
  incentivesController.updateScheme
);

// Lifecycle: Activate scheme
router.post(
  "/schemes/:id/activate",
  authenticate,
  authorize("incentives.rules.manage"),
  validate(withIdParam()),
  incentivesController.activateScheme
);

// Lifecycle: Pause scheme
router.post(
  "/schemes/:id/pause",
  authenticate,
  authorize("incentives.rules.manage"),
  validate(withIdParam()),
  incentivesController.pauseScheme
);

// Lifecycle: Archive scheme
router.post(
  "/schemes/:id/archive",
  authenticate,
  authorize("incentives.rules.manage"),
  validate(withIdParam()),
  incentivesController.archiveScheme
);

// ---------------------------------------------------------
// SCHEME ASSIGNMENT ROUTES
// ---------------------------------------------------------

// List assignments
router.get(
  "/assignments",
  authenticate,
  authorize(["incentives.view", "incentives.view.all"]),
  validate(listAssignmentsSchema),
  incentivesController.listAssignments
);

// Create assignment under ScopeLock
router.post(
  "/assignments",
  authenticate,
  authorize("incentives.rules.manage"),
  validate(createAssignmentSchema),
  incentivesController.createAssignment
);

// ---------------------------------------------------------
// CALCULATION PREVIEW ROUTE
// ---------------------------------------------------------
router.post(
  "/preview",
  authenticate,
  authorize(["incentives.view", "incentives.view.all", "incentives.rules.manage"]),
  validate(previewCalculationSchema),
  incentivesController.previewCalculation
);

router.post(
  "/attendance-evaluations/compute",
  authenticate,
  requireActiveBranch,
  authorize("incentives.approve"),
  validate(computeAttendanceEvaluationSchema),
  incentivesController.computeAttendanceEvaluation,
);

router.post(
  "/attendance-evaluations/:id/finalize",
  authenticate,
  requireActiveBranch,
  authorize("incentives.approve"),
  validate(finalizeAttendanceEvaluationSchema),
  incentivesController.finalizeAttendanceEvaluation,
);

// ---------------------------------------------------------
// FINANCIAL METRICS & SUMMARY
// ---------------------------------------------------------
router.get(
  "/summary",
  authenticate,
  authorize(["incentives.view", "incentives.view.all"]),
  validate(listSummarySchema),
  incentivesController.getIncentivesSummary
);

// ---------------------------------------------------------
// IMMUTABLE EARNINGS LEDGER ROUTE
// ---------------------------------------------------------
router.get(
  "/ledger",
  authenticate,
  authorize(["incentives.view", "incentives.view.all"]),
  validate(listLedgerSchema),
  incentivesController.listLedgerEntries
);

// ---------------------------------------------------------
// RECOVERY OBLIGATIONS & CLAWBACKS ROUTE
// ---------------------------------------------------------
router.get(
  "/recovery-obligations",
  authenticate,
  requireBranchScope,
  authorize(["incentives.view", "incentives.view.all"]),
  validate(listRecoveryObligationsSchema),
  incentivesController.listRecoveryObligations
);

router.post(
  "/recovery-obligations/:id/payments",
  authenticate,
  requireActiveBranch,
  authorize("payroll.disburse"),
  validate(recordRecoveryPaymentSchema),
  incentivesController.recordRecoveryPayment,
);

router.post(
  "/recovery-obligations/:id/payments/:paymentId/confirm",
  authenticate,
  requireActiveBranch,
  authorize("payroll.disburse"),
  validate(confirmRecoveryPaymentSchema),
  incentivesController.confirmRecoveryPayment,
);

router.post(
  "/recovery-obligations/:id/payments/:paymentId/fail",
  authenticate,
  requireActiveBranch,
  authorize("payroll.disburse"),
  validate(failRecoveryPaymentSchema),
  incentivesController.failRecoveryPayment,
);

router.post(
  "/recovery-obligations/:id/payments/:paymentId/reverse",
  authenticate,
  requireActiveBranch,
  authorize("payroll.reverse"),
  validate(reverseRecoveryPaymentSchema),
  incentivesController.reverseRecoveryPayment,
);

router.post(
  "/fulfillment/confirm",
  authenticate,
  requireActiveBranch,
  authorize("incentives.fulfillment.confirm"),
  validate(confirmWalkInFulfillmentSchema),
  incentivesController.confirmWalkInFulfillment,
);

router.get(
  "/fulfillment",
  authenticate,
  requireActiveBranch,
  authorize([
    "incentives.view",
    "incentives.view.all",
    "incentives.fulfillment.confirm",
  ]),
  validate(listWalkInFulfillmentSchema),
  incentivesController.listWalkInFulfillment,
);

export default router;
