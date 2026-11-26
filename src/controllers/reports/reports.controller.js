import { asyncHandler } from "../../utils/errors.js";
import { sendResponse } from "../../utils/response.js";
import { reportsService } from "../../services/reports/reports.service.js";
import { AuditLogService, extractAuditContext } from "../../services/audit/auditLog.service.js";
import { AUDIT_ACTIONS } from "../../models/audit/auditLog.model.js";

const auditLogService = new AuditLogService();

export const getReportsOverview = asyncHandler(async (req, res) => {
  const organizationId = req.organizationId;
  const branchId = req.branchId;
  const userPermissions = req.user?.permissions || [];
  const result = await reportsService.getReportsOverview(
    organizationId,
    branchId,
    req.query,
    userPermissions
  );
  return sendResponse(res, 200, "Reports overview retrieved successfully", result);
});

export const getRevenueReport = asyncHandler(async (req, res) => {
  const organizationId = req.organizationId;
  const branchId = req.branchId;
  const result = await reportsService.getRevenueReport(
    organizationId,
    branchId,
    req.query
  );
  return sendResponse(res, 200, "Revenue report retrieved successfully", result);
});

export const getStaffPerformanceReport = asyncHandler(async (req, res) => {
  const organizationId = req.organizationId;
  const branchId = req.branchId;
  const result = await reportsService.getStaffPerformanceReport(
    organizationId,
    branchId,
    req.query
  );
  return sendResponse(res, 200, "Staff performance report retrieved successfully", result);
});

export const getCustomerRetentionReport = asyncHandler(async (req, res) => {
  const organizationId = req.organizationId;
  const branchId = req.branchId;
  const userPermissions = req.user?.permissions || [];
  const result = await reportsService.getCustomerRetentionReport(
    organizationId,
    branchId,
    req.query,
    userPermissions
  );
  return sendResponse(res, 200, "Customer retention report retrieved successfully", result);
});

export const getServiceAnalyticsReport = asyncHandler(async (req, res) => {
  const organizationId = req.organizationId;
  const branchId = req.branchId;
  const result = await reportsService.getServiceAnalyticsReport(
    organizationId,
    branchId,
    req.query
  );
  return sendResponse(res, 200, "Service analytics report retrieved successfully", result);
});

export const getInventoryReport = asyncHandler(async (req, res) => {
  const organizationId = req.organizationId;
  const branchId = req.branchId;
  const result = await reportsService.getInventoryReport(
    organizationId,
    branchId,
    req.query
  );
  return sendResponse(res, 200, "Inventory report retrieved successfully", result);
});

export const exportReportCSV = asyncHandler(async (req, res) => {
  const organizationId = req.organizationId;
  const branchId = req.branchId;
  const reportType = req.params.reportType;
  const userPermissions = req.user?.permissions || [];

  const csv = await reportsService.exportReportCSV(
    organizationId,
    branchId,
    reportType,
    req.query,
    userPermissions
  );

  await auditLogService
    .createAuditLog(
      {
        action: AUDIT_ACTIONS.SENSITIVE_DATA_EXPORTED,
        entityType: "Report",
        entityId: null,
        branchId: branchId || null,
        description: `Report CSV exported (${reportType})`,
        ...extractAuditContext(req),
        metadata: { reportType, startDate: req.query.startDate, endDate: req.query.endDate, format: "csv" },
      },
      organizationId,
      req.user?._id || req.user?.id || null
    )
    .catch(() => {});

  res.setHeader("Content-Type", "text/csv");
  res.setHeader(
    "Content-Disposition",
    `attachment; filename="${reportType}-report-${req.query.startDate}-to-${req.query.endDate}.csv"`
  );
  return res.status(200).send(csv);
});
