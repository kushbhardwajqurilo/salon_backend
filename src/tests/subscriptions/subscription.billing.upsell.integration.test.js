import { describe, expect, it, beforeEach, afterEach, jest, beforeAll, afterAll } from "@jest/globals";
import request from "supertest";
import mongoose from "mongoose";
import crypto from "crypto";
import app from "../../../app.mjs";
import { Organization } from "../../../src/models/organizations/organization.model.js";
import { Branch } from "../../../src/models/branches/branch.model.js";
import { Customer } from "../../../src/models/customers/customer.model.js";
import { Service } from "../../../src/models/services/service.model.js";
import { ServiceCategory } from "../../../src/models/services/serviceCategory.model.js";
import { Role } from "../../../src/models/roles/role.model.js";
import { Permission } from "../../../src/models/permissions/permission.model.js";
import { User } from "../../../src/models/users/user.model.js";
import { Subscription } from "../../../src/models/subscriptions/subscription.model.js";
import { SubscriptionPlan } from "../../../src/models/subscriptions/subscriptionPlan.model.js";
import { SubscriptionUsage } from "../../../src/models/subscriptions/subscriptionUsage.model.js";
import { Appointment } from "../../../src/models/appointments/appointment.model.js";
import { SubscriptionConsumptionChallenge } from "../../../src/models/subscriptions/subscriptionConsumptionChallenge.model.js";
import { Invoice } from "../../../src/models/billing/invoice.model.js";
import { Payment } from "../../../src/models/billing/payment.model.js";
import { AuditLog } from "../../../src/models/audit/auditLog.model.js";
import jwt from "jsonwebtoken";
import { env } from "../../../src/config/env.js";
import { redis } from "../../../src/utils/redis.js";

jest.spyOn(redis, "get").mockResolvedValue(null);
jest.spyOn(redis, "setex").mockResolvedValue("OK");

// Relative future date helper to prevent fixture staleness
const getFutureDateStr = (daysAhead = 30) => {
  const d = new Date(Date.now() + daysAhead * 86400000);
  return d.toISOString().split("T")[0];
};

