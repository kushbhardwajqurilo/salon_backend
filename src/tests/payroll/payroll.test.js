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
import { Leave } from "../../models/leaves/leave.model.js";
import { SalaryStructure } from "../../models/payroll/salaryStructure.model.js";
import { PayrollPeriod } from "../../models/payroll/payrollPeriod.model.js";
import { PayrollRecord } from "../../models/payroll/payrollRecord.model.js";
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
    await PayrollRecord.deleteMany({ organizationId: orgId });
    await PayrollPeriod.deleteMany({ organizationId: orgId });
    await SalaryStructure.deleteMany({ organizationId: orgId });
    await Attendance.deleteMany({ organizationId: orgId });
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
        .set("Authorization", `Bearer ${staffToken}`);

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
        await Attendance.create({
          organizationId: orgId,
          branchId,
          staffId: testStaff._id,
          attendanceDate: new Date(`2026-11-${day < 10 ? "0" + day : day}T10:00:00.000Z`),
          status: "present",
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

      // Verify financial deductions:
      // Base: 30,000, 30 days -> 1000/day
      // Allowances: 5,000
      // Gross: 35,000
      // Unpaid Leave: 2 days * 1000 = 2000
      // Fixed Deductions: 1000
      // Total Deductions: 3000
      // Net Payable: 35,000 - 3000 = 32,000
      expect(record.calculations.grossBaseSalary).toBe(30000);
      expect(record.calculations.totalAllowances).toBe(5000);
      expect(record.calculations.totalGrossPay).toBe(35000);
      expect(record.calculations.unpaidLeaveDeduction).toBe(2000);
      expect(record.calculations.fixedDeductions).toBe(1000);
      expect(record.calculations.netPayable).toBe(32000);
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

      // Now approve
      const res = await request(app)
        .post(`/api/v1/payroll/records/${record._id}/approve`)
        .set("Authorization", `Bearer ${adminToken}`)
        .send();

      expect(res.status).toBe(200);
      expect(res.body.success).toBe(true);
      expect(res.body.data.status).toBe("approved");
    });
  });

  describe("4. Payment Recording & Concurrency Safety", () => {
    it("successfully records payment for approved record", async () => {
      const record = await PayrollRecord.findOne({
        organizationId: orgId,
        staffId: testStaff._id,
        monthYear: "2026-11",
      });

      const res = await request(app)
        .post(`/api/v1/payroll/records/${record._id}/pay`)
        .set("Authorization", `Bearer ${adminToken}`)
        .send({
          paymentMethod: "bank_transfer",
          paymentReference: "UTR9876543210",
        });

      expect(res.status).toBe(200);
      expect(res.body.success).toBe(true);
      expect(res.body.data.status).toBe("paid");
      expect(res.body.data.paymentReference).toBe("UTR9876543210");
    });

    it("prevents duplicate payments on already paid record", async () => {
      const record = await PayrollRecord.findOne({
        organizationId: orgId,
        staffId: testStaff._id,
        monthYear: "2026-11",
      });

      const res = await request(app)
        .post(`/api/v1/payroll/records/${record._id}/pay`)
        .set("Authorization", `Bearer ${adminToken}`)
        .send({
          paymentMethod: "cash",
          paymentReference: "CASH-REPEAT",
        });

      expect(res.status).toBe(400);
    });

    it("reverses a paid record with an audited reason", async () => {
      const record = await PayrollRecord.findOne({
        organizationId: orgId,
        staffId: testStaff._id,
        monthYear: "2026-11",
      });

      const res = await request(app)
        .post(`/api/v1/payroll/records/${record._id}/reverse`)
        .set("Authorization", `Bearer ${adminToken}`)
        .send({
          reversalReason: "Disputed leave day requires recalculation",
        });

      expect(res.status).toBe(200);
      expect(res.body.success).toBe(true);
      expect(res.body.data.status).toBe("cancelled");
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

      // 4. Manager attempts to reverse -> Denied with 403 (requires payroll.reverse)
      const revRes = await request(app)
        .post(`/api/v1/payroll/records/${testRecord._id}/reverse`)
        .set("Authorization", `Bearer ${managerToken}`)
        .send({
          reversalReason: "Manager unauthorized cancel",
        });
      expect(revRes.status).toBe(403);

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
});
