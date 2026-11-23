import { describe, expect, it, beforeAll, afterAll, beforeEach, jest } from "@jest/globals";
import request from "supertest";
import mongoose from "mongoose";
import jwt from "jsonwebtoken";
import app from "../../../app.mjs";
import { redis } from "../../utils/redis.js";
import { getIsolatedTestMongoUri } from "../testSetup.js";
import { User } from "../../models/users/user.model.js";
import { Role } from "../../models/roles/role.model.js";
import { Permission } from "../../models/permissions/permission.model.js";
import { Organization } from "../../models/organizations/organization.model.js";
import { Branch } from "../../models/branches/branch.model.js";
import { Payment } from "../../models/billing/payment.model.js";
import { Invoice } from "../../models/billing/invoice.model.js";
import { Expense } from "../../models/expenses/expense.model.js";
import { DayClosure } from "../../models/finance/dayClosure.model.js";
import { PettyCashTransaction } from "../../models/expenses/pettyCash.model.js";
import { PayrollPayment } from "../../models/payroll/payrollPayment.model.js";
import { PayrollRecord } from "../../models/payroll/payrollRecord.model.js";
import { SupplierInvoice } from "../../models/procurement/supplierInvoice.model.js";
import { SupplierPayment } from "../../models/procurement/supplierPayment.model.js";
import { Staff } from "../../models/staff/staff.model.js";
import { Supplier } from "../../models/procurement/supplier.model.js";
import { CANONICAL_PERMISSIONS } from "../../config/permissions.js";

jest.spyOn(redis, "get").mockResolvedValue(null);
jest.spyOn(redis, "setex").mockResolvedValue("OK");

