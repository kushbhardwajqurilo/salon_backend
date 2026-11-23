import { afterAll, beforeAll, describe, expect, it, jest } from "@jest/globals";
import mongoose from "mongoose";
import request from "supertest";
import app from "../../../app.mjs";
import { Permission } from "../../models/permissions/permission.model.js";
import { Role } from "../../models/roles/role.model.js";
import { User } from "../../models/users/user.model.js";
import { Staff } from "../../models/staff/staff.model.js";
import { StaffBranch } from "../../models/staff/staffBranch.model.js";
import { Branch } from "../../models/branches/branch.model.js";
import { Organization } from "../../models/organizations/organization.model.js";
import { Attendance } from "../../models/attendance/attendance.model.js";
import { AttendanceBranchConflict } from "../../models/attendance/AttendanceLeaveAppointmentConflict.model.js";
import { Leave } from "../../models/leaves/leave.model.js";
import { SalaryStructure } from "../../models/payroll/salaryStructure.model.js";
import { PayrollPeriod } from "../../models/payroll/payrollPeriod.model.js";
import { PayrollRecord } from "../../models/payroll/payrollRecord.model.js";
import { PayrollPayment } from "../../models/payroll/payrollPayment.model.js";
import { PayrollIncentiveAllocation } from "../../models/payroll/payrollIncentiveAllocation.model.js";
import { IncentiveEvaluation } from "../../models/incentives/incentiveEvaluation.model.js";
import { IncentiveLedger } from "../../models/incentives/incentiveLedger.model.js";
import { IncentiveRecoveryObligation } from "../../models/incentives/incentiveRecoveryObligation.model.js";
import { IncentiveRecoveryPayment } from "../../models/incentives/incentiveRecoveryPayment.model.js";
import { IncentiveScheme } from "../../models/incentives/incentiveScheme.model.js";
import jwt from "jsonwebtoken";
import { env } from "../../config/env.js";
import { getIsolatedTestMongoUri } from "../testSetup.js";

