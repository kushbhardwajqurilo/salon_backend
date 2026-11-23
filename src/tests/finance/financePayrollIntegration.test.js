import { describe, expect, it, beforeAll, afterAll, jest } from "@jest/globals";
import request from "supertest";
import mongoose from "mongoose";
import jwt from "jsonwebtoken";
import app from "../../../app.mjs";
import { env } from "../../config/env.js";
import { Branch } from "../../models/branches/branch.model.js";
import { User } from "../../models/users/user.model.js";
import { Role } from "../../models/roles/role.model.js";
import { Permission } from "../../models/permissions/permission.model.js";
import { Staff } from "../../models/staff/staff.model.js";
import { StaffBranch } from "../../models/staff/staffBranch.model.js";
import { PayrollPeriod } from "../../models/payroll/payrollPeriod.model.js";
import { PayrollRecord } from "../../models/payroll/payrollRecord.model.js";
import { PayrollPayment } from "../../models/payroll/payrollPayment.model.js";
import { getIsolatedTestMongoUri } from "../testSetup.js";

describe("Finance — Full Payroll Integration & Reconciliation Test Suite", () => {
  jest.setTimeout(45000);

  let orgId;
  let branch1Id;
  let branch2Id;
  let ownerUser;
  let branch1ManagerUser;
  let ownerToken;
  let managerToken;
  let staff1;
  let staff2;
  let staff3;
  let periodNov;

  beforeAll(async () => {
    process.env.NODE_ENV = "test";
    const testUri = getIsolatedTestMongoUri("finance_test");
    if (mongoose.connection.readyState !== 1) {
      await mongoose.connect(testUri);
    }

    orgId = new mongoose.Types.ObjectId();
    branch1Id = new mongoose.Types.ObjectId();
    branch2Id = new mongoose.Types.ObjectId();

    await Branch.create([
      {
        _id: branch1Id,
        organizationId: orgId,
        name: "Finance Integration Branch 1",
        timezone: "Asia/Kolkata",
        isActive: true,
      },
      {
        _id: branch2Id,
        organizationId: orgId,
        name: "Finance Integration Branch 2",
        timezone: "Asia/Kolkata",
        isActive: true,
      },
    ]);

    // Permissions
    const permFinanceView = await Permission.findOneAndUpdate(
      { name: "finance.view" },
      { $setOnInsert: { name: "finance.view", module: "Finance", action: "View", description: "View" } },
      { upsert: true, new: true }
    );
    const permFinanceTxView = await Permission.findOneAndUpdate(
      { name: "finance.transactions.view" },
      { $setOnInsert: { name: "finance.transactions.view", module: "Finance", action: "View", description: "View" } },
      { upsert: true, new: true }
    );
    const permPayrollView = await Permission.findOneAndUpdate(
      { name: "payroll.view" },
      { $setOnInsert: { name: "payroll.view", module: "Payroll", action: "View", description: "View" } },
      { upsert: true, new: true }
    );

    const permPayrollDisburse = await Permission.findOneAndUpdate(
      { name: "payroll.disburse" },
      { $setOnInsert: { name: "payroll.disburse", module: "Payroll", action: "Disburse", description: "Disburse" } },
      { upsert: true, new: true }
    );
    const permPayrollReverse = await Permission.findOneAndUpdate(
      { name: "payroll.reverse" },
      { $setOnInsert: { name: "payroll.reverse", module: "Payroll", action: "Reverse", description: "Reverse" } },
      { upsert: true, new: true }
    );
    const permPayrollApprove = await Permission.findOneAndUpdate(
      { name: "payroll.approve" },
      { $setOnInsert: { name: "payroll.approve", module: "Payroll", action: "Approve", description: "Approve" } },
      { upsert: true, new: true }
    );

    const [ownerRole, managerRole] = await Role.create([
      {
        name: "owner",
        organizationId: orgId,
        permissions: [
          permFinanceView._id,
          permFinanceTxView._id,
          permPayrollView._id,
          permPayrollDisburse._id,
          permPayrollReverse._id,
          permPayrollApprove._id,
        ],
        isCustom: false,
      },
      {
        name: "manager",
        organizationId: orgId,
        permissions: [permFinanceView._id, permFinanceTxView._id, permPayrollView._id],
        isCustom: false,
      },
    ]);

    const runId = Date.now();
    ownerUser = await User.create({
      organizationId: orgId,
      branchAccess: [
        { branchId: branch1Id, branchName: "Finance Integration Branch 1", isActive: true },
        { branchId: branch2Id, branchName: "Finance Integration Branch 2", isActive: true },
      ],
      hasOrgWideAccess: true,
      role: ownerRole._id,
      name: `Finance Owner ${runId}`,
      email: `owner.${runId}@finance-test.internal`,
      phone: `+9198${Math.floor(10000000 + Math.random() * 90000000)}`,
      password: "Password123!",
      isActive: true,
    });

    branch1ManagerUser = await User.create({
      organizationId: orgId,
      branchAccess: [{ branchId: branch1Id, branchName: "Finance Integration Branch 1", isActive: true }],
      role: managerRole._id,
      name: `Finance Manager ${runId}`,
      email: `manager.${runId}@finance-test.internal`,
      phone: `+9198${Math.floor(10000000 + Math.random() * 90000000)}`,
      password: "Password123!",
      isActive: true,
    });

    const secret = env.JWT_SECRET || "test-jwt-secret";
    ownerToken = jwt.sign(
      {
        sub: ownerUser._id.toString(),
        id: ownerUser._id.toString(),
        organizationId: orgId.toString(),
        hasOrgWideAccess: true,
        branchAccess: [
          { branchId: branch1Id.toString(), role: "owner" },
          { branchId: branch2Id.toString(), role: "owner" },
        ],
        permissions: [
          "finance.view",
          "finance.transactions.view",
          "payroll.view",
          "payroll.disburse",
          "payroll.reverse",
          "payroll.approve",
        ],
      },
      secret,
      { expiresIn: "1h" }
    );

    managerToken = jwt.sign(
      {
        sub: branch1ManagerUser._id.toString(),
        id: branch1ManagerUser._id.toString(),
        organizationId: orgId.toString(),
        branchAccess: [{ branchId: branch1Id.toString(), role: "manager" }],
        permissions: ["finance.view", "finance.transactions.view", "payroll.view"],
      },
      secret,
      { expiresIn: "1h" }
    );

    // Staff records
    staff1 = await Staff.create({
      organizationId: orgId,
      primaryBranchId: branch1Id,
      name: "Stylist Alice",
      email: "alice@test.internal",
      phone: "+919900000010",
      staffCode: "STF-FIN-001",
      designation: "Senior Stylist",
      joiningDate: new Date("2026-01-01"),
      status: "active",
      isActive: true,
    });

    staff2 = await Staff.create({
      organizationId: orgId,
      primaryBranchId: branch1Id,
      name: "Stylist Bob",
      email: "bob@test.internal",
      phone: "+919900000020",
      staffCode: "STF-FIN-002",
      designation: "Junior Stylist",
      joiningDate: new Date("2026-01-01"),
      status: "active",
      isActive: true,
    });

    staff3 = await Staff.create({
      organizationId: orgId,
      primaryBranchId: branch2Id,
      name: "Branch 2 Stylist Charlie",
      email: "charlie@test.internal",
      phone: "+919900000030",
      staffCode: "STF-FIN-003",
      designation: "Stylist",
      joiningDate: new Date("2026-01-01"),
      status: "active",
      isActive: true,
    });

    await StaffBranch.create([
      { organizationId: orgId, branchId: branch1Id, staffId: staff1._id, isHomeBranch: true, isActive: true },
      { organizationId: orgId, branchId: branch1Id, staffId: staff2._id, isHomeBranch: true, isActive: true },
      { organizationId: orgId, branchId: branch2Id, staffId: staff3._id, isHomeBranch: true, isActive: true },
    ]);

    periodNov = await PayrollPeriod.create({
      organizationId: orgId,
      year: 2026,
      month: 11,
      monthYear: "2026-11",
      startDate: new Date("2026-11-01T00:00:00.000Z"),
      endDate: new Date("2026-11-30T23:59:59.999Z"),
      totalDays: 30,
      status: "open",
    });
  });

  afterAll(async () => {
    if (mongoose.connection.readyState === 1) {
      await mongoose.connection.close();
    }
  });

  it("1. Finance recognizes salary expense against payroll period: finalized gross equals authoritative cost", async () => {
    // Record 1: Alice, Branch 1, Gross: ₹30,000, Net: ₹28,000, Status: approved
    const rec1 = await PayrollRecord.create({
      organizationId: orgId,
      branchId: branch1Id,
      payrollPeriodId: periodNov._id,
      staffId: staff1._id,
      monthYear: "2026-11",
      status: "approved",
      salaryStructureSnapshot: {
        payType: "monthly",
        baseSalary: 25000,
        hourlyRate: 0,
        allowances: [{ name: "Travel", amount: 5000 }],
        deductions: [{ name: "TDS", amount: 2000 }],
      },
      attendanceSummarySnapshot: {
        totalDaysInMonth: 30,
        eligibleDays: 30,
        presentDays: 30,
        payableDays: 30,
      },
      calculations: {
        prorationFactor: 1,
        grossBaseSalary: 25000,
        totalAllowances: 5000,
        totalGrossPay: 30000,
        unpaidLeaveDeduction: 0,
        fixedDeductions: 2000,
        totalDeductions: 2000,
        netPayable: 28000,
      },
    });

    // Record 2: Bob, Branch 1, Gross: ₹20,000, Net: ₹19,000, Status: approved
    const rec2 = await PayrollRecord.create({
      organizationId: orgId,
      branchId: branch1Id,
      payrollPeriodId: periodNov._id,
      staffId: staff2._id,
      monthYear: "2026-11",
      status: "approved",
      salaryStructureSnapshot: {
        payType: "monthly",
        baseSalary: 20000,
        hourlyRate: 0,
        allowances: [],
        deductions: [{ name: "PF", amount: 1000 }],
      },
      attendanceSummarySnapshot: {
        totalDaysInMonth: 30,
        eligibleDays: 30,
        presentDays: 30,
        payableDays: 30,
      },
      calculations: {
        prorationFactor: 1,
        grossBaseSalary: 20000,
        totalAllowances: 0,
        totalGrossPay: 20000,
        unpaidLeaveDeduction: 0,
        fixedDeductions: 1000,
        totalDeductions: 1000,
        netPayable: 19000,
      },
    });

    // Query Operating Profit P&L for Branch 1 in Nov 2026
    const res = await request(app)
      .get("/api/v1/finance/operating-profit?startDate=2026-11-01&endDate=2026-11-30")
      .set("Authorization", `Bearer ${managerToken}`)
      .set("x-branch-id", branch1Id.toString());

    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);

    const workforce = res.body.data.workforceCosts;
    // Expected recognized gross payroll: ₹30,000 + ₹20,000 = ₹50,000
    expect(workforce.finalizedGrossPayroll).toBe(50000);
    expect(workforce.approvedStaffCount).toBe(2);
    // At this stage, no payments confirmed yet -> cash disbursed should be 0
    expect(workforce.actualDisbursedPayroll).toBe(0);
  });

  it("2. Outstanding obligations: unconfirmed or missing disbursements reflect 100% of net payables", async () => {
    // Branch 1 net payables: Alice (₹28,000) + Bob (₹19,000) = ₹47,000
    const resAlerts = await request(app)
      .get("/api/v1/finance/overview-alerts")
      .set("Authorization", `Bearer ${managerToken}`)
      .set("x-branch-id", branch1Id.toString());

    expect(resAlerts.status).toBe(200);
    expect(resAlerts.body.success).toBe(true);
    expect(resAlerts.body.data.outstandingPayrollObligations.count).toBe(2);
    expect(resAlerts.body.data.outstandingPayrollObligations.totalUnpaidAmount).toBe(47000);
  });

  it("3. Actual cash disbursements: confirmed payments record cash outflow; partial payments reduce obligations accurately", async () => {
    const recAlice = await PayrollRecord.findOne({ staffId: staff1._id, monthYear: "2026-11" });
    expect(recAlice).toBeTruthy();

    // Partial disbursement 1 for Alice: ₹15,000 (1,500,000 paise) confirmed on 2026-11-15
    await PayrollPayment.create({
      organizationId: orgId,
      branchId: branch1Id,
      payrollRecordId: recAlice._id,
      staffId: staff1._id,
      source: "MANUAL",
      amountInPaise: 1500000, // ₹15,000
      paymentMethod: "bank_transfer",
      paymentReference: "PAY-ALICE-PART-1",
      paymentDate: new Date("2026-11-15T10:00:00.000Z"),
      status: "confirmed",
      idempotencyKey: "IDEMP-ALICE-P1",
      requestPayloadHash: "HASH1",
      recordedBy: ownerUser._id,
      recordedAt: new Date("2026-11-15T10:00:00.000Z"),
    });

    // Check Operating Profit: cash disbursed is now ₹15,000
    const resPnl = await request(app)
      .get("/api/v1/finance/operating-profit?startDate=2026-11-01&endDate=2026-11-30")
      .set("Authorization", `Bearer ${managerToken}`)
      .set("x-branch-id", branch1Id.toString());

    expect(resPnl.body.data.workforceCosts.actualDisbursedPayroll).toBe(15000);
    expect(resPnl.body.data.workforceCosts.disbursedPaymentsCount).toBe(1);

    // Check Outstanding obligations:
    // Alice remaining = ₹28,000 - ₹15,000 = ₹13,000
    // Bob remaining = ₹19,000
    // Total obligation = ₹32,000
    const resAlerts = await request(app)
      .get("/api/v1/finance/overview-alerts")
      .set("Authorization", `Bearer ${managerToken}`)
      .set("x-branch-id", branch1Id.toString());

    expect(resAlerts.body.data.outstandingPayrollObligations.totalUnpaidAmount).toBe(32000);
    expect(resAlerts.body.data.outstandingPayrollObligations.count).toBe(2);
  });

  it("4. In-flight and failed payments: do NOT reduce obligations or count towards cash outflow", async () => {
    const recAlice = await PayrollRecord.findOne({ staffId: staff1._id, monthYear: "2026-11" });

    // Payment in recorded status (in-flight, not confirmed)
    await PayrollPayment.create({
      organizationId: orgId,
      branchId: branch1Id,
      payrollRecordId: recAlice._id,
      staffId: staff1._id,
      source: "MANUAL",
      amountInPaise: 1300000, // ₹13,000
      paymentMethod: "bank_transfer",
      paymentReference: "PAY-ALICE-INFLIGHT",
      paymentDate: new Date("2026-11-16T10:00:00.000Z"),
      status: "recorded",
      idempotencyKey: "IDEMP-ALICE-INFLIGHT",
      requestPayloadHash: "HASH2",
      recordedBy: ownerUser._id,
      recordedAt: new Date("2026-11-16T10:00:00.000Z"),
    });

    // Failed payment attempt
    await PayrollPayment.create({
      organizationId: orgId,
      branchId: branch1Id,
      payrollRecordId: recAlice._id,
      staffId: staff1._id,
      source: "MANUAL",
      amountInPaise: 1300000,
      paymentMethod: "bank_transfer",
      paymentReference: "PAY-ALICE-FAILED",
      paymentDate: new Date("2026-11-17T10:00:00.000Z"),
      status: "failed",
      idempotencyKey: "IDEMP-ALICE-FAILED",
      requestPayloadHash: "HASH3",
      recordedBy: ownerUser._id,
      recordedAt: new Date("2026-11-17T10:00:00.000Z"),
    });

    // Verification: disbursed amount remains ₹15,000, obligation remains ₹32,000
    const resPnl = await request(app)
      .get("/api/v1/finance/operating-profit?startDate=2026-11-01&endDate=2026-11-30")
      .set("Authorization", `Bearer ${managerToken}`)
      .set("x-branch-id", branch1Id.toString());

    expect(resPnl.body.data.workforceCosts.actualDisbursedPayroll).toBe(15000);

    const resAlerts = await request(app)
      .get("/api/v1/finance/overview-alerts")
      .set("Authorization", `Bearer ${managerToken}`)
      .set("x-branch-id", branch1Id.toString());

    expect(resAlerts.body.data.outstandingPayrollObligations.totalUnpaidAmount).toBe(32000);
  });

  it("5. Payment reversals: restored liability is accurately reflected in Finance obligations", async () => {
    const recBob = await PayrollRecord.findOne({ staffId: staff2._id, monthYear: "2026-11" });

    // Bob payment recorded as reversed
    await PayrollPayment.create({
      organizationId: orgId,
      branchId: branch1Id,
      payrollRecordId: recBob._id,
      staffId: staff2._id,
      source: "MANUAL",
      amountInPaise: 1900000, // ₹19,000
      paymentMethod: "upi",
      paymentReference: "PAY-BOB-REV",
      paymentDate: new Date("2026-11-18T10:00:00.000Z"),
      status: "reversed",
      idempotencyKey: "IDEMP-BOB-REV",
      requestPayloadHash: "HASH4",
      recordedBy: ownerUser._id,
      recordedAt: new Date("2026-11-18T10:00:00.000Z"),
      reversedBy: ownerUser._id,
      reversedAt: new Date("2026-11-19T10:00:00.000Z"),
      reversalReason: "Account frozen",
    });

    // Outflow must not include reversed payment, and Bob's ₹19,000 remains 100% outstanding
    const resPnl = await request(app)
      .get("/api/v1/finance/operating-profit?startDate=2026-11-01&endDate=2026-11-30")
      .set("Authorization", `Bearer ${managerToken}`)
      .set("x-branch-id", branch1Id.toString());

    expect(resPnl.body.data.workforceCosts.actualDisbursedPayroll).toBe(15000);

    const resAlerts = await request(app)
      .get("/api/v1/finance/overview-alerts")
      .set("Authorization", `Bearer ${managerToken}`)
      .set("x-branch-id", branch1Id.toString());

    expect(resAlerts.body.data.outstandingPayrollObligations.totalUnpaidAmount).toBe(32000);
  });

  it("6. Complete settlement: confirming remaining payments brings obligations to zero", async () => {
    const recAlice = await PayrollRecord.findOne({ staffId: staff1._id, monthYear: "2026-11" });
    const recBob = await PayrollRecord.findOne({ staffId: staff2._id, monthYear: "2026-11" });

    // Alice final payment ₹13,000 confirmed
    await PayrollPayment.create({
      organizationId: orgId,
      branchId: branch1Id,
      payrollRecordId: recAlice._id,
      staffId: staff1._id,
      source: "MANUAL",
      amountInPaise: 1300000, // ₹13,000
      paymentMethod: "bank_transfer",
      paymentReference: "PAY-ALICE-FINAL",
      paymentDate: new Date("2026-11-20T10:00:00.000Z"),
      status: "confirmed",
      idempotencyKey: "IDEMP-ALICE-FINAL",
      requestPayloadHash: "HASH5",
      recordedBy: ownerUser._id,
      recordedAt: new Date("2026-11-20T10:00:00.000Z"),
    });

    // Bob payment ₹19,000 confirmed
    await PayrollPayment.create({
      organizationId: orgId,
      branchId: branch1Id,
      payrollRecordId: recBob._id,
      staffId: staff2._id,
      source: "MANUAL",
      amountInPaise: 1900000, // ₹19,000
      paymentMethod: "bank_transfer",
      paymentReference: "PAY-BOB-CONFIRMED",
      paymentDate: new Date("2026-11-20T10:00:00.000Z"),
      status: "confirmed",
      idempotencyKey: "IDEMP-BOB-CONF",
      requestPayloadHash: "HASH6",
      recordedBy: ownerUser._id,
      recordedAt: new Date("2026-11-20T10:00:00.000Z"),
    });

    // Update records status to paid
    await PayrollRecord.updateMany({ _id: { $in: [recAlice._id, recBob._id] } }, { $set: { status: "paid" } });

    // Now total cash disbursed = 15,000 + 13,000 + 19,000 = ₹47,000
    const resPnl = await request(app)
      .get("/api/v1/finance/operating-profit?startDate=2026-11-01&endDate=2026-11-30")
      .set("Authorization", `Bearer ${managerToken}`)
      .set("x-branch-id", branch1Id.toString());

    expect(resPnl.body.data.workforceCosts.actualDisbursedPayroll).toBe(47000);
    expect(resPnl.body.data.workforceCosts.disbursedPaymentsCount).toBe(3);

    // Outstanding obligations should now be 0
    const resAlerts = await request(app)
      .get("/api/v1/finance/overview-alerts")
      .set("Authorization", `Bearer ${managerToken}`)
      .set("x-branch-id", branch1Id.toString());

    expect(resAlerts.body.data.outstandingPayrollObligations.totalUnpaidAmount).toBe(0);
    expect(resAlerts.body.data.outstandingPayrollObligations.count).toBe(0);
  });

  it("7. Unified Transaction Register: confirms payroll payments appear with correct sourceModel and categorization", async () => {
    const resTx = await request(app)
      .get("/api/v1/finance/transactions?startDate=2026-11-01&endDate=2026-11-30&type=payroll_payment")
      .set("Authorization", `Bearer ${managerToken}`)
      .set("x-branch-id", branch1Id.toString());

    expect(resTx.status).toBe(200);
    expect(resTx.body.success).toBe(true);

    const txs = resTx.body.items;
    // Should contain the confirmed, recorded, failed, and reversed payments
    expect(txs.length).toBeGreaterThanOrEqual(3);
    const confirmedTx = txs.find((t) => t.referenceNumber === "PAY-ALICE-PART-1");
    expect(confirmedTx).toBeDefined();
    expect(confirmedTx.category).toBe("Payroll");
    expect(confirmedTx.direction).toBe("outflow");
    expect(confirmedTx.sourceModel).toBe("PayrollPayment");
    expect(confirmedTx.amount).toBe(15000);
  });

  it("8. Multi-Branch Isolation & Org-Wide Aggregation", async () => {
    // Charlie in Branch 2: Gross ₹35,000, Net ₹32,000, Status: approved (unpaid)
    await PayrollRecord.create({
      organizationId: orgId,
      branchId: branch2Id,
      payrollPeriodId: periodNov._id,
      staffId: staff3._id,
      monthYear: "2026-11",
      status: "approved",
      salaryStructureSnapshot: {
        payType: "monthly",
        baseSalary: 35000,
        hourlyRate: 0,
        allowances: [],
        deductions: [{ name: "TDS", amount: 3000 }],
      },
      attendanceSummarySnapshot: {
        totalDaysInMonth: 30,
        eligibleDays: 30,
        presentDays: 30,
        payableDays: 30,
      },
      calculations: {
        prorationFactor: 1,
        grossBaseSalary: 35000,
        totalAllowances: 0,
        totalGrossPay: 35000,
        unpaidLeaveDeduction: 0,
        fixedDeductions: 3000,
        totalDeductions: 3000,
        netPayable: 32000,
      },
    });

    // Branch 1 Manager inspecting Branch 1: only sees Branch 1's ₹50,000 gross payroll
    const resMgr = await request(app)
      .get("/api/v1/finance/operating-profit?startDate=2026-11-01&endDate=2026-11-30")
      .set("Authorization", `Bearer ${managerToken}`)
      .set("x-branch-id", branch1Id.toString());

    expect(resMgr.body.data.workforceCosts.finalizedGrossPayroll).toBe(50000);

    // Salon Owner with org-wide scope inspecting branch performance matrix (no x-branch-id header -> org-wide)
    const resOwnerMatrix = await request(app)
      .get("/api/v1/finance/branch-performance?startDate=2026-11-01&endDate=2026-11-30")
      .set("Authorization", `Bearer ${ownerToken}`);

    expect(resOwnerMatrix.status).toBe(200);
    const branches = resOwnerMatrix.body.data.branches;
    const b1 = branches.find((b) => b.branchId === branch1Id.toString());
    const b2 = branches.find((b) => b.branchId === branch2Id.toString());

    expect(b1).toBeDefined();
    expect(b2).toBeDefined();
    expect(b1.finalizedGrossPayroll).toBe(50000);
    expect(b2.finalizedGrossPayroll).toBe(35000);

    // Consolidated organization gross payroll = ₹50,000 + ₹35,000 = ₹85,000
    expect(resOwnerMatrix.body.data.consolidated.finalizedGrossPayroll).toBe(85000);
  });

  describe("9. Critical Payroll Reversal Accounting & Concurrency Verification", () => {
    let recReversalStaff;
    let staffReversal;

    beforeAll(async () => {
      // Create dedicated staff member for reversal verification:
      // Gross ₹30,000, Net ₹28,000
      staffReversal = await Staff.create({
        organizationId: orgId,
        primaryBranchId: branch1Id,
        name: "Stylist Dave Reversal",
        email: "dave.reversal@example.com",
        phone: "+919888877770",
        staffCode: "STF-FIN-004",
        designation: "Stylist",
        joiningDate: new Date("2026-01-01"),
        status: "active",
        isActive: true,
      });

      await StaffBranch.create({
        organizationId: orgId,
        staffId: staffReversal._id,
        branchId: branch1Id,
        isPrimary: true,
        isActive: true,
      });

      recReversalStaff = await PayrollRecord.create({
        organizationId: orgId,
        branchId: branch1Id,
        payrollPeriodId: periodNov._id,
        staffId: staffReversal._id,
        monthYear: "2026-11",
        status: "approved",
        salaryStructureSnapshot: {
          payType: "monthly",
          baseSalary: 30000,
          hourlyRate: 0,
          allowances: [],
          deductions: [{ name: "TDS", amount: 2000 }],
        },
        attendanceSummarySnapshot: {
          totalDaysInMonth: 30,
          eligibleDays: 30,
          presentDays: 30,
          payableDays: 30,
        },
        calculations: {
          prorationFactor: 1,
          grossBaseSalary: 30000,
          totalAllowances: 0,
          totalGrossPay: 30000,
          unpaidLeaveDeduction: 0,
          fixedDeductions: 2000,
          totalDeductions: 2000,
          netPayable: 28000,
        },
      });
    });

    it("verifies index on PayrollPayment collection", async () => {
      await PayrollPayment.init();
      const indexes = await PayrollPayment.collection.indexes();
      const idempIndex = indexes.find((idx) => idx.key?.organizationId === 1 && idx.key?.idempotencyKey === 1);
      expect(idempIndex).toBeDefined();
      expect(idempIndex.unique).toBe(true);
    });

    it("reversal preserves approved payroll expense, restores obligation, and records audit trail", async () => {
      // 1. Initial State: Approved
      let resPnl = await request(app)
        .get("/api/v1/finance/operating-profit?startDate=2026-11-01&endDate=2026-11-30")
        .set("Authorization", `Bearer ${managerToken}`)
        .set("x-branch-id", branch1Id.toString());
      // Branch 1 Gross includes previous ₹50,000 + Dave ₹30,000 = ₹80,000
      expect(resPnl.body.data.workforceCosts.finalizedGrossPayroll).toBe(80000);

      // 2. Record and Confirm Payment ₹28,000
      const recRes = await request(app)
        .post(`/api/v1/payroll/records/${recReversalStaff._id}/pay`)
        .set("Authorization", `Bearer ${ownerToken}`)
        .send({
          amountInPaise: 2800000,
          paymentMethod: "bank_transfer",
          paymentReference: "PAY-DAVE-REF-001",
          paymentDate: "2026-11-20T10:00:00.000Z",
          idempotencyKey: "IDEMP-DAVE-001",
        });
      expect(recRes.status).toBe(201);
      const paymentId = recRes.body.data.payment._id;

      const confRes = await request(app)
        .post(`/api/v1/payroll/records/${recReversalStaff._id}/payments/${paymentId}/confirm`)
        .set("Authorization", `Bearer ${ownerToken}`)
        .send({ confirmActualPayment: true });
      expect(confRes.status).toBe(200);

      // Check after confirmation:
      // Gross = ₹80,000, Disbursed includes ₹28,000, Dave obligation = 0
      resPnl = await request(app)
        .get("/api/v1/finance/operating-profit?startDate=2026-11-01&endDate=2026-11-30")
        .set("Authorization", `Bearer ${managerToken}`)
        .set("x-branch-id", branch1Id.toString());
      expect(resPnl.body.data.workforceCosts.finalizedGrossPayroll).toBe(80000);
      expect(resPnl.body.data.workforceCosts.actualDisbursedPayroll).toBe(47000 + 28000); // 47k previous + 28k Dave

      let resAlerts = await request(app)
        .get("/api/v1/finance/overview-alerts")
        .set("Authorization", `Bearer ${managerToken}`)
        .set("x-branch-id", branch1Id.toString());
      expect(resAlerts.body.data.outstandingPayrollObligations.totalUnpaidAmount).toBe(0);

      // 3. Execute audited reversal:
      const revRes = await request(app)
        .post(`/api/v1/payroll/records/${recReversalStaff._id}/reverse`)
        .set("Authorization", `Bearer ${ownerToken}`)
        .send({ reversalReason: "NEFT rejected due to IFSC typo by bank" });
      expect(revRes.status).toBe(200);
      expect(revRes.body.data.status).toBe("approved");
      expect(revRes.body.data.manualPaymentStatus).toBe("reversed");
      expect(revRes.body.payment.status).toBe("reversed");
      expect(revRes.body.payment.reversalReason).toBe("NEFT rejected due to IFSC typo by bank");

      // 4. Critical Accounting Verification:
      // Gross payroll expense is NOT erased (must remain ₹80,000)
      resPnl = await request(app)
        .get("/api/v1/finance/operating-profit?startDate=2026-11-01&endDate=2026-11-30")
        .set("Authorization", `Bearer ${managerToken}`)
        .set("x-branch-id", branch1Id.toString());
      expect(resPnl.body.data.workforceCosts.finalizedGrossPayroll).toBe(80000);
      // Cash disbursed excludes reversed payment (returns to ₹47,000)
      expect(resPnl.body.data.workforceCosts.actualDisbursedPayroll).toBe(47000);

      // Outstanding obligation is restored exactly once (Dave's ₹28,000)
      resAlerts = await request(app)
        .get("/api/v1/finance/overview-alerts")
        .set("Authorization", `Bearer ${managerToken}`)
        .set("x-branch-id", branch1Id.toString());
      expect(resAlerts.body.data.outstandingPayrollObligations.totalUnpaidAmount).toBe(28000);
      expect(resAlerts.body.data.outstandingPayrollObligations.count).toBe(1);

      // 5. Transaction Register retains audit trail of reversed payment
      const resTx = await request(app)
        .get("/api/v1/finance/transactions?startDate=2026-11-01&endDate=2026-11-30&type=payroll_payment")
        .set("Authorization", `Bearer ${managerToken}`)
        .set("x-branch-id", branch1Id.toString());
      const daveTx = resTx.body.items.find((t) => t.referenceNumber === "PAY-DAVE-REF-001");
      expect(daveTx).toBeDefined();
      expect(daveTx.status).toBe("reversed");
      expect(daveTx.amount).toBe(28000);
    });

    it("duplicate reversal cannot restore obligation twice and is idempotent", async () => {
      // Replay same reversal with same reason -> HTTP 200 idempotent replay
      const replayRes = await request(app)
        .post(`/api/v1/payroll/records/${recReversalStaff._id}/reverse`)
        .set("Authorization", `Bearer ${ownerToken}`)
        .send({ reversalReason: "NEFT rejected due to IFSC typo by bank" });
      expect(replayRes.status).toBe(200);
      expect(replayRes.body.isIdempotentReplay).toBe(true);

      // Obligation remains exactly ₹28,000, not doubled
      const resAlerts = await request(app)
        .get("/api/v1/finance/overview-alerts")
        .set("Authorization", `Bearer ${managerToken}`)
        .set("x-branch-id", branch1Id.toString());
      expect(resAlerts.body.data.outstandingPayrollObligations.totalUnpaidAmount).toBe(28000);
      expect(resAlerts.body.data.outstandingPayrollObligations.count).toBe(1);

      // Different reversal reason on already reversed payment -> HTTP 409 Conflict
      const conflictRes = await request(app)
        .post(`/api/v1/payroll/records/${recReversalStaff._id}/reverse`)
        .set("Authorization", `Bearer ${ownerToken}`)
        .send({ reversalReason: "Different contradictory reason" });
      expect(conflictRes.status).toBe(409);
    });

    it("concurrent duplicate payment creation with the same idempotency key is safely serialized", async () => {
      // Staff 3 (Charlie) in Branch 2: Net ₹32,000
      const recCharlie = await PayrollRecord.findOne({ staffId: staff3._id, monthYear: "2026-11" });
      const amountInPaise = 3200000;
      const key = "CONCURRENT-IDEMP-KEY-CHARLIE";

      const attempts = await Promise.all([
        request(app)
          .post(`/api/v1/payroll/records/${recCharlie._id}/pay`)
          .set("Authorization", `Bearer ${ownerToken}`)
          .send({
            amountInPaise,
            paymentMethod: "bank_transfer",
            paymentReference: "PAY-CHARLIE-001",
            paymentDate: "2026-11-20T10:00:00.000Z",
            idempotencyKey: key,
          }),
        request(app)
          .post(`/api/v1/payroll/records/${recCharlie._id}/pay`)
          .set("Authorization", `Bearer ${ownerToken}`)
          .send({
            amountInPaise,
            paymentMethod: "bank_transfer",
            paymentReference: "PAY-CHARLIE-001",
            paymentDate: "2026-11-20T10:00:00.000Z",
            idempotencyKey: key,
          }),
      ]);

      const statuses = attempts.map((a) => a.status).sort();
      // One creates 201, the duplicate either succeeds with idempotent 200/201 or is rejected
      expect(statuses.includes(201)).toBe(true);
      expect(await PayrollPayment.countDocuments({ organizationId: orgId, idempotencyKey: key })).toBe(1);
    });

    it("same idempotency key with different payload fails with HTTP 409", async () => {
      const recCharlie = await PayrollRecord.findOne({ staffId: staff3._id, monthYear: "2026-11" });
      const key = "CONCURRENT-IDEMP-KEY-CHARLIE"; // already used with amount 3200000

      const mismatchAttempt = await request(app)
        .post(`/api/v1/payroll/records/${recCharlie._id}/pay`)
        .set("Authorization", `Bearer ${ownerToken}`)
        .send({
          amountInPaise: 3200000,
          paymentMethod: "cash", // different method!
          paymentReference: "DIFFERENT-REF",
          paymentDate: "2026-11-20T10:00:00.000Z",
          idempotencyKey: key,
        });

      expect(mismatchAttempt.status).toBe(409);
      expect(mismatchAttempt.body.message).toMatch(/different payment details/i);
    });

    it("cross-organization idempotency isolation allows another org to use the same idempotency key", async () => {
      const otherOrgId = new mongoose.Types.ObjectId();
      const otherBranchId = new mongoose.Types.ObjectId();
      const key = "CONCURRENT-IDEMP-KEY-CHARLIE";

      // Should create without duplicate key error because of compound index { organizationId, idempotencyKey }
      const otherPayment = await PayrollPayment.create({
        organizationId: otherOrgId,
        branchId: otherBranchId,
        payrollRecordId: new mongoose.Types.ObjectId(),
        staffId: new mongoose.Types.ObjectId(),
        source: "MANUAL",
        amountInPaise: 100000,
        paymentMethod: "bank_transfer",
        paymentReference: "OTHER-ORG-PAY",
        paymentDate: new Date(),
        status: "recorded",
        idempotencyKey: key,
        requestPayloadHash: "OTHERHASH",
        recordedBy: new mongoose.Types.ObjectId(),
        recordedAt: new Date(),
      });

      expect(otherPayment).toBeDefined();
      expect(otherPayment.organizationId.toString()).toBe(otherOrgId.toString());
      expect(otherPayment.idempotencyKey).toBe(key);
    });

    it("genuinely cancelled payroll record is excluded from operating expense and liability", async () => {
      // Create a genuinely cancelled record (e.g. employee never started or calculation cancelled before approval)
      const cancelledStaff = await Staff.create({
        organizationId: orgId,
        primaryBranchId: branch1Id,
        name: "Stylist Ghost Worker",
        email: "ghost@example.com",
        phone: "+919999000000",
        staffCode: "STF-FIN-005",
        designation: "Stylist",
        joiningDate: new Date("2026-01-01"),
        status: "active",
        isActive: true,
      });

      const cancelledRecord = await PayrollRecord.create({
        organizationId: orgId,
        branchId: branch1Id,
        payrollPeriodId: periodNov._id,
        staffId: cancelledStaff._id,
        monthYear: "2026-11",
        status: "cancelled", // genuine cancellation
        manualPaymentStatus: "none",
        salaryStructureSnapshot: {
          payType: "monthly",
          baseSalary: 40000,
          hourlyRate: 0,
          allowances: [],
          deductions: [],
        },
        attendanceSummarySnapshot: {
          totalDaysInMonth: 30,
          eligibleDays: 30,
          presentDays: 30,
          payableDays: 30,
        },
        calculations: {
          prorationFactor: 1,
          grossBaseSalary: 40000,
          totalAllowances: 0,
          totalGrossPay: 40000,
          unpaidLeaveDeduction: 0,
          fixedDeductions: 0,
          totalDeductions: 0,
          netPayable: 40000,
        },
      });

      // Operating profit gross payroll MUST NOT include the ₹40,000 cancelled record
      const resPnl = await request(app)
        .get("/api/v1/finance/operating-profit?startDate=2026-11-01&endDate=2026-11-30")
        .set("Authorization", `Bearer ${managerToken}`)
        .set("x-branch-id", branch1Id.toString());
      expect(resPnl.body.data.workforceCosts.finalizedGrossPayroll).toBe(80000); // unaffected by ₹40,000

      // Overview alerts MUST NOT include cancelled record in outstanding obligations
      const resAlerts = await request(app)
        .get("/api/v1/finance/overview-alerts")
        .set("Authorization", `Bearer ${managerToken}`)
        .set("x-branch-id", branch1Id.toString());
      // Only Dave's restored ₹28,000 is outstanding
      expect(resAlerts.body.data.outstandingPayrollObligations.totalUnpaidAmount).toBe(28000);
    });

    it("allows recording and confirming a replacement payment after reversal", async () => {
      // Dave's original payment was reversed with reason 'NEFT rejected due to IFSC typo by bank'.
      // Now record a replacement payment voucher with the correct reference and method.
      const replaceRes = await request(app)
        .post(`/api/v1/payroll/records/${recReversalStaff._id}/pay`)
        .set("Authorization", `Bearer ${ownerToken}`)
        .send({
          amountInPaise: 2800000,
          paymentMethod: "upi",
          paymentReference: "PAY-DAVE-REPLACEMENT-002",
          paymentDate: "2026-11-21T10:00:00.000Z",
          idempotencyKey: "IDEMP-DAVE-REPLACE-002",
        });

      expect(replaceRes.status).toBe(201);
      expect(replaceRes.body.data.record.manualPaymentStatus).toBe("recorded");
      const newPaymentId = replaceRes.body.data.payment._id;

      // Both vouchers (original reversed + new recorded) are preserved
      const paymentDocs = await PayrollPayment.find({
        organizationId: orgId,
        payrollRecordId: recReversalStaff._id,
      }).sort({ createdAt: 1 });
      expect(paymentDocs.length).toBe(2);
      expect(paymentDocs[0].status).toBe("reversed");
      expect(paymentDocs[0].paymentReference).toBe("PAY-DAVE-REF-001");
      expect(paymentDocs[0].reversalReason).toBe("NEFT rejected due to IFSC typo by bank");
      expect(paymentDocs[1].status).toBe("recorded");
      expect(paymentDocs[1].paymentReference).toBe("PAY-DAVE-REPLACEMENT-002");

      // Confirm the replacement payment
      const confRes = await request(app)
        .post(`/api/v1/payroll/records/${recReversalStaff._id}/payments/${newPaymentId}/confirm`)
        .set("Authorization", `Bearer ${ownerToken}`)
        .send({ confirmActualPayment: true });

      expect(confRes.status).toBe(200);
      expect(confRes.body.data.record.status).toBe("paid");
      expect(confRes.body.data.record.manualPaymentStatus).toBe("confirmed");

      // Obligation is settled to 0
      const resAlerts = await request(app)
        .get("/api/v1/finance/overview-alerts")
        .set("Authorization", `Bearer ${managerToken}`)
        .set("x-branch-id", branch1Id.toString());
      expect(resAlerts.body.data.outstandingPayrollObligations.totalUnpaidAmount).toBe(0);
    });

    it("concurrency race: confirmation vs reversal on the same recorded/confirmed voucher", async () => {
      // Create a fresh approved record for testing the confirm-vs-reverse race
      const raceStaff = await Staff.create({
        organizationId: orgId,
        primaryBranchId: branch1Id,
        name: "Stylist Race Worker",
        email: "race@test.internal",
        phone: "+919876543210",
        staffCode: "STF-FIN-RACE",
        designation: "Stylist",
        joiningDate: new Date("2026-01-01"),
        status: "active",
        isActive: true,
      });

      const raceRecord = await PayrollRecord.create({
        organizationId: orgId,
        branchId: branch1Id,
        payrollPeriodId: periodNov._id,
        staffId: raceStaff._id,
        monthYear: "2026-11",
        status: "approved",
        salaryStructureSnapshot: {
          payType: "monthly",
          baseSalary: 25000,
          hourlyRate: 0,
          allowances: [],
          deductions: [],
        },
        attendanceSummarySnapshot: {
          totalDaysInMonth: 30,
          eligibleDays: 30,
          presentDays: 30,
          payableDays: 30,
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
      });

      // Record payment attempt
      const recPay = await request(app)
        .post(`/api/v1/payroll/records/${raceRecord._id}/pay`)
        .set("Authorization", `Bearer ${ownerToken}`)
        .send({
          amountInPaise: 2500000,
          paymentMethod: "bank_transfer",
          paymentReference: "PAY-RACE-001",
          paymentDate: "2026-11-20T10:00:00.000Z",
          idempotencyKey: "IDEMP-RACE-001",
        });
      expect(recPay.status).toBe(201);
      const racePaymentId = recPay.body.data.payment._id;

      // Run concurrent requests: confirm vs reverse
      // Reversal on a 'recorded' record is invalid (must be 'paid' to reverse),
      // while confirm requires 'recorded' and transitions to 'paid'.
      const [confirmRes, reverseRes] = await Promise.all([
        request(app)
          .post(`/api/v1/payroll/records/${raceRecord._id}/payments/${racePaymentId}/confirm`)
          .set("Authorization", `Bearer ${ownerToken}`)
          .send({ confirmActualPayment: true }),
        request(app)
          .post(`/api/v1/payroll/records/${raceRecord._id}/reverse`)
          .set("Authorization", `Bearer ${ownerToken}`)
          .send({ reversalReason: "Race test reversal" }),
      ]);

      // Exactly one valid state transition must occur:
      // Case 1: confirm executes first -> confirm gets 200, reverse gets 200 (if reverse executed after confirm) or 400 (if reverse executed before record became 'paid')
      // Under all timings, the final state must be strictly consistent:
      const updatedRaceRecord = await PayrollRecord.findById(raceRecord._id);
      const updatedRacePayment = await PayrollPayment.findById(racePaymentId);

      if (updatedRaceRecord.status === "paid") {
        expect(updatedRacePayment.status).toBe("confirmed");
        expect(confirmRes.status).toBe(200);
      } else if (updatedRaceRecord.status === "approved" && updatedRaceRecord.manualPaymentStatus === "reversed") {
        expect(updatedRacePayment.status).toBe("reversed");
      }

      // In no case can parent be 'paid' while child is 'reversed', or vice versa
      expect(
        (updatedRaceRecord.status === "paid" && updatedRacePayment.status === "confirmed") ||
        (updatedRaceRecord.status === "approved" && updatedRacePayment.status === "reversed")
      ).toBe(true);
    });

    it("verifies Finance multiple partial payment aggregation support and limitations", async () => {
      // In Finance aggregation (finance.service.js):
      // Cash flow sums ALL PayrollPayments where status == 'confirmed'.
      // Outstanding obligations sums ALL confirmed payments via $lookup.
      // If direct manual vouchers were confirmed for partial amounts (e.g. ₹10k and ₹8k),
      // Finance mathematically sums confirmed vouchers accurately.
      const partStaff = await Staff.create({
        organizationId: orgId,
        primaryBranchId: branch1Id,
        name: "Stylist Partial Payment Test",
        email: "partial@test.internal",
        phone: "+919876543299",
        staffCode: "STF-FIN-PARTIAL",
        designation: "Stylist",
        joiningDate: new Date("2026-01-01"),
        status: "active",
        isActive: true,
      });

      const partRecord = await PayrollRecord.create({
        organizationId: orgId,
        branchId: branch1Id,
        payrollPeriodId: periodNov._id,
        staffId: partStaff._id,
        monthYear: "2026-11",
        status: "approved",
        salaryStructureSnapshot: {
          payType: "monthly",
          baseSalary: 30000,
          hourlyRate: 0,
          allowances: [],
          deductions: [{ name: "TDS", amount: 2000 }],
        },
        attendanceSummarySnapshot: {
          totalDaysInMonth: 30,
          eligibleDays: 30,
          presentDays: 30,
          payableDays: 30,
        },
        calculations: {
          prorationFactor: 1,
          grossBaseSalary: 30000,
          totalAllowances: 0,
          totalGrossPay: 30000,
          unpaidLeaveDeduction: 0,
          fixedDeductions: 2000,
          totalDeductions: 2000,
          netPayable: 28000,
        },
      });

      // Insert Payment A: ₹10,000 confirmed
      const payA = await PayrollPayment.create({
        organizationId: orgId,
        branchId: branch1Id,
        payrollRecordId: partRecord._id,
        staffId: partStaff._id,
        source: "MANUAL",
        amountInPaise: 1000000,
        paymentMethod: "bank_transfer",
        paymentReference: "PAY-PART-A",
        paymentDate: new Date("2026-11-20T10:00:00.000Z"),
        status: "confirmed",
        idempotencyKey: "IDEMP-PART-A",
        requestPayloadHash: "HASH_A",
        recordedBy: ownerUser._id,
        recordedAt: new Date(),
        confirmedBy: ownerUser._id,
        confirmedAt: new Date(),
      });

      // Insert Payment B: ₹8,000 confirmed
      const payB = await PayrollPayment.create({
        organizationId: orgId,
        branchId: branch1Id,
        payrollRecordId: partRecord._id,
        staffId: partStaff._id,
        source: "MANUAL",
        amountInPaise: 800000,
        paymentMethod: "bank_transfer",
        paymentReference: "PAY-PART-B",
        paymentDate: new Date("2026-11-21T10:00:00.000Z"),
        status: "confirmed",
        idempotencyKey: "IDEMP-PART-B",
        requestPayloadHash: "HASH_B",
        recordedBy: ownerUser._id,
        recordedAt: new Date(),
        confirmedBy: ownerUser._id,
        confirmedAt: new Date(),
      });

      // Check Finance:
      // Gross labor expense includes partRecord ₹30,000
      let resPnl = await request(app)
        .get("/api/v1/finance/operating-profit?startDate=2026-11-01&endDate=2026-11-30")
        .set("Authorization", `Bearer ${managerToken}`)
        .set("x-branch-id", branch1Id.toString());
      expect(resPnl.body.data.workforceCosts.finalizedGrossPayroll).toBe(135000); // 80k + 25k race + 30k part

      // Cash disbursed includes ₹10,000 + ₹8,000 = ₹18,000
      // Previous baseline disbursed was 47,000 + 28,000 replacement = 75,000 + (race maybe 25k) + 18k
      let resAlerts = await request(app)
        .get("/api/v1/finance/overview-alerts")
        .set("Authorization", `Bearer ${managerToken}`)
        .set("x-branch-id", branch1Id.toString());
      // For partRecord: Net = ₹28,000, confirmed = ₹18,000 -> Outstanding = ₹10,000
      expect(resAlerts.body.data.outstandingPayrollObligations.totalUnpaidAmount).toBe(10000);

      // Now reverse Payment A (₹10,000)
      payA.status = "reversed";
      payA.reversalReason = "Incorrect bank account";
      payA.reversedAt = new Date();
      payA.reversedBy = ownerUser._id;
      await payA.save();

      // Finance Check after Reversing A:
      // Gross remains ₹135,000
      resPnl = await request(app)
        .get("/api/v1/finance/operating-profit?startDate=2026-11-01&endDate=2026-11-30")
        .set("Authorization", `Bearer ${managerToken}`)
        .set("x-branch-id", branch1Id.toString());
      expect(resPnl.body.data.workforceCosts.finalizedGrossPayroll).toBe(135000);

      // Confirmed cash outflow for partRecord is now only B (₹8,000)
      resAlerts = await request(app)
        .get("/api/v1/finance/overview-alerts")
        .set("Authorization", `Bearer ${managerToken}`)
        .set("x-branch-id", branch1Id.toString());
      // Outstanding for partRecord: ₹28,000 - ₹8,000 = ₹20,000
      expect(resAlerts.body.data.outstandingPayrollObligations.totalUnpaidAmount).toBe(20000);

      // Add Payment C: ₹10,000 confirmed
      await PayrollPayment.create({
        organizationId: orgId,
        branchId: branch1Id,
        payrollRecordId: partRecord._id,
        staffId: partStaff._id,
        source: "MANUAL",
        amountInPaise: 1000000,
        paymentMethod: "bank_transfer",
        paymentReference: "PAY-PART-C",
        paymentDate: new Date("2026-11-22T10:00:00.000Z"),
        status: "confirmed",
        idempotencyKey: "IDEMP-PART-C",
        requestPayloadHash: "HASH_C",
        recordedBy: ownerUser._id,
        recordedAt: new Date(),
        confirmedBy: ownerUser._id,
        confirmedAt: new Date(),
      });

      // Outstanding is now ₹28,000 - (₹8,000 + ₹10,000) = ₹10,000
      resAlerts = await request(app)
        .get("/api/v1/finance/overview-alerts")
        .set("Authorization", `Bearer ${managerToken}`)
        .set("x-branch-id", branch1Id.toString());
      expect(resAlerts.body.data.outstandingPayrollObligations.totalUnpaidAmount).toBe(10000);

      // Add Final Payment: ₹10,000 confirmed
      await PayrollPayment.create({
        organizationId: orgId,
        branchId: branch1Id,
        payrollRecordId: partRecord._id,
        staffId: partStaff._id,
        source: "MANUAL",
        amountInPaise: 1000000,
        paymentMethod: "bank_transfer",
        paymentReference: "PAY-PART-FINAL",
        paymentDate: new Date("2026-11-23T10:00:00.000Z"),
        status: "confirmed",
        idempotencyKey: "IDEMP-PART-FINAL",
        requestPayloadHash: "HASH_FINAL",
        recordedBy: ownerUser._id,
        recordedAt: new Date(),
        confirmedBy: ownerUser._id,
        confirmedAt: new Date(),
      });

      // Outstanding obligation is now completely ₹0
      resAlerts = await request(app)
        .get("/api/v1/finance/overview-alerts")
        .set("Authorization", `Bearer ${managerToken}`)
        .set("x-branch-id", branch1Id.toString());
      expect(resAlerts.body.data.outstandingPayrollObligations.totalUnpaidAmount).toBe(0);
    });
  });
});
