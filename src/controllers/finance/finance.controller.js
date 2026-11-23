import { FinanceService } from "../../services/finance/finance.service.js";
import { asyncHandler, AppError } from "../../utils/errors.js";

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
  const { startDate, endDate } = req.query;

  const result = await FinanceService.getBranchPerformance(
    organizationId,
    branchId,
    startDate,
    endDate
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

  res.setHeader("Content-Type", "text/csv");
  res.setHeader(
    "Content-Disposition",
    `attachment; filename="${result.filename}"`
  );
  res.status(200).send(result.data);
});
