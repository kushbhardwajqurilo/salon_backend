import { Router } from "express";
import { authenticate } from "../../middleware/auth.js";
import {
  requireBranchScope,
  requireOrganizationScope,
  requireActiveBranch,
} from "../../middleware/branchScope.js";
import { authorize } from "../../middleware/rbac.js";
import { validate } from "../../middleware/validate.js";
import * as expenseController from "../../controllers/expenses/expense.controller.js";
import * as expenseValidation from "../../validation/expenses/expense.validation.js";

const router = Router();

router.use(authenticate);
router.use(requireOrganizationScope);

// ==========================================
// Petty Cash Drawer Endpoints (Branch Scoped)
// ==========================================
router.get(
  "/petty-cash/balance",
  requireActiveBranch,
  authorize("expenses.view"),
  expenseController.getPettyCashBalance
);

router.post(
  "/petty-cash/replenish",
  requireActiveBranch,
  authorize("expenses.create"),
  validate(expenseValidation.replenishPettyCashSchema),
  expenseController.replenishPettyCash
);

router.post(
  "/petty-cash/recover-payout",
  requireActiveBranch,
  authorize("expenses.create"),
  validate(expenseValidation.recoverPettyCashPayoutSchema),
  expenseController.recoverPettyCashPayout
);

router.get(
  "/petty-cash/transactions",
  requireActiveBranch,
  authorize("expenses.view"),
  expenseController.listPettyCashTransactions
);

// ==========================================
// Expense Records & Summaries
// ==========================================
router.get(
  "/summary",
  requireBranchScope,
  authorize("expenses.view"),
  expenseController.getExpenseSummary
);

router.get(
  "/",
  requireBranchScope,
  authorize("expenses.view"),
  validate(expenseValidation.listExpensesQuerySchema),
  expenseController.listExpenses
);

router.get(
  "/:id",
  requireBranchScope,
  authorize("expenses.view"),
  expenseController.getExpenseById
);

router.post(
  "/",
  requireActiveBranch,
  authorize("expenses.create"),
  validate(expenseValidation.createExpenseSchema),
  expenseController.createExpense
);

router.put(
  "/:id",
  requireActiveBranch,
  authorize("expenses.update"),
  validate(expenseValidation.updateExpenseSchema),
  expenseController.updateExpense
);

router.patch(
  "/:id/approve",
  requireActiveBranch,
  authorize("expenses.update"),
  expenseController.approveExpense
);

router.patch(
  "/:id/reject",
  requireActiveBranch,
  authorize("expenses.update"),
  validate(expenseValidation.rejectExpenseSchema),
  expenseController.rejectExpense
);

router.delete(
  "/:id",
  requireActiveBranch,
  authorize("expenses.delete"),
  expenseController.deleteExpense
);

export default router;
