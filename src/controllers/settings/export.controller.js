import { asyncHandler } from "../../utils/errors.js";
import { sendResponse } from "../../utils/response.js";
import { ExportService } from "../../services/settings/export.service.js";

const exportService = new ExportService();

export const listExports = asyncHandler(async (req, res) => {
  const result = await exportService.listExports(req.organizationId, req.branchId || null, req.user);
  return sendResponse(res, 200, "Export jobs retrieved successfully", result);
});

export const requestExport = asyncHandler(async (req, res) => {
  const idempotencyKey =
    req.headers["idempotency-key"] ||
    req.headers["x-idempotency-key"] ||
    req.body.idempotencyKey ||
    null;

  const result = await exportService.requestExport({
    organizationId: req.organizationId,
    branchId: req.branchId || null,
    domain: req.body.domain,
    format: req.body.format,
    idempotencyKey,
    user: req.user,
  });
  return sendResponse(res, 201, "Export job completed", result);
});

export const downloadExport = asyncHandler(async (req, res) => {
  const file = await exportService.downloadExport({
    organizationId: req.organizationId,
    exportId: req.params.id,
    user: req.user,
  });
  res.setHeader("Content-Type", file.contentType);
  res.setHeader("Content-Disposition", `attachment; filename="${file.filename}"`);
  return res.status(200).send(file.content);
});

export const getBackupStatus = asyncHandler(async (_req, res) => {
  return sendResponse(res, 200, "Backup infrastructure boundary status", {
    platformBackupsManagedByInfrastructure: true,
    organizationDatabaseDumpAvailable: false,
    message:
      "Full database backups are managed at the infrastructure/platform-admin level. Organization administrators can use Data Exports for tenant-scoped portability.",
  });
});
