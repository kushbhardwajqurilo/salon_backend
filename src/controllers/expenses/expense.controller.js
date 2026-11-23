import { ExpenseService } from "../../services/expenses/expense.service.js";
import { asyncHandler, AppError } from "../../utils/errors.js";

export const createExpense = asyncHandler(async (req, res) => {
  const organizationId = req.organizationId;
  const branchId = req.branchId || req.body.branchId;
  if (!branchId) throw new AppError("Branch is required", 400);

  const result = await ExpenseService.createExpense(
    organizationId,
    branchId,
    req.user._id,
    req.body
  );
  res.status(201).json({ success: true, data: result });
});

export const listExpenses = asyncHandler(async (req, res) => {
  const organizationId = req.organizationId;
  const branchId = req.branchId; // Null if organization-wide request

  const result = await ExpenseService.listExpenses(
    organizationId,
    branchId,
    req.query
  );
  res.status(200).json({ success: true, ...result });
});

export const getExpenseById = asyncHandler(async (req, res) => {
  const organizationId = req.organizationId;
  const branchId = req.branchId; // Null if org-wide authorized
  const expenseId = req.params.id;

  const result = await ExpenseService.getExpenseById(
    organizationId,
    expenseId,
    branchId
  );
  res.status(200).json({ success: true, data: result });
});

export const updateExpense = asyncHandler(async (req, res) => {
  const organizationId = req.organizationId;
  const branchId = req.branchId;
  const expenseId = req.params.id;

  const result = await ExpenseService.updateExpense(
    organizationId,
    expenseId,
    branchId,
    req.body
  );
  res.status(200).json({ success: true, data: result });
});

export const approveExpense = asyncHandler(async (req, res) => {
  const organizationId = req.organizationId;
  const branchId = req.branchId;
  const expenseId = req.params.id;

  const result = await ExpenseService.approveExpense(
    organizationId,
    expenseId,
    branchId,
    req.user._id
  );
  res.status(200).json({ success: true, data: result });
});

export const rejectExpense = asyncHandler(async (req, res) => {
  const organizationId = req.organizationId;
  const branchId = req.branchId;
  const expenseId = req.params.id;
  const { reason } = req.body;

  const result = await ExpenseService.rejectExpense(
    organizationId,
    expenseId,
    branchId,
    req.user._id,
    reason
  );
  res.status(200).json({ success: true, data: result });
});

export const deleteExpense = asyncHandler(async (req, res) => {
  const organizationId = req.organizationId;
  const branchId = req.branchId;
  const expenseId = req.params.id;

  const result = await ExpenseService.deleteExpense(
    organizationId,
    expenseId,
    branchId,
    req.user._id
  );
  res.status(200).json(result);
});

export const getExpenseSummary = asyncHandler(async (req, res) => {
  const organizationId = req.organizationId;
  const branchId = req.branchId;
  const { startDate, endDate } = req.query;

  const result = await ExpenseService.getExpenseSummary(
    organizationId,
    branchId,
    startDate,
    endDate
  );
  res.status(200).json({ success: true, data: result });
});

export const getPettyCashBalance = asyncHandler(async (req, res) => {
  const organizationId = req.organizationId;
  const branchId = req.branchId;

  const result = await ExpenseService.getPettyCashBalance(
    organizationId,
    branchId
  );
  res.status(200).json({ success: true, data: result });
});

export const replenishPettyCash = asyncHandler(async (req, res) => {
  const organizationId = req.organizationId;
  const branchId = req.branchId;
  const idempotencyKey =
    req.headers["idempotency-key"] || req.headers["x-idempotency-key"];

  const result = await ExpenseService.replenishPettyCash(
    organizationId,
    branchId,
    req.user._id,
    req.body,
    idempotencyKey
  );
  res.status(201).json({ success: true, data: result });
});

export const recoverPettyCashPayout = asyncHandler(async (req, res) => {
  const organizationId = req.organizationId;
  const branchId = req.branchId;
  const idempotencyKey =
    req.headers["idempotency-key"] || req.headers["x-idempotency-key"];

  const result = await ExpenseService.recoverPettyCashPayout(
    organizationId,
    branchId,
    req.user._id,
    req.body,
    idempotencyKey
  );
  res.status(201).json({ success: true, data: result });
});

export const listPettyCashTransactions = asyncHandler(async (req, res) => {
  const organizationId = req.organizationId;
  const branchId = req.branchId;

  const result = await ExpenseService.listPettyCashTransactions(
    organizationId,
    branchId,
    req.query
  );
  res.status(200).json({ success: true, ...result });
});
