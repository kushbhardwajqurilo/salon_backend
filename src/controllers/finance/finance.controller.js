import { FinanceService } from "../../services/finance/finance.service.js";
import { asyncHandler, AppError } from "../../utils/errors.js";
import { AuditLogService, extractAuditContext } from "../../services/audit/auditLog.service.js";
import { AUDIT_ACTIONS } from "../../models/audit/auditLog.model.js";

const auditLogService = new AuditLogService();

export const getSystemTotals = asyncHandler(async (req, res) => {
  const organizationId = req.organizationId;
  const branchId = req.branchId;
  const { businessDate } = req.query;

  const result = await FinanceService.getSystemTotals(
    organizationId,
    branchId,
    businessDate
  );
  res.status(200).json({ success: true, data: result });
});

export const submitDayClosure = asyncHandler(async (req, res) => {
  const organizationId = req.organizationId;
  const branchId = req.branchId;

  const result = await FinanceService.submitDayClosure(
    organizationId,
    branchId,
    req.user._id,
    req.body
  );
  await auditLogService.createAuditLog(
    {
      action: AUDIT_ACTIONS.CASH_REGISTER_CLOSED,
      entityType: "DayClosure",
      entityId: result._id || result.id,
      branchId: branchId || null,
      description: `Day closure submitted`,
      ...extractAuditContext(req),
      metadata: { businessDate: req.body?.businessDate },
    },
    organizationId,
    req.user._id
  );
  res.status(201).json({ success: true, data: result });
});

export const approveDayClosure = asyncHandler(async (req, res) => {
  const organizationId = req.organizationId;
  const branchId = req.branchId;
  const closureId = req.params.id;
  const { managerNotes } = req.body;

  const result = await FinanceService.approveDayClosure(
    organizationId,
    closureId,
    branchId,
    req.user._id,
    managerNotes
  );
  await auditLogService.createAuditLog(
    {
      action: AUDIT_ACTIONS.FINANCE_RECONCILED,
      entityType: "DayClosure",
      entityId: closureId,
      branchId: result?.branchId || branchId || null,
      description: `Day closure approved and reconciled`,
      ...extractAuditContext(req),
      metadata: { managerNotes },
    },
    organizationId,
    req.user._id
  );
  res.status(200).json({ success: true, data: result });
});

export const listDayClosures = asyncHandler(async (req, res) => {
  const organizationId = req.organizationId;
  const branchId = req.branchId;

  const result = await FinanceService.listDayClosures(
    organizationId,
    branchId,
    req.query
  );
  res.status(200).json({ success: true, ...result });
});

export const getDayClosureById = asyncHandler(async (req, res) => {
  const organizationId = req.organizationId;
  const branchId = req.branchId;
  const closureId = req.params.id;

  const result = await FinanceService.getDayClosureById(
    organizationId,
    closureId,
    branchId
  );
  res.status(200).json({ success: true, data: result });
});

export const getOperatingProfit = asyncHandler(async (req, res) => {
  const organizationId = req.organizationId;
  const branchId = req.branchId; // Null for organization-wide view
  const { startDate, endDate } = req.query;

  const result = await FinanceService.getOperatingProfit(
    organizationId,
    branchId,
    startDate,
    endDate
  );
  res.status(200).json({ success: true, data: result });
});

export const getFinancialAlertsAndObligations = asyncHandler(async (req, res) => {
  const organizationId = req.organizationId;
  const branchId = req.branchId;

  const result = await FinanceService.getFinancialAlertsAndObligations(
    organizationId,
    branchId
  );
  res.status(200).json({ success: true, data: result });
});

export const getBranchPerformance = asyncHandler(async (req, res) => {
  const organizationId = req.organizationId;
  const branchId = req.branchId; // Undefined if authorized for org-wide view
  const { startDate, endDate, page, limit } = req.query;

  const result = await FinanceService.getBranchPerformance(
    organizationId,
    branchId,
    startDate,
    endDate,
    { page, limit }
  );
  res.status(200).json({ success: true, data: result });
});

export const getTransactions = asyncHandler(async (req, res) => {
  const organizationId = req.organizationId;
  const branchId = req.branchId;

  const result = await FinanceService.getTransactions(
    organizationId,
    branchId,
    req.query
  );
  res.status(200).json({ success: true, ...result });
});

export const getAuditHistory = asyncHandler(async (req, res) => {
  const organizationId = req.organizationId;
  const branchId = req.branchId;

  const result = await FinanceService.getAuditHistory(
    organizationId,
    branchId,
    req.query
  );
  res.status(200).json({ success: true, ...result });
});

export const getFinancialReports = asyncHandler(async (req, res) => {
  const organizationId = req.organizationId;
  const branchId = req.branchId;

  const result = await FinanceService.getFinancialReports(
    organizationId,
    branchId,
    { ...req.query, format: "json" }
  );
  res.status(200).json({ success: true, data: result.data });
});

export const exportFinancialReport = asyncHandler(async (req, res) => {
  const organizationId = req.organizationId;
  const branchId = req.branchId;

  const result = await FinanceService.getFinancialReports(
    organizationId,
    branchId,
    { ...req.query, format: "csv" }
  );

  await auditLogService.createAuditLog(
    {
      action: AUDIT_ACTIONS.SENSITIVE_DATA_EXPORTED,
      entityType: "FinancialReport",
      entityId: null,
      branchId: branchId || null,
      description: `Financial report exported (${result.filename})`,
      ...extractAuditContext(req),
      metadata: { filename: result.filename, format: "csv" },
    },
    organizationId,
    req.user._id
  );

  res.setHeader("Content-Type", "text/csv");
  res.setHeader(
    "Content-Disposition",
    `attachment; filename="${result.filename}"`
  );
  res.status(200).send(result.data);
});
