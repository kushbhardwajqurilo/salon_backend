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

describe("Refund Lifecycle: Creation, Idempotency, Concurrency & Settlement (Live)", () => {
  jest.setTimeout(60000);

  let orgAId, branchA1Id, ownerTokenA, ownerUserA, customerA;

  beforeAll(async () => {
    process.env.NODE_ENV = "test";
    const testUri = getIsolatedTestMongoUri("refund_lifecycle_test");
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
      name: "Org Lifecycle Salon",
      ownerEmail: "ownerlifecycle@example.com",
      status: "active",
    });
    orgAId = orgA._id;

    const bA1 = await Branch.create({
      organizationId: orgAId,
      name: "Branch L1",
      code: "BL1",
      isActive: true,
    });
    branchA1Id = bA1._id;

    const perms = await Permission.create([
      { name: "payments.view", module: "Payments", action: "View", description: "View payments" },
      { name: "payments.refund", module: "Payments", action: "Refund", description: "Issue refunds" },
      { name: "billing.view", module: "Billing & POS", action: "View", description: "View billing" },
    ]);

    const roleA = await Role.create({
      organizationId: orgAId,
      name: "Owner",
      permissions: perms.map((p) => p._id),
    });

    ownerUserA = await User.create({
      organizationId: orgAId,
      name: "Owner Lifecycle",
      email: "ownerlifecycle@example.com",
      phone: "9000000011",
      password: "Password123!",
      role: roleA._id,
      hasOrgWideAccess: true,
      isActive: true,
    });

    const jwtSecret = env.JWT_SECRET || env.JWT_ACCESS_SECRET;
    ownerTokenA = jwt.sign({ id: ownerUserA._id.toString() }, jwtSecret, {
      expiresIn: "1h",
    });

    customerA = await Customer.create({
      organizationId: orgAId,
      homeBranchId: branchA1Id,
      name: "Customer Lifecycle",
      phone: "9999999911",
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

  async function seedPaidInvoice(amountRupees = 1000) {
    const invoice = await Invoice.create({
      organizationId: orgAId,
      branchId: branchA1Id,
      customerId: customerA._id,
      customerSnapshot: {
        name: customerA.name,
        phone: customerA.phone,
      },
      createdBy: ownerUserA._id,
      invoiceNumber: `INV-LC-${Date.now()}-${Math.floor(Math.random() * 1000)}`,
      invoiceType: "retail",
      status: "finalized",
      paymentStatus: "paid",
      subtotal: amountRupees,
      grossPayable: amountRupees,
      payableAmount: amountRupees,
      amountPaid: amountRupees,
      amountDue: 0,
      lines: [
        {
          lineType: "product",
          productId: new mongoose.Types.ObjectId(),
          sku: "SKU-LC-01",
          name: "Serum",
          quantity: 1,
          unitPrice: amountRupees,
          lineTotal: amountRupees,
          customerPayable: amountRupees,
        },
      ],
    });
    const payment = await Payment.create({
      organizationId: orgAId,
      branchId: branchA1Id,
      invoiceId: invoice._id,
      customerId: customerA._id,
      paymentNumber: `PAY-LC-${Date.now()}-${Math.floor(Math.random() * 1000)}`,
      amount: amountRupees,
      method: "cash",
      type: "payment",
      status: "completed",
      recordedBy: ownerUserA._id,
      paymentDate: new Date(),
    });
    return { invoice, payment };
  }

  it("1. creates pending RefundCase, replays idempotently, and rejects conflicting payload", async () => {
    const { invoice } = await seedPaidInvoice(1000);
    const key = `create-idem-${Date.now()}`;

    const res1 = await request(app)
      .post(`/api/v1/billing/invoices/${invoice._id}/refunds`)
      .set("Authorization", `Bearer ${ownerTokenA}`)
      .set("x-branch-id", branchA1Id.toString())
      .set("Idempotency-Key", key)
      .send({
        refundMode: "financial_only",
        requestedAmountPaise: 40000,
        refundMethod: "cash",
        reason: "Customer goodwill",
      });

    expect(res1.status).toBe(201);
    const rcId = res1.body.data.refundCase._id;

    const res2 = await request(app)
      .post(`/api/v1/billing/invoices/${invoice._id}/refunds`)
      .set("Authorization", `Bearer ${ownerTokenA}`)
      .set("x-branch-id", branchA1Id.toString())
      .set("Idempotency-Key", key)
      .send({
        refundMode: "financial_only",
        requestedAmountPaise: 40000,
        refundMethod: "cash",
        reason: "Customer goodwill",
      });

    expect(res2.status).toBe(200);
    expect(res2.body.data.idempotentReplay).toBe(true);
    expect(res2.body.data.refundCase._id).toBe(rcId);

    const resConflict = await request(app)
      .post(`/api/v1/billing/invoices/${invoice._id}/refunds`)
      .set("Authorization", `Bearer ${ownerTokenA}`)
      .set("x-branch-id", branchA1Id.toString())
      .set("Idempotency-Key", key)
      .send({
        refundMode: "financial_only",
        requestedAmountPaise: 50000,
        refundMethod: "cash",
        reason: "Customer goodwill",
      });

    expect(resConflict.status).toBe(409);
  });

  it("2. concurrent creation attempts do not exceed refundable balance", async () => {
    const { invoice } = await seedPaidInvoice(1000);

    const [r1, r2] = await Promise.all([
      request(app)
        .post(`/api/v1/billing/invoices/${invoice._id}/refunds`)
        .set("Authorization", `Bearer ${ownerTokenA}`)
        .set("x-branch-id", branchA1Id.toString())
        .set("Idempotency-Key", `conc-1-${Date.now()}`)
        .send({
          refundMode: "financial_only",
          requestedAmountPaise: 70000,
          refundMethod: "cash",
          reason: "Concurrent 1",
        }),
      request(app)
        .post(`/api/v1/billing/invoices/${invoice._id}/refunds`)
        .set("Authorization", `Bearer ${ownerTokenA}`)
        .set("x-branch-id", branchA1Id.toString())
        .set("Idempotency-Key", `conc-2-${Date.now()}`)
        .send({
          refundMode: "financial_only",
          requestedAmountPaise: 70000,
          refundMethod: "cash",
          reason: "Concurrent 2",
        }),
    ]);

    const statuses = [r1.status, r2.status];
    expect(statuses.filter((s) => s === 201)).toHaveLength(1);
    expect(statuses.some((s) => s >= 400)).toBe(true);

    const cases = await RefundCase.find({ invoiceId: invoice._id });
    expect(cases).toHaveLength(1);
    expect(cases[0].requestedAmountPaise).toBe(70000);
  });

  it("3. settles RefundCase once, replays idempotently, and preserves original invoice/payment", async () => {
    const { invoice, payment } = await seedPaidInvoice(1000);

    const createRes = await request(app)
      .post(`/api/v1/billing/invoices/${invoice._id}/refunds`)
      .set("Authorization", `Bearer ${ownerTokenA}`)
      .set("x-branch-id", branchA1Id.toString())
      .set("Idempotency-Key", `settle-create-${Date.now()}`)
      .send({
        refundMode: "financial_only",
        requestedAmountPaise: 30000,
        refundMethod: "upi",
        reason: "Partial settle",
      });

    expect(createRes.status).toBe(201);
    const rcId = createRes.body.data.refundCase._id;

    const settleKey = `settle-key-${Date.now()}`;
    const [s1, s2] = await Promise.all([
      request(app)
        .post(`/api/v1/billing/invoices/${invoice._id}/refunds/${rcId}/settle`)
        .set("Authorization", `Bearer ${ownerTokenA}`)
        .set("x-branch-id", branchA1Id.toString())
        .set("Idempotency-Key", settleKey)
        .send({ refundMethod: "upi" }),
      request(app)
        .post(`/api/v1/billing/invoices/${invoice._id}/refunds/${rcId}/settle`)
        .set("Authorization", `Bearer ${ownerTokenA}`)
        .set("x-branch-id", branchA1Id.toString())
        .set("Idempotency-Key", settleKey)
        .send({ refundMethod: "upi" }),
    ]);

    expect([s1.status, s2.status]).toEqual([200, 200]);

    const refundPayments = await Payment.find({
      invoiceId: invoice._id,
      type: "refund",
    });
    expect(refundPayments).toHaveLength(1);
    expect(refundPayments[0].amount).toBe(-300);
    expect(refundPayments[0].status).toBe("completed");

    const freshInvoice = await Invoice.findById(invoice._id);
    const freshOrigPayment = await Payment.findById(payment._id);
    expect(freshInvoice.payableAmount).toBe(1000);
    expect(freshInvoice.paymentStatus).toBe("paid");
    expect(freshOrigPayment.amount).toBe(1000);
  });
});
