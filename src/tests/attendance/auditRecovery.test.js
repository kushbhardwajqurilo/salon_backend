import { describe, expect, it, beforeAll, afterAll, beforeEach, jest } from "@jest/globals";
import mongoose from "mongoose";
import { getIsolatedTestMongoUri } from "../testSetup.js";
import { Organization } from "../../models/organizations/organization.model.js";
import { Branch } from "../../models/branches/branch.model.js";
import { Staff } from "../../models/staff/staff.model.js";
import { Attendance } from "../../models/attendance/attendance.model.js";
import { AttendanceBranchConflict } from "../../models/attendance/AttendanceLeaveAppointmentConflict.model.js";
import { AuditLog } from "../../models/audit/auditLog.model.js";
import {
  recoverReconciliationAuditLog,
  deriveBusinessDate,
} from "../../services/attendance/attendance.service.js";

describe("Attendance Reconciliation Audit Recovery Idempotency", () => {
  jest.setTimeout(30000);

  let orgId;
  let branch;
  let staff;
  let todayStr;

  beforeAll(async () => {
    const mongoUri = getIsolatedTestMongoUri("audit_test");
    if (mongoose.connection.readyState === 0) {
      await mongoose.connect(mongoUri);
    }
    await AuditLog.syncIndexes();

    const org = await Organization.create({
      name: `Audit Recovery Test Org ${Date.now()}`,
      currency: "INR",
    });
    orgId = org._id;

    branch = await Branch.create({
      organizationId: orgId,
      name: "Main Branch",
      code: `MB-${Date.now()}`,
      timezone: "Asia/Kolkata",
    });

    staff = await Staff.create({
      organizationId: orgId,
      name: "Audit Recovery Staff",
      firstName: "Audit",
      lastName: "Staff",
      staffCode: `STF-${Date.now()}`,
      designation: "Stylist",
      email: `audit.recovery.${Date.now()}@example.com`,
      phone: `98765${Math.floor(Math.random() * 90000 + 10000)}`,
      joiningDate: new Date(),
      status: "active",
      employmentType: "full_time",
    });

    todayStr = deriveBusinessDate(new Date(), "Asia/Kolkata");
  });

  afterAll(async () => {
    if (mongoose.connection.readyState !== 0) {
      await AuditLog.deleteMany({ organizationId: orgId });
      await AttendanceBranchConflict.deleteMany({ organizationId: orgId });
      await Attendance.deleteMany({ organizationId: orgId });
      await Staff.deleteMany({ organizationId: orgId });
      await Branch.deleteMany({ organizationId: orgId });
      await Organization.deleteMany({ _id: orgId });
      await mongoose.connection.close();
    }
  });

  beforeEach(async () => {
    await AuditLog.deleteMany({ organizationId: orgId });
    await AttendanceBranchConflict.deleteMany({ organizationId: orgId });
    await Attendance.deleteMany({ organizationId: orgId });
  });

  it("1. First recovery creates exactly one audit event with correct schema fields", async () => {
    const actorId = new mongoose.Types.ObjectId();
    const resolvedAt = new Date();

    const conflict = await AttendanceBranchConflict.create({
      organizationId: orgId,
      staffId: staff._id,
      primaryBranchId: branch._id,
      date: todayStr,
      conflictStatus: "resolved",
      resolution: "retain",
      reason: "Manager reconciled manually",
      resolvedBy: actorId,
      resolvedAt,
      branchesInvolved: [{ branchId: branch._id }],
      isActive: true,
    });

    await Attendance.create({
      organizationId: orgId,
      branchId: branch._id,
      staffId: staff._id,
      attendanceDate: new Date(`${todayStr}T00:00:00.000Z`),
      status: "present",
      isReconciled: true,
      reconciliationReason: "Manager reconciled manually",
      reconciledBy: actorId,
      reconciledAt: resolvedAt,
    });

    const auditRecord = await recoverReconciliationAuditLog({
      organizationId: orgId,
      branchId: branch._id,
      actorId,
      conflictId: conflict._id,
      expectedResolvedAt: resolvedAt,
      expectedResolvedBy: actorId,
    });

    expect(auditRecord).toBeDefined();
    expect(auditRecord.action).toBe("ATTENDANCE_CONFLICT_RESOLVED");
    expect(auditRecord.entityType).toBe("AttendanceBranchConflict");
    expect(auditRecord.entityId.toString()).toBe(conflict._id.toString());
    expect(auditRecord.actorId.toString()).toBe(actorId.toString());
    expect(auditRecord.metadata.idempotencyKey).toBeDefined();

    const auditCount = await AuditLog.countDocuments({
      organizationId: orgId,
      entityId: conflict._id,
      action: "ATTENDANCE_CONFLICT_RESOLVED",
    });
    expect(auditCount).toBe(1);
  });

  it("2. Repeating recovery creates no duplicate audit records (idempotent)", async () => {
    const actorId = new mongoose.Types.ObjectId();
    const resolvedAt = new Date();

    const conflict = await AttendanceBranchConflict.create({
      organizationId: orgId,
      staffId: staff._id,
      primaryBranchId: branch._id,
      date: todayStr,
      conflictStatus: "resolved",
      resolution: "retain",
      reason: "Reconciled cross branch",
      resolvedBy: actorId,
      resolvedAt,
      branchesInvolved: [{ branchId: branch._id }],
      isActive: true,
    });

    await Attendance.create({
      organizationId: orgId,
      branchId: branch._id,
      staffId: staff._id,
      attendanceDate: new Date(`${todayStr}T00:00:00.000Z`),
      status: "present",
      isReconciled: true,
      reconciliationReason: "Reconciled cross branch",
      reconciledBy: actorId,
      reconciledAt: resolvedAt,
    });

    // First recovery run
    const audit1 = await recoverReconciliationAuditLog({
      organizationId: orgId,
      branchId: branch._id,
      actorId,
      conflictId: conflict._id,
    });

    // Second recovery run
    const audit2 = await recoverReconciliationAuditLog({
      organizationId: orgId,
      branchId: branch._id,
      actorId,
      conflictId: conflict._id,
    });

    expect(audit1._id.toString()).toBe(audit2._id.toString());

    const totalAudits = await AuditLog.countDocuments({
      organizationId: orgId,
      entityId: conflict._id,
      action: "ATTENDANCE_CONFLICT_RESOLVED",
    });
    expect(totalAudits).toBe(1);
  });

  it("3. Two concurrent recovery attempts create exactly one event without race conditions", async () => {
    const actorId = new mongoose.Types.ObjectId();
    const resolvedAt = new Date();

    const conflict = await AttendanceBranchConflict.create({
      organizationId: orgId,
      staffId: staff._id,
      primaryBranchId: branch._id,
      date: todayStr,
      conflictStatus: "resolved",
      resolution: "retain",
      reason: "Concurrent recovery target",
      resolvedBy: actorId,
      resolvedAt,
      branchesInvolved: [{ branchId: branch._id }],
      isActive: true,
    });

    await Attendance.create({
      organizationId: orgId,
      branchId: branch._id,
      staffId: staff._id,
      attendanceDate: new Date(`${todayStr}T00:00:00.000Z`),
      status: "present",
      isReconciled: true,
      reconciledBy: actorId,
      reconciledAt: resolvedAt,
    });

    // Launch two simultaneous recovery operations
    const [res1, res2] = await Promise.all([
      recoverReconciliationAuditLog({
        organizationId: orgId,
        branchId: branch._id,
        actorId,
        conflictId: conflict._id,
      }),
      recoverReconciliationAuditLog({
        organizationId: orgId,
        branchId: branch._id,
        actorId,
        conflictId: conflict._id,
      }),
    ]);

    expect(res1).toBeDefined();
    expect(res2).toBeDefined();
    expect(res1._id.toString()).toBe(res2._id.toString());

    const auditCount = await AuditLog.countDocuments({
      organizationId: orgId,
      entityId: conflict._id,
      action: "ATTENDANCE_CONFLICT_RESOLVED",
    });
    expect(auditCount).toBe(1);
  });

  it("4. An existing matching audit event is preserved and returned", async () => {
    const actorId = new mongoose.Types.ObjectId();
    const resolvedAt = new Date();

    const conflict = await AttendanceBranchConflict.create({
      organizationId: orgId,
      staffId: staff._id,
      primaryBranchId: branch._id,
      date: todayStr,
      conflictStatus: "resolved",
      resolution: "retain",
      reason: "Existing audit test",
      resolvedBy: actorId,
      resolvedAt,
      branchesInvolved: [{ branchId: branch._id }],
      isActive: true,
    });

    await Attendance.create({
      organizationId: orgId,
      branchId: branch._id,
      staffId: staff._id,
      attendanceDate: new Date(`${todayStr}T00:00:00.000Z`),
      status: "present",
      isReconciled: true,
      reconciledBy: actorId,
      reconciledAt: resolvedAt,
    });

    // Pre-existing original audit created without an idempotency key
    const preExistingAudit = await AuditLog.create({
      organizationId: orgId,
      branchId: branch._id,
      actorId,
      action: "ATTENDANCE_CONFLICT_RESOLVED",
      entityType: "AttendanceBranchConflict",
      entityId: conflict._id,
      description: "Pre-existing original reconciliation audit event without an idempotency key.",
      metadata: {
        reason: "Original reconciliation",
        resolution: "retain",
        date: conflict.date,
      },
    });

    const result = await recoverReconciliationAuditLog({
      organizationId: orgId,
      branchId: branch._id,
      actorId,
      conflictId: conflict._id,
    });

    expect(result._id.toString()).toBe(preExistingAudit._id.toString());
    expect(result.description).toBe("Pre-existing original reconciliation audit event without an idempotency key.");

    const count = await AuditLog.countDocuments({
      organizationId: orgId,
      entityId: conflict._id,
      action: "ATTENDANCE_CONFLICT_RESOLVED",
    });
    expect(count).toBe(1);
  });

  it("5. An unrelated database failure is surfaced rather than treated as an existing event", async () => {
    const actorId = new mongoose.Types.ObjectId();
    const resolvedAt = new Date();

    const conflict = await AttendanceBranchConflict.create({
      organizationId: orgId,
      staffId: staff._id,
      primaryBranchId: branch._id,
      date: todayStr,
      conflictStatus: "resolved",
      resolution: "retain",
      reason: "Error propagation test",
      resolvedBy: actorId,
      resolvedAt,
      branchesInvolved: [{ branchId: branch._id }],
      isActive: true,
    });

    await Attendance.create({
      organizationId: orgId,
      branchId: branch._id,
      staffId: staff._id,
      attendanceDate: new Date(`${todayStr}T00:00:00.000Z`),
      status: "present",
      isReconciled: true,
      reconciledBy: actorId,
      reconciledAt: resolvedAt,
    });

    // Mock findOneAndUpdate to throw an unrelated DB error (e.g. disk write failure, code 50)
    jest.spyOn(AuditLog, "findOneAndUpdate").mockRejectedValueOnce(
      new Error("MongoServerError: disk full or connection terminated")
    );

    await expect(
      recoverReconciliationAuditLog({
        organizationId: orgId,
        branchId: branch._id,
        actorId,
        conflictId: conflict._id,
      })
    ).rejects.toThrow("disk full or connection terminated");

    AuditLog.findOneAndUpdate.mockRestore();
  });

  it("6. Recovery does not create an audit event when document-state validation fails", async () => {
    const actorId = new mongoose.Types.ObjectId();

    // Conflict is still pending (not resolved)
    const pendingConflict = await AttendanceBranchConflict.create({
      organizationId: orgId,
      staffId: staff._id,
      primaryBranchId: branch._id,
      date: todayStr,
      conflictStatus: "pending",
      branchesInvolved: [{ branchId: branch._id }],
      isActive: true,
    });

    await Attendance.create({
      organizationId: orgId,
      branchId: branch._id,
      staffId: staff._id,
      attendanceDate: new Date(`${todayStr}T00:00:00.000Z`),
      status: "present",
      isReconciled: false,
    });

    // Must reject because conflictStatus is 'pending'
    await expect(
      recoverReconciliationAuditLog({
        organizationId: orgId,
        branchId: branch._id,
        actorId,
        conflictId: pendingConflict._id,
      })
    ).rejects.toThrow("Cannot recover audit log for an unresolved or pending branch conflict.");

    // Verify 0 audit records were created
    const count = await AuditLog.countDocuments({
      organizationId: orgId,
      entityId: pendingConflict._id,
    });
    expect(count).toBe(0);

    // Now test where conflict is resolved but daily Attendance is NOT reconciled
    pendingConflict.conflictStatus = "resolved";
    pendingConflict.resolvedAt = new Date();
    pendingConflict.resolvedBy = actorId;
    await pendingConflict.save();

    await expect(
      recoverReconciliationAuditLog({
        organizationId: orgId,
        branchId: branch._id,
        actorId,
        conflictId: pendingConflict._id,
      })
    ).rejects.toThrow("Cannot recover audit log because daily Attendance record is not reconciled.");

    const count2 = await AuditLog.countDocuments({
      organizationId: orgId,
      entityId: pendingConflict._id,
    });
    expect(count2).toBe(0);
  });

  it("7. Historical audit records without idempotency keys coexist under the unique index without duplicate errors", async () => {
    const actorId = new mongoose.Types.ObjectId();
    const commonEntityId = new mongoose.Types.ObjectId();

    // Insert multiple historical audit logs for the same entity, same organization, and same action without idempotency keys
    const log1 = await AuditLog.create({
      organizationId: orgId,
      branchId: branch._id,
      actorId,
      action: "APPOINTMENT_RESCHEDULED",
      entityType: "Appointment",
      entityId: commonEntityId,
      description: "First reschedule without key",
      metadata: { reason: "Customer requested" },
    });

    const log2 = await AuditLog.create({
      organizationId: orgId,
      branchId: branch._id,
      actorId,
      action: "APPOINTMENT_RESCHEDULED",
      entityType: "Appointment",
      entityId: commonEntityId,
      description: "Second reschedule without key",
      metadata: { reason: "Stylist late" },
    });

    expect(log1).toBeDefined();
    expect(log2).toBeDefined();
    expect(log1._id.toString()).not.toBe(log2._id.toString());

    // Both coexist cleanly in the database
    const count = await AuditLog.countDocuments({
      organizationId: orgId,
      entityId: commonEntityId,
      action: "APPOINTMENT_RESCHEDULED",
    });
    expect(count).toBe(2);
  });

  it("8. A timestamp mismatch between expected and actual conflict resolution is rejected", async () => {
    const actorId = new mongoose.Types.ObjectId();
    const actualResolvedAt = new Date("2026-11-24T10:00:00.000Z");
    const differentResolvedAt = new Date("2026-11-24T10:00:05.000Z");

    const conflict = await AttendanceBranchConflict.create({
      organizationId: orgId,
      staffId: staff._id,
      primaryBranchId: branch._id,
      date: todayStr,
      conflictStatus: "resolved",
      resolution: "retain",
      reason: "Timestamp mismatch test",
      resolvedBy: actorId,
      resolvedAt: actualResolvedAt,
      branchesInvolved: [{ branchId: branch._id }],
      isActive: true,
    });

    await Attendance.create({
      organizationId: orgId,
      branchId: branch._id,
      staffId: staff._id,
      attendanceDate: new Date(`${todayStr}T00:00:00.000Z`),
      status: "present",
      isReconciled: true,
      reconciledBy: actorId,
      reconciledAt: actualResolvedAt,
    });

    // Mismatched expectedResolvedAt
    await expect(
      recoverReconciliationAuditLog({
        organizationId: orgId,
        branchId: branch._id,
        actorId,
        conflictId: conflict._id,
        expectedResolvedAt: differentResolvedAt,
        expectedResolvedBy: actorId,
      })
    ).rejects.toThrow("Conflict resolvedAt timestamp does not match the expected reconciliation time. Recovery aborted.");

    const count = await AuditLog.countDocuments({
      organizationId: orgId,
      entityId: conflict._id,
    });
    expect(count).toBe(0);
  });

  it("9. Attendance reconciliation actor or timestamp mismatch with conflict is rejected", async () => {
    const actorId1 = new mongoose.Types.ObjectId();
    const actorId2 = new mongoose.Types.ObjectId();
    const resolvedAt = new Date("2026-11-24T11:00:00.000Z");
    const differentTime = new Date("2026-11-24T11:05:00.000Z");

    const conflict = await AttendanceBranchConflict.create({
      organizationId: orgId,
      staffId: staff._id,
      primaryBranchId: branch._id,
      date: todayStr,
      conflictStatus: "resolved",
      resolution: "retain",
      reason: "Attendance mismatch test",
      resolvedBy: actorId1,
      resolvedAt,
      branchesInvolved: [{ branchId: branch._id }],
      isActive: true,
    });

    // Attendance reconciled by a different actor
    const att = await Attendance.create({
      organizationId: orgId,
      branchId: branch._id,
      staffId: staff._id,
      attendanceDate: new Date(`${todayStr}T00:00:00.000Z`),
      status: "present",
      isReconciled: true,
      reconciledBy: actorId2, // different actor!
      reconciledAt: resolvedAt,
    });

    await expect(
      recoverReconciliationAuditLog({
        organizationId: orgId,
        branchId: branch._id,
        actorId: actorId1,
        conflictId: conflict._id,
      })
    ).rejects.toThrow("Attendance reconciledBy does not correspond to the conflict resolution actor. Recovery aborted.");

    // Fix actor, but introduce timestamp mismatch on Attendance
    att.reconciledBy = actorId1;
    att.reconciledAt = differentTime; // different timestamp!
    await att.save();

    await expect(
      recoverReconciliationAuditLog({
        organizationId: orgId,
        branchId: branch._id,
        actorId: actorId1,
        conflictId: conflict._id,
      })
    ).rejects.toThrow("Attendance reconciledAt timestamp does not correspond to the conflict resolution timestamp. Recovery aborted.");
  });
});