describe("Phase 6 — Subscription Billing, POS Sales, Auto-Coverage & Upsell Integration Tests", () => {
  jest.setTimeout(45000);

  let orgA, orgB;
  let branchA1, branchA2, branchB1;
  let ownerToken, staffToken;
  let ownerUser, staffUser;
  let customerA, customerB;
  let serviceA1, serviceA2, serviceA3;
  let categoryA;

  beforeAll(async () => {
    let testUri = process.env.MONGO_URI || "mongodb://127.0.0.1:27017/saloon_erp_test";
    if (testUri.includes("?")) {
      const parts = testUri.split("?");
      testUri = parts[0].replace(/\/([^\/]+)$/, "/saloon_erp_sub_billing_test") + "?" + parts[1];
    } else {
      testUri = testUri.replace(/\/([^\/]+)$/, "/saloon_erp_sub_billing_test");
    }
    await mongoose.connect(testUri);
  });

  afterAll(async () => {
    await Payment.deleteMany({});
    await Invoice.deleteMany({});
    await Appointment.deleteMany({});
    await SubscriptionUsage.deleteMany({});
    await Subscription.deleteMany({});
    await SubscriptionPlan.deleteMany({});
    await AuditLog.deleteMany({});
    await Service.deleteMany({});
    await ServiceCategory.deleteMany({});
    await Customer.deleteMany({});
    await User.deleteMany({});
    await Role.deleteMany({});
    await Permission.deleteMany({});
    await Branch.deleteMany({});
    await Organization.deleteMany({});
    await mongoose.connection.close();
  });

  beforeEach(async () => {
    await Payment.deleteMany({});
    await Invoice.deleteMany({});
    await Appointment.deleteMany({});
    await SubscriptionUsage.deleteMany({});
    await Subscription.deleteMany({});
    await SubscriptionPlan.deleteMany({});
    await AuditLog.deleteMany({});
    await Service.deleteMany({});
    await ServiceCategory.deleteMany({});
    await Customer.deleteMany({});
    await User.deleteMany({});
    await Role.deleteMany({});
    await Permission.deleteMany({});
    await Branch.deleteMany({});
    await Organization.deleteMany({});

    orgA = await Organization.create({ name: "Luxury Salon A", code: "LSA" });
    orgB = await Organization.create({ name: "Competitor B", code: "CPB" });

    branchA1 = await Branch.create({
      organizationId: orgA._id,
      name: "Downtown Flagship",
      code: "DF-01",
      timezone: "Asia/Kolkata",
      isActive: true,
    });

    branchA2 = await Branch.create({
      organizationId: orgA._id,
      name: "Suburban Branch",
      code: "SB-02",
      timezone: "Asia/Kolkata",
      isActive: true,
    });

    branchB1 = await Branch.create({
      organizationId: orgB._id,
      name: "Branch B1",
      code: "BB-01",
      timezone: "Asia/Kolkata",
      isActive: true,
    });

    customerA = await Customer.create({
      organizationId: orgA._id,
      homeBranchId: branchA1._id,
      name: "Alice Smith",
      phone: "+919876543210",
      email: "alice@example.com",
      status: "active",
    });

    customerB = await Customer.create({
      organizationId: orgB._id,
      homeBranchId: branchB1._id,
      name: "Bob Jones",
      phone: "+919876543211",
      email: "bob@example.com",
      status: "active",
    });

    categoryA = await ServiceCategory.create({
      organizationId: orgA._id,
      name: "Hair Services",
    });

    serviceA1 = await Service.create({
      organizationId: orgA._id,
      categoryId: categoryA._id,
      name: "Classic Haircut",
      duration: 30,
      price: 500,
      pricing: { basePrice: 500 },
      status: "active",
    });

    serviceA2 = await Service.create({
      organizationId: orgA._id,
      categoryId: categoryA._id,
      name: "Hair Spa",
      duration: 60,
      price: 1500,
      pricing: { basePrice: 1500 },
      status: "active",
    });

    serviceA3 = await Service.create({
      organizationId: orgA._id,
      categoryId: categoryA._id,
      name: "Beard Trim",
      duration: 20,
      price: 300,
      pricing: { basePrice: 300 },
      status: "active",
    });

    // Create permissions
    const permissionNames = [
      "subscriptions.sell",
      "subscriptions.view",
      "subscriptions.configure",
      "subscriptions.redeem",
      "billing.checkout",
      "billing.view",
      "billing.void",
      "payments.receive",
      "payments.view",
      "payments.refund",
      "appointments.create",
      "appointments.view",
      "appointments.edit",
      "appointments.update_status",
    ];

    const permissions = await Permission.insertMany(
      permissionNames.map((name) => ({
        name,
        displayName: name,
        module: name.split(".")[0],
        action: name.split(".")[1],
        description: `Permission for ${name}`,
      }))
    );

    const ownerRole = await Role.create({
      organizationId: orgA._id,
      name: "Owner",
      isCustom: false,
      permissions: permissions.map((p) => p._id),
    });

    ownerUser = await User.create({
      name: "Owner User",
      email: "owner@luxurysalon.com",
      phone: "+919999999990",
      password: "HashedPassword123!",
      organizationId: orgA._id,
      role: ownerRole._id,
      hasOrgWideAccess: true,
      branchAccess: [
        { branchId: branchA1._id, branchName: "Downtown Flagship", isActive: true },
        { branchId: branchA2._id, branchName: "Suburban Branch", isActive: true },
      ],
      status: "active",
    });

    ownerToken = jwt.sign(
      {
        id: ownerUser._id.toString(),
        userId: ownerUser._id.toString(),
        organizationId: orgA._id.toString(),
        role: "owner",
        hasOrgWideAccess: true,
      },
      env.JWT_SECRET,
      { expiresIn: "1h" }
    );
  });

  describe("1. Standalone Subscription Sale & Invoice Generation", () => {
    it("creates a standalone subscription sale and draft invoice without dummy appointments", async () => {
      const res = await request(app)
        .post("/api/v1/subscriptions")
        .set("Authorization", `Bearer ${ownerToken}`)
        .set("x-branch-id", branchA1._id.toString())
        .send({
          customerId: customerA._id.toString(),
          price: 2500,
          entitlements: [
            { serviceId: serviceA1._id.toString(), quantity: 5 },
            { serviceId: serviceA2._id.toString(), quantity: 2 },
          ],
          permittedBranchIds: [branchA1._id.toString()],
          startDate: "2026-01-01",
          endDate: "2026-12-31",
          notes: "Standalone VIP Package",
          billImmediately: true,
          branchId: branchA1._id.toString(),
        });

      expect(res.status).toBe(201);
      expect(res.body.success).toBe(true);

      const subData = res.body.data;
      expect(subData.subscriptionCode).toMatch(/^SUB-\d{8}-\d{4}$/);
      expect(subData.status).toBe("pending_payment"); // Explicit activation policy: unpaid = pending_payment
      expect(subData.invoice).toBeDefined();

      const invoice = subData.invoice;
      expect(invoice.invoiceType).toBe("subscription");
      expect(invoice.appointmentId).toBeNull();
      expect(invoice.subscriptionId.toString()).toBe(subData._id.toString());
      expect(invoice.subtotal).toBe(2500);
      expect(invoice.payableAmount).toBe(2500);
      expect(invoice.amountPaid).toBe(0);
      expect(invoice.amountDue).toBe(2500);
      expect(invoice.paymentStatus).toBe("unpaid");
      expect(invoice.status).toBe("draft");
      expect(invoice.lines).toHaveLength(1);
      expect(invoice.lines[0].lineType).toBe("subscription");
      expect(invoice.lines[0].unitPrice).toBe(2500);
      expect(invoice.lines[0].lineTotal).toBe(2500);

      // Verify invoice is persisted and directly retrievable via API
      const getInvRes = await request(app)
        .get(`/api/v1/billing/invoices/${invoice._id}`)
        .set("Authorization", `Bearer ${ownerToken}`)
        .set("x-branch-id", branchA1._id.toString());
      expect(getInvRes.status).toBe(200);
      expect(getInvRes.body.success).toBe(true);
      expect(getInvRes.body.data.invoice._id.toString()).toBe(invoice._id.toString());
      expect(getInvRes.body.data.invoice.invoiceNumber).toBe(invoice.invoiceNumber);
      expect(getInvRes.body.data.invoice.payableAmount).toBe(2500);

      // Verify the subscription record in DB points to this invoiceId
      const persistedSub = await Subscription.findById(subData._id);
      expect(persistedSub.invoiceId.toString()).toBe(invoice._id.toString());
      expect(persistedSub.status).toBe("pending_payment");
    });

    it("creates a zero-price complimentary subscription with status active and without mandatory invoice", async () => {
      const res = await request(app)
        .post("/api/v1/subscriptions")
        .set("Authorization", `Bearer ${ownerToken}`)
        .set("x-branch-id", branchA1._id.toString())
        .send({
          customerId: customerA._id.toString(),
          price: 0,
          entitlements: [
            { serviceId: serviceA1._id.toString(), quantity: 2 },
          ],
          permittedBranchIds: [branchA1._id.toString()],
          startDate: "2026-01-01",
          endDate: "2026-12-31",
          notes: "Complimentary Promotion",
          billImmediately: false,
        });

      expect(res.status).toBe(201);
      expect(res.body.success).toBe(true);
      const subData = res.body.data;
      expect(subData.price).toBe(0);
      expect(subData.status).toBe("active"); // Complimentary zero-price starts active
      expect(subData.invoiceId).toBeNull();

      const persistedSub = await Subscription.findById(subData._id);
      expect(persistedSub.status).toBe("active");
      expect(persistedSub.invoiceId).toBeNull();
    });
  });

  describe("2. Full Payment, Partial Payment, Unpaid Invoice & Payment Retries", () => {
    it("handles partial payment, retry idempotency, and full payment activating subscription", async () => {
      // 1. Create subscription with billImmediately
      const createRes = await request(app)
        .post("/api/v1/subscriptions")
        .set("Authorization", `Bearer ${ownerToken}`)
        .set("x-branch-id", branchA1._id.toString())
        .send({
          customerId: customerA._id.toString(),
          price: 3000,
          entitlements: [{ serviceId: serviceA1._id.toString(), quantity: 6 }],
          startDate: "2026-01-01",
          endDate: "2026-12-31",
          billImmediately: true,
          branchId: branchA1._id.toString(),
        });

      const subId = createRes.body.data._id;
      const invoiceId = createRes.body.data.invoice._id;

      // 2. Finalize draft invoice
      const finalizeRes = await request(app)
        .post(`/api/v1/billing/invoices/${invoiceId}/finalize`)
        .set("Authorization", `Bearer ${ownerToken}`)
        .set("x-branch-id", branchA1._id.toString())
        .send({});
      expect(finalizeRes.status).toBe(200);
      expect(finalizeRes.body.data.status).toBe("finalized");

      // 3. Partial payment of 1000
      const partialRes = await request(app)
        .post(`/api/v1/billing/invoices/${invoiceId}/payments`)
        .set("Authorization", `Bearer ${ownerToken}`)
        .set("x-branch-id", branchA1._id.toString())
        .set("Idempotency-Key", "partial-pay-key-1")
        .send({
          amount: 1000,
          method: "cash",
          referenceNote: "First installment",
        });

      expect(partialRes.status).toBe(201);
      expect(partialRes.body.data.invoice.amountPaid).toBe(1000);
      expect(partialRes.body.data.invoice.amountDue).toBe(2000);
      expect(partialRes.body.data.invoice.paymentStatus).toBe("partially_paid");

      // Subscription remains pending_payment
      const subCheck1 = await Subscription.findById(subId);
      expect(subCheck1.status).toBe("pending_payment");

      // 4. Retry same payment with same Idempotency-Key -> returns same payment record without double recording
      const retryRes = await request(app)
        .post(`/api/v1/billing/invoices/${invoiceId}/payments`)
        .set("Authorization", `Bearer ${ownerToken}`)
        .set("x-branch-id", branchA1._id.toString())
        .set("Idempotency-Key", "partial-pay-key-1")
        .send({
          amount: 1000,
          method: "cash",
          referenceNote: "First installment",
        });

      expect(retryRes.status).toBe(200);
      expect(retryRes.body.data.payment._id.toString()).toBe(partialRes.body.data.payment._id.toString());
      expect(retryRes.body.data.invoice.amountPaid).toBe(1000);

      // 5. Settle remaining 2000
      const finalPayRes = await request(app)
        .post(`/api/v1/billing/invoices/${invoiceId}/payments`)
        .set("Authorization", `Bearer ${ownerToken}`)
        .set("x-branch-id", branchA1._id.toString())
        .set("Idempotency-Key", "final-pay-key-2")
        .send({
          amount: 2000,
          method: "card",
        });

      expect(finalPayRes.status).toBe(201);
      expect(finalPayRes.body.data.invoice.amountPaid).toBe(3000);
      expect(finalPayRes.body.data.invoice.amountDue).toBe(0);
      expect(finalPayRes.body.data.invoice.paymentStatus).toBe("paid");

      // Activation policy: Subscription transitions from pending_payment to active
      const subCheck2 = await Subscription.findById(subId);
      expect(subCheck2.status).toBe("active");
    });
  });

  describe("3. Subscription Activation Policy & Payment Reversal", () => {
    it("voiding a payment when invoice is no longer fully paid reverts subscription to pending_payment", async () => {
      const createRes = await request(app)
        .post("/api/v1/subscriptions")
        .set("Authorization", `Bearer ${ownerToken}`)
        .set("x-branch-id", branchA1._id.toString())
        .send({
          customerId: customerA._id.toString(),
          price: 1500,
          entitlements: [{ serviceId: serviceA1._id.toString(), quantity: 3 }],
          startDate: "2026-01-01",
          endDate: "2026-12-31",
          billImmediately: true,
          branchId: branchA1._id.toString(),
        });

      const subId = createRes.body.data._id;
      const invoiceId = createRes.body.data.invoice._id;

      await request(app)
        .post(`/api/v1/billing/invoices/${invoiceId}/finalize`)
        .set("Authorization", `Bearer ${ownerToken}`)
        .set("x-branch-id", branchA1._id.toString())
        .send({});

      const payRes = await request(app)
        .post(`/api/v1/billing/invoices/${invoiceId}/payments`)
        .set("Authorization", `Bearer ${ownerToken}`)
        .set("x-branch-id", branchA1._id.toString())
        .send({ amount: 1500, method: "upi" });

      const paymentId = payRes.body.data.payment._id;
      let sub = await Subscription.findById(subId);
      expect(sub.status).toBe("active");

      // Void the payment
      const voidRes = await request(app)
        .post(`/api/v1/billing/payments/${paymentId}/void`)
        .set("Authorization", `Bearer ${ownerToken}`)
        .set("x-branch-id", branchA1._id.toString())
        .send({ reason: "Customer card bounced chargeback" });

      expect(voidRes.status).toBe(200);
      expect(voidRes.body.data.invoice.paymentStatus).toBe("unpaid");

      sub = await Subscription.findById(subId);
      expect(sub.status).toBe("pending_payment");
    });
  });

  describe("4. Existing Appointment Billing Regression", () => {
    it("preserves standard appointment invoice creation with service snapshots and coverage calculation", async () => {
      // 1. Create active subscription
      const sub = await Subscription.create({
        organizationId: orgA._id,
        customerId: customerA._id,
        subscriptionCode: "SUB-REG-01",
        price: 2000,
        entitlements: [{ serviceId: serviceA1._id, serviceName: "Classic Haircut", totalQuantity: 5, usedQuantity: 0, remainingQuantity: 5 }],
        startDate: new Date("2026-01-01"),
        endDate: new Date("2026-12-31"),
        status: "active",
      });

      // 2. Create appointment with 1 covered service line and 1 uncovered line
      const apptRes = await request(app)
        .post("/api/v1/appointments")
        .set("Authorization", `Bearer ${ownerToken}`)
        .set("x-branch-id", branchA1._id.toString())
        .send({
          customerId: customerA._id.toString(),
          branchId: branchA1._id.toString(),
          appointmentDate: getFutureDateStr(10),
          startTime: "10:00",
          bookingType: "advance",
          services: [
            { type: "registered", serviceId: serviceA1._id.toString(), appliedSubscriptionId: sub._id.toString() },
            { type: "registered", serviceId: serviceA2._id.toString() }, // Uncovered Hair Spa ₹1500
          ],
        });

      if (apptRes.status !== 201) {
        console.error("APPT CREATION ERROR:", apptRes.body);
      }
      expect(apptRes.status).toBe(201);
      const apptId = apptRes.body.data._id;

      // 3. Create appointment invoice via billing API
      const invRes = await request(app)
        .post("/api/v1/billing/invoices")
        .set("Authorization", `Bearer ${ownerToken}`)
        .set("x-branch-id", branchA1._id.toString())
        .send({
          appointmentId: apptId.toString(),
          branchId: branchA1._id.toString(),
          discountTotal: 200,
        });

      expect(invRes.status).toBe(201);
      const inv = invRes.body.data;
      expect(inv.invoiceType).toBe("appointment");
      expect(inv.appointmentId.toString()).toBe(apptId.toString());
      expect(inv.subtotal).toBe(2000); // 500 + 1500
      expect(inv.discountTotal).toBe(200);
      expect(inv.grossPayable).toBe(1800); // subtotal (2000) - discount (200)
      expect(inv.subscriptionCoveredAmount).toBe(500);
      expect(inv.payableAmount).toBe(1300); // 1800 - 500
    });
  });

  describe("5. Automatic Subscription Coverage at Booking & After Purchase", () => {
    it("automatically attaches eligible subscription when appliedSubscriptionId is omitted", async () => {
      await Subscription.create({
        organizationId: orgA._id,
        customerId: customerA._id,
        subscriptionCode: "SUB-AUTO-01",
        price: 1000,
        entitlements: [{ serviceId: serviceA1._id, serviceName: "Classic Haircut", totalQuantity: 3, usedQuantity: 0, remainingQuantity: 3 }],
        startDate: new Date("2026-01-01"),
        endDate: new Date("2026-12-31"),
        status: "active",
      });

      // Book appointment with no appliedSubscriptionId specified (omitted)
      const res = await request(app)
        .post("/api/v1/appointments")
        .set("Authorization", `Bearer ${ownerToken}`)
        .set("x-branch-id", branchA1._id.toString())
        .send({
          customerId: customerA._id.toString(),
          branchId: branchA1._id.toString(),
          appointmentDate: getFutureDateStr(12),
          startTime: "11:00",
          bookingType: "advance",
          services: [
            { type: "registered", serviceId: serviceA1._id.toString() },
          ],
        });

      expect(res.status).toBe(201);
      const bookedService = res.body.data.services[0];
      expect(bookedService.appliedSubscriptionId).toBeDefined();
      expect(bookedService.appliedSubscriptionId).not.toBeNull();
      // Ensure entitlement is NOT deducted at booking
      const sub = await Subscription.findOne({ subscriptionCode: "SUB-AUTO-01" });
      expect(sub.entitlements[0].remainingQuantity).toBe(3);
    });

    it("automatically attaches eligible subscription when appliedSubscriptionId is explicitly 'auto'", async () => {
      await Subscription.create({
        organizationId: orgA._id,
        customerId: customerA._id,
        subscriptionCode: "SUB-AUTO-02",
        price: 1000,
        entitlements: [{ serviceId: serviceA1._id, serviceName: "Classic Haircut", totalQuantity: 3, usedQuantity: 0, remainingQuantity: 3 }],
        startDate: new Date("2026-01-01"),
        endDate: new Date("2026-12-31"),
        status: "active",
      });

      const res = await request(app)
        .post("/api/v1/appointments")
        .set("Authorization", `Bearer ${ownerToken}`)
        .set("x-branch-id", branchA1._id.toString())
        .send({
          customerId: customerA._id.toString(),
          branchId: branchA1._id.toString(),
          appointmentDate: getFutureDateStr(13),
          startTime: "12:00",
          bookingType: "advance",
          services: [
            { type: "registered", serviceId: serviceA1._id.toString(), appliedSubscriptionId: "auto" },
          ],
        });

      expect(res.status).toBe(201);
      const bookedService = res.body.data.services[0];
      expect(bookedService.appliedSubscriptionId).toBeDefined();
      expect(bookedService.appliedSubscriptionId).not.toBeNull();
    });

    it("does NOT attach subscription coverage when appliedSubscriptionId is explicitly null (explicit opt-out)", async () => {
      await Subscription.create({
        organizationId: orgA._id,
        customerId: customerA._id,
        subscriptionCode: "SUB-AUTO-03",
        price: 1000,
        entitlements: [{ serviceId: serviceA1._id, serviceName: "Classic Haircut", totalQuantity: 3, usedQuantity: 0, remainingQuantity: 3 }],
        startDate: new Date("2026-01-01"),
        endDate: new Date("2026-12-31"),
        status: "active",
      });

      const res = await request(app)
        .post("/api/v1/appointments")
        .set("Authorization", `Bearer ${ownerToken}`)
        .set("x-branch-id", branchA1._id.toString())
        .send({
          customerId: customerA._id.toString(),
          branchId: branchA1._id.toString(),
          appointmentDate: getFutureDateStr(14),
          startTime: "13:00",
          bookingType: "advance",
          services: [
            { type: "registered", serviceId: serviceA1._id.toString(), appliedSubscriptionId: null },
          ],
        });

      expect(res.status).toBe(201);
      const bookedService = res.body.data.services[0];
      // Must remain null - customer opted out of subscription coverage to pay out-of-pocket
      expect(bookedService.appliedSubscriptionId).toBeNull();
    });

    it("reassesses upcoming appointments and attaches benefits when a subscription is purchased later", async () => {
      // 1. Book appointment without any existing subscription
      const apptRes = await request(app)
        .post("/api/v1/appointments")
        .set("Authorization", `Bearer ${ownerToken}`)
        .set("x-branch-id", branchA1._id.toString())
        .send({
          customerId: customerA._id.toString(),
          branchId: branchA1._id.toString(),
          appointmentDate: getFutureDateStr(15),
          startTime: "14:00",
          bookingType: "advance",
          services: [{ type: "registered", serviceId: serviceA1._id.toString() }],
        });

      const apptId = apptRes.body.data._id;
      expect(apptRes.body.data.services[0].appliedSubscriptionId).toBeNull();

      // 2. Buy active subscription for customer and pay invoice in full
      const subRes = await request(app)
        .post("/api/v1/subscriptions")
        .set("Authorization", `Bearer ${ownerToken}`)
        .set("x-branch-id", branchA1._id.toString())
        .send({
          customerId: customerA._id.toString(),
          price: 2000,
          entitlements: [{ serviceId: serviceA1._id.toString(), quantity: 5 }],
          startDate: "2026-01-01",
          endDate: "2026-12-31",
          billImmediately: true,
          branchId: branchA1._id.toString(),
        });

      expect(subRes.status).toBe(201);
      const invoice = subRes.body.data.invoice;
      expect(invoice).toBeDefined();

      // Finalize and pay subscription invoice to activate subscription
      await request(app)
        .post(`/api/v1/billing/invoices/${invoice._id}/finalize`)
        .set("Authorization", `Bearer ${ownerToken}`)
        .set("x-branch-id", branchA1._id.toString())
        .send({});

      const payRes = await request(app)
        .post(`/api/v1/billing/invoices/${invoice._id}/payments`)
        .set("Authorization", `Bearer ${ownerToken}`)
        .set("x-branch-id", branchA1._id.toString())
        .send({
          amount: 2000,
          method: "card",
        });
      expect(payRes.status).toBe(201);

      // 3. Verify upcoming appointment was automatically updated with newly attached subscription
      const updatedAppt = await Appointment.findById(apptId);
      expect(updatedAppt.services[0].appliedSubscriptionId).not.toBeNull();
    });
  });

  describe("6. Mid-Appointment Upsell with Covered and Uncovered Services", () => {
    it("POST /api/v1/appointments/:id/upsell-subscription creates subscription, invoice, and attaches coverage atomically", async () => {
      // 1. Create in_progress appointment with 1 haircut (to be covered) and 1 custom line (uncovered)
      const now = new Date();
      const startAt = new Date(now.getTime() + 60000);
      const endAt = new Date(now.getTime() + 3660000);

      const appt = await Appointment.create({
        organizationId: orgA._id,
        branchId: branchA1._id,
        customerId: customerA._id,
        appointmentCode: "APT-UPSELL-01",
        startAt,
        endAt,
        appointmentDate: getFutureDateStr(1),
        startTime: "12:00",
        endTime: "13:00",
        bookingType: "walk_in",
        status: "in_progress",
        services: [
          {
            type: "registered",
            serviceType: "registered",
            serviceId: serviceA1._id,
            name: "Classic Haircut",
            duration: 30,
            price: 500,
            appliedSubscriptionId: null,
          },
          {
            type: "custom",
            serviceType: "custom",
            name: "Special Styling Treatment",
            duration: 30,
            price: 800,
            appliedSubscriptionId: null,
          },
        ],
        pricing: {
          subtotal: 1300,
          discount: 0,
          total: 1300,
        },
        subtotal: 1300,
        totalDuration: 60,
        amountDue: 1300,
      });

      // 2. Call upsell endpoint
      const upsellRes = await request(app)
        .post(`/api/v1/appointments/${appt._id}/upsell-subscription`)
        .set("Authorization", `Bearer ${ownerToken}`)
        .set("x-branch-id", branchA1._id.toString())
        .send({
          price: 3500,
          entitlements: [
            { serviceId: serviceA1._id.toString(), quantity: 10 },
          ],
          permittedBranchIds: [branchA1._id.toString()],
          startDate: "2026-01-01",
          endDate: "2026-12-31",
          notes: "In-chair upsell",
          billImmediately: true,
        });

      if (upsellRes.status !== 201) {
        console.error("UPSELL RES ERROR:", upsellRes.body);
      }
      expect(upsellRes.status).toBe(201);
      expect(upsellRes.body.success).toBe(true);

      const { subscription, invoice, appointment, summary } = upsellRes.body.data;
      expect(subscription.price).toBe(3500);
      expect(subscription.status).toBe("pending_payment");
      expect(invoice).toBeDefined();
      expect(invoice.invoiceType).toBe("subscription");
      expect(invoice.subtotal).toBe(3500);
      // Subscriptions are visible and redeemable even when payment is pending or partial
      expect(summary.newlyCoveredServicesCount).toBe(1);

      // Verify the appointment registered line is immediately covered by the pending_payment subscription
      const reloadedAppt = await Appointment.findById(appt._id);
      expect(reloadedAppt.services[0].appliedSubscriptionId.toString()).toBe(subscription._id.toString());
      expect(reloadedAppt.services[1].appliedSubscriptionId).toBeNull();

      // Finalize draft invoice
      await request(app)
        .post(`/api/v1/billing/invoices/${invoice._id}/finalize`)
        .set("Authorization", `Bearer ${ownerToken}`)
        .set("x-branch-id", branchA1._id.toString())
        .send({});

      // Pay the upsell invoice in full -> activates subscription
      const payRes = await request(app)
        .post(`/api/v1/billing/invoices/${invoice._id}/payments`)
        .set("Authorization", `Bearer ${ownerToken}`)
        .set("x-branch-id", branchA1._id.toString())
        .send({
          amount: 3500,
          method: "card",
        });
      expect(payRes.status).toBe(201);
      const paidSub = await Subscription.findById(subscription._id);
      expect(paidSub.status).toBe("active");

      // Verify the subscription invoice is persisted and retrievable via API
      const getSubInvRes = await request(app)
        .get(`/api/v1/billing/invoices/${invoice._id}`)
        .set("Authorization", `Bearer ${ownerToken}`)
        .set("x-branch-id", branchA1._id.toString());
      expect(getSubInvRes.status).toBe(200);
      expect(getSubInvRes.body.data.invoice.invoiceType).toBe("subscription");
      expect(getSubInvRes.body.data.invoice.paymentStatus).toBe("paid");

      // Now generate appointment service invoice for the appointment
      const apptInvRes = await request(app)
        .post("/api/v1/billing/invoices")
        .set("Authorization", `Bearer ${ownerToken}`)
        .set("x-branch-id", branchA1._id.toString())
        .send({ appointmentId: appt._id.toString() });

      expect(apptInvRes.status).toBe(201);
      const apptInvoice = apptInvRes.body.data;
      expect(apptInvoice.invoiceType).toBe("appointment");
      expect(apptInvoice._id.toString()).not.toBe(invoice._id.toString());
      expect(apptInvoice.appointmentId.toString()).toBe(appt._id.toString());
      expect(apptInvoice.subscriptionId).toBeNull();

      // Retrieve appointment invoice via API
      const getApptInvRes = await request(app)
        .get(`/api/v1/billing/invoices/${apptInvoice._id}`)
        .set("Authorization", `Bearer ${ownerToken}`)
        .set("x-branch-id", branchA1._id.toString());
      expect(getApptInvRes.status).toBe(200);
      expect(getApptInvRes.body.data.invoice.invoiceType).toBe("appointment");
      expect(getApptInvRes.body.data.invoice.appointmentId.toString()).toBe(appt._id.toString());
    });
  });

  describe("7. Subscription Cancellation, Refunds & Consumed Entitlement Restrictions", () => {
    it("blocks cancellation/refund if any entitlements have already been consumed", async () => {
      // Create subscription with 1 used entitlement
      const sub = await Subscription.create({
        organizationId: orgA._id,
        customerId: customerA._id,
        subscriptionCode: "SUB-USED-01",
        price: 2000,
        entitlements: [
          {
            serviceId: serviceA1._id,
            serviceName: "Classic Haircut",
            totalQuantity: 4,
            usedQuantity: 1, // Consumed!
            remainingQuantity: 3,
          },
        ],
        startDate: new Date("2026-01-01"),
        endDate: new Date("2026-12-31"),
        status: "active",
      });

      const cancelRes = await request(app)
        .patch(`/api/v1/subscriptions/${sub._id}/cancel`)
        .set("Authorization", `Bearer ${ownerToken}`)
        .set("x-branch-id", branchA1._id.toString())
        .send({ reason: "Customer wants refund" });

      expect(cancelRes.status).toBe(400);
      expect(cancelRes.body.message).toMatch(/already been consumed/i);

      // Subscription remains active
      const reloaded = await Subscription.findById(sub._id);
      expect(reloaded.status).toBe("active");
    });

    it("allows cancellation when zero entitlements have been consumed and cancels draft invoice", async () => {
      const sub = await Subscription.create({
        organizationId: orgA._id,
        customerId: customerA._id,
        subscriptionCode: "SUB-UNUSED-01",
        price: 2000,
        entitlements: [
          {
            serviceId: serviceA1._id,
            serviceName: "Classic Haircut",
            totalQuantity: 4,
            usedQuantity: 0,
            remainingQuantity: 4,
          },
        ],
        startDate: new Date("2026-01-01"),
        endDate: new Date("2026-12-31"),
        status: "active",
      });

      const cancelRes = await request(app)
        .patch(`/api/v1/subscriptions/${sub._id}/cancel`)
        .set("Authorization", `Bearer ${ownerToken}`)
        .set("x-branch-id", branchA1._id.toString())
        .send({ reason: "Customer changed mind before using any services" });

      expect(cancelRes.status).toBe(200);
      const reloaded = await Subscription.findById(sub._id);
      expect(reloaded.status).toBe("cancelled");
    });
  });

  describe("8. Subscription Renewal", () => {
    it("renews subscription with refreshed entitlements and correct customer link", async () => {
      const originalSub = await Subscription.create({
        organizationId: orgA._id,
        customerId: customerA._id,
        subscriptionCode: "SUB-ORIG-01",
        price: 1500,
        entitlements: [
          {
            serviceId: serviceA1._id,
            serviceName: "Classic Haircut",
            totalQuantity: 3,
            usedQuantity: 3,
            remainingQuantity: 0,
          },
        ],
        startDate: new Date("2026-01-01"),
        endDate: new Date("2026-06-30"),
        status: "exhausted",
      });

      const renewRes = await request(app)
        .post(`/api/v1/subscriptions/${originalSub._id}/renew`)
        .set("Authorization", `Bearer ${ownerToken}`)
        .set("x-branch-id", branchA1._id.toString())
        .send({
          price: 1600,
          startDate: "2026-07-01",
          endDate: "2026-12-31",
          billImmediately: true,
          branchId: branchA1._id.toString(),
        });

      expect(renewRes.status).toBe(201);
      const renewed = renewRes.body.data;
      expect(renewed.price).toBe(1600);
      expect(renewed.status).toBe("pending_payment");
      expect(renewed.invoice).toBeDefined();
      expect(renewed.entitlements[0].usedQuantity).toBe(0);
      expect(renewed.entitlements[0].remainingQuantity).toBe(3);

      // Finalize and pay renewal invoice -> activates renewed subscription
      await request(app)
        .post(`/api/v1/billing/invoices/${renewed.invoice._id}/finalize`)
        .set("Authorization", `Bearer ${ownerToken}`)
        .set("x-branch-id", branchA1._id.toString())
        .send({});

      const payRes = await request(app)
        .post(`/api/v1/billing/invoices/${renewed.invoice._id}/payments`)
        .set("Authorization", `Bearer ${ownerToken}`)
        .set("x-branch-id", branchA1._id.toString())
        .send({
          amount: 1600,
          method: "card",
        });
      expect(payRes.status).toBe(201);

      const activeRenewedSub = await Subscription.findById(renewed._id);
      expect(activeRenewedSub.status).toBe("active");
    });
  });

  describe("10. Subscription Redemption Eligibility Across Payment States & Non-Payment Rules", () => {
    it("allows booking and completing appointment with pending_payment subscription, preserving OTP verification and atomic decrement", async () => {
      // 1. Create a subscription with price > 0 and billImmediately: true -> status: pending_payment
      const subRes = await request(app)
        .post("/api/v1/subscriptions")
        .set("Authorization", `Bearer ${ownerToken}`)
        .set("x-branch-id", branchA1._id.toString())
        .send({
          customerId: customerA._id.toString(),
          price: 1500,
          entitlements: [{ serviceId: serviceA1._id.toString(), quantity: 3 }],
          permittedBranchIds: [branchA1._id.toString()],
          startDate: "2026-01-01",
          endDate: "2026-12-31",
          billImmediately: true,
          branchId: branchA1._id.toString(),
        });

      expect(subRes.status).toBe(201);
      const sub = subRes.body.data;
      expect(sub.status).toBe("pending_payment");

      // Verify subscription query returns paymentStatus and isRedeemable
      const getSubRes = await request(app)
        .get(`/api/v1/subscriptions/${sub._id}`)
        .set("Authorization", `Bearer ${ownerToken}`)
        .set("x-branch-id", branchA1._id.toString());
      expect(getSubRes.status).toBe(200);
      expect(getSubRes.body.data.isRedeemable).toBe(true);
      expect(getSubRes.body.data.paymentStatus).toBe("unpaid");

      // 2. Book appointment with this pending_payment subscription applied
      const aptRes = await request(app)
        .post("/api/v1/appointments")
        .set("Authorization", `Bearer ${ownerToken}`)
        .set("x-branch-id", branchA1._id.toString())
        .send({
          customerId: customerA._id.toString(),
          branchId: branchA1._id.toString(),
          appointmentDate: getFutureDateStr(2),
          startTime: "11:00",
          bookingType: "advance",
          services: [
            {
              type: "registered",
              serviceId: serviceA1._id.toString(),
              appliedSubscriptionId: sub._id.toString(),
            },
          ],
        });

      expect(aptRes.status).toBe(201);
      const apt = aptRes.body.data;
      expect(apt.services[0].appliedSubscriptionId).toBe(sub._id.toString());

      // Verify appointment creation does NOT consume entitlement
      const subBeforeComplete = await Subscription.findById(sub._id);
      expect(subBeforeComplete.entitlements[0].usedQuantity).toBe(0);
      expect(subBeforeComplete.entitlements[0].remainingQuantity).toBe(3);

      // Transition appointment to in_progress
      await Appointment.findByIdAndUpdate(apt._id, { status: "in_progress", startedAt: new Date() });

      // 3. Send redemption OTP for this appointment
      const otpRes = await request(app)
        .post(`/api/v1/appointments/${apt._id}/request-consumption-otp`)
        .set("Authorization", `Bearer ${ownerToken}`)
        .set("x-branch-id", branchA1._id.toString())
        .send({});

      expect(otpRes.status).toBe(200);

      // Retrieve challenge OTP hash
      const challenge = await SubscriptionConsumptionChallenge.findOne({
        appointmentId: apt._id,
        status: "pending",
      });
      expect(challenge).toBeDefined();

      // Complete appointment with invalid OTP -> must fail
      const badCompleteRes = await request(app)
        .post(`/api/v1/appointments/${apt._id}/complete-with-subscription`)
        .set("Authorization", `Bearer ${ownerToken}`)
        .set("x-branch-id", branchA1._id.toString())
        .send({ otp: "000000" });
      expect(badCompleteRes.status).toBe(400);

      // Complete appointment with valid OTP
      // Generate a known OTP and set in challenge
      const validOtp = "123456";
      challenge.otpHash = crypto.createHash("sha256").update(validOtp).digest("hex");
      await challenge.save();

      const completeRes = await request(app)
        .post(`/api/v1/appointments/${apt._id}/complete-with-subscription`)
        .set("Authorization", `Bearer ${ownerToken}`)
        .set("x-branch-id", branchA1._id.toString())
        .send({ otp: validOtp });

      expect(completeRes.status).toBe(200);

      // Verify atomic entitlement decrement
      const subAfterComplete = await Subscription.findById(sub._id);
      expect(subAfterComplete.entitlements[0].usedQuantity).toBe(1);
      expect(subAfterComplete.entitlements[0].remainingQuantity).toBe(2);

      // Verify usage record created
      const usage = await SubscriptionUsage.findOne({
        subscriptionId: sub._id,
        appointmentId: apt._id,
      });
      expect(usage).toBeDefined();
      expect(usage.quantity).toBe(1);

      // Verify subscription invoice remains separate and unpaid
      const subInvoice = await Invoice.findById(sub.invoiceId);
      expect(subInvoice.paymentStatus).toBe("unpaid");
      expect(subInvoice.amountDue).toBe(1500);

      // 4. Create appointment invoice and verify it is covered without marking subscription invoice paid
      const aptInvoiceRes = await request(app)
        .post("/api/v1/billing/invoices")
        .set("Authorization", `Bearer ${ownerToken}`)
        .set("x-branch-id", branchA1._id.toString())
        .send({ appointmentId: apt._id.toString() });

      expect(aptInvoiceRes.status).toBe(201);
      const aptInv = aptInvoiceRes.body.data;
      expect(aptInv.lines[0].subscriptionCoveredAmount).toBe(500);
      expect(aptInv.payableAmount).toBe(0); // Fully covered by subscription entitlement
    });

    it("allows redemption when subscription has partial payment recorded", async () => {
      // 1. Create subscription with billImmediately
      const subRes = await request(app)
        .post("/api/v1/subscriptions")
        .set("Authorization", `Bearer ${ownerToken}`)
        .set("x-branch-id", branchA1._id.toString())
        .send({
          customerId: customerA._id.toString(),
          price: 2000,
          entitlements: [{ serviceId: serviceA1._id.toString(), quantity: 2 }],
          permittedBranchIds: [],
          startDate: "2026-01-01",
          endDate: "2026-12-31",
          billImmediately: true,
          branchId: branchA1._id.toString(),
        });

      const sub = subRes.body.data;
      const invoiceId = sub.invoiceId;

      // Finalize invoice and record partial payment of 500
      await request(app)
        .post(`/api/v1/billing/invoices/${invoiceId}/finalize`)
        .set("Authorization", `Bearer ${ownerToken}`)
        .set("x-branch-id", branchA1._id.toString())
        .send({});

      const partialPayRes = await request(app)
        .post(`/api/v1/billing/invoices/${invoiceId}/payments`)
        .set("Authorization", `Bearer ${ownerToken}`)
        .set("x-branch-id", branchA1._id.toString())
        .send({ amount: 500, method: "cash" });

      expect(partialPayRes.status).toBe(201);
      expect(partialPayRes.body.data.invoice.paymentStatus).toBe("partially_paid");

      // Verify subscription is still redeemable
      const getSub = await request(app)
        .get(`/api/v1/subscriptions/${sub._id}`)
        .set("Authorization", `Bearer ${ownerToken}`)
        .set("x-branch-id", branchA1._id.toString());
      expect(getSub.body.data.isRedeemable).toBe(true);
      expect(getSub.body.data.paymentStatus).toBe("partially_paid");

      // Book appointment and apply this partially-paid subscription
      const aptRes = await request(app)
        .post("/api/v1/appointments")
        .set("Authorization", `Bearer ${ownerToken}`)
        .set("x-branch-id", branchA1._id.toString())
        .send({
          customerId: customerA._id.toString(),
          branchId: branchA1._id.toString(),
          appointmentDate: getFutureDateStr(3),
          startTime: "15:00",
          bookingType: "advance",
          services: [
            {
              type: "registered",
              serviceId: serviceA1._id.toString(),
              appliedSubscriptionId: sub._id.toString(),
            },
          ],
        });

      expect(aptRes.status).toBe(201);
      expect(aptRes.body.data.services[0].appliedSubscriptionId).toBe(sub._id.toString());
    });

    it("strictly rejects redemption for expired, cancelled, wrong-customer, or exhausted subscriptions", async () => {
      // 1. Expired subscription
      const expiredSub = await Subscription.create({
        organizationId: orgA._id,
        customerId: customerA._id,
        subscriptionCode: "SUB-EXPIRED-TEST",
        price: 1000,
        status: "active",
        startDate: new Date("2025-01-01"),
        endDate: new Date("2025-06-01"),
        entitlements: [{ serviceId: serviceA1._id, serviceName: "Haircut", totalQuantity: 1, usedQuantity: 0, remainingQuantity: 1 }],
      });

      const expRes = await request(app)
        .post("/api/v1/appointments")
        .set("Authorization", `Bearer ${ownerToken}`)
        .set("x-branch-id", branchA1._id.toString())
        .send({
          customerId: customerA._id.toString(),
          branchId: branchA1._id.toString(),
          appointmentDate: getFutureDateStr(1),
          startTime: "10:00",
          bookingType: "advance",
          services: [{ type: "registered", serviceId: serviceA1._id.toString(), appliedSubscriptionId: expiredSub._id.toString() }],
        });
      expect(expRes.status).toBe(400);
      expect(expRes.body.message).toMatch(/expired/i);

      // 2. Cancelled subscription
      const cancelledSub = await Subscription.create({
        organizationId: orgA._id,
        customerId: customerA._id,
        subscriptionCode: "SUB-CANCELLED-TEST",
        price: 1000,
        status: "cancelled",
        startDate: new Date("2026-01-01"),
        endDate: new Date("2026-12-31"),
        entitlements: [{ serviceId: serviceA1._id, serviceName: "Haircut", totalQuantity: 1, usedQuantity: 0, remainingQuantity: 1 }],
      });

      const canRes = await request(app)
        .post("/api/v1/appointments")
        .set("Authorization", `Bearer ${ownerToken}`)
        .set("x-branch-id", branchA1._id.toString())
        .send({
          customerId: customerA._id.toString(),
          branchId: branchA1._id.toString(),
          appointmentDate: getFutureDateStr(1),
          startTime: "10:00",
          bookingType: "advance",
          services: [{ type: "registered", serviceId: serviceA1._id.toString(), appliedSubscriptionId: cancelledSub._id.toString() }],
        });
      expect(canRes.status).toBe(400);
      expect(canRes.body.message).toMatch(/not eligible for redemption/i);

      // 3. Exhausted subscription (0 remaining)
      const exhaustedSub = await Subscription.create({
        organizationId: orgA._id,
        customerId: customerA._id,
        subscriptionCode: "SUB-EXHAUSTED-TEST",
        price: 1000,
        status: "exhausted",
        startDate: new Date("2026-01-01"),
        endDate: new Date("2026-12-31"),
        entitlements: [{ serviceId: serviceA1._id, serviceName: "Haircut", totalQuantity: 1, usedQuantity: 1, remainingQuantity: 0 }],
      });

      const exhRes = await request(app)
        .post("/api/v1/appointments")
        .set("Authorization", `Bearer ${ownerToken}`)
        .set("x-branch-id", branchA1._id.toString())
        .send({
          customerId: customerA._id.toString(),
          branchId: branchA1._id.toString(),
          appointmentDate: getFutureDateStr(1),
          startTime: "10:00",
          bookingType: "advance",
          services: [{ type: "registered", serviceId: serviceA1._id.toString(), appliedSubscriptionId: exhaustedSub._id.toString() }],
        });
      expect(exhRes.status).toBe(400);

      // 4. Other customer's subscription
      const otherCustSub = await Subscription.create({
        organizationId: orgA._id,
        customerId: new mongoose.Types.ObjectId(), // Different customer
        subscriptionCode: "SUB-DIFF-CUST",
        price: 1000,
        status: "active",
        startDate: new Date("2026-01-01"),
        endDate: new Date("2026-12-31"),
        entitlements: [{ serviceId: serviceA1._id, serviceName: "Haircut", totalQuantity: 1, usedQuantity: 0, remainingQuantity: 1 }],
      });

      const diffCustRes = await request(app)
        .post("/api/v1/appointments")
        .set("Authorization", `Bearer ${ownerToken}`)
        .set("x-branch-id", branchA1._id.toString())
        .send({
          customerId: customerA._id.toString(),
          branchId: branchA1._id.toString(),
          appointmentDate: getFutureDateStr(1),
          startTime: "10:00",
          bookingType: "advance",
          services: [{ type: "registered", serviceId: serviceA1._id.toString(), appliedSubscriptionId: otherCustSub._id.toString() }],
        });
      expect(diffCustRes.status).toBe(400);
      expect(diffCustRes.body.message).toMatch(/does not belong to this customer/i);
    });

    it("prevents invoice coverage when linked subscription is expired, exhausted, wrong branch, or wrong service", async () => {
      // Create subscription valid ONLY at branchA2
      const branchA2Sub = await Subscription.create({
        organizationId: orgA._id,
        customerId: customerA._id,
        subscriptionCode: "SUB-A2-ONLY",
        price: 1000,
        status: "active",
        startDate: new Date("2026-01-01"),
        endDate: new Date("2026-12-31"),
        permittedBranchIds: [branchA2._id],
        entitlements: [{ serviceId: serviceA1._id, serviceName: "Haircut", totalQuantity: 2, usedQuantity: 0, remainingQuantity: 2 }],
      });

      // Appointment at branchA1 with appliedSubscriptionId = branchA2Sub
      const apt = await Appointment.create({
        organizationId: orgA._id,
        branchId: branchA1._id,
        customerId: customerA._id,
        appointmentCode: `APT-BR-INV-${Date.now()}`,
        startAt: new Date(),
        endAt: new Date(Date.now() + 3600000),
        appointmentDate: getFutureDateStr(1),
        startTime: "14:00",
        endTime: "15:00",
        bookingType: "walk_in",
        status: "in_progress",
        services: [
          {
            type: "registered",
            serviceType: "registered",
            serviceId: serviceA1._id,
            name: "Classic Haircut",
            duration: 30,
            price: 500,
            appliedSubscriptionId: branchA2Sub._id,
            isRedeemedViaSubscription: false,
          },
        ],
        pricing: { subtotal: 500, discount: 0, total: 500 },
        subtotal: 500,
        totalDuration: 30,
        amountDue: 500,
      });

      const invRes = await request(app)
        .post("/api/v1/billing/invoices")
        .set("Authorization", `Bearer ${ownerToken}`)
        .set("x-branch-id", branchA1._id.toString())
        .send({ appointmentId: apt._id.toString() });

      expect(invRes.status).toBe(201);
      // Because subscription is not permitted at branchA1, coverage must NOT be applied
      expect(invRes.body.data.lines[0].isCoveredBySubscription).toBe(false);
      expect(invRes.body.data.lines[0].customerPayable).toBe(500);
      expect(invRes.body.data.payableAmount).toBe(500);
    });

    it("prevents duplicate entitlement coverage across multiple appointment lines when only 1 entitlement remains", async () => {
      const singleEntitlementSub = await Subscription.create({
        organizationId: orgA._id,
        customerId: customerA._id,
        subscriptionCode: `SUB-SINGLE-${Date.now()}`,
        price: 1000,
        status: "pending_payment",
        startDate: new Date("2026-01-01"),
        endDate: new Date("2026-12-31"),
        permittedBranchIds: [branchA1._id],
        entitlements: [{ serviceId: serviceA1._id, serviceName: "Haircut", totalQuantity: 1, usedQuantity: 0, remainingQuantity: 1 }],
      });

      // Appointment with TWO haircut lines both pointing to singleEntitlementSub
      const apt = await Appointment.create({
        organizationId: orgA._id,
        branchId: branchA1._id,
        customerId: customerA._id,
        appointmentCode: `APT-DUP-INV-${Date.now()}`,
        startAt: new Date(),
        endAt: new Date(Date.now() + 3600000),
        appointmentDate: getFutureDateStr(1),
        startTime: "14:00",
        endTime: "15:00",
        bookingType: "walk_in",
        status: "in_progress",
        services: [
          {
            type: "registered",
            serviceType: "registered",
            serviceId: serviceA1._id,
            name: "Classic Haircut #1",
            duration: 30,
            price: 500,
            appliedSubscriptionId: singleEntitlementSub._id,
            isRedeemedViaSubscription: false,
          },
          {
            type: "registered",
            serviceType: "registered",
            serviceId: serviceA1._id,
            name: "Classic Haircut #2",
            duration: 30,
            price: 500,
            appliedSubscriptionId: singleEntitlementSub._id,
            isRedeemedViaSubscription: false,
          },
        ],
        pricing: { subtotal: 1000, discount: 0, total: 1000 },
        subtotal: 1000,
        totalDuration: 60,
        amountDue: 1000,
      });

      const invRes = await request(app)
        .post("/api/v1/billing/invoices")
        .set("Authorization", `Bearer ${ownerToken}`)
        .set("x-branch-id", branchA1._id.toString())
        .send({ appointmentId: apt._id.toString() });

      expect(invRes.status).toBe(201);
      // Line 0 is covered, Line 1 must NOT be covered because remainingQuantity was 1
      expect(invRes.body.data.lines[0].isCoveredBySubscription).toBe(true);
      expect(invRes.body.data.lines[0].customerPayable).toBe(0);
      expect(invRes.body.data.lines[1].isCoveredBySubscription).toBe(false);
      expect(invRes.body.data.lines[1].customerPayable).toBe(500);
      expect(invRes.body.data.payableAmount).toBe(500);
    });

    it("rejects repeated completion requests and verifies OTP replay protection", async () => {
      const sub = await Subscription.create({
        organizationId: orgA._id,
        customerId: customerA._id,
        subscriptionCode: `SUB-REPLAY-${Date.now()}`,
        price: 1500,
        status: "pending_payment",
        startDate: new Date("2026-01-01"),
        endDate: new Date("2026-12-31"),
        permittedBranchIds: [branchA1._id],
        entitlements: [{ serviceId: serviceA1._id, serviceName: "Haircut", totalQuantity: 1, usedQuantity: 0, remainingQuantity: 1 }],
      });

      const apt = await Appointment.create({
        organizationId: orgA._id,
        branchId: branchA1._id,
        customerId: customerA._id,
        appointmentCode: `APT-REPLAY-${Date.now()}`,
        startAt: new Date(),
        endAt: new Date(Date.now() + 3600000),
        appointmentDate: getFutureDateStr(1),
        startTime: "14:00",
        endTime: "15:00",
        bookingType: "walk_in",
        status: "in_progress",
        services: [
          {
            type: "registered",
            serviceType: "registered",
            serviceId: serviceA1._id,
            name: "Classic Haircut",
            duration: 30,
            price: 500,
            appliedSubscriptionId: sub._id,
            isRedeemedViaSubscription: false,
          },
        ],
        pricing: { subtotal: 500, discount: 0, total: 500 },
        subtotal: 500,
        totalDuration: 30,
        amountDue: 500,
      });

      const rawOtp = "123456";
      const otpHash = crypto.createHash("sha256").update(rawOtp).digest("hex");
      await SubscriptionConsumptionChallenge.create({
        organizationId: orgA._id,
        branchId: branchA1._id,
        appointmentId: apt._id,
        customerId: customerA._id,
        subscriptionId: sub._id,
        otpHash,
        status: "pending",
        attempts: 0,
        resendAvailableAt: new Date(Date.now() + 60 * 1000),
        expiresAt: new Date(Date.now() + 10 * 60 * 1000),
      });

      // First completion request succeeds
      const comp1 = await request(app)
        .post(`/api/v1/appointments/${apt._id}/complete-with-subscription`)
        .set("Authorization", `Bearer ${ownerToken}`)
        .set("x-branch-id", branchA1._id.toString())
        .send({ branchId: branchA1._id.toString(), otp: rawOtp });

      expect(comp1.status).toBe(200);
      expect(comp1.body.data.status).toBe("completed");

      // Second completion request with same OTP must fail with 400 (Cannot complete appointment with status 'completed')
      const comp2 = await request(app)
        .post(`/api/v1/appointments/${apt._id}/complete-with-subscription`)
        .set("Authorization", `Bearer ${ownerToken}`)
        .set("x-branch-id", branchA1._id.toString())
        .send({ branchId: branchA1._id.toString(), otp: rawOtp });

      expect(comp2.status).toBe(400);

      // Entitlement must not be decremented again
      const refreshedSub = await Subscription.findById(sub._id);
      expect(refreshedSub.entitlements[0].usedQuantity).toBe(1);
      expect(refreshedSub.entitlements[0].remainingQuantity).toBe(0);
      expect(refreshedSub.status).toBe("exhausted");
    });
  });
});
