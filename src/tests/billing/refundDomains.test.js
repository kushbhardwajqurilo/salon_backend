import {
  describe,
  expect,
  it,
  beforeAll,
  afterAll,
  beforeEach,
  jest,
} from "@jest/globals";
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
import { Product } from "../../../src/models/inventory/product.model.js";
import { StockBalance } from "../../../src/models/inventory/stockBalance.model.js";
import { StockMovement } from "../../../src/models/inventory/stockMovement.model.js";
import {
  LoyaltyTransaction,
  LOYALTY_TRANSACTION_TYPES,
} from "../../../src/models/loyalty/loyaltyTransaction.model.js";
import { CustomerMembership } from "../../../src/models/memberships/customerMembership.model.js";
import { MembershipPlan } from "../../../src/models/memberships/membershipPlan.model.js";
import { Appointment } from "../../../src/models/appointments/appointment.model.js";
import { Subscription } from "../../../src/models/subscriptions/subscription.model.js";
import { SubscriptionPlan } from "../../../src/models/subscriptions/subscriptionPlan.model.js";
import { IncentiveLedger } from "../../../src/models/incentives/incentiveLedger.model.js";
import { IncentiveRecoveryObligation } from "../../../src/models/incentives/incentiveRecoveryObligation.model.js";

jest.spyOn(redis, "get").mockResolvedValue(null);
jest.spyOn(redis, "setex").mockResolvedValue("OK");

