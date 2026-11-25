import mongoose from "mongoose";
import { ExportJob } from "../../models/settings/exportJob.model.js";
import { Staff } from "../../models/staff/staff.model.js";
import { Customer } from "../../models/customers/customer.model.js";
import { Appointment } from "../../models/appointments/appointment.model.js";
import { Attendance } from "../../models/attendance/attendance.model.js";
import { Leave } from "../../models/leaves/leave.model.js";
import { SettingsResolverService } from "./settingsResolver.service.js";
import { AuditLogService } from "../audit/auditLog.service.js";
import { AppError } from "../../utils/errors.js";

function toCsv(rows) {
  if (!Array.isArray(rows) || rows.length === 0) return "";
  const headers = Object.keys(rows[0]);
  const escape = (val) => {
    const str = val === null || val === undefined ? "" : String(val);
    return `"${str.replace(/"/g, '""')}"`;
  };
  const lines = [headers.join(",")];
  for (const row of rows) {
    lines.push(headers.map((h) => escape(row[h])).join(","));
  }
  return lines.join("\n");
}

export class ExportService {
  constructor(deps = {}) {
    this.settingsResolver = deps.settingsResolver || new SettingsResolverService();
    this.auditLogService = deps.auditLogService || new AuditLogService();
  }

  assertScopeAuthorized(user, branchId) {
    if (branchId === "all") {
      throw new AppError("Invalid branch scope 'all'", 400);
    }
    if (branchId) {
      if (!mongoose.Types.ObjectId.isValid(branchId)) {
        throw new AppError("Invalid branch ID format", 400);
      }
      if (user?.hasOrgWideAccess === true) return;
      const allowed = (user?.branchAccess || []).some(
        (b) => b.branchId?.toString() === branchId.toString() && b.isActive
      );
      if (!allowed) {
        throw new AppError("Access denied. You do not have access to this branch.", 403);
      }
    } else if (!user?.hasOrgWideAccess) {
      throw new AppError("Organization-wide access is required for organization-wide exports", 403);
    }
  }

  toDTO(doc) {
    return {
      id: doc._id.toString(),
      organizationId: doc.organizationId.toString(),
      branchId: doc.branchId ? doc.branchId.toString() : null,
      domain: doc.domain,
      format: doc.format,
      status: doc.status,
      recordCount: doc.recordCount ?? 0,
      expiresAt: doc.expiresAt ? doc.expiresAt.toISOString() : null,
      completedAt: doc.completedAt ? doc.completedAt.toISOString() : null,
      errorMessage: doc.errorMessage ?? null,
      createdAt: doc.createdAt ? doc.createdAt.toISOString() : null,
    };
  }

  async listExports(organizationId, branchId, user) {
    this.assertScopeAuthorized(user, branchId);
    const filter = { organizationId };
    if (branchId) filter.branchId = branchId;

    const docs = await ExportJob.find(filter).sort({ createdAt: -1 }).limit(50).lean();
    return docs.map((d) => this.toDTO(d));
  }

  async fetchDomainRows({ organizationId, branchId, domain }) {
    const scope = {
      organizationId,
      isDeleted: { $ne: true },
      ...(branchId ? { branchId } : {}),
    };

    switch (domain) {
      case "staff":
        return Staff.find({ organizationId, isDeleted: { $ne: true } })
          .select("staffCode name email phone designation status joiningDate")
          .lean();
      case "customers":
        return Customer.find(scope).select("customerCode name phone email gender createdAt").lean();
      case "appointments":
        return Appointment.find(scope)
          .select("appointmentCode appointmentDate startTime endTime status totalDuration")
          .lean();
      case "attendance":
        return Attendance.find(scope).select("staffId attendanceDate status isReconciled").lean();
      case "leaves":
        return Leave.find(scope)
          .select("leaveCode leaveType startDate endDate status isUnpaid paidDays unpaidDays")
          .lean();
      default:
        throw new AppError(`Unsupported export domain: ${domain}`, 400);
    }
  }

