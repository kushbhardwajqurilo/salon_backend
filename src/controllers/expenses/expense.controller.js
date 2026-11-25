import { ExpenseService } from "../../services/expenses/expense.service.js";
import { asyncHandler, AppError } from "../../utils/errors.js";
import { AuditLogService, extractAuditContext } from "../../services/audit/auditLog.service.js";
import { AUDIT_ACTIONS } from "../../models/audit/auditLog.model.js";

const auditLogService = new AuditLogService();

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
  await auditLogService.createAuditLog(
    {
      action: AUDIT_ACTIONS.EXPENSE_CREATED,
      entityType: "Expense",
      entityId: result._id || result.id,
      branchId,
      description: `Expense created for amount ${result.amount}`,
      ...extractAuditContext(req),
      metadata: { amount: result.amount, category: result.category, paymentMethod: result.paymentMethod },
    },
    organizationId,
    req.user._id
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
  await auditLogService.createAuditLog(
    {
      action: AUDIT_ACTIONS.EXPENSE_UPDATED,
      entityType: "Expense",
      entityId: expenseId,
      branchId: result?.branchId || branchId || null,
      description: `Expense updated`,
      ...extractAuditContext(req),
      metadata: { updatedFields: Object.keys(req.body || {}) },
    },
    organizationId,
    req.user._id
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
  await auditLogService.createAuditLog(
    {
      action: AUDIT_ACTIONS.EXPENSE_APPROVED,
      entityType: "Expense",
      entityId: expenseId,
      branchId: result?.branchId || branchId || null,
      description: `Expense approved`,
      ...extractAuditContext(req),
      metadata: { amount: result?.amount, status: result?.status },
    },
    organizationId,
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
  await auditLogService.createAuditLog(
    {
      action: AUDIT_ACTIONS.EXPENSE_REJECTED,
      entityType: "Expense",
      entityId: expenseId,
      branchId: result?.branchId || branchId || null,
      description: `Expense rejected`,
      ...extractAuditContext(req),
      metadata: { reason, status: result?.status },
    },
    organizationId,
    req.user._id
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
  await auditLogService.createAuditLog(
    {
      action: AUDIT_ACTIONS.EXPENSE_DELETED,
      entityType: "Expense",
      entityId: expenseId,
      branchId: branchId || null,
      description: `Expense deleted`,
      ...extractAuditContext(req),
    },
    organizationId,
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
