import { describe, expect, it, beforeAll, afterAll, beforeEach, jest } from "@jest/globals";
import mongoose from "mongoose";
import request from "supertest";
import jwt from "jsonwebtoken";
import app from "../../../app.mjs";
import { getIsolatedTestMongoUri } from "../testSetup.js";
import { Organization } from "../../models/organizations/organization.model.js";
import { Branch } from "../../models/branches/branch.model.js";
import { User } from "../../models/users/user.model.js";
import { Role } from "../../models/roles/role.model.js";
import { Permission } from "../../models/permissions/permission.model.js";
import { Payment } from "../../models/billing/payment.model.js";
import { Invoice } from "../../models/billing/invoice.model.js";
import { Expense } from "../../models/expenses/expense.model.js";
import { DayClosure } from "../../models/finance/dayClosure.model.js";
import { PayrollRecord } from "../../models/payroll/payrollRecord.model.js";
import { SupplierInvoice } from "../../models/procurement/supplierInvoice.model.js";
import { CANONICAL_PERMISSIONS } from "../../config/permissions.js";
import { redis } from "../../utils/redis.js";

jest.spyOn(redis, "get").mockResolvedValue(null);
jest.spyOn(redis, "setex").mockResolvedValue("OK");

describe("Finance Integration Suite (Day Closure & Operating Profit)", () => {
  jest.setTimeout(40000);

  let dbUri;
  let organization;
  let branchA;
  let branchB;
  let managerUser;
  let cashierUser;
  let managerToken;
  let cashierToken;

  beforeAll(async () => {
    dbUri = getIsolatedTestMongoUri("finance_test");
    await mongoose.connect(dbUri);

    const permissionDocs = [];
    for (const perm of CANONICAL_PERMISSIONS) {
      const doc = await Permission.findOneAndUpdate(
        { name: perm.name },
        { ...perm },
        { upsert: true, returnDocument: 'after' }
      );
      permissionDocs.push(doc);
    }

    organization = await Organization.create({
      name: "Finance Test Salon Org",
      expenseApprovalThreshold: 5000,
      allowedExpenseCategories: ["utilities", "maintenance", "consumables", "refreshments", "marketing", "other"],
    });

    const managerRole = await Role.create({
      name: "manager",
      description: "Full manager role",
      permissions: permissionDocs.map((p) => p._id),
      isSystem: true,
    });

    const cashierPerms = permissionDocs.filter((p) =>
      ["finance.view", "finance.create"].includes(p.name)
    );
    const cashierRole = await Role.create({
      name: "cashier",
      description: "Cashier role",
      organizationId: organization._id,
      permissions: cashierPerms.map((p) => p._id),
      isSystem: false,
    });

    branchA = await Branch.create({
      name: "Finance Branch 1",
      organizationId: organization._id,
      timezone: "Asia/Kolkata",
    });

    branchB = await Branch.create({
      name: "Finance Branch 2",
      organizationId: organization._id,
      timezone: "Asia/Kolkata",
    });

    managerUser = await User.create({
      name: "Finance Manager",
      email: "finance.manager@salon.test",
      phone: "+919999998801",
      password: "password123",
      organizationId: organization._id,
      role: managerRole._id,
      roles: [managerRole._id],
      hasOrgWideAccess: true,
      branchAccess: [
        { branchId: branchA._id, branchName: branchA.name, isActive: true },
        { branchId: branchB._id, branchName: branchB.name, isActive: true },
      ],
    });

    cashierUser = await User.create({
      name: "Finance Cashier",
      email: "finance.cashier@salon.test",
      phone: "+919999998802",
      password: "password123",
      organizationId: organization._id,
      role: cashierRole._id,
      roles: [cashierRole._id],
      hasOrgWideAccess: false,
      branchAccess: [{ branchId: branchA._id, branchName: branchA.name, isActive: true }],
    });

    const jwtSecret = process.env.JWT_SECRET || "fallback_test_jwt_secret_32bytes_long";
    managerToken = jwt.sign(
      {
        id: managerUser._id.toString(),
        userId: managerUser._id.toString(),
        organizationId: organization._id.toString(),
        email: managerUser.email,
        roles: ["manager"],
      },
      jwtSecret,
      { expiresIn: "1h" }
    );

    cashierToken = jwt.sign(
      {
        id: cashierUser._id.toString(),
        userId: cashierUser._id.toString(),
        organizationId: organization._id.toString(),
        email: cashierUser.email,
        roles: ["cashier"],
      },
      jwtSecret,
      { expiresIn: "1h" }
    );
  });

  afterAll(async () => {
    await mongoose.connection.dropDatabase();
    await mongoose.disconnect();
  });

  describe("1. System Totals Aggregation", () => {
    const businessDate = "2026-11-20";

    beforeAll(async () => {
      // Seed payments for businessDate 2026-11-20 in Asia/Kolkata timezone (10:00 AM IST = 04:30 AM UTC)
      const paymentDate = new Date("2026-11-20T04:30:00.000Z");
      const dummyCustomerId = new mongoose.Types.ObjectId();
      const dummyInvoiceId = new mongoose.Types.ObjectId();

      await Payment.create([
        {
          organizationId: organization._id,
          branchId: branchA._id,
          invoiceId: dummyInvoiceId,
          customerId: dummyCustomerId,
          paymentNumber: "PAY-20261120-0001",
          amount: 2500,
          type: "payment",
          method: "cash",
          status: "completed",
          recordedBy: cashierUser._id,
          paymentDate,
        },
        {
          organizationId: organization._id,
          branchId: branchA._id,
          invoiceId: dummyInvoiceId,
          customerId: dummyCustomerId,
          paymentNumber: "PAY-20261120-0002",
          amount: 4000,
          type: "payment",
          method: "card",
          status: "completed",
          recordedBy: cashierUser._id,
          paymentDate,
        },
        {
          organizationId: organization._id,
          branchId: branchA._id,
          invoiceId: dummyInvoiceId,
          customerId: dummyCustomerId,
          paymentNumber: "PAY-20261120-0003",
          amount: 3500,
          type: "payment",
          method: "upi",
          status: "completed",
          recordedBy: cashierUser._id,
          paymentDate,
        },
        // A refund on card of 500
        {
          organizationId: organization._id,
          branchId: branchA._id,
          invoiceId: dummyInvoiceId,
          customerId: dummyCustomerId,
          paymentNumber: "REF-20261120-0001",
          amount: 500,
          type: "refund",
          method: "card",
          status: "completed",
          recordedBy: cashierUser._id,
          paymentDate,
        },
      ]);
    });

    it("correctly aggregates tender-wise collections and refunds in branch timezone", async () => {
      const res = await request(app)
        .get("/api/v1/finance/day-closure/system-totals")
        .set("Authorization", `Bearer ${cashierToken}`)
        .set("X-Branch-Id", branchA._id.toString())
        .query({ businessDate });

      expect(res.status).toBe(200);
      expect(res.body.success).toBe(true);
      const totals = res.body.data.systemTotals;
      expect(totals.cash).toBe(2500);
      expect(totals.card).toBe(3500); // 4000 - 500 refund
      expect(totals.upi).toBe(3500);
      expect(totals.totalCollected).toBe(10000);
      expect(totals.totalRefunded).toBe(500);
      expect(totals.netExpected).toBe(9500);
      expect(res.body.data.alreadyClosed).toBe(false);
    });
  });

  describe("2. Day Closure Submission & Reconciliations", () => {
    const businessDate = "2026-11-20";

    it("rejects submission if tender discrepancy exists without discrepancyReason", async () => {
      const res = await request(app)
        .post("/api/v1/finance/day-closure")
        .set("Authorization", `Bearer ${cashierToken}`)
        .set("X-Branch-Id", branchA._id.toString())
        .send({
          businessDate,
          physicalCounts: {
            cash: 2400, // 100 short
            card: 3500,
            upi: 3500,
            other: 0,
          },
          discrepancyReason: "", // Empty reason!
        });

      expect(res.status).toBe(400);
      expect(res.body.message).toMatch(/discrepancy reason is required/i);
    });

    it("correctly detects offsetting tender discrepancies (net totalDelta == 0) and marks discrepant", async () => {
      // Cash is 500 short (2000 vs 2500), UPI is 500 over (4000 vs 3500). Net total is 9500 (delta 0).
      const res = await request(app)
        .post("/api/v1/finance/day-closure")
        .set("Authorization", `Bearer ${cashierToken}`)
        .set("X-Branch-Id", branchA._id.toString())
        .send({
          businessDate,
          physicalCounts: {
            cash: 2000,
            card: 3500,
            upi: 4000,
            other: 0,
          },
          discrepancyReason: "Customer paid ₹500 via QR instead of cash by mistake",
        });

      expect(res.status).toBe(201);
      expect(res.body.success).toBe(true);
      const closure = res.body.data;
      expect(closure.status).toBe("submitted");
      expect(closure.reconciliationResult).toBe("discrepant");
      expect(closure.discrepancy.cashDelta).toBe(-500);
      expect(closure.discrepancy.upiDelta).toBe(500);
      expect(closure.discrepancy.totalDelta).toBe(0);
      expect(closure.discrepancy.reason).toBe("Customer paid ₹500 via QR instead of cash by mistake");
    });

    it("strictly prevents duplicate day closure submission for same branch & business date (409 Conflict)", async () => {
      const res = await request(app)
        .post("/api/v1/finance/day-closure")
        .set("Authorization", `Bearer ${cashierToken}`)
        .set("X-Branch-Id", branchA._id.toString())
        .send({
          businessDate,
          physicalCounts: {
            cash: 2500,
            card: 3500,
            upi: 3500,
            other: 0,
          },
        });

      expect(res.status).toBe(409);
      expect(res.body.message).toMatch(/already exists/i);
    });

    it("manager approves day closure, updating status to 'approved' while permanently preserving discrepancy history", async () => {
      const closuresRes = await request(app)
        .get("/api/v1/finance/day-closure")
        .set("Authorization", `Bearer ${managerToken}`)
        .set("X-Branch-Id", branchA._id.toString())
        .query({ startDate: businessDate, endDate: businessDate });

      const closureId = closuresRes.body.items[0].id;

      const approveRes = await request(app)
        .patch(`/api/v1/finance/day-closure/${closureId}/approve`)
        .set("Authorization", `Bearer ${managerToken}`)
        .set("X-Branch-Id", branchA._id.toString())
        .send({ managerNotes: "Reviewed discrepancy with cashier; approved." });

      expect(approveRes.status).toBe(200);
      expect(approveRes.body.data.status).toBe("approved");
      expect(approveRes.body.data.reconciliationResult).toBe("discrepant"); // Preserved!
      expect(approveRes.body.data.discrepancy.cashDelta).toBe(-500);
      expect(approveRes.body.data.managerNotes).toBe("Reviewed discrepancy with cashier; approved.");
    });
  });

  describe("3. Operating Profit (P&L MVP) Aggregation", () => {
    const periodStart = "2026-11-01";
    const periodEnd = "2026-11-30";

    beforeAll(async () => {
      const dummyCustomer = {
        name: "P&L Test Client",
        phone: "+919888881234",
        email: "client@test.com",
      };

      // 1. Finalized Invoice of 50000 on Nov 15
      await Invoice.create({
        organizationId: organization._id,
        branchId: branchA._id,
        invoiceNumber: "INV-PNL-001",
        invoiceType: "retail",
        customerId: new mongoose.Types.ObjectId(),
        customerSnapshot: dummyCustomer,
        lines: [
          {
            lineType: "service",
            serviceType: "custom",
            name: "Hair Spa Deluxe",
            quantity: 1,
            unitPrice: 50000,
            subtotal: 50000,
            lineTotal: 50000,
            customerPayable: 50000,
          },
        ],
        subtotal: 50000,
        grossPayable: 50000,
        payableAmount: 50000,
        amountPaid: 50000,
        amountDue: 0,
        status: "finalized",
        paymentStatus: "paid",
        finalizedAt: new Date("2026-11-15T10:00:00.000Z"),
        createdBy: managerUser._id,
      });

      // 2. Completed Payment Refund of 2000 on Nov 18
      await Payment.create({
        organizationId: organization._id,
        branchId: branchA._id,
        invoiceId: new mongoose.Types.ObjectId(),
        customerId: new mongoose.Types.ObjectId(),
        paymentNumber: "REF-PNL-001",
        amount: 2000,
        type: "refund",
        method: "cash",
        status: "completed",
        recordedBy: managerUser._id,
        paymentDate: new Date("2026-11-18T10:00:00.000Z"),
      });

      // 3. Approved Expense of 12000 on Nov 12
      await Expense.create({
        organizationId: organization._id,
        branchId: branchA._id,
        expenseCode: "EXP-PNL-001",
        category: "utilities",
        amount: 12000,
        paymentMethod: "bank_transfer",
        payeeName: "Power Board",
        expenseDate: new Date("2026-11-12T10:00:00.000Z"),
        approvalStatus: "approved",
        paymentStatus: "settled",
        approvalThresholdAtCreation: 5000,
        recordedBy: managerUser._id,
      });

      // 4. Unapproved Expense of 8000 on Nov 14 (Must NOT be deducted!)
      await Expense.create({
        organizationId: organization._id,
        branchId: branchA._id,
        expenseCode: "EXP-PNL-002",
        category: "maintenance",
        amount: 8000,
        paymentMethod: "petty_cash",
        payeeName: "Renovation Crew",
        expenseDate: new Date("2026-11-14T10:00:00.000Z"),
        approvalStatus: "pending_approval",
        paymentStatus: "unpaid",
        approvalThresholdAtCreation: 5000,
        recordedBy: cashierUser._id,
      });
    });

    it("accurately calculates gross revenue, refunds, net revenue, approved expenses, and operating profit", async () => {
      const res = await request(app)
        .get("/api/v1/finance/operating-profit")
        .set("Authorization", `Bearer ${managerToken}`)
        .set("X-Branch-Id", branchA._id.toString())
        .query({ startDate: periodStart, endDate: periodEnd });

      expect(res.status).toBe(200);
      expect(res.body.success).toBe(true);
      const data = res.body.data;
      expect(data.grossRevenue).toBe(50000);
      // Refunds = 2000 (from Payment refund) + 500 (from Section 1 refund) = 2500
      expect(data.refunds).toBe(2500);
      expect(data.netRevenue).toBe(47500);
      expect(data.operatingExpenses.utilities).toBe(12000);
      expect(data.operatingExpenses.total).toBe(12000); // 8000 unapproved is excluded!
      expect(data.operatingProfit).toBe(35500); // 47500 - 12000
      expect(data.operatingMarginPercentage).toBeCloseTo((35500 / 47500) * 100, 2);
    });

    it("incorporates approved payroll into workforce costs and verifies overview-alerts endpoint", async () => {
      // 1. Seed an approved PayrollRecord for branchA in November 2026
      await PayrollRecord.create({
        organizationId: organization._id,
        branchId: branchA._id,
        payrollPeriodId: new mongoose.Types.ObjectId(),
        staffId: new mongoose.Types.ObjectId(),
        userId: cashierUser._id,
        monthYear: "2026-11",
        salaryStructureSnapshot: {
          payType: "monthly",
          baseSalary: 20000,
          allowances: [],
          deductions: [],
        },
        attendanceSummarySnapshot: {
          totalDaysInMonth: 30,
          eligibleDays: 30,
        },
        calculations: {
          prorationFactor: 1,
          grossBaseSalary: 20000,
          totalAllowances: 2000,
          totalGrossPay: 22000,
          unpaidLeaveDeduction: 0,
          fixedDeductions: 1000,
          totalDeductions: 1000,
          netPayable: 21000,
        },
        manualPaymentStatus: "none",
        status: "approved",
      });

      // 2. Seed an unpaid SupplierInvoice for branchA
      await SupplierInvoice.create({
        organizationId: organization._id,
        branchId: branchA._id,
        invoiceNumber: "SUPP-INV-2026-001",
        supplierId: new mongoose.Types.ObjectId(),
        totalAmount: 15000,
        amountPaid: 5000,
        status: "partially_paid",
        createdBy: managerUser._id,
        invoiceDate: new Date("2026-11-10"),
        dueDate: new Date("2026-11-25"),
      });

      // Query Operating Profit again
      const pnlRes = await request(app)
        .get("/api/v1/finance/operating-profit")
        .set("Authorization", `Bearer ${managerToken}`)
        .set("X-Branch-Id", branchA._id.toString())
        .query({ startDate: periodStart, endDate: periodEnd });

      expect(pnlRes.status).toBe(200);
      expect(pnlRes.body.data.workforceCosts.finalizedGrossPayroll).toBe(22000);
      // Net revenue (47500) - expenses (12000) - payroll (22000) = 13500
      expect(pnlRes.body.data.operatingProfit).toBe(13500);
      expect(pnlRes.body.data.costCoverageNotice).toBeDefined();

      // Query Overview Alerts
      const alertsRes = await request(app)
        .get("/api/v1/finance/overview-alerts")
        .set("Authorization", `Bearer ${managerToken}`)
        .set("X-Branch-Id", branchA._id.toString());

      expect(alertsRes.status).toBe(200);
      expect(alertsRes.body.success).toBe(true);
      const alerts = alertsRes.body.data;
      expect(alerts.pendingExpenseApprovals.count).toBe(1); // from Section 3
      expect(alerts.pendingExpenseApprovals.totalAmount).toBe(8000);
      expect(alerts.outstandingSupplierInvoices.count).toBe(1);
      expect(alerts.outstandingSupplierInvoices.totalUnpaidAmount).toBe(10000); // 15000 - 5000
      expect(alerts.outstandingPayrollObligations.count).toBe(1);
      expect(alerts.outstandingPayrollObligations.totalUnpaidAmount).toBe(21000);
    });

    it("handles legacy missing fields, failed/reversed payroll, and excludes procurement invoice double-count in operating expenses", async () => {
      // 1. Seed a legacy supplier invoice with missing amountPaid
      await SupplierInvoice.create({
        organizationId: organization._id,
        branchId: branchA._id,
        invoiceNumber: "SUPP-INV-LEGACY-002",
        supplierId: new mongoose.Types.ObjectId(),
        totalAmount: 7500,
        // amountPaid is undefined/omitted
        status: "unpaid",
        createdBy: managerUser._id,
        invoiceDate: new Date("2026-11-12"),
        dueDate: new Date("2026-11-28"),
      });

      // 2. Seed a procurement-linked expense (should NOT be added to operating expenses)
      await Expense.create({
        organizationId: organization._id,
        branchId: branchA._id,
        expenseCode: "EXP-PROC-001",
        category: "inventory_purchase",
        amount: 5000,
        paymentMethod: "bank_transfer",
        payeeName: "Supplier ABC",
        sourceType: "procurement_invoice",
        expenseDate: new Date("2026-11-15T10:00:00.000Z"),
        approvalStatus: "approved",
        paymentStatus: "settled",
        approvalThresholdAtCreation: 5000,
        recordedBy: managerUser._id,
      });

      // Check Operating Profit - Operating expenses should remain 12000 (excluding 5000 procurement-linked)
      const pnlRes = await request(app)
        .get("/api/v1/finance/operating-profit")
        .set("Authorization", `Bearer ${managerToken}`)
        .set("X-Branch-Id", branchA._id.toString())
        .query({ startDate: periodStart, endDate: periodEnd });

      expect(pnlRes.status).toBe(200);
      expect(pnlRes.body.data.operatingExpenses.total).toBe(12000);

      // Check Overview Alerts
      // Supplier invoices: 1st (10000) + legacy 2nd (7500) = 17500
      const alertsRes = await request(app)
        .get("/api/v1/finance/overview-alerts")
        .set("Authorization", `Bearer ${managerToken}`)
        .set("X-Branch-Id", branchA._id.toString());

      expect(alertsRes.status).toBe(200);
      expect(alertsRes.body.data.outstandingSupplierInvoices.count).toBe(2);
      expect(alertsRes.body.data.outstandingSupplierInvoices.totalUnpaidAmount).toBe(17500);
    });
  });
});