  async requestExport({ organizationId, branchId = null, domain, format = "csv", idempotencyKey = null, user }) {
    this.assertScopeAuthorized(user, branchId);

    if (idempotencyKey) {
      const existing = await ExportJob.findOne({ organizationId, idempotencyKey }).lean();
      if (existing) {
        return this.toDTO(existing);
      }
    }

    const effective = await this.settingsResolver.resolveEffectiveSettings(organizationId, branchId);
    const retentionHours = effective?.exports?.retentionHours?.value ?? 24;
    const expiresAt = new Date(Date.now() + retentionHours * 60 * 60 * 1000);

    const job = await ExportJob.create({
      organizationId,
      branchId: branchId || null,
      requestedBy: user.id,
      domain,
      format,
      status: "processing",
      idempotencyKey: idempotencyKey || null,
      expiresAt,
    });

    await this.auditLogService.createAuditLog(
      {
        entityType: "ExportJob",
        entityId: job._id,
        action: "EXPORT_REQUESTED",
        description: `Export requested for ${domain} (${format})`,
        metadata: { domain, format, branchId: branchId ? branchId.toString() : null },
        branchId: branchId || null,
        actorId: user.id,
      },
      organizationId,
      user.id
    );

    try {
      const rawRows = await this.fetchDomainRows({ organizationId, branchId, domain });
      const sanitized = rawRows.map((r) => {
        const copy = { ...r, id: r._id?.toString() };
        delete copy._id;
        return copy;
      });
      const content = format === "json" ? JSON.stringify(sanitized, null, 2) : toCsv(sanitized);

      job.status = "completed";
      job.recordCount = sanitized.length;
      job.payloadContent = content;
      job.completedAt = new Date();
      await job.save();

      await this.auditLogService.createAuditLog(
        {
          entityType: "ExportJob",
          entityId: job._id,
          action: "EXPORT_COMPLETED",
          description: `Export completed for ${domain} (${sanitized.length} records)`,
          metadata: { domain, format, recordCount: sanitized.length },
          branchId: branchId || null,
          actorId: user.id,
        },
        organizationId,
        user.id
      );

      return this.toDTO(job);
    } catch (error) {
      job.status = "failed";
      job.errorMessage = error.message || "Export generation failed";
      await job.save();

      await this.auditLogService.createAuditLog(
        {
          entityType: "ExportJob",
          entityId: job._id,
          action: "EXPORT_FAILED",
          description: `Export failed for ${domain}`,
          metadata: { domain, format, error: job.errorMessage },
          branchId: branchId || null,
          actorId: user.id,
        },
        organizationId,
        user.id
      );

      throw error;
    }
  }

  async downloadExport({ organizationId, exportId, user }) {
    const job = await ExportJob.findOne({ _id: exportId, organizationId }).select("+payloadContent");
    if (!job) {
      throw new AppError("Export job not found", 404);
    }

    this.assertScopeAuthorized(user, job.branchId ? job.branchId.toString() : null);

    if (job.status === "expired" || (job.expiresAt && job.expiresAt.getTime() < Date.now())) {
      if (job.status !== "expired") {
        job.status = "expired";
        job.payloadContent = null;
        await job.save();
        await this.auditLogService.createAuditLog(
          {
            entityType: "ExportJob",
            entityId: job._id,
            action: "EXPORT_EXPIRED",
            description: `Export ${job.domain} expired and payload cleared`,
            metadata: { domain: job.domain },
            branchId: job.branchId,
            actorId: user.id,
          },
          organizationId,
          user.id
        );
      }
      throw new AppError("Export file has expired and is no longer available", 410);
    }

    if (job.status !== "completed" || job.payloadContent === null) {
      throw new AppError("Export is not ready for download", 409);
    }

    await this.auditLogService.createAuditLog(
      {
        entityType: "ExportJob",
        entityId: job._id,
        action: "EXPORT_DOWNLOADED",
        description: `Export ${job.domain} (${job.format}) downloaded`,
        metadata: { domain: job.domain, format: job.format, recordCount: job.recordCount },
        branchId: job.branchId,
        actorId: user.id,
      },
      organizationId,
      user.id
    );

    return {
      filename: `${job.domain}-export-${job._id}.${job.format}`,
      contentType: job.format === "json" ? "application/json" : "text/csv",
      content: job.payloadContent,
    };
  }
}