describe("Salary / Payroll Module — Comprehensive Backend Tests", () => {
  jest.setTimeout(30000);
  let orgId;
  let branchId;
  let adminUser;
  let adminToken;
  let managerToken;
  let staffUser;
  let staffToken;
  let testStaff;

  beforeAll(async () => {
    if (mongoose.connection.readyState === 0) {
      const mongoUri = getIsolatedTestMongoUri("payroll_test");
      await mongoose.connect(mongoUri, {
        serverSelectionTimeoutMS: 10000,
      });
    }

    // 1. Create Organization
    const org = await Organization.create({
      name: "Payroll Test Salon Org",
      code: "PTSO-" + Date.now(),
      email: `org-${Date.now()}@test.com`,
      phone: "+919876543210",
    });
    orgId = org._id;

    // 2. Create Branch
    const branch = await Branch.create({
      name: "Main Payroll Branch",
      code: "MPB-" + Date.now(),
      organizationId: orgId,
      isActive: true,
    });
    branchId = branch._id;

    // 3. Setup Permissions & Roles
    const [
      viewPerm,
      structPerm,
      calcPerm,
      approvePerm,
      disbursePerm,
      adjustPerm,
      reversePerm,
      exportPerm,
    ] = await Promise.all([
      Permission.findOneAndUpdate(
        { name: "payroll.view" },
        { $setOnInsert: { name: "payroll.view", module: "Salary / Payroll", action: "View", description: "View payroll" } },
        { upsert: true, new: true }
      ),
      Permission.findOneAndUpdate(
        { name: "payroll.structure.manage" },
        { $setOnInsert: { name: "payroll.structure.manage", module: "Salary / Payroll", action: "Manage Structure", description: "Manage salary" } },
        { upsert: true, new: true }
      ),
      Permission.findOneAndUpdate(
        { name: "payroll.calculate" },
        { $setOnInsert: { name: "payroll.calculate", module: "Salary / Payroll", action: "Calculate", description: "Calculate payroll" } },
        { upsert: true, new: true }
      ),
      Permission.findOneAndUpdate(
        { name: "payroll.approve" },
        { $setOnInsert: { name: "payroll.approve", module: "Salary / Payroll", action: "Approve", description: "Approve payroll" } },
        { upsert: true, new: true }
      ),
      Permission.findOneAndUpdate(
        { name: "payroll.disburse" },
        { $setOnInsert: { name: "payroll.disburse", module: "Salary / Payroll", action: "Disburse", description: "Disburse payroll" } },
        { upsert: true, new: true }
      ),
      Permission.findOneAndUpdate(
        { name: "payroll.adjust" },
        { $setOnInsert: { name: "payroll.adjust", module: "Salary / Payroll", action: "Adjust", description: "Adjust payroll" } },
        { upsert: true, new: true }
      ),
      Permission.findOneAndUpdate(
        { name: "payroll.reverse" },
        { $setOnInsert: { name: "payroll.reverse", module: "Salary / Payroll", action: "Reverse", description: "Reverse payroll" } },
        { upsert: true, new: true }
      ),
      Permission.findOneAndUpdate(
        { name: "payroll.export" },
        { $setOnInsert: { name: "payroll.export", module: "Salary / Payroll", action: "Export", description: "Export payslips" } },
        { upsert: true, new: true }
      ),
    ]);

    const adminRole = await Role.create({
      name: "admin-" + Date.now(),
      organizationId: orgId,
      permissions: [
        viewPerm._id,
        structPerm._id,
        calcPerm._id,
        approvePerm._id,
        disbursePerm._id,
        adjustPerm._id,
        reversePerm._id,
        exportPerm._id,
      ],
    });

    const managerRole = await Role.create({
      name: "manager-" + Date.now(),
      organizationId: orgId,
      permissions: [
        viewPerm._id,
        structPerm._id,
        calcPerm._id,
        adjustPerm._id,
        exportPerm._id,
      ], // Manager DOES NOT have approve, disburse, or reverse permissions
    });

    const staffRole = await Role.create({
      name: "staff-" + Date.now(),
      organizationId: orgId,
      permissions: [viewPerm._id],
    });

    // 4. Create Admin User with payroll permissions
    adminUser = await User.create({
      name: "Payroll Admin",
      email: `payrolladmin-${Date.now()}@test.com`,
      phone: "+919999988888",
      password: "HashedPassword123!",
      organizationId: orgId,
      hasOrgWideAccess: true,
      role: adminRole._id,
      status: "active",
      branchAccess: [{ branchId, branchName: branch.name, isActive: true }],
    });
    adminToken = jwt.sign({ id: adminUser._id.toString() }, env.JWT_SECRET);

    // 5. Create Manager User (has calculate & adjust, but lacks approve, disburse, reverse)
    const managerUser = await User.create({
      name: "Payroll Manager",
      email: `manager-${Date.now()}@test.com`,
      phone: "+919999966666",
      password: "HashedPassword123!",
      organizationId: orgId,
      hasOrgWideAccess: false,
      role: managerRole._id,
      status: "active",
      branchAccess: [{ branchId, branchName: branch.name, isActive: true }],
    });
    managerToken = jwt.sign({ id: managerUser._id.toString() }, env.JWT_SECRET);

    // 6. Create Staff User with view-only
    staffUser = await User.create({
      name: "Staff Viewer",
      email: `staffview-${Date.now()}@test.com`,
      phone: "+919999977777",
      password: "HashedPassword123!",
      organizationId: orgId,
      hasOrgWideAccess: false,
      role: staffRole._id,
      status: "active",
      branchAccess: [{ branchId, branchName: branch.name, isActive: true }],
    });
    staffToken = jwt.sign({ id: staffUser._id.toString() }, env.JWT_SECRET);

    // 5. Create Staff Record
    testStaff = await Staff.create({
      name: "Jane Stylist",
      email: `jane-${Date.now()}@test.com`,
      phone: "+919811122233",
      organizationId: orgId,
      designation: "Senior Stylist",
      staffCode: "STF-" + Date.now(),
      joiningDate: new Date("2026-11-01T00:00:00.000Z"),
      status: "active",
    });

    // 6. Map Staff to Branch as primary
    await StaffBranch.create({
      staffId: testStaff._id,
      branchId: branchId,
      organizationId: orgId,
      isPrimary: true,
      isActive: true,
    });
  });

  afterAll(async () => {
    await PayrollPayment.deleteMany({ organizationId: orgId });
    await IncentiveRecoveryPayment.deleteMany({ organizationId: orgId });
    await IncentiveRecoveryObligation.deleteMany({ organizationId: orgId });
    await PayrollIncentiveAllocation.deleteMany({ organizationId: orgId });
    await PayrollRecord.deleteMany({ organizationId: orgId });
    await IncentiveLedger.deleteMany({ organizationId: orgId });
    await IncentiveEvaluation.deleteMany({ organizationId: orgId });
    await IncentiveScheme.deleteMany({ organizationId: orgId });
    await PayrollPeriod.deleteMany({ organizationId: orgId });
    await SalaryStructure.deleteMany({ organizationId: orgId });
    await Attendance.deleteMany({ organizationId: orgId });
    await AttendanceBranchConflict.deleteMany({ organizationId: orgId });
    await Leave.deleteMany({ organizationId: orgId });
    await StaffBranch.deleteMany({ organizationId: orgId });
    await Staff.deleteMany({ organizationId: orgId });
    await User.deleteMany({ organizationId: orgId });
    await Branch.deleteMany({ organizationId: orgId });
    await Organization.deleteMany({ _id: orgId });
    if (mongoose.connection.readyState === 1) {
      await mongoose.disconnect();
    }
  });

  describe("1. Salary Configuration & Structure", () => {
    it("creates salary structure successfully for active staff", async () => {
      const res = await request(app)
        .post("/api/v1/payroll/structures")
        .set("Authorization", `Bearer ${adminToken}`)
        .send({
          staffId: testStaff._id.toString(),
          payType: "fixed_monthly",
          baseSalary: 30000,
          allowances: [{ name: "Housing", amount: 5000 }],
          deductions: [{ name: "Insurance", amount: 1000 }],
          effectiveFrom: "2026-11-01T00:00:00.000Z",
        });

      expect(res.status).toBe(200);
      expect(res.body.success).toBe(true);
      expect(res.body.data.baseSalary).toBe(30000);
      expect(res.body.data.allowances).toHaveLength(1);
    });

    it("denies salary structure modification without payroll.calculate permission", async () => {
      const res = await request(app)
        .post("/api/v1/payroll/structures")
        .set("Authorization", `Bearer ${staffToken}`)
        .send({
          staffId: testStaff._id.toString(),
          baseSalary: 35000,
          effectiveFrom: "2026-11-01T00:00:00.000Z",
        });

      expect(res.status).toBe(403);
    });

    it("fetches effective salary structure for staff", async () => {
      const res = await request(app)
        .get(`/api/v1/payroll/structures/${testStaff._id}`)
        .set("Authorization", `Bearer ${staffToken}`)
        .set("X-Branch-Id", branchId.toString());

      expect(res.status).toBe(200);
      expect(res.body.success).toBe(true);
      expect(res.body.data.baseSalary).toBe(30000);
    });
  });

  describe("2. Payroll Period Management", () => {
    it("creates a new payroll period with calendar-day calculation", async () => {
      const res = await request(app)
        .post("/api/v1/payroll/periods")
        .set("Authorization", `Bearer ${adminToken}`)
        .send({
          year: 2026,
          month: 11, // November has 30 days
        });

      expect(res.status).toBe(201);
      expect(res.body.success).toBe(true);
      expect(res.body.data.monthYear).toBe("2026-11");
      expect(res.body.data.totalDays).toBe(30);
    });

    it("prevents duplicate payroll periods for the same monthYear", async () => {
      const res = await request(app)
        .post("/api/v1/payroll/periods")
        .set("Authorization", `Bearer ${adminToken}`)
        .send({
          year: 2026,
          month: 11,
        });

      expect(res.status).toBe(409);
    });
  });

  describe("3. Attendance Ingestion & Calculation Engine", () => {
    let periodId;

    beforeAll(async () => {
      const period = await PayrollPeriod.findOne({
        organizationId: orgId,
        monthYear: "2026-11",
      });
      periodId = period._id;

      // Seed 20 present days, 1 incomplete day
      for (let day = 1; day <= 20; day++) {
        const status = day === 19 ? "late" : day === 20 ? "early_departure" : "present";
        await Attendance.create({
          organizationId: orgId,
          branchId,
          staffId: testStaff._id,
          attendanceDate: new Date(`2026-11-${day < 10 ? "0" + day : day}T10:00:00.000Z`),
          status,
        });
      }

      // Day 21: Incomplete punch (missing checkout)
      await Attendance.create({
        organizationId: orgId,
        branchId,
        staffId: testStaff._id,
        attendanceDate: new Date("2026-11-21T10:00:00.000Z"),
        status: "incomplete",
      });

      // Day 22-23: Approved Unpaid Leave (LOP)
      await Leave.create({
        organizationId: orgId,
        branchId,
        staffId: testStaff._id,
        leaveCode: "LV-" + Date.now(),
        leaveType: "Unpaid Leave",
        isUnpaid: true,
        startDate: new Date("2026-11-22T00:00:00.000Z"),
        endDate: new Date("2026-11-23T23:59:59.000Z"),
        reason: "Personal urgent work",
        status: "approved",
        submittedBy: adminUser._id,
        submittedFor: "staff",
      });
    });

    it("calculates payroll, capturing attendance blocker for incomplete punches", async () => {
      const res = await request(app)
        .post("/api/v1/payroll/calculate")
        .set("Authorization", `Bearer ${adminToken}`)
        .send({
          payrollPeriodId: periodId.toString(),
          staffIds: [testStaff._id.toString()],
        });

      expect(res.status).toBe(200);
      expect(res.body.success).toBe(true);
      expect(res.body.data).toHaveLength(1);

      const record = res.body.data[0];
      expect(record.status).toBe("draft");
      expect(record.approvalBlocked).toBe(true);
      expect(record.approvalBlockReasons.length).toBeGreaterThan(0);
      expect(record.approvalBlockReasons[0]).toContain("incomplete attendance record");
      expect(record.attendanceSummarySnapshot).toMatchObject({
        presentDays: 20,
        lateDays: 1,
        earlyDepartureDays: 1,
        incompleteDays: 1,
      });

      // Verify financial deductions:
      // Base: 30,000, 30 days -> 1000/day
      // Allowances: 5,000
      // Present: 20 days -> Payable Days: 20
      // Prorated Base Salary: 20 * 1000 = 20,000
      // Total Gross: 20,000 + 5,000 = 25,000
      // Unpaid Leave (LOP): 2 days * 1000 = 2000
      // Fixed Deductions: 1000
      // Net Payable: 25,000 - 1000 = 24,000
      expect(record.calculations.dailySalaryRate).toBe(1000);
      expect(record.calculations.payableDays).toBe(20);
      expect(record.calculations.proratedBaseSalary).toBe(20000);
      expect(record.calculations.grossBaseSalary).toBe(20000);
      expect(record.calculations.totalAllowances).toBe(5000);
      expect(record.calculations.totalGrossPay).toBe(25000);
      expect(record.calculations.unpaidLeaveDeduction).toBe(2000);
      expect(record.calculations.fixedDeductions).toBe(1000);
      expect(record.calculations.netPayable).toBe(24000);
    });

    it("blocks payroll when a branch attendance conflict remains pending or disputed", async () => {
      await AttendanceBranchConflict.create([
        {
          organizationId: orgId,
          staffId: testStaff._id,
          date: new Date("2026-11-24T00:00:00.000Z"),
          branchesInvolved: [{ branchId, punchCount: 1 }],
          primaryBranchId: branchId,
          conflictStatus: "pending",
          isActive: true,
        },
        {
          organizationId: orgId,
          staffId: testStaff._id,
          date: new Date("2026-11-25T00:00:00.000Z"),
          branchesInvolved: [{ branchId, punchCount: 1 }],
          primaryBranchId: branchId,
          conflictStatus: "disputed",
          isActive: true,
          reason: "Branch ownership of attendance is disputed",
        },
      ]);

      const res = await request(app)
        .post("/api/v1/payroll/calculate")
        .set("Authorization", `Bearer ${adminToken}`)
        .send({
          payrollPeriodId: periodId.toString(),
          staffIds: [testStaff._id.toString()],
        });

      expect(res.status).toBe(200);
      expect(res.body.data[0].approvalBlocked).toBe(true);
      expect(res.body.data[0].approvalBlockReasons).toContain(
        "Staff has 2 unresolved attendance conflict(s)",
      );
      await AttendanceBranchConflict.deleteMany({ organizationId: orgId });
    });

    it("blocks approval when attendance has incomplete records", async () => {
      const record = await PayrollRecord.findOne({
        organizationId: orgId,
        staffId: testStaff._id,
        monthYear: "2026-11",
      });

      const res = await request(app)
        .post(`/api/v1/payroll/records/${record._id}/approve`)
        .set("Authorization", `Bearer ${adminToken}`)
        .send();

      expect(res.status).toBe(400);
      expect(res.body.message).toContain("Cannot approve payroll");
    });

    it("allows approval once attendance exceptions are reconciled", async () => {
      // Reconcile the incomplete attendance
      await Attendance.findOneAndUpdate(
        {
          organizationId: orgId,
          staffId: testStaff._id,
          status: "incomplete",
        },
        { $set: { status: "present", isReconciled: true } }
      );

      // Recalculate payroll
      await request(app)
        .post("/api/v1/payroll/calculate")
        .set("Authorization", `Bearer ${adminToken}`)
        .send({
          payrollPeriodId: periodId.toString(),
          staffIds: [testStaff._id.toString()],
        });

      const record = await PayrollRecord.findOne({
        organizationId: orgId,
        staffId: testStaff._id,
        monthYear: "2026-11",
      });
      expect(record.approvalBlocked).toBe(false);
      expect(record.incentiveAmountInPaise).toBe(0);

      const scheme = await IncentiveScheme.create({
        organizationId: orgId,
        name: "Verified attendance payroll test",
        code: `ATT_PAYROLL_${Date.now()}`,
        schemeType: "ATTENDANCE_BONUS",
        calculationBasis: "ATTENDANCE_DAYS",
        rules: {
          fixedAmountPaise: 1234,
          minimumAttendanceDays: 20,
          tiers: [],
        },
        status: "active",
      });
      await IncentiveEvaluation.create({
        organizationId: orgId,
        branchId,
        staffId: testStaff._id,
        schemeId: scheme._id,
        monthYear: "2026-11",
        evaluationType: "ATTENDANCE_BONUS",
        targetDays: 20,
        achievedDays: 21,
        isTargetMet: true,
        bonusAwardedInPaise: 1234,
        status: "finalized",
        finalizedBy: adminUser._id,
        finalizedAt: new Date(),
      });

      const staleApproval = await request(app)
        .post(`/api/v1/payroll/records/${record._id}/approve`)
        .set("Authorization", `Bearer ${adminToken}`)
        .send();
      expect(staleApproval.status).toBe(409);
      expect(staleApproval.body.message).toContain("Finalized incentives changed");

      const recalculated = await request(app)
        .post("/api/v1/payroll/calculate")
        .set("Authorization", `Bearer ${adminToken}`)
        .send({
          payrollPeriodId: periodId.toString(),
          staffIds: [testStaff._id.toString()],
        });
      expect(recalculated.status).toBe(200);
      expect(recalculated.body.data[0].incentiveAmountInPaise).toBe(1234);
      expect(recalculated.body.data[0].incentiveEvaluationIds).toContain(
        (await IncentiveEvaluation.findOne({ organizationId: orgId, staffId: testStaff._id }))._id.toString(),
      );
      expect(recalculated.body.data[0].calculations.totalIncentivesInPaise).toBe(1234);
      // Reconciled: 21 present days -> Prorated base = 21,000 + 5000 allowances + 12.34 bonus = 26,012.34
      // Net Payable = 26,012.34 - 1000 fixed deduction = 25,012.34
      expect(recalculated.body.data[0].calculations.totalGrossPay).toBe(26012.34);
      expect(recalculated.body.data[0].calculations.netPayable).toBe(25012.34);

      const attendanceRetry = await request(app)
        .post("/api/v1/payroll/calculate")
        .set("Authorization", `Bearer ${adminToken}`)
        .send({
          payrollPeriodId: periodId.toString(),
          staffIds: [testStaff._id.toString()],
        });
      expect(attendanceRetry.status).toBe(200);
      expect(attendanceRetry.body.data[0].incentiveAmountInPaise).toBe(1234);
      expect(attendanceRetry.body.data[0].incentiveEvaluationIds).toHaveLength(1);
      expect(attendanceRetry.body.data[0].calculations.totalIncentivesInPaise).toBe(1234);

      // Now approve
      const res = await request(app)
        .post(`/api/v1/payroll/records/${record._id}/approve`)
        .set("Authorization", `Bearer ${adminToken}`)
        .send();

      expect(res.status).toBe(200);
      expect(res.body.success).toBe(true);
      expect(res.body.data.status).toBe("approved");

      const approvedRecord = await PayrollRecord.findById(record._id);
      const paymentDate = "2026-11-30T00:00:00.000Z";
      const recordedPayment = await request(app)
        .post(`/api/v1/payroll/records/${approvedRecord._id}/pay`)
        .set("Authorization", `Bearer ${adminToken}`)
        .send({
          paymentMethod: "bank_transfer",
          paymentReference: "ATTENDANCE-BONUS-UTR",
          amountInPaise: Math.round(approvedRecord.calculations.netPayable * 100),
          paymentDate,
          idempotencyKey: `attendance-payroll-${approvedRecord._id}`,
        });
      expect(recordedPayment.status).toBe(201);
      expect(recordedPayment.body.data.record.status).toBe("approved");
      expect(recordedPayment.body.data.payment.incentiveAmountInPaise).toBe(1234);
      expect(recordedPayment.body.data.payment.incentiveEvaluationIds).toContain(
        recalculated.body.data[0].incentiveEvaluationIds[0],
      );

      const settlement = await request(app)
        .post(`/api/v1/payroll/records/${approvedRecord._id}/payments/${recordedPayment.body.data.payment._id}/confirm`)
        .set("Authorization", `Bearer ${adminToken}`)
        .send({ confirmActualPayment: true });
      expect(settlement.status).toBe(200);
      expect(settlement.body.data.record.status).toBe("paid");
      expect(settlement.body.data.payment.status).toBe("confirmed");
      expect(settlement.body.data.record.manualPaymentStatus).toBe("confirmed");
    });
  });

  describe("3a. Commission payroll allocation and manual recovery", () => {
    it("allocates payable commission once and supports auditable, idempotent partial recovery", async () => {
      const period = await PayrollPeriod.findOne({
        organizationId: orgId,
        monthYear: "2026-11",
        isDeleted: false,
      });
      expect(period).toBeTruthy();

      const staff = await Staff.create({
        name: "Commission Payroll Test",
        email: `commission-payroll-${Date.now()}@test.com`,
        phone: `+9198${String(Date.now()).slice(-8)}`,
        organizationId: orgId,
        designation: "Stylist",
        staffCode: `CPT-${Date.now()}`,
        joiningDate: new Date("2026-11-01T00:00:00.000Z"),
        status: "active",
      });
      await Promise.all([
        StaffBranch.create({
          staffId: staff._id,
          branchId,
          organizationId: orgId,
          isPrimary: true,
          isActive: true,
        }),
        SalaryStructure.create({
          organizationId: orgId,
          staffId: staff._id,
          payType: "fixed_monthly",
          baseSalary: 30000,
          effectiveFrom: new Date("2026-11-01T00:00:00.000Z"),
        }),
      ]);

      const schemeId = new mongoose.Types.ObjectId();
      const invoiceId = new mongoose.Types.ObjectId();
      const settlementEventId = new mongoose.Types.ObjectId();
      const lineItemId = new mongoose.Types.ObjectId();
      const accrual = await IncentiveLedger.create({
        organizationId: orgId,
        branchId,
        staffId: staff._id,
        schemeId,
        entryType: "ACCRUAL",
        sourceType: "service_commission",
        settlementEventId,
        invoiceId,
        lineItemId,
        fulfillmentStatus: "confirmed",
        fulfillmentConfirmedAt: new Date(),
        fulfillmentConfirmedBy: adminUser._id,
        sourceRevenueInPaise: 100000,
        attributedRevenueInPaise: 100000,
        amountInPaise: 10000,
        idempotencyKey: `payroll-commission-accrual-${staff._id}`,
        createdAt: new Date("2026-11-10T00:00:00.000Z"),
      });
      const coveredClawback = await IncentiveLedger.create({
        organizationId: orgId,
        branchId,
        staffId: staff._id,
        schemeId,
        entryType: "CLAWBACK",
        sourceType: "service_commission",
        settlementEventId: new mongoose.Types.ObjectId(),
        invoiceId,
        lineItemId,
        reversesLedgerId: accrual._id,
        fulfillmentStatus: "not_applicable",
        sourceRevenueInPaise: 20000,
        attributedRevenueInPaise: 20000,
        amountInPaise: 2000,
        idempotencyKey: `payroll-commission-clawback-${staff._id}`,
        createdAt: new Date("2026-11-12T00:00:00.000Z"),
      });

      const calculated = await request(app)
        .post("/api/v1/payroll/calculate")
        .set("Authorization", `Bearer ${adminToken}`)
        .set("X-Branch-Id", branchId.toString())
        .send({ payrollPeriodId: period._id.toString(), staffIds: [staff._id.toString()] });
      expect(calculated.status).toBe(200);
      const record = calculated.body.data.find((item) => item.staffId === staff._id.toString());
      expect(record).toBeTruthy();
      expect(record.incentiveLedgerGrossInPaise).toBe(10000);
      expect(record.incentiveLedgerClawbackInPaise).toBe(2000);
      expect(record.incentiveLedgerAmountInPaise).toBe(8000);

      const approved = await request(app)
        .post(`/api/v1/payroll/records/${record._id}/approve`)
        .set("Authorization", `Bearer ${adminToken}`)
        .set("X-Branch-Id", branchId.toString())
        .send();
      expect(approved.status).toBe(200);
      const allocation = await PayrollIncentiveAllocation.findOne({
        organizationId: orgId,
        incentiveLedgerId: accrual._id,
      });
      expect(allocation.status).toBe("approved");
      expect(allocation.payableAmountInPaise).toBe(8000);
      expect(allocation.coveredClawbackLedgerIds.map(String)).toContain(String(coveredClawback._id));
      expect(await PayrollIncentiveAllocation.countDocuments({
        organizationId: orgId,
        incentiveLedgerId: accrual._id,
      })).toBe(1);

      const paymentAmount = Math.round(approved.body.data.calculations.netPayable * 100);
      const paymentAttempt = await request(app)
        .post(`/api/v1/payroll/records/${record._id}/pay`)
        .set("Authorization", `Bearer ${adminToken}`)
        .set("X-Branch-Id", branchId.toString())
        .send({
          paymentMethod: "bank_transfer",
          paymentReference: `COMMISSION-${record._id}`,
          amountInPaise: paymentAmount,
          paymentDate: "2026-11-30T00:00:00.000Z",
          idempotencyKey: `commission-payroll-${record._id}`,
        });
      expect(paymentAttempt.status).toBe(201);
      expect(paymentAttempt.body.data.payment.incentiveLedgerAmountInPaise).toBe(8000);
      const settled = await request(app)
        .post(`/api/v1/payroll/records/${record._id}/payments/${paymentAttempt.body.data.payment._id}/confirm`)
        .set("Authorization", `Bearer ${adminToken}`)
        .set("X-Branch-Id", branchId.toString())
        .send({ confirmActualPayment: true });
      expect(settled.status).toBe(200);
      expect(settled.body.data.record.status).toBe("paid");
      expect((await PayrollIncentiveAllocation.findById(allocation._id)).status).toBe("paid");

      const coveredObligation = await IncentiveRecoveryObligation.create({
        organizationId: orgId,
        branchId,
        staffId: staff._id,
        clawbackLedgerId: coveredClawback._id,
        originalClawbackInPaise: 2000,
      });
      const recoveryRequest = (obligationId, amountInPaise, idempotencyKey) =>
        request(app)
          .post(`/api/v1/incentives/recovery-obligations/${obligationId}/payments`)
          .set("Authorization", `Bearer ${adminToken}`)
          .set("X-Branch-Id", branchId.toString())
          .send({
            amountInPaise,
            paymentMethod: "bank_transfer",
            paymentReference: `RECOVERY-${idempotencyKey}`,
            paymentDate: "2026-12-01T00:00:00.000Z",
            reason: "Manual recovery settlement",
            idempotencyKey,
          });
      const coveredRecovery = await recoveryRequest(
        coveredObligation._id,
        2000,
        `covered-${record._id}`,
      );
      expect(coveredRecovery.status).toBe(409);

      const postPayrollClawback = await IncentiveLedger.create({
        organizationId: orgId,
        branchId,
        staffId: staff._id,
        schemeId,
        entryType: "CLAWBACK",
        sourceType: "service_commission",
        settlementEventId: new mongoose.Types.ObjectId(),
        invoiceId,
        lineItemId,
        reversesLedgerId: accrual._id,
        fulfillmentStatus: "not_applicable",
        sourceRevenueInPaise: 10000,
        attributedRevenueInPaise: 10000,
        amountInPaise: 1000,
        idempotencyKey: `payroll-post-settlement-clawback-${staff._id}`,
        createdAt: new Date("2026-11-15T00:00:00.000Z"),
      });
      const obligation = await IncentiveRecoveryObligation.create({
        organizationId: orgId,
        branchId,
        staffId: staff._id,
        clawbackLedgerId: postPayrollClawback._id,
        originalClawbackInPaise: 1000,
      });

      const unauthorized = await request(app)
        .post(`/api/v1/incentives/recovery-obligations/${obligation._id}/payments`)
        .set("Authorization", `Bearer ${managerToken}`)
        .set("X-Branch-Id", branchId.toString())
        .send({
          amountInPaise: 100,
          paymentMethod: "cash",
          paymentReference: "UNAUTHORIZED",
          paymentDate: "2026-12-01T00:00:00.000Z",
          reason: "Unauthorized recovery attempt",
          idempotencyKey: `unauth-${record._id}`,
        });
      expect(unauthorized.status).toBe(403);

      const concurrentKeys = [
        `recovery-concurrent-a-${record._id}`,
        `recovery-concurrent-b-${record._id}`,
      ];
      const concurrentAttempts = await Promise.all(
        concurrentKeys.map((key) => recoveryRequest(obligation._id, 600, key)),
      );
      expect(concurrentAttempts.map((attempt) => attempt.status).sort()).toEqual([201, 409]);
      const failedAttempt = concurrentAttempts.find((attempt) => attempt.status === 201);
      expect(failedAttempt.body.data.payment.status).toBe("recorded");
      expect((await IncentiveRecoveryObligation.findById(obligation._id)).totalReservedInPaise).toBe(600);
      const attemptKey = failedAttempt.body.data.payment.idempotencyKey;
      const replayedAttempt = await recoveryRequest(obligation._id, 600, attemptKey);
      expect(replayedAttempt.status).toBe(200);
      expect(replayedAttempt.body.data.isIdempotentReplay).toBe(true);
      expect(await IncentiveRecoveryPayment.countDocuments({
        organizationId: orgId,
        idempotencyKey: attemptKey,
      })).toBe(1);

      const failed = await request(app)
        .post(`/api/v1/incentives/recovery-obligations/${obligation._id}/payments/${failedAttempt.body.data.payment._id}/fail`)
        .set("Authorization", `Bearer ${adminToken}`)
        .set("X-Branch-Id", branchId.toString())
        .send({ failureReason: "Cash receipt was not issued" });
      expect(failed.status).toBe(200);
      expect(failed.body.data.obligation.totalReservedInPaise).toBe(0);

      const confirmedAttempt = await recoveryRequest(
        obligation._id,
        600,
        `recovery-confirm-${record._id}`,
      );
      expect(confirmedAttempt.status).toBe(201);
      const confirmedRecovery = await request(app)
        .post(`/api/v1/incentives/recovery-obligations/${obligation._id}/payments/${confirmedAttempt.body.data.payment._id}/confirm`)
        .set("Authorization", `Bearer ${adminToken}`)
        .set("X-Branch-Id", branchId.toString())
        .send({ confirmActualPayment: true });
      expect(confirmedRecovery.status).toBe(200);
      expect(confirmedRecovery.body.data.obligation.totalRecoveredInPaise).toBe(600);
      const replayedConfirmation = await request(app)
        .post(`/api/v1/incentives/recovery-obligations/${obligation._id}/payments/${confirmedAttempt.body.data.payment._id}/confirm`)
        .set("Authorization", `Bearer ${adminToken}`)
        .set("X-Branch-Id", branchId.toString())
        .send({ confirmActualPayment: true });
      expect(replayedConfirmation.status).toBe(200);
      expect(replayedConfirmation.body.data.isIdempotentReplay).toBe(true);

      const reversedRecovery = await request(app)
        .post(`/api/v1/incentives/recovery-obligations/${obligation._id}/payments/${confirmedAttempt.body.data.payment._id}/reverse`)
        .set("Authorization", `Bearer ${adminToken}`)
        .set("X-Branch-Id", branchId.toString())
        .send({
          confirmActualReversal: true,
          reversalReason: "Recovery transfer was returned",
        });
      expect(reversedRecovery.status).toBe(200);
      expect(reversedRecovery.body.data.obligation.totalRecoveredInPaise).toBe(0);
      expect((await PayrollIncentiveAllocation.findById(allocation._id)).recoveredInPaise).toBe(0);
      const reversedAgain = await request(app)
        .post(`/api/v1/incentives/recovery-obligations/${obligation._id}/payments/${confirmedAttempt.body.data.payment._id}/reverse`)
        .set("Authorization", `Bearer ${adminToken}`)
        .set("X-Branch-Id", branchId.toString())
        .send({
          confirmActualReversal: true,
          reversalReason: "Recovery transfer was returned",
        });
      expect(reversedAgain.status).toBe(200);
      expect(reversedAgain.body.data.isIdempotentReplay).toBe(true);

      const overRecovery = await recoveryRequest(
        obligation._id,
        1001,
        `recovery-over-${record._id}`,
      );
      expect(overRecovery.status).toBe(409);
      const finalRecoveryAttempt = await recoveryRequest(
        obligation._id,
        400,
        `recovery-final-${record._id}`,
      );
      expect(finalRecoveryAttempt.status).toBe(201);
      const finalConfirmation = await request(app)
        .post(`/api/v1/incentives/recovery-obligations/${obligation._id}/payments/${finalRecoveryAttempt.body.data.payment._id}/confirm`)
        .set("Authorization", `Bearer ${adminToken}`)
        .set("X-Branch-Id", branchId.toString())
        .send({ confirmActualPayment: true });
      expect(finalConfirmation.status).toBe(200);
      expect(finalConfirmation.body.data.obligation.status).toBe("partially_recovered");
      expect(finalConfirmation.body.data.obligation.totalRecoveredInPaise).toBe(400);

      const lastRecoveryAttempt = await recoveryRequest(
        obligation._id,
        600,
        `recovery-last-${record._id}`,
      );
      expect(lastRecoveryAttempt.status).toBe(201);
      const lastConfirmation = await request(app)
        .post(`/api/v1/incentives/recovery-obligations/${obligation._id}/payments/${lastRecoveryAttempt.body.data.payment._id}/confirm`)
        .set("Authorization", `Bearer ${adminToken}`)
        .set("X-Branch-Id", branchId.toString())
        .send({ confirmActualPayment: true });
      expect(lastConfirmation.status).toBe(200);
      expect(lastConfirmation.body.data.obligation.status).toBe("recovered");
      expect(lastConfirmation.body.data.obligation.totalRecoveredInPaise).toBe(1000);
      expect((await PayrollIncentiveAllocation.findById(allocation._id)).recoveredInPaise).toBe(1000);
    });

    it("allocates each supported commission source once and keeps unapproved categories invalid", async () => {
      const period = await PayrollPeriod.findOne({
        organizationId: orgId,
        monthYear: "2026-11",
        isDeleted: false,
      });
      expect(period).toBeTruthy();

      const staff = await Staff.create({
        name: "All Commission Sources Test",
        email: `commission-sources-${Date.now()}@test.com`,
        phone: `+9197${String(Date.now()).slice(-8)}`,
        organizationId: orgId,
        designation: "Stylist",
        staffCode: `CST-${Date.now()}`,
        joiningDate: period.startDate,
        status: "active",
      });
      await Promise.all([
        StaffBranch.create({
          staffId: staff._id,
          branchId,
          organizationId: orgId,
          isPrimary: true,
          isActive: true,
        }),
        SalaryStructure.create({
          organizationId: orgId,
          staffId: staff._id,
          payType: "fixed_monthly",
          baseSalary: 30000,
          effectiveFrom: period.startDate,
        }),
      ]);

      const sourceTypes = [
        "service_commission",
        "subscription_sale_commission",
        "membership_sale_commission",
        "retail_sale_commission",
      ];
      const accruals = await IncentiveLedger.create(sourceTypes.map((sourceType, index) => ({
        organizationId: orgId,
        branchId,
        staffId: staff._id,
        schemeId: new mongoose.Types.ObjectId(),
        entryType: "ACCRUAL",
        sourceType,
        settlementEventId: new mongoose.Types.ObjectId(),
        invoiceId: new mongoose.Types.ObjectId(),
        lineItemId: new mongoose.Types.ObjectId(),
        fulfillmentStatus: sourceType === "service_commission" ? "confirmed" : "not_applicable",
        sourceRevenueInPaise: 100000,
        attributedRevenueInPaise: 100000,
        amountInPaise: 1000,
        idempotencyKey: `all-commission-sources-${staff._id}-${index}`,
        createdAt: new Date("2026-11-10T00:00:00.000Z"),
      })));

      const calculated = await request(app)
        .post("/api/v1/payroll/calculate")
        .set("Authorization", `Bearer ${adminToken}`)
        .set("X-Branch-Id", branchId.toString())
        .send({ payrollPeriodId: period._id.toString(), staffIds: [staff._id.toString()] });
      expect(calculated.status).toBe(200);
      const record = calculated.body.data.find((item) => item.staffId === staff._id.toString());
      expect(record.incentiveLedgerGrossInPaise).toBe(4000);
      expect(record.incentiveLedgerAmountInPaise).toBe(4000);

      const approved = await request(app)
        .post(`/api/v1/payroll/records/${record._id}/approve`)
        .set("Authorization", `Bearer ${adminToken}`)
        .set("X-Branch-Id", branchId.toString())
        .send();
      expect(approved.status).toBe(200);
      const allocations = await PayrollIncentiveAllocation.find({
        organizationId: orgId,
        incentiveLedgerId: { $in: accruals.map((entry) => entry._id) },
      }).sort({ sourceType: 1 });
      expect(allocations).toHaveLength(sourceTypes.length);
      expect(allocations.map((allocation) => allocation.sourceType).sort()).toEqual(
        [...sourceTypes].sort(),
      );
      expect(allocations.every((allocation) =>
        allocation.payableAmountInPaise === 1000 &&
        allocation.payrollPeriodId.toString() === period._id.toString() &&
        allocation.sourceBranchId.toString() === branchId.toString(),
      )).toBe(true);

      const paymentAttempt = await request(app)
        .post(`/api/v1/payroll/records/${record._id}/pay`)
        .set("Authorization", `Bearer ${adminToken}`)
        .set("X-Branch-Id", branchId.toString())
        .send({
          paymentMethod: "bank_transfer",
          paymentReference: `ALL-COMMISSION-SOURCES-${record._id}`,
          amountInPaise: Math.round(approved.body.data.calculations.netPayable * 100),
          paymentDate: period.endDate.toISOString(),
          idempotencyKey: `all-commission-sources-payment-${record._id}`,
        });
      expect(paymentAttempt.status).toBe(201);
      expect(paymentAttempt.body.data.record.status).toBe("approved");
      const confirmed = await request(app)
        .post(`/api/v1/payroll/records/${record._id}/payments/${paymentAttempt.body.data.payment._id}/confirm`)
        .set("Authorization", `Bearer ${adminToken}`)
        .set("X-Branch-Id", branchId.toString())
        .send({ confirmActualPayment: true });
      expect(confirmed.status).toBe(200);
      expect(confirmed.body.data.record.status).toBe("paid");
      expect(await PayrollIncentiveAllocation.countDocuments({
        organizationId: orgId,
        incentiveLedgerId: { $in: accruals.map((entry) => entry._id) },
        status: "paid",
      })).toBe(sourceTypes.length);

      const unsupported = new IncentiveLedger({
        ...accruals[0].toObject(),
        _id: undefined,
        sourceType: "subscription_renewal_commission",
        idempotencyKey: `unsupported-renewal-${staff._id}`,
      });
      await expect(unsupported.validate()).rejects.toThrow(
        "subscription_renewal_commission",
      );
    });
  });

  describe("4. Payment Recording & Concurrency Safety", () => {
    let paymentRecordSequence = 0;
    const createApprovedRecord = async () => {
      paymentRecordSequence += 1;
      const month = String(paymentRecordSequence).padStart(2, "0");
      const monthYear = `2027-${month}`;
      const monthNumber = paymentRecordSequence;
      const totalDays = new Date(Date.UTC(2027, monthNumber, 0)).getUTCDate();
      const period = await PayrollPeriod.create({
        organizationId: orgId,
        year: 2027,
        month: monthNumber,
        monthYear,
        startDate: new Date(Date.UTC(2027, monthNumber - 1, 1)),
        endDate: new Date(Date.UTC(2027, monthNumber, 0, 23, 59, 59, 999)),
        totalDays,
        status: "open",
      });
      const evaluation = await IncentiveEvaluation.create({
        organizationId: orgId,
        branchId,
        staffId: testStaff._id,
        schemeId: new mongoose.Types.ObjectId(),
        monthYear,
        evaluationType: "ATTENDANCE_BONUS",
        status: "finalized",
        bonusAwardedInPaise: 1234,
        isTargetMet: true,
        finalizedBy: adminUser._id,
        finalizedAt: new Date(),
      });
      return PayrollRecord.create({
        organizationId: orgId,
        branchId,
        payrollPeriodId: period._id,
        staffId: testStaff._id,
        monthYear,
        status: "approved",
        salaryStructureSnapshot: {
          payType: "fixed_monthly",
          baseSalary: 30000,
          hourlyRate: 0,
          allowances: [],
          deductions: [],
        },
        attendanceSummarySnapshot: {
          totalDaysInMonth: 31,
          eligibleDays: 31,
          presentDays: 31,
          lateDays: 0,
          earlyDepartureDays: 0,
          incompleteDays: 0,
          unresolvedConflicts: 0,
          paidLeaveDays: 0,
          unpaidLeaveDays: 0,
          absentDays: 0,
        },
        incentiveEvaluationIds: [evaluation._id],
        incentiveAmountInPaise: evaluation.bonusAwardedInPaise,
        calculations: {
          prorationFactor: 1,
          grossBaseSalary: 30000,
          totalAllowances: 0,
          totalGrossPay: 30012.34,
          unpaidLeaveDeduction: 0,
          fixedDeductions: 0,
          totalAdjustmentsEarning: 0,
          totalAdjustmentsDeduction: 0,
          totalIncentivesInPaise: evaluation.bonusAwardedInPaise,
          totalDeductions: 0,
          netPayable: 30012.34,
        },
        approvalBlocked: false,
        approvalBlockReasons: [],
        manualPaymentStatus: "none",
        manualPaymentId: null,
        manualPaymentAmountInPaise: null,
        paymentMethod: null,
        paymentReference: null,
        disbursedAt: null,
        disbursedBy: null,
        createdBy: adminUser._id,
        updatedBy: adminUser._id,
      });
    };

    const recordPayment = (recordId, idempotencyKey, amountInPaise) =>
      request(app)
        .post(`/api/v1/payroll/records/${recordId}/pay`)
        .set("Authorization", `Bearer ${adminToken}`)
        .send({
          paymentMethod: "bank_transfer",
          paymentReference: `UTR-${idempotencyKey}`,
          amountInPaise,
          paymentDate: "2027-01-15T00:00:00.000Z",
          idempotencyKey,
        });

    it("separates payment recording from settlement confirmation and makes retries/reversals idempotent", async () => {
      const record = await createApprovedRecord();
      const amountInPaise = Math.round(record.calculations.netPayable * 100);
      const idempotencyKey = `pay-${record._id.toString()}`;
      const recorded = await recordPayment(record._id, idempotencyKey, amountInPaise);

      expect(recorded.status).toBe(201);
      expect(recorded.body.data.record.status).toBe("approved");
      expect(recorded.body.data.record.manualPaymentStatus).toBe("recorded");
      expect(recorded.body.data.payment.status).toBe("recorded");
      expect(recorded.body.data.payment.incentiveAmountInPaise).toBe(1234);
      expect(recorded.body.data.payment.incentiveEvaluationIds).toContain(
        record.incentiveEvaluationIds[0].toString(),
      );
      expect(recorded.body.data.record.disbursedAt).toBeNull();

      const notSettled = await PayrollRecord.findById(record._id);
      expect(notSettled.status).toBe("approved");
      expect(notSettled.manualPaymentStatus).toBe("recorded");

      const paymentId = recorded.body.data.payment._id;
      const confirmed = await request(app)
        .post(`/api/v1/payroll/records/${record._id}/payments/${paymentId}/confirm`)
        .set("Authorization", `Bearer ${adminToken}`)
        .send({ confirmActualPayment: true });

      expect(confirmed.status).toBe(200);
      expect(confirmed.body.data.record.status).toBe("paid");
      expect(confirmed.body.data.record.manualPaymentStatus).toBe("confirmed");
      expect(confirmed.body.data.payment.status).toBe("confirmed");
      expect(confirmed.body.data.record.disbursedBy).toBe(adminUser._id.toString());

      const details = await request(app)
        .get(`/api/v1/payroll/records/${record._id}`)
        .set("Authorization", `Bearer ${adminToken}`);
      expect(details.status).toBe(200);
      expect(details.body.data.latestPaymentAttempt.status).toBe("confirmed");
      expect(details.body.data.paymentHistory[0].history.map((event) => event.action)).toEqual([
        "recorded",
        "confirmed",
      ]);

      const replayedPayment = await recordPayment(record._id, idempotencyKey, amountInPaise);
      expect(replayedPayment.status).toBe(200);
      expect(replayedPayment.body.data.isIdempotentReplay).toBe(true);

      const replayedConfirmation = await request(app)
        .post(`/api/v1/payroll/records/${record._id}/payments/${paymentId}/confirm`)
        .set("Authorization", `Bearer ${adminToken}`)
        .send({ confirmActualPayment: true });
      expect(replayedConfirmation.status).toBe(200);
      expect(replayedConfirmation.body.data.isIdempotentReplay).toBe(true);
      expect(await PayrollPayment.countDocuments({ organizationId: orgId, payrollRecordId: record._id })).toBe(1);

      const reversed = await request(app)
        .post(`/api/v1/payroll/records/${record._id}/reverse`)
        .set("Authorization", `Bearer ${adminToken}`)
        .send({ reversalReason: "Payment was confirmed against the wrong account" });
      expect(reversed.status).toBe(200);
      expect(reversed.body.data.status).toBe("approved");
      expect(reversed.body.data.manualPaymentStatus).toBe("reversed");
      expect(reversed.body.payment.status).toBe("reversed");

      const reversalReplay = await request(app)
        .post(`/api/v1/payroll/records/${record._id}/reverse`)
        .set("Authorization", `Bearer ${adminToken}`)
        .send({ reversalReason: "Payment was confirmed against the wrong account" });
      expect(reversalReplay.status).toBe(200);
      expect(reversalReplay.body.isIdempotentReplay).toBe(true);
      expect(await PayrollPayment.countDocuments({ organizationId: orgId, payrollRecordId: record._id })).toBe(1);
    });

    it("keeps failed payments unsettled, supports a new idempotent attempt, and rejects duplicate pending attempts", async () => {
      const record = await createApprovedRecord();
      const amountInPaise = Math.round(record.calculations.netPayable * 100);
      const concurrentAttempts = await Promise.all([
        recordPayment(record._id, `attempt-${record._id}-1`, amountInPaise),
        recordPayment(record._id, `attempt-${record._id}-2`, amountInPaise),
      ]);
      expect(concurrentAttempts.map((attempt) => attempt.status).sort()).toEqual([201, 409]);
      const firstAttempt = concurrentAttempts.find((attempt) => attempt.status === 201);
      expect(firstAttempt).toBeTruthy();
      expect(firstAttempt.status).toBe(201);

      const firstPaymentId = firstAttempt.body.data.payment._id;
      const failed = await request(app)
        .post(`/api/v1/payroll/records/${record._id}/payments/${firstPaymentId}/fail`)
        .set("Authorization", `Bearer ${adminToken}`)
        .send({ failureReason: "Bank rejected beneficiary account" });
      expect(failed.status).toBe(200);
      expect(failed.body.data.record.status).toBe("approved");
      expect(failed.body.data.record.manualPaymentStatus).toBe("failed");
      expect(failed.body.data.payment.status).toBe("failed");

      const retry = await recordPayment(record._id, `attempt-${record._id}-3`, amountInPaise);
      expect(retry.status).toBe(201);
      expect(retry.body.data.payment._id).not.toBe(firstPaymentId);
      expect(await PayrollPayment.countDocuments({ organizationId: orgId, payrollRecordId: record._id })).toBe(2);
    });

    it("rejects amounts that do not exactly match the payroll payable", async () => {
      const record = await createApprovedRecord();
      const expectedAmountInPaise = Math.round(record.calculations.netPayable * 100);
      const res = await recordPayment(
        record._id,
        `wrong-${record._id}`,
        expectedAmountInPaise + 1,
      );
      expect(res.status).toBe(400);
      expect(res.body.message).toContain("exact payroll payable amount");
      expect(await PayrollPayment.countDocuments({ organizationId: orgId, payrollRecordId: record._id })).toBe(0);
    });

    it("reverses a paid record with an audited reason", async () => {
      const record = await createApprovedRecord();
      await PayrollRecord.updateOne(
        { _id: record._id, organizationId: orgId },
        {
          $set: {
            status: "paid",
            paymentMethod: "bank_transfer",
            paymentReference: "LEGACY_SETTLEMENT",
            disbursedAt: new Date(),
            disbursedBy: adminUser._id,
          },
        },
      );
      const res = await request(app)
        .post(`/api/v1/payroll/records/${record._id}/reverse`)
        .set("Authorization", `Bearer ${adminToken}`)
        .send({
          reversalReason: "Disputed leave day requires recalculation",
        });

      expect(res.status).toBe(200);
      expect(res.body.success).toBe(true);
      expect(res.body.data.status).toBe("approved");
      expect(res.body.data.reversalReason).toBe(
        "Disputed leave day requires recalculation"
      );
    });

    it("generates and downloads a payslip PDF for authorized users and denies unauthorized staff", async () => {
      const record = await PayrollRecord.findOne({
        organizationId: orgId,
        staffId: testStaff._id,
        monthYear: "2026-11",
      });

      // 1. Staff viewer without payroll.export -> Denied with 403
      const unauthorizedRes = await request(app)
        .get(`/api/v1/payroll/records/${record._id}/payslip-pdf`)
        .set("Authorization", `Bearer ${staffToken}`);
      expect(unauthorizedRes.status).toBe(403);

      // 2. Authorized user with payroll.export (Admin or Manager) -> 200 with PDF
      const res = await request(app)
        .get(`/api/v1/payroll/records/${record._id}/payslip-pdf`)
        .set("Authorization", `Bearer ${adminToken}`);

      expect(res.status).toBe(200);
      expect(res.headers["content-type"]).toBe("application/pdf");
      expect(res.headers["content-disposition"]).toContain("payslip-2026-11");
      expect(res.body).toBeDefined();
    });

    it("supports draft manual adjustments with automatic recalculation and audit trail", async () => {
      // 1. Create a draft record for another staff or period
      const draftRecord = await PayrollRecord.create({
        organizationId: orgId,
        branchId,
        payrollPeriodId: new mongoose.Types.ObjectId(),
        staffId: testStaff._id,
        monthYear: "2026-12",
        status: "draft",
        salaryStructureSnapshot: {
          baseSalary: 30000,
          payType: "fixed_monthly",
          allowances: [],
          deductions: [],
        },
        attendanceSummarySnapshot: {
          totalDaysInMonth: 31,
          eligibleDays: 31,
          presentDays: 31,
          lateDays: 0,
          earlyDepartureDays: 0,
          incompleteDays: 0,
          unresolvedConflicts: 0,
          paidLeaveDays: 0,
          unpaidLeaveDays: 0,
          absentDays: 0,
        },
        calculations: {
          prorationFactor: 1,
          grossBaseSalary: 30000,
          totalAllowances: 0,
          totalGrossPay: 30000,
          unpaidLeaveDeduction: 0,
          fixedDeductions: 0,
          totalDeductions: 0,
          netPayable: 30000,
        },
        approvalBlocked: false,
        createdBy: adminUser._id,
        updatedBy: adminUser._id,
      });

      // 2. Add an earning adjustment (e.g. +1500)
      const resEarning = await request(app)
        .post(`/api/v1/payroll/records/${draftRecord._id}/adjust`)
        .set("Authorization", `Bearer ${adminToken}`)
        .send({
          type: "earning",
          amount: 1500,
          reason: "Holiday shift incentive",
          reference: "HR-INC-101",
        });

      if (resEarning.status !== 200) {
        console.error("Adjustment response error:", resEarning.body);
      }

      expect(resEarning.status).toBe(200);
      expect(resEarning.body.data.calculations.totalGrossPay).toBe(31500);
      expect(resEarning.body.data.calculations.netPayable).toBe(31500);
      expect(resEarning.body.data.adjustments.length).toBe(1);
      expect(resEarning.body.data.adjustments[0].reason).toBe("Holiday shift incentive");

      // 3. Add a deduction adjustment (e.g. -500)
      const resDeduction = await request(app)
        .post(`/api/v1/payroll/records/${draftRecord._id}/adjust`)
        .set("Authorization", `Bearer ${adminToken}`)
        .send({
          type: "deduction",
          amount: 500,
          reason: "Uniform damage fee",
        });

      expect(resDeduction.status).toBe(200);
      expect(resDeduction.body.data.calculations.totalDeductions).toBe(500);
      expect(resDeduction.body.data.calculations.netPayable).toBe(31000);
      expect(resDeduction.body.data.adjustments.length).toBe(2);

      // Clean up test record
      await PayrollRecord.deleteOne({ _id: draftRecord._id });
    });

    it("rejects overlapping future salary structures", async () => {
      const res = await request(app)
        .post("/api/v1/payroll/structures")
        .set("Authorization", `Bearer ${adminToken}`)
        .send({
          staffId: testStaff._id.toString(),
          payType: "fixed_monthly",
          baseSalary: 45000,
          effectiveFrom: "2026-06-01",
          effectiveTo: "2026-05-01", // Invalid: toDate < fromDate
        });

      expect(res.status).toBe(400);
      expect(res.body.message).toContain("Effective-to date must be strictly after effective-from date");
    });

    it("enforces strict least-privilege: denies manager approval, payment, and reversal (HTTP 403)", async () => {
      // 1. Create a draft record
      const testRecord = await PayrollRecord.create({
        organizationId: orgId,
        branchId,
        payrollPeriodId: new mongoose.Types.ObjectId(),
        staffId: testStaff._id,
        monthYear: "2026-10",
        status: "draft",
        salaryStructureSnapshot: {
          baseSalary: 25000,
          payType: "fixed_monthly",
          allowances: [],
          deductions: [],
        },
        attendanceSummarySnapshot: {
          totalDaysInMonth: 31,
          eligibleDays: 31,
          presentDays: 31,
          lateDays: 0,
          earlyDepartureDays: 0,
          incompleteDays: 0,
          unresolvedConflicts: 0,
          paidLeaveDays: 0,
          unpaidLeaveDays: 0,
          absentDays: 0,
        },
        calculations: {
          prorationFactor: 1,
          grossBaseSalary: 25000,
          totalAllowances: 0,
          totalGrossPay: 25000,
          unpaidLeaveDeduction: 0,
          fixedDeductions: 0,
          totalDeductions: 0,
          netPayable: 25000,
        },
        approvalBlocked: false,
        createdBy: adminUser._id,
        updatedBy: adminUser._id,
      });

      // 2. Manager attempts to approve -> Denied with 403 (requires payroll.approve)
      const approveRes = await request(app)
        .post(`/api/v1/payroll/records/${testRecord._id}/approve`)
        .set("Authorization", `Bearer ${managerToken}`);
      expect(approveRes.status).toBe(403);
      expect(approveRes.body.message).toContain("Access denied");

      // 3. Manager attempts to pay -> Denied with 403 (requires payroll.disburse)
      const payRes = await request(app)
        .post(`/api/v1/payroll/records/${testRecord._id}/pay`)
        .set("Authorization", `Bearer ${managerToken}`)
        .send({
          paymentMethod: "bank_transfer",
          paymentReference: "MGR-ATTEMPT",
        });
      expect(payRes.status).toBe(403);

      const confirmRes = await request(app)
        .post(`/api/v1/payroll/records/${testRecord._id}/payments/${new mongoose.Types.ObjectId()}/confirm`)
        .set("Authorization", `Bearer ${managerToken}`)
        .send({ confirmActualPayment: true });
      expect(confirmRes.status).toBe(403);

      // 4. Manager attempts to reverse -> Denied with 403 (requires payroll.reverse)
      const revRes = await request(app)
        .post(`/api/v1/payroll/records/${testRecord._id}/reverse`)
        .set("Authorization", `Bearer ${managerToken}`)
        .send({
          reversalReason: "Manager unauthorized cancel",
        });
      expect(revRes.status).toBe(403);

      const managerRecords = await request(app)
        .get("/api/v1/payroll/records")
        .set("Authorization", `Bearer ${managerToken}`)
        .set("X-Branch-Id", branchId.toString());
      expect(managerRecords.status).toBe(200);

      const unassignedBranch = await Branch.create({
        name: "Restricted Payroll Branch",
        code: `RPB-${Date.now()}`,
        organizationId: orgId,
        isActive: true,
      });
      const deniedBranchRecords = await request(app)
        .get("/api/v1/payroll/records")
        .set("Authorization", `Bearer ${managerToken}`)
        .set("X-Branch-Id", unassignedBranch._id.toString());
      expect(deniedBranchRecords.status).toBe(403);
      await Branch.deleteOne({ _id: unassignedBranch._id });

      // Clean up
      await PayrollRecord.deleteOne({ _id: testRecord._id });
    });

    it("verifies multi-tenant and multi-branch data isolation and blocked count in KPI summary", async () => {
      // 1. Create a second organization and second branch
      const secondOrg = await Organization.create({
        name: "Rival Salon Org",
        code: "RSO-" + Date.now(),
        email: `rival-${Date.now()}@test.com`,
      });
      const secondBranch = await Branch.create({
        name: "Rival Branch",
        code: "RB-" + Date.now(),
        organizationId: secondOrg._id,
        isActive: true,
      });

      // 2. Create record in second org
      await PayrollRecord.create({
        organizationId: secondOrg._id,
        branchId: secondBranch._id,
        payrollPeriodId: new mongoose.Types.ObjectId(),
        staffId: new mongoose.Types.ObjectId(),
        monthYear: "2026-11",
        status: "draft",
        salaryStructureSnapshot: { baseSalary: 80000, payType: "fixed_monthly", allowances: [], deductions: [] },
        attendanceSummarySnapshot: { totalDaysInMonth: 30, eligibleDays: 30, presentDays: 30, lateDays: 0, earlyDepartureDays: 0, incompleteDays: 0, unresolvedConflicts: 0, paidLeaveDays: 0, unpaidLeaveDays: 0, absentDays: 0 },
        calculations: { prorationFactor: 1, grossBaseSalary: 80000, totalAllowances: 0, totalGrossPay: 80000, unpaidLeaveDeduction: 0, fixedDeductions: 0, totalDeductions: 0, netPayable: 80000 },
        approvalBlocked: true,
        createdBy: adminUser._id,
        updatedBy: adminUser._id,
      });

      // 3. Query records with admin token (scoped to orgId)
      const res = await request(app)
        .get("/api/v1/payroll/records?monthYear=2026-11")
        .set("Authorization", `Bearer ${adminToken}`);

      expect(res.status).toBe(200);
      expect(res.body.success).toBe(true);
      // All returned records must strictly belong to orgId
      for (const rec of res.body.data) {
        expect(rec.organizationId.toString()).toBe(orgId.toString());
      }
      // Server-side summary must NOT include secondOrg's 80,000
      expect(res.body.summary).toBeDefined();
      expect(res.body.summary.blockedCount).toBeDefined();

      // Clean up second org records
      await PayrollRecord.deleteMany({ organizationId: secondOrg._id });
      await Branch.deleteOne({ _id: secondBranch._id });
      await Organization.deleteOne({ _id: secondOrg._id });
    });
  });

  describe("5. Attendance-Driven Payroll & Employee Paid Leave Entitlement", () => {
    it("correctly calculates November mandatory scenario: 15 present, 2 approved leave, 11 consumed of 12 entitlement", async () => {
      // Setup staff member
      const staffMember = await Staff.create({
        name: "Nov Scenario Staff",
        email: `nov-scenario-${Date.now()}@test.com`,
        phone: `+9198${String(Date.now()).slice(-8)}`,
        organizationId: orgId,
        designation: "Senior Stylist",
        staffCode: `NOV-${Date.now()}`,
        joiningDate: new Date("2026-01-01T00:00:00.000Z"),
        status: "active",
      });

      await StaffBranch.create({
        staffId: staffMember._id,
        branchId,
        organizationId: orgId,
        isPrimary: true,
        isActive: true,
      });

      // Salary structure: ₹30,000 base, annual entitlement: 12 days
      await SalaryStructure.create({
        organizationId: orgId,
        staffId: staffMember._id,
        payType: "fixed_monthly",
        baseSalary: 30000,
        paidLeavePolicy: {
          annualEntitlement: 12,
          carryForwardDays: 0,
        },
        allowances: [],
        deductions: [],
        effectiveFrom: new Date("2026-01-01T00:00:00.000Z"),
        isActive: true,
      });

      // Seed 11 prior consumed paid leave days in 2026 before Nov 2026
      await Leave.create({
        organizationId: orgId,
        branchId,
        staffId: staffMember._id,
        leaveCode: `LV-PRIOR-${Date.now()}`,
        leaveType: "Casual Leave",
        startDate: new Date("2026-05-01T00:00:00.000Z"),
        endDate: new Date("2026-05-11T23:59:59.999Z"), // 11 days
        dates: [
          "2026-05-01", "2026-05-02", "2026-05-03", "2026-05-04", "2026-05-05",
          "2026-05-06", "2026-05-07", "2026-05-08", "2026-05-09", "2026-05-10", "2026-05-11"
        ],
        reason: "Prior annual leave",
        status: "approved",
        submittedBy: adminUser._id,
        submittedFor: "staff",
      });

      // Seed 15 present days in November (days 1 to 15)
      for (let d = 1; d <= 15; d++) {
        await Attendance.create({
          organizationId: orgId,
          branchId,
          staffId: staffMember._id,
          attendanceDate: new Date(`2026-11-${d < 10 ? "0" + d : d}T10:00:00.000Z`),
          status: "present",
        });
      }

      // Seed 2 approved leave days in November (Nov 16 and Nov 17)
      await Leave.create({
        organizationId: orgId,
        branchId,
        staffId: staffMember._id,
        leaveCode: `LV-NOV-${Date.now()}`,
        leaveType: "Sick Leave",
        startDate: new Date("2026-11-16T00:00:00.000Z"),
        endDate: new Date("2026-11-17T23:59:59.999Z"), // 2 days
        dates: ["2026-11-16", "2026-11-17"],
        reason: "Medical recovery",
        status: "approved",
        submittedBy: adminUser._id,
        submittedFor: "staff",
      });

      // Days 18-30 (13 days) are absent

      const period = await PayrollPeriod.findOne({ organizationId: orgId, monthYear: "2026-11" });

      const res = await request(app)
        .post("/api/v1/payroll/calculate")
        .set("Authorization", `Bearer ${adminToken}`)
        .send({
          payrollPeriodId: period._id.toString(),
          staffIds: [staffMember._id.toString()],
        });

      expect(res.status).toBe(200);
      expect(res.body.success).toBe(true);

      const rec = res.body.data[0];

      // Verification against mandatory specification:
      // Monthly salary: ₹30,000
      // Period: 30 days -> Daily Rate = ₹1,000
      // Annual paid leave entitlement: 12 days
      // Previously consumed: 11 days
      // Present: 15 days
      // Approved leave: 2 days
      // Expected paid leave: 1 day
      // Expected unpaid leave: 1 day
      // Expected payable days: 16
      // Expected prorated base salary: ₹16,000
      expect(rec.calculations.dailySalaryRate).toBe(1000);
      expect(rec.attendanceSummarySnapshot.paidLeaveEntitlement).toBe(12);
      expect(rec.attendanceSummarySnapshot.previouslyConsumedPaidLeave).toBe(11);
      expect(rec.attendanceSummarySnapshot.presentDays).toBe(15);
      expect(rec.attendanceSummarySnapshot.paidLeaveDays).toBe(1);
      expect(rec.attendanceSummarySnapshot.unpaidLeaveDays).toBe(1);
      expect(rec.attendanceSummarySnapshot.absentDays).toBe(13);
      expect(rec.attendanceSummarySnapshot.payableDays).toBe(16);
      expect(rec.calculations.payableDays).toBe(16);
      expect(rec.calculations.proratedBaseSalary).toBe(16000);
      expect(rec.calculations.grossBaseSalary).toBe(16000);
      expect(rec.calculations.netPayable).toBe(16000);

      // Clean up
      await Leave.deleteMany({ organizationId: orgId, staffId: staffMember._id });
      await Attendance.deleteMany({ organizationId: orgId, staffId: staffMember._id });
      await PayrollRecord.deleteMany({ organizationId: orgId, staffId: staffMember._id });
      await SalaryStructure.deleteMany({ organizationId: orgId, staffId: staffMember._id });
      await StaffBranch.deleteMany({ organizationId: orgId, staffId: staffMember._id });
      await Staff.deleteOne({ _id: staffMember._id });
    });

    it("handles half-day presence, half-day leave, and overlap reconciliation cleanly", async () => {
      const halfStaff = await Staff.create({
        name: "Half Day Staff",
        email: `half-day-${Date.now()}@test.com`,
        phone: `+9198${String(Date.now()).slice(-8)}`,
        organizationId: orgId,
        designation: "Barber",
        staffCode: `HDS-${Date.now()}`,
        joiningDate: new Date("2026-01-01T00:00:00.000Z"),
        status: "active",
      });

      await StaffBranch.create({
        staffId: halfStaff._id,
        branchId,
        organizationId: orgId,
        isPrimary: true,
        isActive: true,
      });

      await SalaryStructure.create({
        organizationId: orgId,
        staffId: halfStaff._id,
        payType: "fixed_monthly",
        baseSalary: 60000, // 2000/day for 30-day period
        paidLeavePolicy: { annualEntitlement: 10, carryForwardDays: 0 },
        allowances: [],
        deductions: [],
        effectiveFrom: new Date("2026-01-01T00:00:00.000Z"),
        isActive: true,
      });

      // 10 full present days
      for (let d = 1; d <= 10; d++) {
        await Attendance.create({
          organizationId: orgId,
          branchId,
          staffId: halfStaff._id,
          attendanceDate: new Date(`2026-11-${d < 10 ? "0" + d : d}T10:00:00.000Z`),
          status: "present",
        });
      }

      // 1 half-day approved leave on Nov 11
      await Leave.create({
        organizationId: orgId,
        branchId,
        staffId: halfStaff._id,
        leaveCode: `LV-HALF-${Date.now()}`,
        leaveType: "Personal Leave",
        startDate: new Date("2026-11-11T00:00:00.000Z"),
        endDate: new Date("2026-11-11T23:59:59.999Z"),
        dates: ["2026-11-11"],
        isPartialDay: true,
        dayPart: "first_half",
        reason: "Half day personal appointment",
        status: "approved",
        submittedBy: adminUser._id,
        submittedFor: "staff",
      });

      const period = await PayrollPeriod.findOne({ organizationId: orgId, monthYear: "2026-11" });

      const res = await request(app)
        .post("/api/v1/payroll/calculate")
        .set("Authorization", `Bearer ${adminToken}`)
        .send({
          payrollPeriodId: period._id.toString(),
          staffIds: [halfStaff._id.toString()],
        });

      expect(res.status).toBe(200);
      const rec = res.body.data[0];

      // 10 present days + 0.5 paid leave day = 10.5 payable days
      // Daily Rate = 60,000 / 30 = 2,000
      // Prorated base salary = 2,000 * 10.5 = 21,000
      expect(rec.calculations.dailySalaryRate).toBe(2000);
      expect(rec.attendanceSummarySnapshot.presentDays).toBe(10);
      expect(rec.attendanceSummarySnapshot.paidLeaveDays).toBe(0.5);
      expect(rec.attendanceSummarySnapshot.payableDays).toBe(10.5);
      expect(rec.calculations.payableDays).toBe(10.5);
      expect(rec.calculations.proratedBaseSalary).toBe(21000);
      expect(rec.calculations.netPayable).toBe(21000);

      // Clean up
      await Leave.deleteMany({ organizationId: orgId, staffId: halfStaff._id });
      await Attendance.deleteMany({ organizationId: orgId, staffId: halfStaff._id });
      await PayrollRecord.deleteMany({ organizationId: orgId, staffId: halfStaff._id });
      await SalaryStructure.deleteMany({ organizationId: orgId, staffId: halfStaff._id });
      await StaffBranch.deleteMany({ organizationId: orgId, staffId: halfStaff._id });
      await Staff.deleteOne({ _id: halfStaff._id });
    });
  });
});
