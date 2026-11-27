import { describe, expect, it, beforeAll, afterAll, beforeEach, jest } from "@jest/globals";
import request from "supertest";
import mongoose from "mongoose";
import jwt from "jsonwebtoken";
import app from "../../../app.mjs";
import { env } from "../../../src/config/env.js";
import { redis } from "../../../src/utils/redis.js";
import "../../database/db.js";
import { getIsolatedTestMongoUri } from "../testSetup.js";

import { Organization } from "../../../src/models/organizations/organization.model.js";
import { Branch } from "../../../src/models/branches/branch.model.js";
import { Customer } from "../../../src/models/customers/customer.model.js";
import { Role } from "../../../src/models/roles/role.model.js";
import { Permission } from "../../../src/models/permissions/permission.model.js";
import { User } from "../../../src/models/users/user.model.js";
import { Invoice } from "../../../src/models/billing/invoice.model.js";
import { Payment } from "../../../src/models/billing/payment.model.js";
import { RefundCase } from "../../../src/models/billing/refundCase.model.js";

jest.spyOn(redis, "get").mockResolvedValue(null);
jest.spyOn(redis, "setex").mockResolvedValue("OK");

describe("Refund Foundation: Context, Eligibility & Preview", () => {
  jest.setTimeout(45000);

  let orgAId, orgBId;
  let branchA1Id, branchA2Id;
  let ownerTokenA, branchUserTokenA, ownerTokenB;
  let ownerUserA, customerA;

  beforeAll(async () => {
    process.env.NODE_ENV = "test";
    const testUri = getIsolatedTestMongoUri("refund_foundation_test");
    await mongoose.connect(testUri);
    await Promise.all([
      User.deleteMany({}),
      Role.deleteMany({}),
      Permission.deleteMany({}),
      Organization.deleteMany({}),
      Branch.deleteMany({}),
      Customer.deleteMany({}),
      Invoice.deleteMany({}),
      Payment.deleteMany({}),
      RefundCase.deleteMany({}),
    ]);

    const orgA = await Organization.create({
      name: "Org A Salon",
      ownerEmail: "ownera@example.com",
      status: "active",
    });
    const orgB = await Organization.create({
      name: "Org B Salon",
      ownerEmail: "ownerb@example.com",
      status: "active",
    });
    orgAId = orgA._id;
    orgBId = orgB._id;

    const [bA1, bA2] = await Branch.create([
      { organizationId: orgAId, name: "Branch A1", code: "BA1", isActive: true },
      { organizationId: orgAId, name: "Branch A2", code: "BA2", isActive: true },
    ]);
    branchA1Id = bA1._id;
    branchA2Id = bA2._id;

    const perms = await Permission.create([
      { name: "payments.view", module: "Payments", action: "View", description: "View payments" },
      { name: "payments.refund", module: "Payments", action: "Refund", description: "Issue refunds" },
      { name: "billing.view", module: "Billing & POS", action: "View", description: "View billing" },
    ]);
    const permIds = perms.map((p) => p._id);

    const roleA = await Role.create({
      organizationId: orgAId,
      name: "Owner",
      permissions: permIds,
    });
    const roleB = await Role.create({
      organizationId: orgBId,
      name: "Owner",
      permissions: permIds,
    });

    ownerUserA = await User.create({
      organizationId: orgAId,
      name: "Owner A",
      email: "ownera@example.com",
      phone: "9000000001",
      password: "Password123!",
      role: roleA._id,
      hasOrgWideAccess: true,
      isActive: true,
    });

    const branchUserA = await User.create({
      organizationId: orgAId,
      name: "Branch User A1",
      email: "brancha1@example.com",
      phone: "9000000002",
      password: "Password123!",
      role: roleA._id,
      hasOrgWideAccess: false,
      branchAccess: [{ branchId: branchA1Id, branchName: "Branch A1", isActive: true }],
      isActive: true,
    });

    const ownerUserB = await User.create({
      organizationId: orgBId,
      name: "Owner B",
      email: "ownerb@example.com",
      phone: "9000000003",
      password: "Password123!",
      role: roleB._id,
      hasOrgWideAccess: true,
      isActive: true,
    });

    const jwtSecret = env.JWT_SECRET || env.JWT_ACCESS_SECRET;
    ownerTokenA = jwt.sign({ id: ownerUserA._id.toString() }, jwtSecret, {
      expiresIn: "1h",
    });
    branchUserTokenA = jwt.sign({ id: branchUserA._id.toString() }, jwtSecret, {
      expiresIn: "1h",
    });
    ownerTokenB = jwt.sign({ id: ownerUserB._id.toString() }, jwtSecret, {
      expiresIn: "1h",
    });

    customerA = await Customer.create({
      organizationId: orgAId,
      homeBranchId: branchA1Id,
      name: "Customer A",
      phone: "9999999999",
    });
  });

  afterAll(async () => {
    if (mongoose.connection.readyState === 1) {
      await mongoose.connection.dropDatabase();
    }
    await mongoose.connection.close();
  });

  beforeEach(async () => {
    await Promise.all([
      Invoice.deleteMany({}),
      Payment.deleteMany({}),
      RefundCase.deleteMany({}),
    ]);
  });

  const createInvoice = async (overrides = {}) => {
    return Invoice.create({
      organizationId: orgAId,
      branchId: branchA1Id,
      invoiceNumber: `INV-${Date.now()}-${Math.floor(Math.random() * 1000)}`,
      invoiceType: "retail",
      customerId: customerA._id,
      customerSnapshot: { name: "Customer A", phone: "9999999999" },
      lines: [
        {
          lineType: "product",
          productId: new mongoose.Types.ObjectId(),
          sku: "SKU-1",
          name: "Shampoo",
          quantity: 2,
          unitPrice: 500,
          lineTotal: 1000,
          customerPayable: 1000,
        },
      ],
      subtotal: 1000,
      discountTotal: 0,
      grossPayable: 1000,
      subscriptionCoveredAmount: 0,
      payableAmount: 1000,
      amountPaid: 1000,
      amountDue: 0,
      status: "finalized",
      paymentStatus: "paid",
      createdBy: ownerUserA._id,
      ...overrides,
    });
  };

  it("1. Finalized Paid invoice is eligible when refundable balance exists", async () => {
    const invoice = await createInvoice();
    await Payment.create({
      organizationId: orgAId,
      branchId: branchA1Id,
      invoiceId: invoice._id,
      customerId: customerA._id,
      paymentNumber: "PAY-1",
      amount: 1000,
      type: "payment",
      method: "cash",
      status: "completed",
      recordedBy: ownerUserA._id,
    });

    const res = await request(app)
      .get(`/api/v1/billing/invoices/${invoice._id}/refund-context`)
      .set("Authorization", `Bearer ${ownerTokenA}`)
      .set("x-branch-id", branchA1Id.toString());

    expect(res.status).toBe(200);
    expect(res.body.data.eligibility.isEligible).toBe(true);
    expect(res.body.data.summary.refundableBalancePaise).toBe(100000);
    expect(res.body.data.summary.derivedRefundStatus).toBe("none");
  });

  it("2. Draft, unpaid and partially paid invoices are rejected", async () => {
    const draftInv = await createInvoice({ status: "draft", paymentStatus: "unpaid", amountPaid: 0, amountDue: 1000 });
    const unpaidInv = await createInvoice({ status: "finalized", paymentStatus: "unpaid", amountPaid: 0, amountDue: 1000 });
    const partialInv = await createInvoice({ status: "finalized", paymentStatus: "partially_paid", amountPaid: 500, amountDue: 500 });

    for (const [inv, expectedCode] of [
      [draftInv, "DRAFT_INVOICE"],
      [unpaidInv, "UNPAID_INVOICE"],
      [partialInv, "PARTIALLY_PAID_INVOICE"],
    ]) {
      const ctxRes = await request(app)
        .get(`/api/v1/billing/invoices/${inv._id}/refund-context`)
        .set("Authorization", `Bearer ${ownerTokenA}`)
        .set("x-branch-id", branchA1Id.toString());

      expect(ctxRes.status).toBe(200);
      expect(ctxRes.body.data.eligibility.isEligible).toBe(false);
      expect(ctxRes.body.data.eligibility.reasonCode).toBe(expectedCode);

      const prevRes = await request(app)
        .post(`/api/v1/billing/invoices/${inv._id}/refunds/preview`)
        .set("Authorization", `Bearer ${ownerTokenA}`)
        .set("x-branch-id", branchA1Id.toString())
        .send({ refundMode: "financial_only", requestedAmountPaise: 10000 });

      expect(prevRes.status).toBe(400);
    }
  });

  it("3 & 4. Partially refunded invoice remains eligible; fully refunded is rejected", async () => {
    const invoice = await createInvoice();
    await Payment.create([
      {
        organizationId: orgAId,
        branchId: branchA1Id,
        invoiceId: invoice._id,
        customerId: customerA._id,
        paymentNumber: "PAY-2",
        amount: 1000,
        type: "payment",
        method: "cash",
        status: "completed",
        recordedBy: ownerUserA._id,
      },
      {
        organizationId: orgAId,
        branchId: branchA1Id,
        invoiceId: invoice._id,
        customerId: customerA._id,
        paymentNumber: "PAY-REF-1",
        amount: -400,
        type: "refund",
        method: "cash",
        status: "completed",
        recordedBy: ownerUserA._id,
      },
    ]);

    const partialRes = await request(app)
      .get(`/api/v1/billing/invoices/${invoice._id}/refund-context`)
      .set("Authorization", `Bearer ${ownerTokenA}`)
      .set("x-branch-id", branchA1Id.toString());

    expect(partialRes.status).toBe(200);
    expect(partialRes.body.data.eligibility.isEligible).toBe(true);
    expect(partialRes.body.data.summary.refundableBalancePaise).toBe(60000);
    expect(partialRes.body.data.summary.derivedRefundStatus).toBe("partially_refunded");

    await Payment.create({
      organizationId: orgAId,
      branchId: branchA1Id,
      invoiceId: invoice._id,
      customerId: customerA._id,
      paymentNumber: "PAY-REF-2",
      amount: -600,
      type: "refund",
      method: "cash",
      status: "completed",
      recordedBy: ownerUserA._id,
    });

    const fullRes = await request(app)
      .get(`/api/v1/billing/invoices/${invoice._id}/refund-context`)
      .set("Authorization", `Bearer ${ownerTokenA}`)
      .set("x-branch-id", branchA1Id.toString());

    expect(fullRes.status).toBe(200);
    expect(fullRes.body.data.eligibility.isEligible).toBe(false);
    expect(fullRes.body.data.eligibility.reasonCode).toBe("FULLY_REFUNDED");
    expect(fullRes.body.data.summary.derivedRefundStatus).toBe("fully_refunded");
  });

  it("5 & 6. Voided payments are excluded; pending RefundCase reserves balance", async () => {
    const invoice = await createInvoice();
    await Payment.create([
      {
        organizationId: orgAId,
        branchId: branchA1Id,
        invoiceId: invoice._id,
        customerId: customerA._id,
        paymentNumber: "PAY-3",
        amount: 1000,
        type: "payment",
        method: "cash",
        status: "completed",
        recordedBy: ownerUserA._id,
      },
      {
        organizationId: orgAId,
        branchId: branchA1Id,
        invoiceId: invoice._id,
        customerId: customerA._id,
        paymentNumber: "PAY-VOID",
        amount: 500,
        type: "payment",
        method: "upi",
        status: "voided",
        recordedBy: ownerUserA._id,
      },
    ]);

    await RefundCase.create({
      organizationId: orgAId,
      branchId: branchA1Id,
      invoiceId: invoice._id,
      customerId: customerA._id,
      refundNumber: "REF-1",
      refundMode: "financial_only",
      requestedAmountPaise: 30000,
      pendingAmountPaise: 30000,
      settledAmountPaise: 0,
      refundMethod: "cash",
      status: "pending",
      reason: "Pending approval",
      initiatedBy: ownerUserA._id,
    });

    const res = await request(app)
      .get(`/api/v1/billing/invoices/${invoice._id}/refund-context`)
      .set("Authorization", `Bearer ${ownerTokenA}`)
      .set("x-branch-id", branchA1Id.toString());

    expect(res.status).toBe(200);
    expect(res.body.data.summary.completedPaymentsPaise).toBe(100000);
    expect(res.body.data.summary.pendingReservedPaise).toBe(30000);
    expect(res.body.data.summary.refundableBalancePaise).toBe(70000);
    expect(res.body.data.summary.derivedRefundStatus).toBe("pending_refund");
  });

  it("7, 8 & 12. Preview is read-only, financial-only has no operational reversals, and repeated previews are consistent", async () => {
    const invoice = await createInvoice();
    await Payment.create({
      organizationId: orgAId,
      branchId: branchA1Id,
      invoiceId: invoice._id,
      customerId: customerA._id,
      paymentNumber: "PAY-4",
      amount: 1000,
      type: "payment",
      method: "cash",
      status: "completed",
      recordedBy: ownerUserA._id,
    });

    const res1 = await request(app)
      .post(`/api/v1/billing/invoices/${invoice._id}/refunds/preview`)
      .set("Authorization", `Bearer ${ownerTokenA}`)
      .set("x-branch-id", branchA1Id.toString())
      .send({ refundMode: "financial_only", requestedAmountPaise: 25000 });

    const res2 = await request(app)
      .post(`/api/v1/billing/invoices/${invoice._id}/refunds/preview`)
      .set("Authorization", `Bearer ${ownerTokenA}`)
      .set("x-branch-id", branchA1Id.toString())
      .send({ refundMode: "financial_only", requestedAmountPaise: 25000 });

    expect(res1.status).toBe(200);
    expect(res1.body.data).toEqual(res2.body.data);
    expect(res1.body.data.allocations).toEqual([]);
    expect(res1.body.data.remainingRefundableBalancePaise).toBe(75000);
    expect(await RefundCase.countDocuments({})).toBe(0);
    expect(await Payment.countDocuments({ type: "refund" })).toBe(0);
  });

  it("9 & 10. Item-linked preview validates quantities and allocates loyalty redemption deterministically in paise", async () => {
    const invoice = await createInvoice({
      loyaltyDiscountAmount: 100, // ₹100 = 10000 paise
      payableAmount: 900,
      amountPaid: 900,
    });
    await Payment.create({
      organizationId: orgAId,
      branchId: branchA1Id,
      invoiceId: invoice._id,
      customerId: customerA._id,
      paymentNumber: "PAY-5",
      amount: 900,
      type: "payment",
      method: "cash",
      status: "completed",
      recordedBy: ownerUserA._id,
    });

    const lineId = invoice.lines[0]._id.toString();

    const validRes = await request(app)
      .post(`/api/v1/billing/invoices/${invoice._id}/refunds/preview`)
      .set("Authorization", `Bearer ${ownerTokenA}`)
      .set("x-branch-id", branchA1Id.toString())
      .send({
        refundMode: "item_linked",
        items: [{ lineId, quantity: 1, acceptPhysicalRestock: true }],
      });

    expect(validRes.status).toBe(200);
    // 100000 - 10000 = 90000 paise for qty 2 -> 45000 paise for qty 1
    expect(validRes.body.data.totalRefundAmountPaise).toBe(45000);
    expect(validRes.body.data.allocations[0].loyaltyAllocatedPaise).toBe(10000);

    const overQtyRes = await request(app)
      .post(`/api/v1/billing/invoices/${invoice._id}/refunds/preview`)
      .set("Authorization", `Bearer ${ownerTokenA}`)
      .set("x-branch-id", branchA1Id.toString())
      .send({
        refundMode: "item_linked",
        items: [{ lineId, quantity: 3 }],
      });

    expect(overQtyRes.status).toBe(400);
  });

  it("11. Cross-organization and unauthorized branch access are rejected", async () => {
    const invoice = await createInvoice();

    const crossOrgRes = await request(app)
      .get(`/api/v1/billing/invoices/${invoice._id}/refund-context`)
      .set("Authorization", `Bearer ${ownerTokenB}`)
      .set("x-branch-id", branchA1Id.toString());

    expect([403, 404]).toContain(crossOrgRes.status);

    const wrongBranchRes = await request(app)
      .get(`/api/v1/billing/invoices/${invoice._id}/refund-context`)
      .set("Authorization", `Bearer ${branchUserTokenA}`)
      .set("x-branch-id", branchA2Id.toString());

    expect(wrongBranchRes.status).toBe(403);
  });
});