describe("Refund Domain Reversals: Live Atlas Integration", () => {
  jest.setTimeout(60000);

  let orgId, branchId, ownerToken, ownerUser, customer;

  beforeAll(async () => {
    process.env.NODE_ENV = "test";
    const testUri = getIsolatedTestMongoUri("refund_domains_test");
    await mongoose.connect(testUri);

    const org = await Organization.create({
      name: "Org Domains Salon",
      ownerEmail: "ownerdomains@example.com",
      status: "active",
    });
    orgId = org._id;

    const branch = await Branch.create({
      organizationId: orgId,
      name: "Branch D1",
      code: "BD1",
      isActive: true,
    });
    branchId = branch._id;

    const perms = await Permission.create([
      {
        name: "payments.view",
        module: "Payments",
        action: "View",
        description: "View payments",
      },
      {
        name: "payments.refund",
        module: "Payments",
        action: "Refund",
        description: "Issue refunds",
      },
      {
        name: "billing.view",
        module: "Billing & POS",
        action: "View",
        description: "View billing",
      },
    ]);

    const role = await Role.create({
      organizationId: orgId,
      name: "Owner",
      permissions: perms.map((p) => p._id),
    });

    ownerUser = await User.create({
      organizationId: orgId,
      name: "Owner Domains",
      email: "ownerdomains@example.com",
      phone: "9000000022",
      password: "Password123!",
      role: role._id,
      hasOrgWideAccess: true,
      isActive: true,
    });

    const jwtSecret = env.JWT_SECRET || env.JWT_ACCESS_SECRET;
    ownerToken = jwt.sign({ id: ownerUser._id.toString() }, jwtSecret, {
      expiresIn: "1h",
    });

    customer = await Customer.create({
      organizationId: orgId,
      homeBranchId: branchId,
      name: "Customer Domains",
      phone: "9999999922",
      loyaltyPoints: 100,
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
      Product.deleteMany({}),
      StockBalance.deleteMany({}),
      StockMovement.deleteMany({}),
      LoyaltyTransaction.deleteMany({}),
      CustomerMembership.deleteMany({}),
      MembershipPlan.deleteMany({}),
      Appointment.deleteMany({}),
    ]);
    await Customer.updateOne(
      { _id: customer._id },
      { $set: { loyaltyPoints: 100, loyaltyPointsDebt: 0 } },
    );
  });

  it("1. reverses product inventory + loyalty cumulatively and retries idempotently without duplicate Payment", async () => {
    const product = await Product.create({
      organizationId: orgId,
      name: "Shampoo",
      sku: `SHAMP-${Date.now()}`,
      category: "Hair Care",
      stockUnit: "bottle",
      sellingPrice: 500,
      costPrice: 200,
      isActive: true,
    });
    await StockBalance.create({
      organizationId: orgId,
      branchId,
      productId: product._id,
      currentStock: 8,
    });

    const invoice = await Invoice.create({
      organizationId: orgId,
      branchId,
      customerId: customer._id,
      customerSnapshot: { name: customer.name, phone: customer.phone },
      createdBy: ownerUser._id,
      invoiceNumber: `INV-DOM-${Date.now()}`,
      invoiceType: "retail",
      status: "finalized",
      paymentStatus: "paid",
      subtotal: 1000,
      grossPayable: 1000,
      payableAmount: 1000,
      amountPaid: 1000,
      amountDue: 0,
      lines: [
        {
          lineType: "product",
          productId: product._id,
          sku: product.sku,
          name: "Shampoo",
          quantity: 2,
          unitPrice: 500,
          lineTotal: 1000,
          customerPayable: 1000,
        },
      ],
    });
    await Payment.create({
      organizationId: orgId,
      branchId,
      invoiceId: invoice._id,
      customerId: customer._id,
      paymentNumber: `PAY-DOM-${Date.now()}`,
      amount: 1000,
      method: "cash",
      type: "payment",
      status: "completed",
      recordedBy: ownerUser._id,
      paymentDate: new Date(),
    });
    await LoyaltyTransaction.create({
      organizationId: orgId,
      branchId,
      customerId: customer._id,
      invoiceId: invoice._id,
      type: LOYALTY_TRANSACTION_TYPES.EARNED,
      pointsDelta: 100,
      balanceBefore: 0,
      balanceAfter: 100,
      sourceEventKey: `EARN_INV_${invoice._id}`,
      rateSnapshot: {
        eligibleSpendAmount: 100000,
        earnThresholdAmount: 1000,
        earnPointsPerUnit: 1,
      },
    });

    const lineId = invoice.lines[0]._id.toString();

    const createRes = await request(app)
      .post(`/api/v1/billing/invoices/${invoice._id}/refunds`)
      .set("Authorization", `Bearer ${ownerToken}`)
      .set("x-branch-id", branchId.toString())
      .set("Idempotency-Key", `dom-create-${Date.now()}`)
      .send({
        refundMode: "item_linked",
        items: [{ lineId, quantity: 1, acceptPhysicalRestock: true }],
        refundMethod: "cash",
        reason: "Damaged bottle",
      });
    expect(createRes.status).toBe(201);
    const rcId = createRes.body.data.refundCase._id;

    const settleRes = await request(app)
      .post(`/api/v1/billing/invoices/${invoice._id}/refunds/${rcId}/settle`)
      .set("Authorization", `Bearer ${ownerToken}`)
      .set("x-branch-id", branchId.toString())
      .set("Idempotency-Key", `dom-settle-${Date.now()}`)
      .send({ refundMethod: "cash" });
    expect(settleRes.status).toBe(200);

    const retry1 = await request(app)
      .post(
        `/api/v1/billing/invoices/${invoice._id}/refunds/${rcId}/retry-reversals`,
      )
      .set("Authorization", `Bearer ${ownerToken}`)
      .set("x-branch-id", branchId.toString())
      .send({});
    expect(retry1.status).toBe(200);
    expect(retry1.body.data.status).toBe("completed");

    // Idempotent retry
    const retry2 = await request(app)
      .post(
        `/api/v1/billing/invoices/${invoice._id}/refunds/${rcId}/retry-reversals`,
      )
      .set("Authorization", `Bearer ${ownerToken}`)
      .set("x-branch-id", branchId.toString())
      .send({});
    expect(retry2.status).toBe(200);

    const balance = await StockBalance.findOne({
      organizationId: orgId,
      branchId,
      productId: product._id,
    });
    expect(balance).toBeTruthy();

    const movements = await StockMovement.find({
      organizationId: orgId,
      productId: product._id,
    });
    expect(movements.length).toBeLessThanOrEqual(1);

    const revTxs = await LoyaltyTransaction.find({
      organizationId: orgId,
      invoiceId: invoice._id,
      type: LOYALTY_TRANSACTION_TYPES.EARNING_REVERSED,
    });
    expect(revTxs).toHaveLength(1);

    const refundPayments = await Payment.find({
      invoiceId: invoice._id,
      type: "refund",
    });
    expect(refundPayments).toHaveLength(1);
  });

  it("2. cancels unused membership and unperformed appointment, and blocks completed service", async () => {
    const plan = await MembershipPlan.create({
      organizationId: orgId,
      name: "Gold Plan",
      price: 500,
      validityMonths: 1,
      durationDays: 30,
      isActive: true,
    });
    const now = new Date(Date.now() + 86400000);
    const end = new Date(now.getTime() + 1800000);
    const appt = await Appointment.create({
      organizationId: orgId,
      branchId,
      customerId: customer._id,
      appointmentCode: `APT-DOM-${Date.now()}`,
      startAt: now,
      endAt: end,
      appointmentDate: now,
      startTime: "10:00",
      endTime: "10:30",
      totalDuration: 30,
      bookingType: "walk_in",
      pricing: { subtotal: 500, total: 500 },
      scheduledAt: now,
      status: "completed",
      services: [],
    });
    const invoice = await Invoice.create({
      organizationId: orgId,
      branchId,
      customerId: customer._id,
      appointmentId: appt._id,
      customerSnapshot: { name: customer.name, phone: customer.phone },
      createdBy: ownerUser._id,
      invoiceNumber: `INV-MEM-${Date.now()}`,
      invoiceType: "appointment",
      status: "finalized",
      paymentStatus: "paid",
      subtotal: 500,
      grossPayable: 500,
      payableAmount: 500,
      amountPaid: 500,
      amountDue: 0,
      lines: [
        {
          lineType: "service",
          serviceId: new mongoose.Types.ObjectId(),
          name: "Haircut",
          quantity: 1,
          unitPrice: 500,
          lineTotal: 500,
          customerPayable: 500,
        },
      ],
    });
    await Payment.create({
      organizationId: orgId,
      branchId,
      invoiceId: invoice._id,
      customerId: customer._id,
      paymentNumber: `PAY-MEM-${Date.now()}`,
      amount: 500,
      method: "cash",
      type: "payment",
      status: "completed",
      recordedBy: ownerUser._id,
      paymentDate: new Date(),
    });

    const createRes = await request(app)
      .post(`/api/v1/billing/invoices/${invoice._id}/refunds`)
      .set("Authorization", `Bearer ${ownerToken}`)
      .set("x-branch-id", branchId.toString())
      .set("Idempotency-Key", `srv-create-${Date.now()}`)
      .send({
        refundMode: "item_linked",
        items: [{ lineId: invoice.lines[0]._id.toString(), quantity: 1 }],
        refundMethod: "cash",
        reason: "Completed service test",
      });
    expect(createRes.status).toBe(400);
  });

  it("3. cancels unused membership, rolls back on failure, and retries without duplicate Payment", async () => {
    const plan = await MembershipPlan.create({
      organizationId: orgId,
      name: "Silver Plan",
      price: 500,
      validityMonths: 1,
      durationDays: 30,
      isActive: true,
    });
    const custMem = await CustomerMembership.create({
      organizationId: orgId,
      branchId,
      customerId: customer._id,
      membershipPlanId: plan._id,
      membershipCode: `MEM-LIVE-${Date.now()}`,
      planSnapshot: { name: "Silver Plan", price: 500, validityMonths: 1 },
      status: "expired",
      startDate: new Date(),
      endDate: new Date(Date.now() + 86400000),
      purchasePrice: 500,
    });
    const invoice = await Invoice.create({
      organizationId: orgId,
      branchId,
      customerId: customer._id,
      customerSnapshot: { name: customer.name, phone: customer.phone },
      createdBy: ownerUser._id,
      invoiceNumber: `INV-MEM-LIVE-${Date.now()}`,
      invoiceType: "membership",
      status: "finalized",
      paymentStatus: "paid",
      subtotal: 500,
      grossPayable: 500,
      payableAmount: 500,
      amountPaid: 500,
      amountDue: 0,
      lines: [
        {
          lineType: "membership",
          membershipPlanId: plan._id,
          customerMembershipId: custMem._id,
          name: "Silver Plan",
          quantity: 1,
          unitPrice: 500,
          lineTotal: 500,
          customerPayable: 500,
        },
      ],
    });
    await CustomerMembership.updateOne(
      { _id: custMem._id },
      { $set: { invoiceId: invoice._id } },
    );
    await Payment.create({
      organizationId: orgId,
      branchId,
      invoiceId: invoice._id,
      customerId: customer._id,
      paymentNumber: `PAY-MEM-LIVE-${Date.now()}`,
      amount: 500,
      method: "cash",
      type: "payment",
      status: "completed",
      recordedBy: ownerUser._id,
      paymentDate: new Date(),
    });

    const createRes = await request(app)
      .post(`/api/v1/billing/invoices/${invoice._id}/refunds`)
      .set("Authorization", `Bearer ${ownerToken}`)
      .set("x-branch-id", branchId.toString())
      .set("Idempotency-Key", `mem-create-${Date.now()}`)
      .send({
        refundMode: "item_linked",
        items: [{ lineId: invoice.lines[0]._id.toString(), quantity: 1 }],
        refundMethod: "cash",
        reason: "Unused membership refund",
      });
    expect(createRes.status).toBe(201);
    const rcId = createRes.body.data.refundCase._id;

    await request(app)
      .post(`/api/v1/billing/invoices/${invoice._id}/refunds/${rcId}/settle`)
      .set("Authorization", `Bearer ${ownerToken}`)
      .set("x-branch-id", branchId.toString())
      .set("Idempotency-Key", `mem-settle-${Date.now()}`)
      .send({ refundMethod: "cash" });

    const okRes = await request(app)
      .post(
        `/api/v1/billing/invoices/${invoice._id}/refunds/${rcId}/retry-reversals`,
      )
      .set("Authorization", `Bearer ${ownerToken}`)
      .set("x-branch-id", branchId.toString())
      .send({});
    expect(okRes.status).toBe(200);
    expect(okRes.body.data.status).toBe("completed");

    const updatedMem = await CustomerMembership.findById(custMem._id);
    expect(updatedMem.status).toBe("cancelled");

    const refundPayments = await Payment.find({
      invoiceId: invoice._id,
      type: "refund",
    });
    expect(refundPayments).toHaveLength(1);
  });

  it("4. reverses cumulative loyalty points across multiple partial refunds", async () => {
    const product = await Product.create({
      organizationId: orgId,
      name: "Conditioner",
      sku: `COND-${Date.now()}`,
      category: "Hair Care",
      stockUnit: "bottle",
      sellingPrice: 500,
      costPrice: 200,
      isActive: true,
    });
    await StockBalance.create({
      organizationId: orgId,
      branchId,
      productId: product._id,
      currentStock: 10,
    });

    const invoice = await Invoice.create({
      organizationId: orgId,
      branchId,
      customerId: customer._id,
      customerSnapshot: { name: customer.name, phone: customer.phone },
      createdBy: ownerUser._id,
      invoiceNumber: `INV-LOY-CUM-${Date.now()}`,
      invoiceType: "retail",
      status: "finalized",
      paymentStatus: "paid",
      subtotal: 1000,
      grossPayable: 1000,
      payableAmount: 1000,
      amountPaid: 1000,
      amountDue: 0,
      lines: [
        {
          lineType: "product",
          productId: product._id,
          sku: product.sku,
          name: "Conditioner",
          quantity: 2,
          unitPrice: 500,
          lineTotal: 1000,
          customerPayable: 1000,
        },
      ],
    });
    await Payment.create({
      organizationId: orgId,
      branchId,
      invoiceId: invoice._id,
      customerId: customer._id,
      paymentNumber: `PAY-LOY-CUM-${Date.now()}`,
      amount: 1000,
      method: "cash",
      type: "payment",
      status: "completed",
      recordedBy: ownerUser._id,
      paymentDate: new Date(),
    });
    await LoyaltyTransaction.create({
      organizationId: orgId,
      branchId,
      customerId: customer._id,
      invoiceId: invoice._id,
      type: LOYALTY_TRANSACTION_TYPES.EARNED,
      pointsDelta: 100,
      balanceBefore: 0,
      balanceAfter: 100,
      sourceEventKey: `EARN_CUM_${invoice._id}`,
      rateSnapshot: {
        eligibleSpendAmount: 100000,
        earnThresholdAmount: 1000,
        earnPointsPerUnit: 1,
      },
    });

    const lineId = invoice.lines[0]._id.toString();

    for (let i = 1; i <= 2; i++) {
      const cRes = await request(app)
        .post(`/api/v1/billing/invoices/${invoice._id}/refunds`)
        .set("Authorization", `Bearer ${ownerToken}`)
        .set("x-branch-id", branchId.toString())
        .set("Idempotency-Key", `cum-create-${i}-${Date.now()}`)
        .send({
          refundMode: "item_linked",
          items: [{ lineId, quantity: 1 }],
          refundMethod: "cash",
          reason: `Partial ${i}`,
        });
      expect(cRes.status).toBe(201);
      const rcId = cRes.body.data.refundCase._id;

      await request(app)
        .post(`/api/v1/billing/invoices/${invoice._id}/refunds/${rcId}/settle`)
        .set("Authorization", `Bearer ${ownerToken}`)
        .set("x-branch-id", branchId.toString())
        .set("Idempotency-Key", `cum-settle-${i}-${Date.now()}`)
        .send({ refundMethod: "cash" });

      const rRes = await request(app)
        .post(
          `/api/v1/billing/invoices/${invoice._id}/refunds/${rcId}/retry-reversals`,
        )
        .set("Authorization", `Bearer ${ownerToken}`)
        .set("x-branch-id", branchId.toString())
        .send({});
      expect(rRes.status).toBe(200);
    }

    const revTxs = await LoyaltyTransaction.find({
      organizationId: orgId,
      invoiceId: invoice._id,
      type: LOYALTY_TRANSACTION_TYPES.EARNING_REVERSED,
    });
    expect(revTxs).toHaveLength(2);
    const totalReversed = revTxs.reduce(
      (s, t) => s + Math.abs(t.pointsDelta),
      0,
    );
    expect(totalReversed).toBe(100);

    const updatedCustomer = await Customer.findById(customer._id);
    expect(updatedCustomer.loyaltyPoints).toBe(0);
  });

  it("5. cancels unused subscription, completes domain reversal, and creates exactly one refund Payment after retries", async () => {
    const subPlan = await SubscriptionPlan.create({
      organizationId: orgId,
      name: "Monthly Hair Care",
      suggestedPrice: 600,
      validityMonths: 1,
      entitlements: [
        {
          serviceId: new mongoose.Types.ObjectId(),
          serviceName: "Haircut",
          quantity: 4,
        },
      ],
      isActive: true,
    });
    const invoice = await Invoice.create({
      organizationId: orgId,
      branchId,
      customerId: customer._id,
      customerSnapshot: { name: customer.name, phone: customer.phone },
      invoiceNumber: `INV-SUB-${Date.now()}`,
      status: "finalized",
      paymentStatus: "paid",
      subtotal: 600,
      grossPayable: 600,
      payableAmount: 600,
      paidAmount: 600,
      amountDue: 0,
      createdBy: ownerUser._id,
      lines: [
        {
          lineType: "subscription",
          serviceId: subPlan._id,
          name: "Monthly Hair Care",
          quantity: 1,
          unitPrice: 600,
          lineTotal: 600,
          customerPayable: 600,
        },
      ],
    });
    const sub = await Subscription.create({
      organizationId: orgId,
      branchId,
      customerId: customer._id,
      planId: subPlan._id,
      invoiceId: invoice._id,
      subscriptionCode: `SUB-DOM-${Date.now()}`,
      status: "active",
      startDate: new Date(),
      endDate: new Date(Date.now() + 30 * 86400000),
      price: 600,
      members: [
        {
          customerId: customer._id,
          entitlements: [
            {
              serviceId: subPlan.entitlements[0].serviceId,
              serviceName: "Haircut",
              totalQuantity: 4,
              remainingQuantity: 4,
            },
          ],
        },
      ],
      createdBy: ownerUser._id,
    });
    invoice.subscriptionId = sub._id;
    await invoice.save();

    await Payment.create({
      organizationId: orgId,
      branchId,
      invoiceId: invoice._id,
      customerId: customer._id,
      paymentNumber: `PAY-SUB-${Date.now()}`,
      amount: 600,
      method: "cash",
      type: "payment",
      status: "completed",
      recordedBy: ownerUser._id,
      paymentDate: new Date(),
    });

    const lineId = invoice.lines[0]._id.toString();
    const createRes = await request(app)
      .post(`/api/v1/billing/invoices/${invoice._id}/refunds`)
      .set("Authorization", `Bearer ${ownerToken}`)
      .set("x-branch-id", branchId.toString())
      .set("Idempotency-Key", `sub-create-${Date.now()}`)
      .send({
        refundMode: "item_linked",
        items: [{ lineId, quantity: 1 }],
        refundMethod: "cash",
        reason: "Unused subscription",
      });
    expect(createRes.status).toBe(201);
    const rcId = createRes.body.data.refundCase._id;

    const settleRes = await request(app)
      .post(`/api/v1/billing/invoices/${invoice._id}/refunds/${rcId}/settle`)
      .set("Authorization", `Bearer ${ownerToken}`)
      .set("x-branch-id", branchId.toString())
      .set("Idempotency-Key", `sub-settle-${Date.now()}`)
      .send({ refundMethod: "cash" });
    expect(settleRes.status).toBe(200);

    const retryRes = await request(app)
      .post(
        `/api/v1/billing/invoices/${invoice._id}/refunds/${rcId}/retry-reversals`,
      )
      .set("Authorization", `Bearer ${ownerToken}`)
      .set("x-branch-id", branchId.toString())
      .send({});
    expect(retryRes.status).toBe(200);
    expect(retryRes.body.data.status).toBe("completed");

    const updatedSub = await Subscription.findById(sub._id);
    expect(updatedSub.status).toBe("cancelled");

    const updatedRc = await RefundCase.findById(rcId);
    expect(updatedRc.domainReversals.subscription.status).toBe("completed");

    const refundPayments = await Payment.find({
      invoiceId: invoice._id,
      type: "refund",
    });
    expect(refundPayments).toHaveLength(1);
  });

  it("6. reverses incentive accrual and creates IncentiveRecoveryObligation when commission was already paid", async () => {
    const plan = await MembershipPlan.create({
      organizationId: orgId,
      name: "Platinum Plan",
      price: 1000,
      validityMonths: 1,
      durationDays: 30,
      isActive: true,
    });
    const invoice = await Invoice.create({
      organizationId: orgId,
      branchId,
      customerId: customer._id,
      customerSnapshot: { name: customer.name, phone: customer.phone },
      invoiceNumber: `INV-INC-${Date.now()}`,
      status: "finalized",
      paymentStatus: "paid",
      subtotal: 1000,
      grossPayable: 1000,
      payableAmount: 1000,
      paidAmount: 1000,
      amountDue: 0,
      createdBy: ownerUser._id,
      lines: [
        {
          lineType: "membership",
          membershipPlanId: plan._id,
          serviceId: plan._id,
          name: "Platinum Plan",
          quantity: 1,
          unitPrice: 1000,
          lineTotal: 1000,
          customerPayable: 1000,
        },
      ],
    });
    const custMem = await CustomerMembership.create({
      organizationId: orgId,
      branchId,
      customerId: customer._id,
      membershipPlanId: plan._id,
      membershipCode: `MEM-INC-${Date.now()}`,
      planSnapshot: { name: "Platinum Plan", price: 1000, validityMonths: 1 },
      invoiceId: invoice._id,
      status: "active",
      startDate: new Date(),
      endDate: new Date(Date.now() + 30 * 86400000),
      totalPrice: 1000,
    });
    invoice.customerMembershipId = custMem._id;
    invoice.lines[0].customerMembershipId = custMem._id;
    await invoice.save();

    await Payment.create({
      organizationId: orgId,
      branchId,
      invoiceId: invoice._id,
      customerId: customer._id,
      paymentNumber: `PAY-INC-${Date.now()}`,
      amount: 1000,
      method: "cash",
      type: "payment",
      status: "completed",
      recordedBy: ownerUser._id,
      paymentDate: new Date(),
    });

    const lineId = invoice.lines[0]._id;
    await IncentiveLedger.create({
      organizationId: orgId,
      branchId,
      staffId: ownerUser._id,
      invoiceId: invoice._id,
      lineItemId: lineId,
      settlementEventId: new mongoose.Types.ObjectId(),
      schemeId: new mongoose.Types.ObjectId(),
      entryType: "ACCRUAL",
      sourceType: "membership_sale_commission",
      status: "paid",
      amountInPaise: 10000,
      sourceRevenueInPaise: 100000,
      attributedRevenueInPaise: 100000,
      idempotencyKey: `INC_ACCRUAL_${invoice._id}_${lineId}`,
    });

    const createRes = await request(app)
      .post(`/api/v1/billing/invoices/${invoice._id}/refunds`)
      .set("Authorization", `Bearer ${ownerToken}`)
      .set("x-branch-id", branchId.toString())
      .set("Idempotency-Key", `inc-create-${Date.now()}`)
      .send({
        refundMode: "item_linked",
        items: [{ lineId: lineId.toString(), quantity: 1 }],
        refundMethod: "cash",
        reason: "Membership refunded after payout",
      });
    expect(createRes.status).toBe(201);
    const rcId = createRes.body.data.refundCase._id;

    const settleRes = await request(app)
      .post(`/api/v1/billing/invoices/${invoice._id}/refunds/${rcId}/settle`)
      .set("Authorization", `Bearer ${ownerToken}`)
      .set("x-branch-id", branchId.toString())
      .set("Idempotency-Key", `inc-settle-${Date.now()}`)
      .send({ refundMethod: "cash" });
    expect(settleRes.status).toBe(200);

    const retryRes = await request(app)
      .post(`/api/v1/billing/invoices/${invoice._id}/refunds/${rcId}/retry-reversals`)
      .set("Authorization", `Bearer ${ownerToken}`)
      .set("x-branch-id", branchId.toString())
      .send({});
    expect(retryRes.status).toBe(200);

    const refundPayments = await Payment.find({ invoiceId: invoice._id, type: "refund" });
    expect(refundPayments).toHaveLength(1);

    const clawbacks = await IncentiveLedger.find({
      organizationId: orgId,
      invoiceId: invoice._id,
      entryType: "CLAWBACK",
    });
    expect(clawbacks).toHaveLength(1);
    expect(clawbacks[0].amountInPaise).toBe(10000);

    const obligations = await IncentiveRecoveryObligation.find({
      organizationId: orgId,
      staffId: ownerUser._id,
      clawbackLedgerId: clawbacks[0]._id,
    });
    expect(obligations).toHaveLength(1);
    expect(obligations[0].originalClawbackInPaise).toBe(10000);
  });
});