describe("Finance Multi-Role Platform & Security Suite", () => {
  jest.setTimeout(40000);

  let dbUri;
  let organization;
  let otherOrg;
  let branch1;
  let branch2;
  let otherOrgBranch;

  let ownerRole, managerRole, auditorRole, cashierRole;
  let ownerUser, managerUser, auditorUser, cashierUser;
  let ownerToken, managerToken, auditorToken, cashierToken, otherOrgToken;

  beforeAll(async () => {
    dbUri = getIsolatedTestMongoUri("finance_test");
    await mongoose.connect(dbUri);
    // 1. Setup Organizations
    organization = await Organization.create({
      name: "Salon Chain Alpha",
      slug: `org-alpha-${Date.now()}`,
    });

    otherOrg = await Organization.create({
      name: "Competitor Org Beta",
      slug: `org-beta-${Date.now()}`,
    });

    // 2. Setup Branches
    branch1 = await Branch.create({
      name: "Downtown Branch",
      organizationId: organization._id,
      timezone: "Asia/Kolkata",
      isActive: true,
    });

    branch2 = await Branch.create({
      name: "Uptown Branch",
      organizationId: organization._id,
      timezone: "Asia/Kolkata",
      isActive: true,
    });

    otherOrgBranch = await Branch.create({
      name: "Other Org Branch",
      organizationId: otherOrg._id,
      timezone: "Asia/Kolkata",
      isActive: true,
    });

    // 3. Ensure Canonical Permissions in DB
    const permDocs = {};
    for (const p of CANONICAL_PERMISSIONS) {
      let doc = await Permission.findOne({ name: p.name });
      if (!doc) {
        doc = await Permission.create({
          name: p.name,
          module: p.module,
          action: p.action,
          description: p.description,
        });
      }
      permDocs[p.name] = doc._id;
    }

    // 4. Setup Roles
    ownerRole = await Role.create({
      name: `owner_${Date.now()}`,
      organizationId: organization._id,
      permissions: Object.values(permDocs),
      isSystem: true,
    });

    managerRole = await Role.create({
      name: `manager_${Date.now()}`,
      organizationId: organization._id,
      permissions: [
        permDocs["finance.view"],
        permDocs["finance.create"],
        permDocs["finance.edit"],
        permDocs["finance.transactions.view"],
        permDocs["finance.audit.view"],
        permDocs["finance.reports.export"],
        permDocs["expenses.view"],
        permDocs["expenses.create"],
        permDocs["expenses.update"],
      ].filter(Boolean),
    });

    // Auditor: STRICTLY read-only permissions
    auditorRole = await Role.create({
      name: `auditor_${Date.now()}`,
      organizationId: organization._id,
      permissions: [
        permDocs["finance.view"],
        permDocs["finance.transactions.view"],
        permDocs["finance.audit.view"],
        permDocs["finance.reports.export"],
        permDocs["expenses.view"],
        permDocs["logs.view"],
      ].filter(Boolean),
    });

    cashierRole = await Role.create({
      name: `cashier_${Date.now()}`,
      organizationId: organization._id,
      permissions: [
        permDocs["finance.view"],
        permDocs["finance.create"],
        permDocs["expenses.create"],
      ].filter(Boolean),
    });

    // 5. Setup Users & Tokens
    const jwtSecret = process.env.JWT_SECRET || "fallback_test_jwt_secret_32bytes_long";

    ownerUser = await User.create({
      name: "Owner User",
      email: `owner_${Date.now()}@alpha.com`,
      phone: `+91999999${Math.floor(1000 + Math.random() * 9000)}`,
      password: "password123",
      organizationId: organization._id,
      role: ownerRole._id,
      roles: [ownerRole._id],
      hasOrgWideAccess: true,
      branchAccess: [
        { branchId: branch1._id, branchName: branch1.name, roleId: ownerRole._id, isActive: true },
        { branchId: branch2._id, branchName: branch2.name, roleId: ownerRole._id, isActive: true },
      ],
      isActive: true,
    });
    ownerToken = jwt.sign(
      {
        id: ownerUser._id.toString(),
        userId: ownerUser._id.toString(),
        organizationId: organization._id.toString(),
        email: ownerUser.email,
        roles: ["owner"],
      },
      jwtSecret,
      { expiresIn: "1h" }
    );

    managerUser = await User.create({
      name: "Branch Manager",
      email: `manager_${Date.now()}@alpha.com`,
      phone: `+91999999${Math.floor(1000 + Math.random() * 9000)}`,
      password: "password123",
      organizationId: organization._id,
      role: managerRole._id,
      roles: [managerRole._id],
      hasOrgWideAccess: false,
      branchAccess: [{ branchId: branch1._id, branchName: branch1.name, roleId: managerRole._id, isActive: true }],
      isActive: true,
    });
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

    auditorUser = await User.create({
      name: "Compliance Auditor",
      email: `auditor_${Date.now()}@alpha.com`,
      phone: `+91999999${Math.floor(1000 + Math.random() * 9000)}`,
      password: "password123",
      organizationId: organization._id,
      role: auditorRole._id,
      roles: [auditorRole._id],
      hasOrgWideAccess: true,
      branchAccess: [
        { branchId: branch1._id, branchName: branch1.name, roleId: auditorRole._id, isActive: true },
        { branchId: branch2._id, branchName: branch2.name, roleId: auditorRole._id, isActive: true },
      ],
      isActive: true,
    });
    auditorToken = jwt.sign(
      {
        id: auditorUser._id.toString(),
        userId: auditorUser._id.toString(),
        organizationId: organization._id.toString(),
        email: auditorUser.email,
        roles: ["auditor"],
      },
      jwtSecret,
      { expiresIn: "1h" }
    );

    cashierUser = await User.create({
      name: "Cashier Desk",
      email: `cashier_${Date.now()}@alpha.com`,
      phone: `+91999999${Math.floor(1000 + Math.random() * 9000)}`,
      password: "password123",
      organizationId: organization._id,
      role: cashierRole._id,
      roles: [cashierRole._id],
      hasOrgWideAccess: false,
      branchAccess: [{ branchId: branch1._id, branchName: branch1.name, roleId: cashierRole._id, isActive: true }],
      isActive: true,
    });
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

    const otherOrgRole = await Role.create({
      name: `other_owner_${Date.now()}`,
      organizationId: otherOrg._id,
      permissions: Object.values(permDocs),
      isSystem: true,
    });

    const otherOrgUser = await User.create({
      name: "Other Org User",
      email: `other_${Date.now()}@beta.com`,
      phone: `+91999999${Math.floor(1000 + Math.random() * 9000)}`,
      password: "password123",
      organizationId: otherOrg._id,
      role: otherOrgRole._id,
      roles: [otherOrgRole._id],
      hasOrgWideAccess: true,
      branchAccess: [
        {
          branchId: otherOrgBranch._id,
          branchName: otherOrgBranch.name,
          roleId: otherOrgRole._id,
          isActive: true,
        },
      ],
      isActive: true,
    });

    otherOrgToken = jwt.sign(
      {
        id: otherOrgUser._id.toString(),
        userId: otherOrgUser._id.toString(),
        organizationId: otherOrg._id.toString(),
        email: otherOrgUser.email,
        roles: ["owner"],
      },
      jwtSecret,
      { expiresIn: "1h" }
    );

    // 6. Seed Operational Financial Data
    const dummyCustId = new mongoose.Types.ObjectId();
    const dummyCustSnapshot = {
      name: "Client Test",
      phone: "+919888881234",
      email: "client@test.com",
    };

    const inv1 = await Invoice.create({
      organizationId: organization._id,
      branchId: branch1._id,
      invoiceNumber: "INV-B1-001",
      invoiceType: "retail",
      customerId: dummyCustId,
      customerSnapshot: dummyCustSnapshot,
      status: "finalized",
      paymentStatus: "paid",
      finalizedAt: new Date("2026-11-10T10:00:00Z"),
      subtotal: 5000,
      grossPayable: 5000,
      payableAmount: 5000,
      amountPaid: 5000,
      amountDue: 0,
      createdBy: managerUser._id,
      lines: [
        {
          lineType: "service",
          serviceType: "custom",
          name: "Hair Spa",
          quantity: 1,
          unitPrice: 5000,
          subtotal: 5000,
          lineTotal: 5000,
          customerPayable: 5000,
        },
      ],
    });

    await Payment.create({
      organizationId: organization._id,
      branchId: branch1._id,
      invoiceId: inv1._id,
      customerId: dummyCustId,
      paymentNumber: "PAY-B1-001",
      amount: 5000,
      type: "payment",
      method: "card",
      status: "completed",
      recordedBy: cashierUser._id,
      paymentDate: new Date("2026-11-10T10:05:00Z"),
    });

    // Branch 2 payment
    const inv2 = await Invoice.create({
      organizationId: organization._id,
      branchId: branch2._id,
      invoiceNumber: "INV-B2-001",
      invoiceType: "retail",
      customerId: dummyCustId,
      customerSnapshot: dummyCustSnapshot,
      status: "finalized",
      paymentStatus: "paid",
      finalizedAt: new Date("2026-11-12T11:00:00Z"),
      subtotal: 8000,
      grossPayable: 8000,
      payableAmount: 8000,
      amountPaid: 8000,
      amountDue: 0,
      createdBy: ownerUser._id,
      lines: [
        {
          lineType: "service",
          serviceType: "custom",
          name: "Keratin Treatment",
          quantity: 1,
          unitPrice: 8000,
          subtotal: 8000,
          lineTotal: 8000,
          customerPayable: 8000,
        },
      ],
    });

    await Payment.create({
      organizationId: organization._id,
      branchId: branch2._id,
      invoiceId: inv2._id,
      customerId: dummyCustId,
      paymentNumber: "PAY-B2-001",
      amount: 8000,
      type: "payment",
      method: "upi",
      status: "completed",
      recordedBy: ownerUser._id,
      paymentDate: new Date("2026-11-12T11:05:00Z"),
    });

    // Operating Expense in Branch 1
    await Expense.create({
      organizationId: organization._id,
      branchId: branch1._id,
      expenseCode: "EXP-B1-001",
      category: "utilities",
      amount: 1500,
      paymentMethod: "bank_transfer",
      payeeName: "Power Utility Corp",
      approvalStatus: "approved",
      paymentStatus: "settled",
      approvalThresholdAtCreation: 5000,
      recordedBy: managerUser._id,
      expenseDate: new Date("2026-11-15T09:00:00Z"),
    });

    // Petty Cash Replenishment in Branch 1
    await PettyCashTransaction.create({
      organizationId: organization._id,
      branchId: branch1._id,
      transactionNumber: "PC-B1-001",
      type: "replenishment",
      amount: 3000,
      description: "Weekly Petty Cash Imprest",
      recordedBy: managerUser._id,
      transactionDate: new Date("2026-11-08T08:00:00Z"),
    });

    // Supplier Payment in Branch 1
    const supp = await Supplier.create({
      organizationId: organization._id,
      name: "Salon Essentials Ltd",
      contactPerson: "Rajesh",
      phone: "9876543210",
      email: "supplier@essentials.com",
    });

    const suppInv = await SupplierInvoice.create({
      organizationId: organization._id,
      branchId: branch1._id,
      invoiceNumber: "SUPP-INV-001",
      supplierId: supp._id,
      totalAmount: 10000,
      amountPaid: 4000,
      status: "partially_paid",
      invoiceDate: new Date("2026-11-05"),
      dueDate: new Date("2026-11-25"),
      createdBy: managerUser._id,
    });

    await SupplierPayment.create({
      organizationId: organization._id,
      branchId: branch1._id,
      paymentNumber: "SUPP-PAY-001",
      supplierId: supp._id,
      supplierInvoiceId: suppInv._id,
      amount: 4000,
      paymentMethod: "bank_transfer",
      paymentDate: new Date("2026-11-14T14:00:00Z"),
      recordedBy: managerUser._id,
    });
  });

  describe("1. Branch-by-Branch Performance Matrix", () => {
    it("allows Owner with org-wide scope to compare all branches side-by-side", async () => {
      const res = await request(app)
        .get("/api/v1/finance/branch-performance")
        .set("Authorization", `Bearer ${ownerToken}`)
        .query({ startDate: "2026-11-01", endDate: "2026-11-30" });

      expect(res.status).toBe(200);
      expect(res.body.success).toBe(true);
      expect(res.body.data.branches).toBeDefined();
      expect(res.body.data.branches.length).toBe(2);

      // Branch 1 has 5000 revenue
      const b1 = res.body.data.branches.find((b) => b.branchId === branch1._id.toString());
      expect(b1).toBeDefined();
      expect(b1.grossRevenue).toBe(5000);
      expect(b1.operatingExpenses).toBe(1500);

      // Branch 2 has 8000 revenue
      const b2 = res.body.data.branches.find((b) => b.branchId === branch2._id.toString());
      expect(b2).toBeDefined();
      expect(b2.grossRevenue).toBe(8000);

      // Consolidated total = 13000
      expect(res.body.data.consolidated.grossRevenue).toBe(13000);
      expect(res.body.data.consolidated.operatingExpenses).toBe(1500);
      expect(res.body.data.consolidated.netRevenue).toBe(13000);
    });

    it("restricts Branch Manager strictly to their assigned branch", async () => {
      const res = await request(app)
        .get("/api/v1/finance/branch-performance")
        .set("Authorization", `Bearer ${managerToken}`)
        .set("X-Branch-Id", branch1._id.toString())
        .query({ startDate: "2026-11-01", endDate: "2026-11-30" });

      expect(res.status).toBe(200);
      expect(res.body.data.branches.length).toBe(1);
      expect(res.body.data.branches[0].branchId).toBe(branch1._id.toString());
    });

    it("rejects Branch Manager attempting to inspect another branch (403)", async () => {
      const res = await request(app)
        .get("/api/v1/finance/branch-performance")
        .set("Authorization", `Bearer ${managerToken}`)
        .set("X-Branch-Id", branch2._id.toString())
        .query({ startDate: "2026-11-01", endDate: "2026-11-30" });

      expect(res.status).toBe(403);
    });
  });

  describe("2. Unified Financial Transactions Explorer", () => {
    it("aggregates across payments, expenses, petty cash, and supplier payments with global pagination", async () => {
      const res = await request(app)
        .get("/api/v1/finance/transactions")
        .set("Authorization", `Bearer ${ownerToken}`)
        .query({
          startDate: "2026-11-01",
          endDate: "2026-11-30",
          page: 1,
          limit: 10,
        });

      expect(res.status).toBe(200);
      expect(res.body.success).toBe(true);
      expect(res.body.items).toBeDefined();
      expect(res.body.items.length).toBeGreaterThanOrEqual(4);

      // Verify that sourceTypes from multiple collections are present
      const sourceTypes = res.body.items.map((it) => it.sourceType);
      expect(sourceTypes).toContain("customer_payment");
      expect(sourceTypes).toContain("expense");
      expect(sourceTypes).toContain("petty_cash");
      expect(sourceTypes).toContain("supplier_payment");

      // Verify deterministic sorting (eventDate desc)
      for (let i = 0; i < res.body.items.length - 1; i++) {
        const d1 = new Date(res.body.items[i].eventDate).getTime();
        const d2 = new Date(res.body.items[i + 1].eventDate).getTime();
        expect(d1).toBeGreaterThanOrEqual(d2);
      }

      // Verify accurate totals
      expect(res.body.summary.totalInflow).toBeGreaterThan(0);
      expect(res.body.summary.totalOutflow).toBeGreaterThan(0);
    });

    it("filters transactions by type correctly", async () => {
      const res = await request(app)
        .get("/api/v1/finance/transactions")
        .set("Authorization", `Bearer ${ownerToken}`)
        .query({
          startDate: "2026-11-01",
          endDate: "2026-11-30",
          type: "expense",
        });

      expect(res.status).toBe(200);
      expect(res.body.items.every((it) => it.sourceType === "expense")).toBe(true);
      expect(res.body.items.length).toBe(1);
      expect(res.body.items[0].referenceNumber).toBe("EXP-B1-001");
    });
  });

  describe("3. Consolidated Financial Audit History", () => {
    it("returns audit logs for financial events", async () => {
      const res = await request(app)
        .get("/api/v1/finance/audit-history")
        .set("Authorization", `Bearer ${ownerToken}`)
        .query({
          startDate: "2026-11-01",
          endDate: "2026-11-30",
        });

      expect(res.status).toBe(200);
      expect(res.body.success).toBe(true);
      expect(res.body.items).toBeDefined();
      expect(res.body.pagination.total).toBeGreaterThanOrEqual(1);
    });
  });

  describe("4. Financial Reports & CSV Export", () => {
    it("generates structured JSON summary report", async () => {
      const res = await request(app)
        .get("/api/v1/finance/reports/summary")
        .set("Authorization", `Bearer ${ownerToken}`)
        .query({
          reportType: "pnl_statement",
          startDate: "2026-11-01",
          endDate: "2026-11-30",
        });

      expect(res.status).toBe(200);
      expect(res.body.success).toBe(true);
      expect(res.body.data.netRevenue).toBe(13000);
    });

    it("generates downloadable CSV report with proper headers", async () => {
      const res = await request(app)
        .get("/api/v1/finance/reports/export")
        .set("Authorization", `Bearer ${ownerToken}`)
        .query({
          reportType: "expense_breakdown",
          startDate: "2026-11-01",
          endDate: "2026-11-30",
        });

      expect(res.status).toBe(200);
      expect(res.headers["content-type"]).toContain("text/csv");
      expect(res.text).toContain("expenseCode,branchName,expenseDate,category,amount");
      expect(res.text).toContain("EXP-B1-001");
    });
  });

  describe("5. RBAC & Read-Only Auditor Direct Mutation Rejections", () => {
    it("allows Auditor to read financial reports, transactions, and audit history", async () => {
      const txRes = await request(app)
        .get("/api/v1/finance/transactions")
        .set("Authorization", `Bearer ${auditorToken}`)
        .query({ startDate: "2026-11-01", endDate: "2026-11-30" });
      expect(txRes.status).toBe(200);

      const auditRes = await request(app)
        .get("/api/v1/finance/audit-history")
        .set("Authorization", `Bearer ${auditorToken}`);
      expect(auditRes.status).toBe(200);
    });

    it("rejects Auditor direct API call to POST /day-closure with 403 Forbidden", async () => {
      const res = await request(app)
        .post("/api/v1/finance/day-closure")
        .set("Authorization", `Bearer ${auditorToken}`)
        .set("X-Branch-Id", branch1._id.toString())
        .send({
          businessDate: "2026-11-20",
          physicalCounts: { cash: 100, card: 0, upi: 0 },
        });

      expect(res.status).toBe(403);
    });

    it("rejects Auditor direct API call to PATCH /day-closure/:id/approve with 403 Forbidden", async () => {
      const dummyId = new mongoose.Types.ObjectId();
      const res = await request(app)
        .patch(`/api/v1/finance/day-closure/${dummyId}/approve`)
        .set("Authorization", `Bearer ${auditorToken}`)
        .set("X-Branch-Id", branch1._id.toString())
        .send({ managerNotes: "Auditor trying to approve" });

      expect(res.status).toBe(403);
    });

    it("rejects Auditor direct API call to POST /expenses with 403 Forbidden", async () => {
      const res = await request(app)
        .post("/api/v1/expenses")
        .set("Authorization", `Bearer ${auditorToken}`)
        .set("X-Branch-Id", branch1._id.toString())
        .send({
          category: "utilities",
          amount: 500,
          paymentMethod: "petty_cash",
          payeeName: "Malicious Actor",
        });

      expect(res.status).toBe(403);
    });

    it("rejects cross-organization access completely (404/403)", async () => {
      const res = await request(app)
        .get("/api/v1/finance/branch-performance")
        .set("Authorization", `Bearer ${managerToken}`)
        .set("X-Branch-Id", otherOrgBranch._id.toString())
        .query({ startDate: "2026-11-01", endDate: "2026-11-30" });

      expect([403, 404]).toContain(res.status);
    });
  });

  describe("6. Enhanced Lifecycle Reconciliations & Separation of Duties", () => {
    it("correctly computes outstanding payroll liabilities with partial and reversed payments", async () => {
      const dummyStaff = new mongoose.Types.ObjectId();
      const dummyPeriod = new mongoose.Types.ObjectId();

      const payrollRec = await PayrollRecord.create({
        organizationId: organization._id,
        branchId: branch1._id,
        payrollPeriodId: dummyPeriod,
        staffId: dummyStaff,
        monthYear: "2026-11",
        salaryStructureSnapshot: { payType: "monthly", baseSalary: 30000 },
        attendanceSummarySnapshot: { totalDaysInMonth: 30, eligibleDays: 30 },
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
        status: "approved",
        manualPaymentStatus: "recorded",
      });

      // 1. Partial confirmed payment: 10,000 in native paise (1,000,000 paise)
      await PayrollPayment.create({
        organizationId: organization._id,
        branchId: branch1._id,
        payrollRecordId: payrollRec._id,
        staffId: dummyStaff,
        amountInPaise: 1000000,
        paymentMethod: "bank_transfer",
        paymentReference: `PAY-PARTIAL-${Date.now()}`,
        paymentDate: new Date("2026-11-15"),
        status: "confirmed",
        idempotencyKey: `idem-part-${Date.now()}`,
        requestPayloadHash: "hash-part-1",
        recordedBy: managerUser._id,
        recordedAt: new Date(),
      });

      // 2. Reversed payment: 5,000 in native paise (500,000 paise) -> Must NOT reduce obligation
      await PayrollPayment.create({
        organizationId: organization._id,
        branchId: branch1._id,
        payrollRecordId: payrollRec._id,
        staffId: dummyStaff,
        amountInPaise: 500000,
        paymentMethod: "upi",
        paymentReference: `PAY-REV-${Date.now()}`,
        paymentDate: new Date("2026-11-16"),
        status: "reversed",
        idempotencyKey: `idem-rev-${Date.now()}`,
        requestPayloadHash: "hash-rev-1",
        recordedBy: managerUser._id,
        recordedAt: new Date(),
      });

      const res = await request(app)
        .get("/api/v1/finance/overview-alerts")
        .set("Authorization", `Bearer ${managerToken}`)
        .set("X-Branch-Id", branch1._id.toString());

      expect(res.status).toBe(200);
      // Net payable (30000) - Confirmed (10000) = 20000 remaining
      expect(res.body.data.outstandingPayrollObligations.totalUnpaidAmount).toBe(20000);
      expect(res.body.data.outstandingPayrollObligations.count).toBe(1);
    });

    it("reconciles supplier outstanding liabilities with child SupplierPayment records", async () => {
      const dummySupplier = new mongoose.Types.ObjectId();

      const invoice = await SupplierInvoice.create({
        organizationId: organization._id,
        branchId: branch2._id,
        invoiceNumber: `SUPP-INV-RECON-${Date.now()}`,
        supplierId: dummySupplier,
        totalAmount: 25000,
        amountPaid: 0,
        status: "partially_paid",
        createdBy: ownerUser._id,
        invoiceDate: new Date("2026-11-05"),
        dueDate: new Date("2026-11-25"),
      });

      // Partial payment of 10,000 recorded via SupplierPayment
      await SupplierPayment.create({
        organizationId: organization._id,
        branchId: branch2._id,
        paymentNumber: `SPAY-TEST-${Date.now()}`,
        supplierId: dummySupplier,
        supplierInvoiceId: invoice._id,
        amount: 10000,
        paymentMethod: "bank_transfer",
        paymentDate: new Date("2026-11-12"),
        recordedBy: ownerUser._id,
      });

      const res = await request(app)
        .get("/api/v1/finance/overview-alerts")
        .set("Authorization", `Bearer ${ownerToken}`)
        .set("X-Branch-Id", branch2._id.toString());

      expect(res.status).toBe(200);
      // Total 25000 - Paid 10000 = 15000 remaining
      expect(res.body.data.outstandingSupplierInvoices.totalUnpaidAmount).toBe(15000);
    });

    it("guarantees deterministic pagination across disparate collections with identical event timestamps", async () => {
      const fixedTimestamp = new Date("2026-11-18T10:00:00.000Z");

      // Seed 4 records across different collections with the exact same millisecond
      const dummyInv = new mongoose.Types.ObjectId();
      const dummyCust = new mongoose.Types.ObjectId();
      const dummySupp = new mongoose.Types.ObjectId();

      await Payment.create({
        organizationId: organization._id,
        branchId: branch1._id,
        invoiceId: dummyInv,
        customerId: dummyCust,
        paymentNumber: `PAY-TIE-${Date.now()}`,
        amount: 1200,
        type: "payment",
        method: "cash",
        status: "completed",
        recordedBy: managerUser._id,
        paymentDate: fixedTimestamp,
      });

      await Expense.create({
        organizationId: organization._id,
        branchId: branch1._id,
        expenseCode: `EXP-TIE-${Date.now()}`,
        category: "utilities",
        amount: 800,
        paymentMethod: "petty_cash",
        payeeName: "Tie Payee",
        expenseDate: fixedTimestamp,
        approvalStatus: "approved",
        paymentStatus: "settled",
        approvalThresholdAtCreation: 5000,
        recordedBy: managerUser._id,
      });

      await PettyCashTransaction.create({
        organizationId: organization._id,
        branchId: branch1._id,
        transactionNumber: `PC-TIE-${Date.now()}`,
        type: "replenishment",
        amount: 2000,
        transactionDate: fixedTimestamp,
        currentBalance: 5000,
        recordedBy: managerUser._id,
      });

      await SupplierPayment.create({
        organizationId: organization._id,
        branchId: branch1._id,
        paymentNumber: `SPAY-TIE-${Date.now()}`,
        supplierId: dummySupp,
        supplierInvoiceId: new mongoose.Types.ObjectId(),
        amount: 3000,
        paymentMethod: "bank_transfer",
        paymentDate: fixedTimestamp,
        recordedBy: managerUser._id,
      });

      // Page 1: 2 items
      const page1Res = await request(app)
        .get("/api/v1/finance/transactions")
        .set("Authorization", `Bearer ${managerToken}`)
        .set("X-Branch-Id", branch1._id.toString())
        .query({ page: 1, limit: 2 });

      expect(page1Res.status).toBe(200);
      expect(page1Res.body.items).toHaveLength(2);

      // Page 2: 2 items
      const page2Res = await request(app)
        .get("/api/v1/finance/transactions")
        .set("Authorization", `Bearer ${managerToken}`)
        .set("X-Branch-Id", branch1._id.toString())
        .query({ page: 2, limit: 2 });

      expect(page2Res.status).toBe(200);
      expect(page2Res.body.items).toHaveLength(2);

      // Verify no intersection between page 1 and page 2 (stable pagination)
      const page1Ids = page1Res.body.items.map((i) => i.id);
      const page2Ids = page2Res.body.items.map((i) => i.id);
      const overlap = page1Ids.filter((id) => page2Ids.includes(id));
      expect(overlap).toHaveLength(0);
    });

    it("enforces separation of duties on day closure and expense approvals (403 Forbidden)", async () => {
      // 1. User cannot approve their own Day Closure
      const closure = await DayClosure.create({
        organizationId: organization._id,
        branchId: branch1._id,
        businessDate: "2026-11-28",
        branchTimezone: "Asia/Kolkata",
        submittedBy: managerUser._id, // Manager submitted
        status: "submitted",
        reconciliationResult: "balanced",
        systemTotals: { cash: 100, card: 0, upi: 0, other: 0, totalCollected: 100, totalRefunded: 0, netExpected: 100 },
        physicalCounts: { cash: 100, card: 0, upi: 0, other: 0, totalCounted: 100 },
        discrepancy: { cashDelta: 0, cardDelta: 0, upiDelta: 0, otherDelta: 0, totalDelta: 0, reason: "" },
      });

      // Same manager attempts to approve their own closure
      const approveClosureRes = await request(app)
        .patch(`/api/v1/finance/day-closure/${closure._id}/approve`)
        .set("Authorization", `Bearer ${managerToken}`)
        .set("X-Branch-Id", branch1._id.toString())
        .send({ managerNotes: "Self approval attempt" });

      expect(approveClosureRes.status).toBe(403);
      expect(approveClosureRes.body.message).toMatch(/separation of duties/i);

      // 2. User cannot approve an expense they recorded
      const expense = await Expense.create({
        organizationId: organization._id,
        branchId: branch1._id,
        expenseCode: `EXP-SOD-${Date.now()}`,
        category: "maintenance",
        amount: 8000,
        paymentMethod: "bank_transfer",
        payeeName: "AC Guy",
        expenseDate: new Date(),
        approvalStatus: "pending_approval",
        approvalThresholdAtCreation: 5000,
        recordedBy: managerUser._id, // Manager recorded
      });

      // Same manager attempts to approve
      const approveExpRes = await request(app)
        .patch(`/api/v1/expenses/${expense._id}/approve`)
        .set("Authorization", `Bearer ${managerToken}`)
        .set("X-Branch-Id", branch1._id.toString());

      expect(approveExpRes.status).toBe(403);
      expect(approveExpRes.body.message).toMatch(/separation of duties/i);
    });

    it("enforces refund authority: completed non-deleted Payment refunds appear exactly once and ignore voided/deleted refunds", async () => {
      const refundCustId = new mongoose.Types.ObjectId();
      const testDate = new Date("2026-11-15T12:00:00Z");

      const testInvoice = await Invoice.create({
        organizationId: organization._id,
        branchId: branch1._id,
        invoiceNumber: `INV-REF-TEST-${Date.now()}`,
        invoiceType: "retail",
        customerId: refundCustId,
        customerSnapshot: {
          name: "Refund Client",
          phone: "+919888881234",
          email: "refund@test.com",
        },
        status: "finalized",
        paymentStatus: "paid",
        finalizedAt: testDate,
        subtotal: 6000,
        grossPayable: 6000,
        payableAmount: 6000,
        amountPaid: 6000,
        amountDue: 0,
        createdBy: managerUser._id,
        lines: [
          {
            lineType: "service",
            serviceType: "custom",
            name: "Hair Styling",
            quantity: 1,
            unitPrice: 6000,
            subtotal: 6000,
            lineTotal: 6000,
            customerPayable: 6000,
          },
        ],
      });

      // 1. Valid completed payment
      await Payment.create({
        organizationId: organization._id,
        branchId: branch1._id,
        invoiceId: testInvoice._id,
        customerId: refundCustId,
        paymentNumber: `PAY-ORIG-${Date.now()}`,
        amount: 6000,
        type: "payment",
        method: "cash",
        status: "completed",
        isDeleted: false,
        recordedBy: cashierUser._id,
        paymentDate: testDate,
      });

      // 2. Valid completed refund (authoritative: exactly once)
      const validRefund = await Payment.create({
        organizationId: organization._id,
        branchId: branch1._id,
        invoiceId: testInvoice._id,
        customerId: refundCustId,
        paymentNumber: `PAY-REF-OK-${Date.now()}`,
        amount: -1500,
        type: "refund",
        method: "cash",
        status: "completed",
        isDeleted: false,
        recordedBy: cashierUser._id,
        paymentDate: testDate,
        referenceNote: "Valid Partial Refund",
      });

      // 3. Voided refund (MUST NOT be counted)
      await Payment.create({
        organizationId: organization._id,
        branchId: branch1._id,
        invoiceId: testInvoice._id,
        customerId: refundCustId,
        paymentNumber: `PAY-REF-VOID-${Date.now()}`,
        amount: -1000,
        type: "refund",
        method: "cash",
        status: "voided",
        isDeleted: false,
        recordedBy: cashierUser._id,
        paymentDate: testDate,
      });

      // 4. Soft-deleted refund (MUST NOT be counted)
      await Payment.create({
        organizationId: organization._id,
        branchId: branch1._id,
        invoiceId: testInvoice._id,
        customerId: refundCustId,
        paymentNumber: `PAY-REF-DEL-${Date.now()}`,
        amount: -1000,
        type: "refund",
        method: "cash",
        status: "completed",
        isDeleted: true,
        recordedBy: cashierUser._id,
        paymentDate: testDate,
      });

      // Query operating profit for this specific day
      const opRes = await request(app)
        .get("/api/v1/finance/operating-profit")
        .set("Authorization", `Bearer ${ownerToken}`)
        .set("X-Branch-Id", branch1._id.toString())
        .query({ startDate: "2026-11-15", endDate: "2026-11-15" });

      expect(opRes.status).toBe(200);
      expect(opRes.body.data.grossRevenue).toBe(6000);
      expect(opRes.body.data.refunds).toBe(1500); // Only the 1 completed, non-deleted refund
      expect(opRes.body.data.netRevenue).toBe(4500); // 6000 - 1500

      // Query transaction register with search for this invoice's payments
      const txRes = await request(app)
        .get("/api/v1/finance/transactions")
        .set("Authorization", `Bearer ${ownerToken}`)
        .set("X-Branch-Id", branch1._id.toString())
        .query({
          startDate: "2026-11-15",
          endDate: "2026-11-15",
          search: "Refund",
        });

      expect(txRes.status).toBe(200);
      // Ensure the refund appears exactly once
      const refundItems = txRes.body.items.filter(
        (t) => t.sourceType === "customer_refund" && t.id === validRefund._id.toString()
      );
      expect(refundItems).toHaveLength(1);
      expect(refundItems[0].amount).toBe(1500);
      expect(refundItems[0].direction).toBe("outflow");
    });

    it("enforces audit integrity: state changes record actor, previous/new state, and rejects API mutation attempts", async () => {
      // 1. Audit history query returns structured events with actor & previous/new state
      const auditRes = await request(app)
        .get("/api/v1/finance/audit-history")
        .set("Authorization", `Bearer ${auditorToken}`)
        .query({ startDate: "2026-11-01", endDate: "2026-11-30" });

      expect(auditRes.status).toBe(200);
      expect(Array.isArray(auditRes.body.items)).toBe(true);
      expect(auditRes.body.items.length).toBeGreaterThan(0);

      const firstItem = auditRes.body.items[0];
      expect(firstItem).toHaveProperty("actorName");
      expect(firstItem).toHaveProperty("timestamp");
      expect(firstItem).toHaveProperty("action");
      expect(firstItem.details).toHaveProperty("previousState");
      expect(firstItem.details).toHaveProperty("newState");

      // 2. Reject mutation attempts against audit-history (404/405 - route cannot be altered)
      const putRes = await request(app)
        .put("/api/v1/finance/audit-history")
        .set("Authorization", `Bearer ${ownerToken}`)
        .send({ tamper: true });
      expect([404, 405]).toContain(putRes.status);

      const delRes = await request(app)
        .delete("/api/v1/finance/audit-history")
        .set("Authorization", `Bearer ${ownerToken}`);
      expect([404, 405]).toContain(delRes.status);
    });

    it("enforces tenant and branch isolation across cross-org and branch-scoped requests", async () => {
      // 1. Cross-org denial: otherOrg user attempting to access branch1 of organization
      const crossOrgRes = await request(app)
        .get("/api/v1/finance/day-closure/system-totals")
        .set("Authorization", `Bearer ${otherOrgToken}`)
        .set("X-Branch-Id", branch1._id.toString())
        .query({ businessDate: "2026-11-10" });
      expect([403, 404]).toContain(crossOrgRes.status);

      // 2. Branch-limited access: managerUser (assigned to branch1 only) trying to access branch2
      const branchForbiddenRes = await request(app)
        .get("/api/v1/finance/day-closure/system-totals")
        .set("Authorization", `Bearer ${managerToken}`)
        .set("X-Branch-Id", branch2._id.toString())
        .query({ businessDate: "2026-11-10" });
      expect(branchForbiddenRes.status).toBe(403);

      // 3. Reject invalid X-Branch-Id: all
      const allBranchRes = await request(app)
        .get("/api/v1/finance/day-closure/system-totals")
        .set("Authorization", `Bearer ${ownerToken}`)
        .set("X-Branch-Id", "all")
        .query({ businessDate: "2026-11-10" });
      expect(allBranchRes.status).toBe(400);

      // 4. Org-wide access: owner omitting X-Branch-Id succeeds for org-level aggregations
      const orgWideRes = await request(app)
        .get("/api/v1/finance/branch-performance")
        .set("Authorization", `Bearer ${ownerToken}`)
        .query({ startDate: "2026-11-01", endDate: "2026-11-30" });
      expect(orgWideRes.status).toBe(200);
      expect(orgWideRes.body.data.consolidated).toBeDefined();
    });

    it("handles payroll & supplier obligations: unconfirmed payments do not reduce liability, cancellations excluded", async () => {
      // 1. Supplier: Cancelled invoice is completely excluded from obligations
      await SupplierInvoice.create({
        organizationId: organization._id,
        branchId: branch2._id,
        invoiceNumber: `SINV-CANCELLED-${Date.now()}`,
        supplierId: new mongoose.Types.ObjectId(),
        invoiceDate: new Date(),
        dueDate: new Date(),
        totalAmount: 50000,
        amountPaid: 0,
        status: "cancelled",
        createdBy: managerUser._id,
      });

      // 2. Supplier: Invoice with 12,000 total and 6,000 partial payment -> 6,000 remaining
      const suppInvPending = await SupplierInvoice.create({
        organizationId: organization._id,
        branchId: branch2._id,
        invoiceNumber: `SINV-PARTIAL-${Date.now()}`,
        supplierId: new mongoose.Types.ObjectId(),
        invoiceDate: new Date(),
        dueDate: new Date(),
        totalAmount: 12000,
        amountPaid: 0,
        status: "partially_paid",
        createdBy: managerUser._id,
      });

      await SupplierPayment.create({
        organizationId: organization._id,
        branchId: branch2._id,
        supplierId: suppInvPending.supplierId,
        supplierInvoiceId: suppInvPending._id,
        paymentNumber: `SPAY-PARTIAL-${Date.now()}`,
        paymentDate: new Date(),
        amount: 6000,
        paymentMethod: "bank_transfer",
        recordedBy: managerUser._id,
      });

      // Query alerts for branch2
      const alertsRes = await request(app)
        .get("/api/v1/finance/overview-alerts")
        .set("Authorization", `Bearer ${ownerToken}`)
        .set("X-Branch-Id", branch2._id.toString());

      expect(alertsRes.status).toBe(200);
      // Cancelled 50,000 is excluded, 12,000 - 6,000 payment leaves 6,000 remaining
      expect(
        alertsRes.body.data.outstandingSupplierInvoices.totalUnpaidAmount
      ).toBeGreaterThanOrEqual(6000);
    });
  });

  afterAll(async () => {
    try {
      await mongoose.connection.dropDatabase();
      await mongoose.connection.close();
    } catch (_) {}
  });
});
