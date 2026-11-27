import { describe, expect, it, beforeAll, afterAll, jest } from "@jest/globals";
import mongoose from "mongoose";
import "../../database/db.js";
import { getIsolatedTestMongoUri } from "../testSetup.js";
import { redis } from "../../../src/utils/redis.js";

import { Organization } from "../../../src/models/organizations/organization.model.js";
import { Branch } from "../../../src/models/branches/branch.model.js";
import { Customer } from "../../../src/models/customers/customer.model.js";
import { User } from "../../../src/models/users/user.model.js";
import { Invoice } from "../../../src/models/billing/invoice.model.js";
import { Payment } from "../../../src/models/billing/payment.model.js";
import { RefundCase } from "../../../src/models/billing/refundCase.model.js";

import { FinanceService } from "../../../src/services/finance/finance.service.js";
import { reportsService } from "../../../src/services/reports/reports.service.js";
const financeService = new FinanceService();
import { DashboardOverviewService } from "../../../src/services/dashboard/dashboardOverview.service.js";
const dashboardOverviewService = new DashboardOverviewService();

jest.spyOn(redis, "get").mockResolvedValue(null);
jest.spyOn(redis, "setex").mockResolvedValue("OK");

describe("Refund Accounting Reconciliation: Finance, Reports & Dashboard (Live Atlas)", () => {
  jest.setTimeout(60000);

  let orgId, otherOrgId, branchId, otherBranchId, userId, customerId;
  const todayStr = new Date().toISOString().slice(0, 10);

  beforeAll(async () => {
    process.env.NODE_ENV = "test";
    const testUri = getIsolatedTestMongoUri("finance_test");
    await mongoose.connect(testUri);

    const org = await Organization.create({
      name: "Org Finance Recon",
      ownerEmail: "ownerrecon@example.com",
      status: "active",
    });
    orgId = org._id;

    const otherOrg = await Organization.create({
      name: "Other Org Recon",
      ownerEmail: "otherrecon@example.com",
      status: "active",
    });
    otherOrgId = otherOrg._id;

    const branch = await Branch.create({
      organizationId: orgId,
      name: "Main Branch",
      code: "MAIN-RECON",
      status: "active",
    });
    branchId = branch._id;

    const otherBranch = await Branch.create({
      organizationId: orgId,
      name: "Second Branch",
      code: "SEC-RECON",
      status: "active",
    });
    otherBranchId = otherBranch._id;

    const user = await User.create({
      organizationId: orgId,
      branchIds: [branchId, otherBranchId],
      name: "Recon Owner",
      email: "reconowner@example.com",
      phone: "9999977777",
      password: "Password123!",
      role: new mongoose.Types.ObjectId(),
      status: "active",
    });
    userId = user._id;

    const customer = await Customer.create({
      organizationId: orgId,
      homeBranchId: branchId,
      name: "Recon Customer",
      phone: "9999988888",
      status: "active",
    });
    customerId = customer._id;

    const now = new Date();

    // 1. Finalized invoice in target org + branch: 1500 INR (1000 cash + 500 upi)
    const inv1 = await Invoice.create({
      organizationId: orgId,
      branchId,
      customerId,
      customerSnapshot: { name: "Recon Customer", phone: "9999988888" },
      invoiceNumber: `INV-REC-1-${Date.now()}`,
      status: "finalized",
      paymentStatus: "paid",
      finalizedAt: now,
      subtotal: 1500,
      grossPayable: 1500,
      payableAmount: 1500,
      paidAmount: 1500,
      amountDue: 0,
      createdBy: userId,
      lines: [
        {
          lineType: "product",
          productId: new mongoose.Types.ObjectId(),
          sku: "SER-001",
          name: "Serum",
          quantity: 1,
          unitPrice: 1500,
          lineTotal: 1500,
          customerPayable: 1500,
        },
      ],
    });

    await Payment.create([
      {
        organizationId: orgId,
        branchId,
        invoiceId: inv1._id,
        customerId,
        paymentNumber: `PAY-C-${Date.now()}`,
        amount: 1000,
        method: "cash",
        type: "payment",
        status: "completed",
        recordedBy: userId,
        paymentDate: now,
      },
      {
        organizationId: orgId,
        branchId,
        invoiceId: inv1._id,
        customerId,
        paymentNumber: `PAY-U-${Date.now()}`,
        amount: 500,
        method: "upi",
        type: "payment",
        status: "completed",
        recordedBy: userId,
        paymentDate: now,
      },
      // Completed refund: -300 cash
      {
        organizationId: orgId,
        branchId,
        invoiceId: inv1._id,
        customerId,
        paymentNumber: `REF-C-${Date.now()}`,
        amount: -300,
        method: "cash",
        type: "refund",
        status: "completed",
        recordedBy: userId,
        paymentDate: now,
      },
    ]);

    // Settled RefundCase with domain reversal still "processing" (must NOT be counted as pending/failed)
    await RefundCase.create({
      organizationId: orgId,
      branchId,
      invoiceId: inv1._id,
      customerId,
      refundNumber: `RC-SET-${Date.now()}`,
      refundMode: "item_linked",
      requestedAmountPaise: 30000,
      pendingAmountPaise: 0,
      settledAmountPaise: 30000,
      refundMethod: "cash",
      status: "processing",
      paymentSettlementStatus: "settled",
      initiatedBy: userId,
      reason: "Settled refund",
      createdBy: userId,
    });

    // Pending RefundCase: 200 INR (20000 paise)
    await RefundCase.create({
      organizationId: orgId,
      branchId,
      invoiceId: inv1._id,
      customerId,
      refundNumber: `RC-PEN-${Date.now()}`,
      refundMode: "item_linked",
      requestedAmountPaise: 20000,
      pendingAmountPaise: 20000,
      settledAmountPaise: 0,
      refundMethod: "cash",
      status: "pending",
      paymentSettlementStatus: "pending",
      initiatedBy: userId,
      reason: "Pending refund",
      createdBy: userId,
    });

    // Failed RefundCase: 150 INR (15000 paise)
    await RefundCase.create({
      organizationId: orgId,
      branchId,
      invoiceId: inv1._id,
      customerId,
      refundNumber: `RC-FAIL-${Date.now()}`,
      refundMode: "item_linked",
      requestedAmountPaise: 15000,
      pendingAmountPaise: 15000,
      settledAmountPaise: 0,
      refundMethod: "cash",
      status: "failed",
      paymentSettlementStatus: "failed",
      initiatedBy: userId,
      reason: "Failed refund",
      createdBy: userId,
    });

    // 2. Noise in otherBranchId (must be excluded when filtering by branchId)
    const invOtherBranch = await Invoice.create({
      organizationId: orgId,
      branchId: otherBranchId,
      customerId,
      customerSnapshot: { name: "Recon Customer", phone: "9999988888" },
      invoiceNumber: `INV-OB-${Date.now()}`,
      status: "finalized",
      paymentStatus: "paid",
      finalizedAt: now,
      subtotal: 900,
      grossPayable: 900,
      payableAmount: 900,
      paidAmount: 900,
      amountDue: 0,
      createdBy: userId,
      lines: [],
    });
    await Payment.create({
      organizationId: orgId,
      branchId: otherBranchId,
      invoiceId: invOtherBranch._id,
      customerId,
      paymentNumber: `PAY-OB-${Date.now()}`,
      amount: 900,
      method: "card",
      type: "payment",
      status: "completed",
      recordedBy: userId,
      paymentDate: now,
    });

    // 3. Noise in otherOrgId (must be excluded by tenant isolation)
    const invOtherOrg = await Invoice.create({
      organizationId: otherOrgId,
      branchId,
      customerId,
      customerSnapshot: { name: "Other", phone: "1111111111" },
      invoiceNumber: `INV-OO-${Date.now()}`,
      status: "finalized",
      paymentStatus: "paid",
      finalizedAt: now,
      subtotal: 5000,
      grossPayable: 5000,
      payableAmount: 5000,
      paidAmount: 5000,
      amountDue: 0,
      createdBy: userId,
      lines: [],
    });
    await Payment.create({
      organizationId: otherOrgId,
      branchId,
      invoiceId: invOtherOrg._id,
      customerId,
      paymentNumber: `PAY-OO-${Date.now()}`,
      amount: 5000,
      method: "cash",
      type: "payment",
      status: "completed",
      recordedBy: userId,
      paymentDate: now,
    });
  });

  afterAll(async () => {
    if (mongoose.connection.readyState === 1) {
      await mongoose.connection.dropDatabase();
      await mongoose.disconnect();
    }
  });

  it("1. Finance system totals reconcile gross/net collections, tenders, and settled refunds only", async () => {
    const summary = await FinanceService.getOperatingProfit(
      orgId,
      branchId,
      todayStr,
      todayStr,
    );
    expect(summary.grossRevenue).toBe(1500);
    expect(summary.refunds).toBe(300);
    expect(summary.netRevenue).toBe(1200);
    expect(summary.collections.totalCollected).toBe(1500);
    expect(summary.collections.netCollections).toBe(1200);

    expect(summary.collections.cash).toBe(700);
    expect(summary.collections.upi).toBe(500);
  });

  it("2. Reports reconcile gross collections, refunds issued, and net collections with branch isolation", async () => {
    const report = await reportsService.getRevenueReport(
      orgId,
      branchId,
      { startDate: todayStr, endDate: todayStr },
    );
    expect(report.summary.grossCollected.current).toBe(1500);
    expect(report.summary.refundsIssued.current).toBe(300);
    expect(report.summary.netCollected.current).toBe(1200);
  });

  it("3. Dashboard KPIs reconcile refunds, netCollections, netSales, pendingRefunds, and failedRefunds", async () => {
    const overview = await dashboardOverviewService.getOverview(
      orgId,
      branchId,
      { startDate: todayStr, endDate: todayStr },
      ["billing.view", "payments.view", "appointments.view", "customers.view"],
    );
    expect(overview.kpis.collections.current).toBe(1500);
    expect(overview.kpis.refunds.current).toBe(300);
    expect(overview.kpis.netCollections.current).toBe(1200);
    expect(overview.kpis.netSales.current).toBe(1200);
    expect(overview.kpis.pendingRefunds).toEqual({ amount: 200, count: 1 });
    expect(overview.kpis.failedRefunds).toEqual({ amount: 150, count: 1 });
  });

  it("4. Dashboard RefundCase aggregation respects non-UTC timezone (Asia/Kolkata) day boundaries", async () => {
    const invTz = await Invoice.create({
      organizationId: orgId,
      branchId,
      customerId,
      customerSnapshot: { name: "Recon Customer", phone: "9999988888" },
      invoiceNumber: `INV-TZ-${Date.now()}`,
      status: "finalized",
      paymentStatus: "paid",
      finalizedAt: new Date("2026-11-26T20:00:00.000Z"),
      subtotal: 500,
      grossPayable: 500,
      payableAmount: 500,
      paidAmount: 500,
      amountDue: 0,
      createdBy: userId,
      lines: [],
    });

    // 2026-11-26T20:00:00Z = 2026-11-27T01:30:00+05:30 (inside 2026-11-27 IST)
    await RefundCase.create({
      organizationId: orgId,
      branchId,
      invoiceId: invTz._id,
      customerId,
      refundNumber: `RC-IST-IN-${Date.now()}`,
      refundMode: "item_linked",
      requestedAmountPaise: 12000,
      pendingAmountPaise: 12000,
      settledAmountPaise: 0,
      refundMethod: "cash",
      status: "pending",
      paymentSettlementStatus: "pending",
      initiatedBy: userId,
      reason: "IST inside day",
      createdAt: new Date("2026-11-26T20:00:00.000Z"),
    });

    // 2026-11-26T18:00:00Z = 2026-11-26T23:30:00+05:30 (outside 2026-11-27 IST)
    await RefundCase.create({
      organizationId: orgId,
      branchId,
      invoiceId: invTz._id,
      customerId,
      refundNumber: `RC-IST-OUT-${Date.now()}`,
      refundMode: "item_linked",
      requestedAmountPaise: 9000,
      pendingAmountPaise: 9000,
      settledAmountPaise: 0,
      refundMethod: "cash",
      status: "failed",
      paymentSettlementStatus: "failed",
      initiatedBy: userId,
      reason: "IST outside day",
      createdAt: new Date("2026-11-26T18:00:00.000Z"),
    });

    const overview = await dashboardOverviewService.getOverview(
      orgId,
      branchId,
      { startDate: "2026-11-27", endDate: "2026-11-27", timezone: "Asia/Kolkata" },
      ["billing.view", "payments.view", "appointments.view", "customers.view"],
    );

    // Includes 200 (from beforeAll) + 120 (from 20:00Z) = 320; excludes 90 (from 18:00Z)
    expect(overview.kpis.pendingRefunds).toEqual({ amount: 320, count: 2 });
    expect(overview.kpis.failedRefunds).toEqual({ amount: 150, count: 1 });
  });
});
