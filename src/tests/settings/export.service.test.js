import { jest } from "@jest/globals";
import mongoose from "mongoose";

const orgId = new mongoose.Types.ObjectId();
const otherOrgId = new mongoose.Types.ObjectId();
const branchId = new mongoose.Types.ObjectId();
const otherBranchId = new mongoose.Types.ObjectId();
const userId = new mongoose.Types.ObjectId();

const mockExportJobModel = {
  find: jest.fn(),
  findOne: jest.fn(),
  create: jest.fn(),
};

const mockAuditLogService = {
  createAuditLog: jest.fn().mockResolvedValue(undefined),
};

const mockStaffModel = { find: jest.fn() };
const mockCustomerModel = { find: jest.fn() };
const mockAppointmentModel = { find: jest.fn() };
const mockAttendanceModel = { find: jest.fn() };
const mockLeaveModel = { find: jest.fn() };

jest.unstable_mockModule("../../models/settings/exportJob.model.js", () => ({
  ExportJob: mockExportJobModel,
  EXPORT_DOMAINS: ["staff", "customers", "appointments", "attendance", "leaves"],
  EXPORT_FORMATS: ["json", "csv"],
  EXPORT_STATUSES: ["pending", "processing", "completed", "failed", "expired"],
}));

jest.unstable_mockModule("../../services/audit/auditLog.service.js", () => ({
  AuditLogService: mockAuditLogService,
}));

jest.unstable_mockModule("../../models/staff/staff.model.js", () => ({
  Staff: mockStaffModel,
}));

jest.unstable_mockModule("../../models/customers/customer.model.js", () => ({
  Customer: mockCustomerModel,
}));

jest.unstable_mockModule("../../models/appointments/appointment.model.js", () => ({
  Appointment: mockAppointmentModel,
}));

jest.unstable_mockModule("../../models/attendance/attendance.model.js", () => ({
  Attendance: mockAttendanceModel,
}));

jest.unstable_mockModule("../../models/leaves/leave.model.js", () => ({
  Leave: mockLeaveModel,
}));

const { ExportService } = await import(
  "../../services/settings/export.service.js"
);

const exportService = new ExportService({
  auditLogService: mockAuditLogService,
  settingsResolver: {
    resolveEffectiveSettings: jest.fn().mockResolvedValue({
      exports: { retentionHours: { value: 24 } },
    }),
  },
});

const chainableLean = (data) => ({
  select: jest.fn().mockReturnThis(),
  sort: jest.fn().mockReturnThis(),
  limit: jest.fn().mockReturnThis(),
  lean: jest.fn().mockResolvedValue(data),
});

describe("ExportService", () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  test("rejects X-Branch-Id: all for export requests", async () => {
    await expect(
      exportService.requestExport({
        organizationId: orgId,
        branchId: "all",
        domain: "staff",
        format: "json",
        user: { id: userId, hasOrgWideAccess: true },
      })
    ).rejects.toMatchObject({
      statusCode: 400,
    });
  });

  test("rejects branch-restricted user requesting another branch", async () => {
    await expect(
      exportService.requestExport({
        organizationId: orgId,
        branchId: otherBranchId.toString(),
        domain: "staff",
        format: "json",
        user: {
          id: userId,
          hasOrgWideAccess: false,
          branchAccess: [{ branchId, isActive: true }],
        },
      })
    ).rejects.toMatchObject({
      statusCode: 403,
    });
  });

  test("returns existing job when idempotencyKey matches", async () => {
    const existingJob = {
      _id: new mongoose.Types.ObjectId(),
      organizationId: orgId,
      domain: "staff",
      format: "json",
      status: "completed",
      idempotencyKey: "idem-123",
    };

    mockExportJobModel.findOne.mockReturnValueOnce({
      lean: jest.fn().mockResolvedValue(existingJob),
    });

    const result = await exportService.requestExport({
      organizationId: orgId,
      branchId: branchId.toString(),
      domain: "staff",
      format: "json",
      idempotencyKey: "idem-123",
      user: { id: userId, hasOrgWideAccess: true },
    });

    expect(result.id).toBe(existingJob._id.toString());
    expect(mockExportJobModel.create).not.toHaveBeenCalled();
  });

  test("creates completed export and logs requested + completed audit events", async () => {
    const jobDoc = {
      _id: new mongoose.Types.ObjectId(),
      organizationId: orgId,
      branchId,
      domain: "staff",
      format: "csv",
      status: "processing",
      save: jest.fn().mockResolvedValue(undefined),
      toObject: jest.fn().mockReturnValue({
        _id: "job-1",
        domain: "staff",
        format: "csv",
        status: "completed",
        recordCount: 1,
      }),
    };

    mockExportJobModel.create.mockResolvedValue(jobDoc);
    mockStaffModel.find.mockReturnValue(
      chainableLean([
        {
          _id: new mongoose.Types.ObjectId(),
          firstName: "Asha",
          lastName: "Rao",
          email: "asha@example.com",
          status: "active",
        },
      ])
    );

    const result = await exportService.requestExport({
      organizationId: orgId,
      branchId: branchId.toString(),
      domain: "staff",
      format: "csv",
      user: { id: userId, hasOrgWideAccess: true },
    });

    expect(result.status).toBe("completed");
    expect(jobDoc.save).toHaveBeenCalled();
    expect(mockAuditLogService.createAuditLog).toHaveBeenCalledWith(
      expect.objectContaining({
        action: "EXPORT_REQUESTED",
      }),
      orgId,
      userId
    );
    expect(mockAuditLogService.createAuditLog).toHaveBeenCalledWith(
      expect.objectContaining({
        action: "EXPORT_COMPLETED",
      }),
      orgId,
      userId
    );
  });

  test("returns 410 and clears payload when downloading an expired export", async () => {
    const expiredJob = {
      _id: new mongoose.Types.ObjectId(),
      organizationId: orgId,
      branchId,
      domain: "staff",
      format: "json",
      status: "completed",
      expiresAt: new Date(Date.now() - 60_000),
      payloadContent: '[{"id":"1"}]',
      save: jest.fn().mockResolvedValue(undefined),
    };

    mockExportJobModel.findOne.mockReturnValue({
      select: jest.fn().mockResolvedValue(expiredJob),
    });

    await expect(
      exportService.downloadExport({
        organizationId: orgId,
        exportId: expiredJob._id.toString(),
        user: { id: userId, hasOrgWideAccess: true },
      })
    ).rejects.toMatchObject({
      statusCode: 410,
    });

    expect(expiredJob.status).toBe("expired");
    expect(expiredJob.payloadContent).toBeNull();
    expect(expiredJob.save).toHaveBeenCalled();
    expect(mockAuditLogService.createAuditLog).toHaveBeenCalledWith(
      expect.objectContaining({
        action: "EXPORT_EXPIRED",
      }),
      orgId,
      userId
    );
  });

  test("enforces tenant isolation on downloadExport", async () => {
    mockExportJobModel.findOne.mockReturnValue({
      select: jest.fn().mockResolvedValue(null),
    });

    await expect(
      exportService.downloadExport({
        organizationId: otherOrgId,
        exportId: new mongoose.Types.ObjectId().toString(),
        user: { id: userId, hasOrgWideAccess: true },
      })
    ).rejects.toMatchObject({
      statusCode: 404,
    });
  });
});
