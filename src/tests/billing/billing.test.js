import dns from "dns";
import { describe, expect, it, beforeEach, afterEach, beforeAll, afterAll, jest } from "@jest/globals";
import request from "supertest";
import mongoose from "mongoose";
import jwt from "jsonwebtoken";
import app from "../../../app.mjs";
import { env } from "../../../src/config/env.js";
import { redis } from "../../../src/utils/redis.js";
import "../../database/db.js";

try {
  dns.setServers(["8.8.8.8", "1.1.1.1"]);
} catch (_) {}

import { Organization } from "../../../src/models/organizations/organization.model.js";
import { Branch } from "../../../src/models/branches/branch.model.js";
import { Customer } from "../../../src/models/customers/customer.model.js";
import { Service } from "../../../src/models/services/service.model.js";
import { ServiceCategory } from "../../../src/models/services/serviceCategory.model.js";
import { Role } from "../../../src/models/roles/role.model.js";
import { Permission } from "../../../src/models/permissions/permission.model.js";
import { User } from "../../../src/models/users/user.model.js";
import { Appointment } from "../../../src/models/appointments/appointment.model.js";
import { Subscription } from "../../../src/models/subscriptions/subscription.model.js";
import { SubscriptionUsage } from "../../../src/models/subscriptions/subscriptionUsage.model.js";
import { Invoice } from "../../../src/models/billing/invoice.model.js";
import { Payment } from "../../../src/models/billing/payment.model.js";
import { AuditLog } from "../../../src/models/audit/auditLog.model.js";

jest.spyOn(redis, "get").mockResolvedValue(null);
jest.spyOn(redis, "setex").mockResolvedValue("OK");

describe("Billing / POS Module Comprehensive Test Suite", () => {
  jest.setTimeout(45000);

  let orgAId, orgBId;
  let branchA1Id, branchA2Id, branchB1Id;
  let ownerTokenA, branchUserTokenA, ownerTokenB;
  let ownerUserA, branchUserA, ownerUserB;
  let customerA, categoryA, serviceHaircut, serviceColor;

  beforeAll(async () => {
    process.env.ALLOW_STANDALONE_TRANSACTION_FALLBACK = "true";
    process.env.NODE_ENV = "test";
    let testUri = process.env.MONGO_URI || "mongodb://127.0.0.1:27017/saloon_erp_test";
    if (testUri.includes("?")) {
      const parts = testUri.split("?");
      testUri = parts[0].replace(/\/([^\/]+)$/, "/saloon_erp_billing_test") + "?" + parts[1];
    } else {
      testUri = testUri.replace(/\/([^\/]+)$/, "/saloon_erp_billing_test");
    }
    await mongoose.connect(testUri);
  });

  afterAll(async () => {
    await Invoice.deleteMany({});
    await Payment.deleteMany({});
    await Appointment.deleteMany({});
    await Subscription.deleteMany({});
    await SubscriptionUsage.deleteMany({});
    await Service.deleteMany({});
    await ServiceCategory.deleteMany({});
    await Customer.deleteMany({});
    await User.deleteMany({});
    await Role.deleteMany({});
    await Permission.deleteMany({});
    await Branch.deleteMany({});
    await Organization.deleteMany({});
    await AuditLog.deleteMany({});
    await mongoose.connection.close();
  });

  beforeEach(async () => {
    // 1. Setup Organization A & Branches
    const orgA = await Organization.create({ name: "Glamour Salon A" });
    orgAId = orgA._id;

    const bA1 = await Branch.create({ organizationId: orgAId, name: "Branch A1", isActive: true });
    branchA1Id = bA1._id;

    const bA2 = await Branch.create({ organizationId: orgAId, name: "Branch A2", isActive: true });
    branchA2Id = bA2._id;

    // 2. Setup Organization B & Branch
    const orgB = await Organization.create({ name: "Rival Salon B" });
    orgBId = orgB._id;

    const bB1 = await Branch.create({ organizationId: orgBId, name: "Branch B1", isActive: true });
    branchB1Id = bB1._id;

    // 3. Permissions & Roles
    const billingPerms = [
      "billing.view",
      "billing.checkout",
      "billing.void",
      "payments.view",
      "payments.receive",
      "payments.refund",
      "appointments.book",
      "appointments.view",
      "appointments.update_status",
    ];

    const permsDocs = await Promise.all(
      billingPerms.map((name) =>
        Permission.findOneAndUpdate(
          { name },
          { name, module: "Billing & POS", action: name, description: name },
          { upsert: true, new: true }
        )
      )
    );

    const ownerRoleA = await Role.create({
      name: `owner_a_${Date.now()}`,
      description: "Owner Role",
      permissions: permsDocs.map((p) => p._id),
    });

    // 4. Users
    ownerUserA = await User.create({
      name: "Owner A",
      email: `owner_a_${Date.now()}@test.com`,
      phone: "+919999990001",
      password: "Password@123",
      role: ownerRoleA._id,
      organizationId: orgAId,
      status: "active",
      hasOrgWideAccess: true,
      branchAccess: [
        { branchId: branchA1Id, branchName: "Branch A1", isActive: true },
        { branchId: branchA2Id, branchName: "Branch A2", isActive: true },
      ],
    });
    ownerTokenA = jwt.sign({ id: ownerUserA._id, role: "owner" }, env.JWT_SECRET, { expiresIn: "1h" });

    // Branch-limited User in Org A (access ONLY to branchA1)
    branchUserA = await User.create({
      name: "Staff Branch A1",
      email: `staff_a1_${Date.now()}@test.com`,
      phone: "+919999990002",
      password: "Password@123",
      role: ownerRoleA._id,
      organizationId: orgAId,
      status: "active",
      hasOrgWideAccess: false,
      branchAccess: [{ branchId: branchA1Id, branchName: "Branch A1", isActive: true }],
    });
    branchUserTokenA = jwt.sign({ id: branchUserA._id, role: "staff" }, env.JWT_SECRET, { expiresIn: "1h" });

    // Owner in Org B
    ownerUserB = await User.create({
      name: "Owner B",
      email: `owner_b_${Date.now()}@test.com`,
      phone: "+919999990003",
      password: "Password@123",
      role: ownerRoleA._id,
      organizationId: orgBId,
      status: "active",
      hasOrgWideAccess: true,
      branchAccess: [{ branchId: branchB1Id, branchName: "Branch B1", isActive: true }],
    });
    ownerTokenB = jwt.sign({ id: ownerUserB._id, role: "owner" }, env.JWT_SECRET, { expiresIn: "1h" });

    // 5. Customer in Org A
    customerA = await Customer.create({
      name: "Alice Green",
      phone: "+919876543210",
      email: "alice@example.com",
      organizationId: orgAId,
      homeBranchId: branchA1Id,
      status: "active",
    });

    // 6. Services in Org A
    categoryA = await ServiceCategory.create({
      name: "Hair Care",
      organizationId: orgAId,
    });

    serviceHaircut = await Service.create({
      name: "Classic Haircut",
      categoryId: categoryA._id,
      duration: 30,
      pricing: { basePrice: 500 },
      organizationId: orgAId,
      status: "active",
    });

    serviceColor = await Service.create({
      name: "Hair Color",
      categoryId: categoryA._id,
      duration: 60,
      pricing: { basePrice: 1500 },
      organizationId: orgAId,
      status: "active",
    });
  });

  afterEach(async () => {
    await Invoice.deleteMany({});
    await Payment.deleteMany({});
    await Appointment.deleteMany({});
    await Subscription.deleteMany({});
    await SubscriptionUsage.deleteMany({});
    await Customer.deleteMany({});
    await Service.deleteMany({});
    await ServiceCategory.deleteMany({});
    await User.deleteMany({});
    await Role.deleteMany({});
    await Branch.deleteMany({});
    await Organization.deleteMany({});
  });

  // Helper to create an appointment
  async function createTestAppointment(overrides = {}) {
    const defaultData = {
      organizationId: orgAId,
      branchId: branchA1Id,
      appointmentCode: `APT-${Date.now()}-${Math.floor(Math.random() * 1000)}`,
      customerId: customerA._id,
      services: [
        {
          serviceId: serviceHaircut._id,
          name: serviceHaircut.name,
          duration: 30,
          price: 500,
          isRedeemedViaSubscription: false,
        },
        {
          serviceId: serviceColor._id,
          name: serviceColor.name,
          duration: 60,
          price: 1500,
          isRedeemedViaSubscription: false,
        },
      ],
      startAt: new Date(),
      endAt: new Date(Date.now() + 90 * 60000),
      appointmentDate: "2026-10-10",
      startTime: "10:00",
      endTime: "11:30",
      totalDuration: 90,
      status: "completed",
      bookingType: "advance",
      pricing: {
        subtotal: 2000,
        discount: 100,
        total: 1900,
      },
    };
    return await Appointment.create({ ...defaultData, ...overrides });
  }

  // -------------------------------------------------------------
  // TEST SUITE CASES
  // -------------------------------------------------------------

  it("1. creates draft invoice from appointment with accurate line snapshots and totals", async () => {
    const apt = await createTestAppointment();

    const res = await request(app)
      .post("/api/v1/billing/invoices")
      .set("Authorization", `Bearer ${ownerTokenA}`)
      .set("X-Branch-Id", branchA1Id.toString())
      .send({
        appointmentId: apt._id.toString(),
        notes: "Test invoice notes",
      });

    if (res.status !== 201) {
      console.error("Test 1 Failure Body:", JSON.stringify(res.body, null, 2));
    }
    expect(res.status).toBe(201);
    expect(res.body.success).toBe(true);
    const invoice = res.body.data;

    expect(invoice.invoiceNumber).toMatch(/^INV-\d{8}-\d{4}$/);
    expect(invoice.status).toBe("draft");
    expect(invoice.paymentStatus).toBe("unpaid");
    expect(invoice.subtotal).toBe(2000);
    expect(invoice.discountTotal).toBe(100); // seeded from appointment pricing discount
    expect(invoice.grossPayable).toBe(1900);
    expect(invoice.subscriptionCoveredAmount).toBe(0);
    expect(invoice.payableAmount).toBe(1900);
    expect(invoice.amountPaid).toBe(0);
    expect(invoice.amountDue).toBe(1900);

    // Verify appointment snapshot preservation
    expect(invoice.appointmentPricingSnapshot.subtotal).toBe(2000);
    expect(invoice.appointmentPricingSnapshot.discount).toBe(100);
    expect(invoice.appointmentPricingSnapshot.total).toBe(1900);

    // Verify customer snapshot
    expect(invoice.customerSnapshot.name).toBe("Alice Green");
    expect(invoice.customerSnapshot.phone).toBe("+919876543210");
  });

  it("2. changing Service master price does NOT alter created or newly created invoice service price snapshot", async () => {
    const apt = await createTestAppointment();

    // Mutate the master Service catalog prices drastically
    await Service.findByIdAndUpdate(serviceHaircut._id, { "pricing.basePrice": 9999 });
    await Service.findByIdAndUpdate(serviceColor._id, { "pricing.basePrice": 8888 });

    // Generate invoice
    const res = await request(app)
      .post("/api/v1/billing/invoices")
      .set("Authorization", `Bearer ${ownerTokenA}`)
      .set("X-Branch-Id", branchA1Id.toString())
      .send({ appointmentId: apt._id.toString() });

    expect(res.status).toBe(201);
    const invoice = res.body.data;

    // Prices must strictly equal appointment snapshots (500 and 1500), NOT catalog prices (9999, 8888)
    expect(invoice.lines[0].unitPrice).toBe(500);
    expect(invoice.lines[1].unitPrice).toBe(1500);
    expect(invoice.subtotal).toBe(2000);
  });

  it("3. custom appointment price override is authoritative and faithfully captured", async () => {
    // Appointment where haircut was given at custom price of ₹350
    const apt = await createTestAppointment({
      services: [
        {
          serviceId: serviceHaircut._id,
          name: serviceHaircut.name,
          duration: 30,
          price: 350, // Custom price
        },
      ],
      pricing: { subtotal: 350, discount: 0, total: 350 },
    });

    const res = await request(app)
      .post("/api/v1/billing/invoices")
      .set("Authorization", `Bearer ${ownerTokenA}`)
      .set("X-Branch-Id", branchA1Id.toString())
      .send({ appointmentId: apt._id.toString() });

    expect(res.status).toBe(201);
    expect(res.body.data.lines[0].unitPrice).toBe(350);
    expect(res.body.data.subtotal).toBe(350);
    expect(res.body.data.payableAmount).toBe(350);
  });

  it("4. subscription-redeemed line gets financial coverage without double-redeeming or zeroing economic value", async () => {
    const dummySubId = new mongoose.Types.ObjectId();
    const dummyUsageId = new mongoose.Types.ObjectId();

    // Haircut redeemed via subscription; Color unpaid
    const apt = await createTestAppointment({
      services: [
        {
          serviceId: serviceHaircut._id,
          name: serviceHaircut.name,
          duration: 30,
          price: 500, // Economic value preserved!
          isRedeemedViaSubscription: true,
          appliedSubscriptionId: dummySubId,
          subscriptionUsageId: dummyUsageId,
        },
        {
          serviceId: serviceColor._id,
          name: serviceColor.name,
          duration: 60,
          price: 1500,
          isRedeemedViaSubscription: false,
        },
      ],
      pricing: { subtotal: 2000, discount: 0, total: 2000 },
    });

    const res = await request(app)
      .post("/api/v1/billing/invoices")
      .set("Authorization", `Bearer ${ownerTokenA}`)
      .set("X-Branch-Id", branchA1Id.toString())
      .send({ appointmentId: apt._id.toString() });

    expect(res.status).toBe(201);
    const invoice = res.body.data;

    // Line 0 (Haircut): covered
    expect(invoice.lines[0].unitPrice).toBe(500);
    expect(invoice.lines[0].isCoveredBySubscription).toBe(true);
    expect(invoice.lines[0].subscriptionCoveredAmount).toBe(500);
    expect(invoice.lines[0].customerPayable).toBe(0);

    // Line 1 (Color): not covered
    expect(invoice.lines[1].unitPrice).toBe(1500);
    expect(invoice.lines[1].isCoveredBySubscription).toBe(false);
    expect(invoice.lines[1].subscriptionCoveredAmount).toBe(0);
    expect(invoice.lines[1].customerPayable).toBe(1500);

    // Invoice Totals
    expect(invoice.subtotal).toBe(2000);
    expect(invoice.subscriptionCoveredAmount).toBe(500);
    expect(invoice.grossPayable).toBe(2000);
    expect(invoice.payableAmount).toBe(1500); // 2000 - 500
    expect(invoice.amountDue).toBe(1500);
  });

  it("5. discount is not double-counted between appointment and invoice", async () => {
    // Appointment has discount: 100. Subtotal: 2000. Total: 1900.
    const apt = await createTestAppointment({
      pricing: { subtotal: 2000, discount: 100, total: 1900 },
    });

    const res = await request(app)
      .post("/api/v1/billing/invoices")
      .set("Authorization", `Bearer ${ownerTokenA}`)
      .set("X-Branch-Id", branchA1Id.toString())
      .send({ appointmentId: apt._id.toString() });

    expect(res.status).toBe(201);
    // Verified calculation: subtotal (2000) - discount (100) = grossPayable (1900).
    // NOT (1900 - 100 = 1800).
    expect(res.body.data.subtotal).toBe(2000);
    expect(res.body.data.discountTotal).toBe(100);
    expect(res.body.data.grossPayable).toBe(1900);
    expect(res.body.data.payableAmount).toBe(1900);
  });

  it("6. updates discount on draft invoice and recalculates totals correctly", async () => {
    const apt = await createTestAppointment();
    const createRes = await request(app)
      .post("/api/v1/billing/invoices")
      .set("Authorization", `Bearer ${ownerTokenA}`)
      .set("X-Branch-Id", branchA1Id.toString())
      .send({ appointmentId: apt._id.toString() });

    const invoiceId = createRes.body.data._id;

    // Update discount to 300
    const updateRes = await request(app)
      .patch(`/api/v1/billing/invoices/${invoiceId}`)
      .set("Authorization", `Bearer ${ownerTokenA}`)
      .set("X-Branch-Id", branchA1Id.toString())
      .send({
        discountTotal: 300,
        notes: "Loyalty concession added by cashier",
      });

    expect(updateRes.status).toBe(200);
    const updated = updateRes.body.data;
    expect(updated.discountTotal).toBe(300);
    expect(updated.grossPayable).toBe(1700); // 2000 - 300
    expect(updated.payableAmount).toBe(1700);
    expect(updated.amountDue).toBe(1700);
    expect(updated.notes).toBe("Loyalty concession added by cashier");

    // Strict validation: Reject modifying unauthorized fields like customerId or lines
    const invalidUpdateRes = await request(app)
      .patch(`/api/v1/billing/invoices/${invoiceId}`)
      .set("Authorization", `Bearer ${ownerTokenA}`)
      .set("X-Branch-Id", branchA1Id.toString())
      .send({
        customerId: new mongoose.Types.ObjectId(),
      });
    expect(invalidUpdateRes.status).toBe(400);
  });

  it("7. finalized invoice rejects draft modifications", async () => {
    const apt = await createTestAppointment();
    const createRes = await request(app)
      .post("/api/v1/billing/invoices")
      .set("Authorization", `Bearer ${ownerTokenA}`)
      .set("X-Branch-Id", branchA1Id.toString())
      .send({ appointmentId: apt._id.toString() });

    const invoiceId = createRes.body.data._id;

    // Finalize invoice
    const finRes = await request(app)
      .post(`/api/v1/billing/invoices/${invoiceId}/finalize`)
      .set("Authorization", `Bearer ${ownerTokenA}`)
      .set("X-Branch-Id", branchA1Id.toString())
      .send();

    expect(finRes.status).toBe(200);
    expect(finRes.body.data.status).toBe("finalized");
    expect(finRes.body.data.finalizedAt).toBeDefined();

    // Attempt to modify finalized invoice
    const patchRes = await request(app)
      .patch(`/api/v1/billing/invoices/${invoiceId}`)
      .set("Authorization", `Bearer ${ownerTokenA}`)
      .set("X-Branch-Id", branchA1Id.toString())
      .send({ discountTotal: 500 });

    expect(patchRes.status).toBe(400);
    expect(patchRes.body.message).toMatch(/Only draft invoices may be modified/);
  });

  it("8. duplicate active invoice creation for same appointment is prevented", async () => {
    const apt = await createTestAppointment();

    // First invoice
    const res1 = await request(app)
      .post("/api/v1/billing/invoices")
      .set("Authorization", `Bearer ${ownerTokenA}`)
      .set("X-Branch-Id", branchA1Id.toString())
      .send({ appointmentId: apt._id.toString() });
    expect(res1.status).toBe(201);

    // Second invoice attempt
    const res2 = await request(app)
      .post("/api/v1/billing/invoices")
      .set("Authorization", `Bearer ${ownerTokenA}`)
      .set("X-Branch-Id", branchA1Id.toString())
      .send({ appointmentId: apt._id.toString() });

    expect(res2.status).toBe(400);
    expect(res2.body.message).toMatch(/active invoice/i);
  });

  it("9. cancelled invoice releases appointment uniqueness guard allowing re-invoicing", async () => {
    const apt = await createTestAppointment();

    // Create draft invoice
    const res1 = await request(app)
      .post("/api/v1/billing/invoices")
      .set("Authorization", `Bearer ${ownerTokenA}`)
      .set("X-Branch-Id", branchA1Id.toString())
      .send({ appointmentId: apt._id.toString() });
    const invoiceId = res1.body.data._id;

    // Cancel invoice
    const cancelRes = await request(app)
      .post(`/api/v1/billing/invoices/${invoiceId}/cancel`)
      .set("Authorization", `Bearer ${ownerTokenA}`)
      .set("X-Branch-Id", branchA1Id.toString())
      .send({ reason: "Customer changed billing preference" });
    expect(cancelRes.status).toBe(200);
    expect(cancelRes.body.data.status).toBe("cancelled");

    // Re-create invoice for same appointment now succeeds!
    const res2 = await request(app)
      .post("/api/v1/billing/invoices")
      .set("Authorization", `Bearer ${ownerTokenA}`)
      .set("X-Branch-Id", branchA1Id.toString())
      .send({ appointmentId: apt._id.toString() });
    expect(res2.status).toBe(201);
  });

  it("10. rejects payment recording against a draft invoice", async () => {
    const apt = await createTestAppointment();
    const createRes = await request(app)
      .post("/api/v1/billing/invoices")
      .set("Authorization", `Bearer ${ownerTokenA}`)
      .set("X-Branch-Id", branchA1Id.toString())
      .send({ appointmentId: apt._id.toString() });
    const invoiceId = createRes.body.data._id;

    // Payment on draft
    const payRes = await request(app)
      .post(`/api/v1/billing/invoices/${invoiceId}/payments`)
      .set("Authorization", `Bearer ${ownerTokenA}`)
      .set("X-Branch-Id", branchA1Id.toString())
      .send({
        amount: 500,
        method: "cash",
      });

    expect(payRes.status).toBe(400);
    expect(payRes.body.message).toMatch(/Must be 'finalized'/);
  });

  it("11. supports partial payments, multiple payments, and exact full settlement", async () => {
    const apt = await createTestAppointment();
    const createRes = await request(app)
      .post("/api/v1/billing/invoices")
      .set("Authorization", `Bearer ${ownerTokenA}`)
      .set("X-Branch-Id", branchA1Id.toString())
      .send({ appointmentId: apt._id.toString() });
    const invoiceId = createRes.body.data._id;

    // Finalize
    await request(app)
      .post(`/api/v1/billing/invoices/${invoiceId}/finalize`)
      .set("Authorization", `Bearer ${ownerTokenA}`)
      .set("X-Branch-Id", branchA1Id.toString())
      .send();

    // 1. First partial payment: ₹1000 via Card
    const pay1 = await request(app)
      .post(`/api/v1/billing/invoices/${invoiceId}/payments`)
      .set("Authorization", `Bearer ${ownerTokenA}`)
      .set("X-Branch-Id", branchA1Id.toString())
      .send({
        amount: 1000,
        method: "card",
        referenceNote: "Swipe slip #4901",
      });

    expect(pay1.status).toBe(201);
    expect(pay1.body.data.invoice.amountPaid).toBe(1000);
    expect(pay1.body.data.invoice.amountDue).toBe(900);
    expect(pay1.body.data.invoice.paymentStatus).toBe("partially_paid");
    expect(pay1.body.data.payment.paymentNumber).toMatch(/^PAY-\d{8}-\d{4}$/);

    // 2. Second partial payment: ₹500 via UPI
    const pay2 = await request(app)
      .post(`/api/v1/billing/invoices/${invoiceId}/payments`)
      .set("Authorization", `Bearer ${ownerTokenA}`)
      .set("X-Branch-Id", branchA1Id.toString())
      .send({
        amount: 500,
        method: "upi",
        referenceNote: "GPay UPI txn 91823",
      });

    expect(pay2.status).toBe(201);
    expect(pay2.body.data.invoice.amountPaid).toBe(1500);
    expect(pay2.body.data.invoice.amountDue).toBe(400);
    expect(pay2.body.data.invoice.paymentStatus).toBe("partially_paid");

    // 3. Final payment: Remaining ₹400 via Cash
    const pay3 = await request(app)
      .post(`/api/v1/billing/invoices/${invoiceId}/payments`)
      .set("Authorization", `Bearer ${ownerTokenA}`)
      .set("X-Branch-Id", branchA1Id.toString())
      .send({
        amount: 400,
        method: "cash",
      });

    expect(pay3.status).toBe(201);
    expect(pay3.body.data.invoice.amountPaid).toBe(1900);
    expect(pay3.body.data.invoice.amountDue).toBe(0);
    expect(pay3.body.data.invoice.paymentStatus).toBe("paid");

    // Fetch invoice details and payments list
    const getRes = await request(app)
      .get(`/api/v1/billing/invoices/${invoiceId}`)
      .set("Authorization", `Bearer ${ownerTokenA}`)
      .set("X-Branch-Id", branchA1Id.toString());

    expect(getRes.status).toBe(200);
    expect(getRes.body.data.invoice.paymentStatus).toBe("paid");
    expect(getRes.body.data.payments).toHaveLength(3);
  });

  it("12. overpayment, zero, and negative payments are strictly rejected", async () => {
    const apt = await createTestAppointment();
    const createRes = await request(app)
      .post("/api/v1/billing/invoices")
      .set("Authorization", `Bearer ${ownerTokenA}`)
      .set("X-Branch-Id", branchA1Id.toString())
      .send({ appointmentId: apt._id.toString() });
    const invoiceId = createRes.body.data._id;

    await request(app)
      .post(`/api/v1/billing/invoices/${invoiceId}/finalize`)
      .set("Authorization", `Bearer ${ownerTokenA}`)
      .set("X-Branch-Id", branchA1Id.toString())
      .send();

    // 1. Zero payment
    const zeroRes = await request(app)
      .post(`/api/v1/billing/invoices/${invoiceId}/payments`)
      .set("Authorization", `Bearer ${ownerTokenA}`)
      .set("X-Branch-Id", branchA1Id.toString())
      .send({ amount: 0, method: "cash" });
    expect(zeroRes.status).toBe(400);

    // 2. Negative payment
    const negRes = await request(app)
      .post(`/api/v1/billing/invoices/${invoiceId}/payments`)
      .set("Authorization", `Bearer ${ownerTokenA}`)
      .set("X-Branch-Id", branchA1Id.toString())
      .send({ amount: -150, method: "cash" });
    expect(negRes.status).toBe(400);

    // 3. Overpayment (Amount due is 1900; attempting 2000)
    const overRes = await request(app)
      .post(`/api/v1/billing/invoices/${invoiceId}/payments`)
      .set("Authorization", `Bearer ${ownerTokenA}`)
      .set("X-Branch-Id", branchA1Id.toString())
      .send({ amount: 2000, method: "cash" });
    expect(overRes.status).toBe(400);
    expect(overRes.body.message).toMatch(/exceeds outstanding balance/);
  });

  it("13. payment void reverses invoice balance and recalculates paymentStatus without deleting payment document", async () => {
    const apt = await createTestAppointment();
    const createRes = await request(app)
      .post("/api/v1/billing/invoices")
      .set("Authorization", `Bearer ${ownerTokenA}`)
      .set("X-Branch-Id", branchA1Id.toString())
      .send({ appointmentId: apt._id.toString() });
    const invoiceId = createRes.body.data._id;

    await request(app)
      .post(`/api/v1/billing/invoices/${invoiceId}/finalize`)
      .set("Authorization", `Bearer ${ownerTokenA}`)
      .set("X-Branch-Id", branchA1Id.toString())
      .send();

    // Pay ₹1900 in full
    const payRes = await request(app)
      .post(`/api/v1/billing/invoices/${invoiceId}/payments`)
      .set("Authorization", `Bearer ${ownerTokenA}`)
      .set("X-Branch-Id", branchA1Id.toString())
      .send({ amount: 1900, method: "upi" });
    expect(payRes.body.data.invoice.paymentStatus).toBe("paid");
    const paymentId = payRes.body.data.payment._id;

    // Void the payment
    const voidRes = await request(app)
      .post(`/api/v1/billing/payments/${paymentId}/void`)
      .set("Authorization", `Bearer ${ownerTokenA}`)
      .set("X-Branch-Id", branchA1Id.toString())
      .send({ reason: "Customer transaction cancelled by bank" });

    expect(voidRes.status).toBe(200);
    expect(voidRes.body.data.payment.status).toBe("voided");
    expect(voidRes.body.data.payment.voidReason).toBe("Customer transaction cancelled by bank");

    // Reconciled invoice balance
    expect(voidRes.body.data.invoice.amountPaid).toBe(0);
    expect(voidRes.body.data.invoice.amountDue).toBe(1900);
    expect(voidRes.body.data.invoice.paymentStatus).toBe("unpaid");

    // Payment still exists in database
    const savedPayment = await Payment.findById(paymentId);
    expect(savedPayment).not.toBeNull();
    expect(savedPayment.status).toBe("voided");
  });

  it("14. invoice cancellation with recorded payments is strictly rejected", async () => {
    const apt = await createTestAppointment();
    const createRes = await request(app)
      .post("/api/v1/billing/invoices")
      .set("Authorization", `Bearer ${ownerTokenA}`)
      .set("X-Branch-Id", branchA1Id.toString())
      .send({ appointmentId: apt._id.toString() });
    const invoiceId = createRes.body.data._id;

    await request(app)
      .post(`/api/v1/billing/invoices/${invoiceId}/finalize`)
      .set("Authorization", `Bearer ${ownerTokenA}`)
      .set("X-Branch-Id", branchA1Id.toString())
      .send();

    // Pay partial ₹500
    await request(app)
      .post(`/api/v1/billing/invoices/${invoiceId}/payments`)
      .set("Authorization", `Bearer ${ownerTokenA}`)
      .set("X-Branch-Id", branchA1Id.toString())
      .send({ amount: 500, method: "cash" });

    // Try to cancel
    const cancelRes = await request(app)
      .post(`/api/v1/billing/invoices/${invoiceId}/cancel`)
      .set("Authorization", `Bearer ${ownerTokenA}`)
      .set("X-Branch-Id", branchA1Id.toString())
      .send({ reason: "Wrong invoice created" });

    expect(cancelRes.status).toBe(400);
    expect(cancelRes.body.message).toMatch(/Cannot cancel an invoice with recorded payments/);
  });

  it("15. organization isolation: Organization B cannot view or mutate Organization A invoice", async () => {
    const apt = await createTestAppointment();
    const createRes = await request(app)
      .post("/api/v1/billing/invoices")
      .set("Authorization", `Bearer ${ownerTokenA}`)
      .set("X-Branch-Id", branchA1Id.toString())
      .send({ appointmentId: apt._id.toString() });
    const invoiceId = createRes.body.data._id;

    // Org B owner tries to fetch Org A's invoice
    const getRes = await request(app)
      .get(`/api/v1/billing/invoices/${invoiceId}`)
      .set("Authorization", `Bearer ${ownerTokenB}`)
      .set("X-Branch-Id", branchB1Id.toString());

    expect(getRes.status).toBe(404);

    // Org B owner tries to record payment on Org A's invoice
    const payRes = await request(app)
      .post(`/api/v1/billing/invoices/${invoiceId}/payments`)
      .set("Authorization", `Bearer ${ownerTokenB}`)
      .set("X-Branch-Id", branchB1Id.toString())
      .send({ amount: 100, method: "cash" });

    expect(payRes.status).toBe(404);
  });

  it("16. branch isolation: staff restricted to Branch A1 cannot bill or pay for Branch A2", async () => {
    // Appointment in Branch A2
    const aptA2 = await createTestAppointment({ branchId: branchA2Id });

    // Branch A1 staff tries to create invoice in Branch A2
    const res = await request(app)
      .post("/api/v1/billing/invoices")
      .set("Authorization", `Bearer ${branchUserTokenA}`)
      .set("X-Branch-Id", branchA2Id.toString())
      .send({ appointmentId: aptA2._id.toString() });

    expect(res.status).toBe(403);
    expect(res.body.message).toMatch(/Access denied/);
  });

  it("17. rejects mutation requests with X-Branch-Id: all", async () => {
    const apt = await createTestAppointment();

    const res = await request(app)
      .post("/api/v1/billing/invoices")
      .set("Authorization", `Bearer ${ownerTokenA}`)
      .set("X-Branch-Id", "all")
      .send({ appointmentId: apt._id.toString() });

    expect(res.status).toBe(400);
    expect(res.body.message).toMatch(/branchId .* is required for this mutation/);
  });

  it("18. RBAC and unauthenticated protection", async () => {
    const apt = await createTestAppointment();

    // 1. Unauthenticated request
    const unauthRes = await request(app)
      .post("/api/v1/billing/invoices")
      .send({ appointmentId: apt._id.toString() });
    expect(unauthRes.status).toBe(401);

    // 2. User missing billing.checkout permission
    const noPermRole = await Role.create({
      name: `no_perm_${Date.now()}`,
      description: "Empty Role",
      permissions: [],
    });
    const lowPermUser = await User.create({
      name: "Low Perm User",
      email: `low_${Date.now()}@test.com`,
      phone: "+919999990099",
      password: "Password@123",
      role: noPermRole._id,
      organizationId: orgAId,
      status: "active",
      hasOrgWideAccess: true,
      branchAccess: [{ branchId: branchA1Id, branchName: "Branch A1", isActive: true }],
    });
    const lowPermToken = jwt.sign({ id: lowPermUser._id, role: "cleaner" }, env.JWT_SECRET, { expiresIn: "1h" });

    const forbidRes = await request(app)
      .post("/api/v1/billing/invoices")
      .set("Authorization", `Bearer ${lowPermToken}`)
      .set("X-Branch-Id", branchA1Id.toString())
      .send({ appointmentId: apt._id.toString() });

    expect(forbidRes.status).toBe(403);
  });

  it("19. ABSOLUTE VERIFICATION: NO TAX / NO GST fields anywhere in responses, models, or calculations", async () => {
    const apt = await createTestAppointment();

    const res = await request(app)
      .post("/api/v1/billing/invoices")
      .set("Authorization", `Bearer ${ownerTokenA}`)
      .set("X-Branch-Id", branchA1Id.toString())
      .send({ appointmentId: apt._id.toString() });

    expect(res.status).toBe(201);
    const invoice = res.body.data;

    // Stringify entire response JSON to inspect for tax/gst keys
    const jsonStr = JSON.stringify(invoice);
    expect(jsonStr).not.toMatch(/tax/i);
    expect(jsonStr).not.toMatch(/gst/i);
    expect(jsonStr).not.toMatch(/cgst/i);
    expect(jsonStr).not.toMatch(/sgst/i);
    expect(jsonStr).not.toMatch(/igst/i);

    expect(invoice.taxRate).toBeUndefined();
    expect(invoice.taxAmount).toBeUndefined();
    expect(invoice.taxableAmount).toBeUndefined();
    expect(invoice.lines[0].taxRate).toBeUndefined();
    expect(invoice.lines[0].taxAmount).toBeUndefined();
  });

  it("20. invoice fully covered by subscription has payableAmount = 0, amountDue = 0, paymentStatus = 'paid' upon finalization, and no Payment record created", async () => {
    const dummySubId = new mongoose.Types.ObjectId();
    const dummyUsageId = new mongoose.Types.ObjectId();

    // Both haircut and color fully covered by subscription
    const apt = await createTestAppointment({
      services: [
        {
          serviceId: serviceHaircut._id,
          name: serviceHaircut.name,
          duration: 30,
          price: 500,
          isRedeemedViaSubscription: true,
          appliedSubscriptionId: dummySubId,
          subscriptionUsageId: dummyUsageId,
        },
        {
          serviceId: serviceColor._id,
          name: serviceColor.name,
          duration: 60,
          price: 1500,
          isRedeemedViaSubscription: true,
          appliedSubscriptionId: dummySubId,
          subscriptionUsageId: dummyUsageId,
        },
      ],
      pricing: { subtotal: 2000, discount: 0, total: 2000 },
    });

    const createRes = await request(app)
      .post("/api/v1/billing/invoices")
      .set("Authorization", `Bearer ${ownerTokenA}`)
      .set("X-Branch-Id", branchA1Id.toString())
      .send({ appointmentId: apt._id.toString() });

    expect(createRes.status).toBe(201);
    const draftInvoice = createRes.body.data;
    expect(draftInvoice.subtotal).toBe(2000);
    expect(draftInvoice.subscriptionCoveredAmount).toBe(2000);
    expect(draftInvoice.payableAmount).toBe(0);
    expect(draftInvoice.amountPaid).toBe(0);
    expect(draftInvoice.amountDue).toBe(0);
    expect(draftInvoice.paymentStatus).toBe("paid"); // zero-balance invoice is paid

    // Finalize invoice
    const finRes = await request(app)
      .post(`/api/v1/billing/invoices/${draftInvoice._id}/finalize`)
      .set("Authorization", `Bearer ${ownerTokenA}`)
      .set("X-Branch-Id", branchA1Id.toString())
      .send();

    expect(finRes.status).toBe(200);
    const finalizedInvoice = finRes.body.data;
    expect(finalizedInvoice.status).toBe("finalized");
    expect(finalizedInvoice.payableAmount).toBe(0);
    expect(finalizedInvoice.amountPaid).toBe(0);
    expect(finalizedInvoice.amountDue).toBe(0);
    expect(finalizedInvoice.paymentStatus).toBe("paid");

    // Verify NO Payment document was created
    const payments = await Payment.find({ invoiceId: finalizedInvoice._id });
    expect(payments).toHaveLength(0);
  });

  it("21. invoice with discount reducing payable amount to zero has paymentStatus = 'paid'", async () => {
    // Subtotal 2000, 100% discount of 2000
    const apt = await createTestAppointment({
      pricing: { subtotal: 2000, discount: 2000, total: 0 },
    });

    const createRes = await request(app)
      .post("/api/v1/billing/invoices")
      .set("Authorization", `Bearer ${ownerTokenA}`)
      .set("X-Branch-Id", branchA1Id.toString())
      .send({ appointmentId: apt._id.toString() });

    expect(createRes.status).toBe(201);
    const draftInvoice = createRes.body.data;
    expect(draftInvoice.subtotal).toBe(2000);
    expect(draftInvoice.discountTotal).toBe(2000);
    expect(draftInvoice.payableAmount).toBe(0);
    expect(draftInvoice.amountDue).toBe(0);
    expect(draftInvoice.paymentStatus).toBe("paid");

    // Finalize
    const finRes = await request(app)
      .post(`/api/v1/billing/invoices/${draftInvoice._id}/finalize`)
      .set("Authorization", `Bearer ${ownerTokenA}`)
      .set("X-Branch-Id", branchA1Id.toString())
      .send();

    expect(finRes.status).toBe(200);
    expect(finRes.body.data.status).toBe("finalized");
    expect(finRes.body.data.payableAmount).toBe(0);
    expect(finRes.body.data.amountDue).toBe(0);
    expect(finRes.body.data.paymentStatus).toBe("paid");

    // Ensure no manual payment record exists
    const payments = await Payment.find({ invoiceId: draftInvoice._id });
    expect(payments).toHaveLength(0);
  });

  it("22. draft discount update reducing payableAmount to 0 updates paymentStatus to 'paid', and restoring positive balance sets 'unpaid'", async () => {
    const apt = await createTestAppointment({
      pricing: { subtotal: 2000, discount: 0, total: 2000 },
    });

    const createRes = await request(app)
      .post("/api/v1/billing/invoices")
      .set("Authorization", `Bearer ${ownerTokenA}`)
      .set("X-Branch-Id", branchA1Id.toString())
      .send({ appointmentId: apt._id.toString() });

    const invoiceId = createRes.body.data._id;
    expect(createRes.body.data.paymentStatus).toBe("unpaid");

    // 1. Set full discount (2000)
    const patchRes1 = await request(app)
      .patch(`/api/v1/billing/invoices/${invoiceId}`)
      .set("Authorization", `Bearer ${ownerTokenA}`)
      .set("X-Branch-Id", branchA1Id.toString())
      .send({ discountTotal: 2000 });

    expect(patchRes1.status).toBe(200);
    expect(patchRes1.body.data.amountDue).toBe(0);
    expect(patchRes1.body.data.paymentStatus).toBe("paid");

    // 2. Reduce discount to 500 (amountDue becomes 1500)
    const patchRes2 = await request(app)
      .patch(`/api/v1/billing/invoices/${invoiceId}`)
      .set("Authorization", `Bearer ${ownerTokenA}`)
      .set("X-Branch-Id", branchA1Id.toString())
      .send({ discountTotal: 500 });

    expect(patchRes2.status).toBe(200);
    expect(patchRes2.body.data.amountDue).toBe(1500);
    expect(patchRes2.body.data.paymentStatus).toBe("unpaid");
  });

  it("23. supports payment recording using paymentMethod alias (e.g. paymentMethod: 'cash')", async () => {
    const apt = await createTestAppointment({
      services: [
        {
          serviceId: serviceHaircut._id,
          name: serviceHaircut.name,
          duration: 30,
          price: 1000,
          isRedeemedViaSubscription: false,
        },
      ],
      pricing: { subtotal: 1000, discount: 0, total: 1000 },
    });

    const createRes = await request(app)
      .post("/api/v1/billing/invoices")
      .set("Authorization", `Bearer ${ownerTokenA}`)
      .set("X-Branch-Id", branchA1Id.toString())
      .send({ appointmentId: apt._id.toString() });

    const invoiceId = createRes.body.data._id;

    // Finalize invoice
    await request(app)
      .post(`/api/v1/billing/invoices/${invoiceId}/finalize`)
      .set("Authorization", `Bearer ${ownerTokenA}`)
      .set("X-Branch-Id", branchA1Id.toString())
      .send();

    // Record payment with paymentMethod instead of method
    const payRes = await request(app)
      .post(`/api/v1/billing/invoices/${invoiceId}/payments`)
      .set("Authorization", `Bearer ${ownerTokenA}`)
      .set("X-Branch-Id", branchA1Id.toString())
      .send({
        amount: 1000,
        paymentMethod: "cash",
        referenceNote: "Cash at desk",
        branchId: branchA1Id.toString(),
      });

    expect(payRes.status).toBe(201);
    expect(payRes.body.data.invoice.amountPaid).toBe(1000);
    expect(payRes.body.data.invoice.amountDue).toBe(0);
    expect(payRes.body.data.invoice.paymentStatus).toBe("paid");
    expect(payRes.body.data.payment.method).toBe("cash");
  });

  it("24. generates production-grade invoice PDF stream with appropriate headers, layout, and branch isolation", async () => {
    const apt = await createTestAppointment();

    // 1. Create draft invoice
    const createRes = await request(app)
      .post("/api/v1/billing/invoices")
      .set("Authorization", `Bearer ${ownerTokenA}`)
      .set("X-Branch-Id", branchA1Id.toString())
      .send({ appointmentId: apt._id.toString() });

    expect(createRes.status).toBe(201);
    const invoiceId = createRes.body.data._id;

    // 2. Fetch PDF for draft invoice
    const draftPdfRes = await request(app)
      .get(`/api/v1/billing/invoices/${invoiceId}/pdf`)
      .set("Authorization", `Bearer ${ownerTokenA}`)
      .set("X-Branch-Id", branchA1Id.toString());

    expect(draftPdfRes.status).toBe(200);
    expect(draftPdfRes.headers["content-type"]).toBe("application/pdf");
    expect(draftPdfRes.headers["content-disposition"]).toMatch(/inline; filename="INV-.*\.pdf"/);
    expect(draftPdfRes.headers["cache-control"]).toBe("private, no-cache, no-store, must-revalidate");
    expect(draftPdfRes.body.length).toBeGreaterThan(1000);
    // Check PDF magic bytes '%PDF'
    const draftHeader = draftPdfRes.body.slice(0, 4).toString();
    expect(draftHeader).toBe("%PDF");

    // 3. Finalize invoice and record payment
    await request(app)
      .post(`/api/v1/billing/invoices/${invoiceId}/finalize`)
      .set("Authorization", `Bearer ${ownerTokenA}`)
      .set("X-Branch-Id", branchA1Id.toString())
      .send();

    await request(app)
      .post(`/api/v1/billing/invoices/${invoiceId}/payments`)
      .set("Authorization", `Bearer ${ownerTokenA}`)
      .set("X-Branch-Id", branchA1Id.toString())
      .send({
        amount: 1900,
        method: "cash",
        referenceNote: "Settled in full",
      });

    // 4. Fetch PDF for finalized & paid invoice
    const finalizedPdfRes = await request(app)
      .get(`/api/v1/billing/invoices/${invoiceId}/pdf`)
      .set("Authorization", `Bearer ${ownerTokenA}`)
      .set("X-Branch-Id", branchA1Id.toString());

    expect(finalizedPdfRes.status).toBe(200);
    expect(finalizedPdfRes.headers["content-type"]).toBe("application/pdf");
    expect(finalizedPdfRes.headers["cache-control"]).toBe("private, max-age=86400, immutable");
    expect(finalizedPdfRes.body.slice(0, 4).toString()).toBe("%PDF");

    // 5. Multi-tenancy & Isolation guards
    // Org B cannot access Org A invoice PDF
    const orgBRes = await request(app)
      .get(`/api/v1/billing/invoices/${invoiceId}/pdf`)
      .set("Authorization", `Bearer ${ownerTokenB}`)
      .set("X-Branch-Id", branchB1Id.toString());

    expect(orgBRes.status).toBe(404);

    // Non-existent ID returns 404
    const fakeId = new mongoose.Types.ObjectId();
    const notFoundRes = await request(app)
      .get(`/api/v1/billing/invoices/${fakeId}/pdf`)
      .set("Authorization", `Bearer ${ownerTokenA}`)
      .set("X-Branch-Id", branchA1Id.toString());

    expect(notFoundRes.status).toBe(404);
  });

  it("25. GET /billing/invoices returns aggregate summary in meta.summary when filtering by customerId", async () => {
    // Create customer specific to this test
    const targetCustomer = await Customer.create({
      name: "Summary Test Customer",
      phone: "+919888877777",
      email: "summary_test@example.com",
      gender: "female",
      homeBranchId: branchA1Id,
      organizationId: orgAId,
      status: "active",
    });

    // Invoice 1: finalized, payableAmount 1500, paid 1500, amountDue 0
    const apt1 = await createTestAppointment({ customerId: targetCustomer._id, totalAmount: 1500 });
    const inv1Res = await request(app)
      .post("/api/v1/billing/invoices")
      .set("Authorization", `Bearer ${ownerTokenA}`)
      .set("X-Branch-Id", branchA1Id.toString())
      .send({ appointmentId: apt1._id.toString() });
    const inv1Id = inv1Res.body.data._id;
    await request(app)
      .post(`/api/v1/billing/invoices/${inv1Id}/finalize`)
      .set("Authorization", `Bearer ${ownerTokenA}`)
      .set("X-Branch-Id", branchA1Id.toString());
    await request(app)
      .post(`/api/v1/billing/invoices/${inv1Id}/payments`)
      .set("Authorization", `Bearer ${ownerTokenA}`)
      .set("X-Branch-Id", branchA1Id.toString())
      .send({ amount: 1500, method: "cash" });

    // Invoice 2: finalized, payableAmount 2000, partially paid 500, amountDue 1500
    const apt2 = await createTestAppointment({ customerId: targetCustomer._id, totalAmount: 2000 });
    const inv2Res = await request(app)
      .post("/api/v1/billing/invoices")
      .set("Authorization", `Bearer ${ownerTokenA}`)
      .set("X-Branch-Id", branchA1Id.toString())
      .send({ appointmentId: apt2._id.toString() });
    const inv2Id = inv2Res.body.data._id;
    await request(app)
      .post(`/api/v1/billing/invoices/${inv2Id}/finalize`)
      .set("Authorization", `Bearer ${ownerTokenA}`)
      .set("X-Branch-Id", branchA1Id.toString());
    await request(app)
      .post(`/api/v1/billing/invoices/${inv2Id}/payments`)
      .set("Authorization", `Bearer ${ownerTokenA}`)
      .set("X-Branch-Id", branchA1Id.toString())
      .send({ amount: 500, method: "upi" });

    // Fetch invoices filtering by customerId with pagination (e.g. limit=1)
    const listRes = await request(app)
      .get(`/api/v1/billing/invoices?customerId=${targetCustomer._id.toString()}&page=1&limit=1`)
      .set("Authorization", `Bearer ${ownerTokenA}`)
      .set("X-Branch-Id", branchA1Id.toString());

    expect(listRes.status).toBe(200);
    expect(listRes.body.success).toBe(true);
    expect(listRes.body.status).toBe("success");
    expect(listRes.body.data).toHaveLength(1);
    expect(listRes.body.meta).toBeDefined();
    expect(listRes.body.meta.total).toBe(2);
    expect(listRes.body.meta.page).toBe(1);
    expect(listRes.body.meta.limit).toBe(1);
    expect(listRes.body.meta.totalPages).toBe(2);
    expect(listRes.body.meta.summary).toEqual({
      totalInvoices: 2,
      totalBilled: 3800,
      totalPaid: 2000,
      totalOutstanding: 1800,
    });

    // Also check when filtering for a customer with 0 invoices
    const emptyCustomer = await Customer.create({
      name: "Empty Invoices Customer",
      phone: "+919666655555",
      gender: "male",
      homeBranchId: branchA1Id,
      organizationId: orgAId,
      status: "active",
    });

    const emptyRes = await request(app)
      .get(`/api/v1/billing/invoices?customerId=${emptyCustomer._id.toString()}`)
      .set("Authorization", `Bearer ${ownerTokenA}`)
      .set("X-Branch-Id", branchA1Id.toString());

    expect(emptyRes.status).toBe(200);
    expect(emptyRes.body.data).toEqual([]);
    expect(emptyRes.body.meta.total).toBe(0);
    expect(emptyRes.body.meta.summary).toEqual({
      totalInvoices: 0,
      totalBilled: 0,
      totalPaid: 0,
      totalOutstanding: 0,
    });
  });

  it("26. GET /billing/invoices summary honors subscription-coverage, mixed payment statuses, soft-deletes, branch & org isolation, and requests without customerId", async () => {
    const cust = await Customer.create({
      name: "Isolation & Subscription Customer",
      phone: "+919555544444",
      gender: "female",
      homeBranchId: branchA1Id,
      organizationId: orgAId,
      status: "active",
    });

    const dummySubId = new mongoose.Types.ObjectId();
    const dummyUsageId = new mongoose.Types.ObjectId();

    // 1. Subscription-covered invoice in Branch A1: payableAmount=0, amountPaid=0, amountDue=0
    const aptSub = await createTestAppointment({
      customerId: cust._id,
      services: [
        {
          serviceId: serviceHaircut._id,
          name: serviceHaircut.name,
          duration: 30,
          price: 500,
          isRedeemedViaSubscription: true,
          appliedSubscriptionId: dummySubId,
          subscriptionUsageId: dummyUsageId,
        },
      ],
      pricing: { subtotal: 500, discount: 0, total: 500 },
    });
    const invSubRes = await request(app)
      .post("/api/v1/billing/invoices")
      .set("Authorization", `Bearer ${ownerTokenA}`)
      .set("X-Branch-Id", branchA1Id.toString())
      .send({ appointmentId: aptSub._id.toString() });
    const invSubId = invSubRes.body.data._id;
    await request(app)
      .post(`/api/v1/billing/invoices/${invSubId}/finalize`)
      .set("Authorization", `Bearer ${ownerTokenA}`)
      .set("X-Branch-Id", branchA1Id.toString());

    // 2. Unpaid invoice in Branch A1: payableAmount=1900, amountPaid=0, amountDue=1900
    const aptUnpaid = await createTestAppointment({ customerId: cust._id });
    const invUnpaidRes = await request(app)
      .post("/api/v1/billing/invoices")
      .set("Authorization", `Bearer ${ownerTokenA}`)
      .set("X-Branch-Id", branchA1Id.toString())
      .send({ appointmentId: aptUnpaid._id.toString() });
    const invUnpaidId = invUnpaidRes.body.data._id;
    await request(app)
      .post(`/api/v1/billing/invoices/${invUnpaidId}/finalize`)
      .set("Authorization", `Bearer ${ownerTokenA}`)
      .set("X-Branch-Id", branchA1Id.toString());

    // 3. Partially paid invoice in Branch A1: payableAmount=1900, amountPaid=700, amountDue=1200
    const aptPartial = await createTestAppointment({ customerId: cust._id });
    const invPartialRes = await request(app)
      .post("/api/v1/billing/invoices")
      .set("Authorization", `Bearer ${ownerTokenA}`)
      .set("X-Branch-Id", branchA1Id.toString())
      .send({ appointmentId: aptPartial._id.toString() });
    const invPartialId = invPartialRes.body.data._id;
    await request(app)
      .post(`/api/v1/billing/invoices/${invPartialId}/finalize`)
      .set("Authorization", `Bearer ${ownerTokenA}`)
      .set("X-Branch-Id", branchA1Id.toString());
    await request(app)
      .post(`/api/v1/billing/invoices/${invPartialId}/payments`)
      .set("Authorization", `Bearer ${ownerTokenA}`)
      .set("X-Branch-Id", branchA1Id.toString())
      .send({ amount: 700, method: "cash" });

    // 4. Soft-deleted invoice in Branch A1: should NOT be included in summary or list
    const aptDeleted = await createTestAppointment({ customerId: cust._id });
    const invDelRes = await request(app)
      .post("/api/v1/billing/invoices")
      .set("Authorization", `Bearer ${ownerTokenA}`)
      .set("X-Branch-Id", branchA1Id.toString())
      .send({ appointmentId: aptDeleted._id.toString() });
    await Invoice.updateOne({ _id: invDelRes.body.data._id }, { isDeleted: true });

    // 5. Invoice in Branch A2 for same customer: should NOT be included when filtering Branch A1
    const aptBranchA2 = await createTestAppointment({
      customerId: cust._id,
      branchId: branchA2Id,
    });
    const invA2Res = await request(app)
      .post("/api/v1/billing/invoices")
      .set("Authorization", `Bearer ${ownerTokenA}`)
      .set("X-Branch-Id", branchA2Id.toString())
      .send({ appointmentId: aptBranchA2._id.toString() });
    await request(app)
      .post(`/api/v1/billing/invoices/${invA2Res.body.data._id}/finalize`)
      .set("Authorization", `Bearer ${ownerTokenA}`)
      .set("X-Branch-Id", branchA2Id.toString());

    // Check Branch A1 summary: includes (1) Sub (0 billed, 0 paid, 0 due), (2) Unpaid (1900 billed, 0 paid, 1900 due), (3) Partial (1900 billed, 700 paid, 1200 due)
    // Totals: totalInvoices=3, totalBilled=3800, totalPaid=700, totalOutstanding=3100
    const branchA1SummaryRes = await request(app)
      .get(`/api/v1/billing/invoices?customerId=${cust._id.toString()}`)
      .set("Authorization", `Bearer ${ownerTokenA}`)
      .set("X-Branch-Id", branchA1Id.toString());

    expect(branchA1SummaryRes.status).toBe(200);
    expect(branchA1SummaryRes.body.meta.total).toBe(3);
    expect(branchA1SummaryRes.body.meta.summary).toEqual({
      totalInvoices: 3,
      totalBilled: 3800,
      totalPaid: 700,
      totalOutstanding: 3100,
    });

    // Verify Organization Isolation: Org B querying for same customerId gets zero results
    const orgBSummaryRes = await request(app)
      .get(`/api/v1/billing/invoices?customerId=${cust._id.toString()}`)
      .set("Authorization", `Bearer ${ownerTokenB}`)
      .set("X-Branch-Id", branchB1Id.toString());

    expect(orgBSummaryRes.status).toBe(200);
    expect(orgBSummaryRes.body.data).toHaveLength(0);
    expect(orgBSummaryRes.body.meta.total).toBe(0);
    expect(orgBSummaryRes.body.meta.summary).toEqual({
      totalInvoices: 0,
      totalBilled: 0,
      totalPaid: 0,
      totalOutstanding: 0,
    });

    // Verify request WITHOUT customerId preserves response structure without meta.summary
    const noCustomerRes = await request(app)
      .get("/api/v1/billing/invoices?page=1&limit=5")
      .set("Authorization", `Bearer ${ownerTokenA}`)
      .set("X-Branch-Id", branchA1Id.toString());

    expect(noCustomerRes.status).toBe(200);
    expect(noCustomerRes.body.success).toBe(true);
    expect(noCustomerRes.body.status).toBe("success");
    expect(noCustomerRes.body.meta).toBeDefined();
    expect(noCustomerRes.body.meta.summary).toBeUndefined();
    expect(noCustomerRes.body.pagination).toBeDefined();
    expect(noCustomerRes.body.pagination.summary).toBeUndefined();
  });

  it("27. Option B discount allocation: discount applies strictly to uncovered services, preserving subscription value and reconciling line totals with header", async () => {
    const dummySubId = new mongoose.Types.ObjectId();
    const dummyUsageId = new mongoose.Types.ObjectId();

    // 1 covered haircut (₹500), 1 uncovered color (₹1500). Total subtotal = ₹2000.
    // Invoice discount = ₹300.
    const apt = await createTestAppointment({
      services: [
        {
          serviceId: serviceHaircut._id,
          name: serviceHaircut.name,
          duration: 30,
          price: 500,
          isRedeemedViaSubscription: true,
          appliedSubscriptionId: dummySubId,
          subscriptionUsageId: dummyUsageId,
        },
        {
          serviceId: serviceColor._id,
          name: serviceColor.name,
          duration: 60,
          price: 1500,
          isRedeemedViaSubscription: false,
        },
      ],
      pricing: { subtotal: 2000, discount: 300, total: 1700 },
    });

    const res = await request(app)
      .post("/api/v1/billing/invoices")
      .set("Authorization", `Bearer ${ownerTokenA}`)
      .set("X-Branch-Id", branchA1Id.toString())
      .send({ appointmentId: apt._id.toString() });

    expect(res.status).toBe(201);
    const invoice = res.body.data;

    // Header totals
    expect(invoice.subtotal).toBe(2000);
    expect(invoice.discountTotal).toBe(300);
    expect(invoice.grossPayable).toBe(1700);
    expect(invoice.subscriptionCoveredAmount).toBe(500);
    expect(invoice.payableAmount).toBe(1200); // 1500 uncovered - 300 discount
    expect(invoice.amountDue).toBe(1200);

    // Line 0 (Haircut): covered line retains 100% economic coverage, 0 discount, 0 payable
    expect(invoice.lines[0].isCoveredBySubscription).toBe(true);
    expect(invoice.lines[0].subscriptionCoveredAmount).toBe(500);
    expect(invoice.lines[0].discountAmount).toBe(0);
    expect(invoice.lines[0].customerPayable).toBe(0);

    // Line 1 (Color): absorbs the entire ₹300 discount
    expect(invoice.lines[1].isCoveredBySubscription).toBe(false);
    expect(invoice.lines[1].subscriptionCoveredAmount).toBe(0);
    expect(invoice.lines[1].discountAmount).toBe(300);
    expect(invoice.lines[1].customerPayable).toBe(1200);

    // Exact reconciliation check: sum of line-level customerPayable === invoice.payableAmount
    const sumLinePayables = invoice.lines.reduce((acc, l) => acc + l.customerPayable, 0);
    expect(sumLinePayables).toBe(invoice.payableAmount);
  });

  it("28. discount capped at uncovered amount when discount exceeds eligible uncovered total", async () => {
    const dummySubId = new mongoose.Types.ObjectId();
    const dummyUsageId = new mongoose.Types.ObjectId();

    // 1 covered haircut (₹500), 1 uncovered custom service (₹200). Subtotal = ₹700.
    // Desired discount = ₹400 (exceeds uncovered ₹200).
    const apt = await createTestAppointment({
      services: [
        {
          serviceId: serviceHaircut._id,
          name: serviceHaircut.name,
          duration: 30,
          price: 500,
          isRedeemedViaSubscription: true,
          appliedSubscriptionId: dummySubId,
          subscriptionUsageId: dummyUsageId,
        },
        {
          serviceId: serviceColor._id,
          name: serviceColor.name,
          duration: 15,
          price: 200,
          isRedeemedViaSubscription: false,
        },
      ],
      pricing: { subtotal: 700, discount: 400, total: 300 },
    });

    const res = await request(app)
      .post("/api/v1/billing/invoices")
      .set("Authorization", `Bearer ${ownerTokenA}`)
      .set("X-Branch-Id", branchA1Id.toString())
      .send({ appointmentId: apt._id.toString() });

    expect(res.status).toBe(201);
    const invoice = res.body.data;

    // Discount is capped at eligible uncovered total (200), not full 400
    expect(invoice.discountTotal).toBe(200);
    expect(invoice.grossPayable).toBe(500);
    expect(invoice.subscriptionCoveredAmount).toBe(500);
    expect(invoice.payableAmount).toBe(0);
    expect(invoice.amountDue).toBe(0);
    expect(invoice.paymentStatus).toBe("paid");

    expect(invoice.lines[0].customerPayable).toBe(0);
    expect(invoice.lines[1].discountAmount).toBe(200);
    expect(invoice.lines[1].customerPayable).toBe(0);
  });

  it("29. decimal prices and discount allocation rounding reconciliation", async () => {
    // 3 uncovered services with non-round decimal prices
    const apt = await createTestAppointment({
      services: [
        {
          serviceId: serviceHaircut._id,
          name: "Item 1",
          duration: 15,
          price: 33.33,
          isRedeemedViaSubscription: false,
        },
        {
          serviceId: serviceHaircut._id,
          name: "Item 2",
          duration: 15,
          price: 33.33,
          isRedeemedViaSubscription: false,
        },
        {
          serviceId: serviceHaircut._id,
          name: "Item 3",
          duration: 15,
          price: 33.34,
          isRedeemedViaSubscription: false,
        },
      ],
      pricing: { subtotal: 100, discount: 10, total: 90 },
    });

    const res = await request(app)
      .post("/api/v1/billing/invoices")
      .set("Authorization", `Bearer ${ownerTokenA}`)
      .set("X-Branch-Id", branchA1Id.toString())
      .send({ appointmentId: apt._id.toString() });

    expect(res.status).toBe(201);
    const invoice = res.body.data;

    expect(invoice.subtotal).toBe(100);
    expect(invoice.discountTotal).toBe(10);
    expect(invoice.payableAmount).toBe(90);

    const sumDiscountAmounts = Number(invoice.lines.reduce((acc, l) => acc + l.discountAmount, 0).toFixed(2));
    const sumLinePayables = Number(invoice.lines.reduce((acc, l) => acc + l.customerPayable, 0).toFixed(2));

    expect(sumDiscountAmounts).toBe(10);
    expect(sumLinePayables).toBe(90);
  });

  it("30. payment idempotency: identical retry returns original payment without modifying balances", async () => {
    const apt = await createTestAppointment();
    const createRes = await request(app)
      .post("/api/v1/billing/invoices")
      .set("Authorization", `Bearer ${ownerTokenA}`)
      .set("X-Branch-Id", branchA1Id.toString())
      .send({ appointmentId: apt._id.toString() });
    const invoiceId = createRes.body.data._id;

    await request(app)
      .post(`/api/v1/billing/invoices/${invoiceId}/finalize`)
      .set("Authorization", `Bearer ${ownerTokenA}`)
      .set("X-Branch-Id", branchA1Id.toString())
      .send();

    const idempotencyKey = `idemp-key-${Date.now()}`;

    // First attempt
    const pay1 = await request(app)
      .post(`/api/v1/billing/invoices/${invoiceId}/payments`)
      .set("Authorization", `Bearer ${ownerTokenA}`)
      .set("X-Branch-Id", branchA1Id.toString())
      .set("Idempotency-Key", idempotencyKey)
      .send({
        amount: 500,
        method: "cash",
      });

    expect(pay1.status).toBe(201);
    const originalPaymentId = pay1.body.data.payment._id;
    expect(pay1.body.data.invoice.amountPaid).toBe(500);
    expect(pay1.body.data.invoice.amountDue).toBe(1400);

    // Second attempt with exact same key and payload
    const pay2 = await request(app)
      .post(`/api/v1/billing/invoices/${invoiceId}/payments`)
      .set("Authorization", `Bearer ${ownerTokenA}`)
      .set("X-Branch-Id", branchA1Id.toString())
      .set("Idempotency-Key", idempotencyKey)
      .send({
        amount: 500,
        method: "cash",
      });

    expect(pay2.status).toBe(201);
    expect(pay2.body.data.payment._id).toBe(originalPaymentId);
    expect(pay2.body.data.isIdempotentReplay).toBe(true);

    // Balance must NOT have been double-incremented
    expect(pay2.body.data.invoice.amountPaid).toBe(500);
    expect(pay2.body.data.invoice.amountDue).toBe(1400);

    // Verify only ONE Payment document exists in DB
    const count = await Payment.countDocuments({ idempotencyKey });
    expect(count).toBe(1);
  });

  it("31. payment idempotency conflict: reusing same key with different amount or method rejects with 409", async () => {
    const apt = await createTestAppointment();
    const createRes = await request(app)
      .post("/api/v1/billing/invoices")
      .set("Authorization", `Bearer ${ownerTokenA}`)
      .set("X-Branch-Id", branchA1Id.toString())
      .send({ appointmentId: apt._id.toString() });
    const invoiceId = createRes.body.data._id;

    await request(app)
      .post(`/api/v1/billing/invoices/${invoiceId}/finalize`)
      .set("Authorization", `Bearer ${ownerTokenA}`)
      .set("X-Branch-Id", branchA1Id.toString())
      .send();

    const idempotencyKey = `idemp-conflict-${Date.now()}`;

    // First attempt: ₹500 via cash
    const pay1 = await request(app)
      .post(`/api/v1/billing/invoices/${invoiceId}/payments`)
      .set("Authorization", `Bearer ${ownerTokenA}`)
      .set("X-Branch-Id", branchA1Id.toString())
      .set("Idempotency-Key", idempotencyKey)
      .send({
        amount: 500,
        method: "cash",
      });
    expect(pay1.status).toBe(201);

    // Attempt reuse with different amount (₹600)
    const payConflictAmount = await request(app)
      .post(`/api/v1/billing/invoices/${invoiceId}/payments`)
      .set("Authorization", `Bearer ${ownerTokenA}`)
      .set("X-Branch-Id", branchA1Id.toString())
      .set("Idempotency-Key", idempotencyKey)
      .send({
        amount: 600,
        method: "cash",
      });
    expect(payConflictAmount.status).toBe(409);
    expect(payConflictAmount.body.message).toMatch(/Idempotency key reuse with differing payment parameters/);

    // Attempt reuse with different method (card)
    const payConflictMethod = await request(app)
      .post(`/api/v1/billing/invoices/${invoiceId}/payments`)
      .set("Authorization", `Bearer ${ownerTokenA}`)
      .set("X-Branch-Id", branchA1Id.toString())
      .set("Idempotency-Key", idempotencyKey)
      .send({
        amount: 500,
        method: "card",
      });
    expect(payConflictMethod.status).toBe(409);
  });

  it("32. concurrent duplicate payment requests with same key process safely without race condition overpayment", async () => {
    const apt = await createTestAppointment();
    const createRes = await request(app)
      .post("/api/v1/billing/invoices")
      .set("Authorization", `Bearer ${ownerTokenA}`)
      .set("X-Branch-Id", branchA1Id.toString())
      .send({ appointmentId: apt._id.toString() });
    const invoiceId = createRes.body.data._id;

    await request(app)
      .post(`/api/v1/billing/invoices/${invoiceId}/finalize`)
      .set("Authorization", `Bearer ${ownerTokenA}`)
      .set("X-Branch-Id", branchA1Id.toString())
      .send();

    const idempotencyKey = `idemp-race-${Date.now()}`;

    // Fire 2 concurrent requests simultaneously with same idempotency key
    const [res1, res2] = await Promise.all([
      request(app)
        .post(`/api/v1/billing/invoices/${invoiceId}/payments`)
        .set("Authorization", `Bearer ${ownerTokenA}`)
        .set("X-Branch-Id", branchA1Id.toString())
        .set("Idempotency-Key", idempotencyKey)
        .send({ amount: 500, method: "upi" }),
      request(app)
        .post(`/api/v1/billing/invoices/${invoiceId}/payments`)
        .set("Authorization", `Bearer ${ownerTokenA}`)
        .set("X-Branch-Id", branchA1Id.toString())
        .set("Idempotency-Key", idempotencyKey)
        .send({ amount: 500, method: "upi" }),
    ]);

    // Either both succeed (one created, one replayed) or one throws race 409
    const statuses = [res1.status, res2.status].sort();
    expect([[201, 201], [201, 409]]).toContainEqual(statuses);

    const invoice = await Invoice.findById(invoiceId);
    expect(invoice.amountPaid).toBe(500);
    expect(invoice.amountDue).toBe(1400);

    const paymentCount = await Payment.countDocuments({ idempotencyKey });
    expect(paymentCount).toBe(1);
  });

  it("33. legitimate separate partial payments succeed when using distinct idempotency keys", async () => {
    const apt = await createTestAppointment();
    const createRes = await request(app)
      .post("/api/v1/billing/invoices")
      .set("Authorization", `Bearer ${ownerTokenA}`)
      .set("X-Branch-Id", branchA1Id.toString())
      .send({ appointmentId: apt._id.toString() });
    const invoiceId = createRes.body.data._id;

    await request(app)
      .post(`/api/v1/billing/invoices/${invoiceId}/finalize`)
      .set("Authorization", `Bearer ${ownerTokenA}`)
      .set("X-Branch-Id", branchA1Id.toString())
      .send();

    const pay1 = await request(app)
      .post(`/api/v1/billing/invoices/${invoiceId}/payments`)
      .set("Authorization", `Bearer ${ownerTokenA}`)
      .set("X-Branch-Id", branchA1Id.toString())
      .set("Idempotency-Key", `legit-pay-1-${Date.now()}`)
      .send({ amount: 500, method: "cash" });
    expect(pay1.status).toBe(201);
    expect(pay1.body.data.invoice.amountPaid).toBe(500);

    const pay2 = await request(app)
      .post(`/api/v1/billing/invoices/${invoiceId}/payments`)
      .set("Authorization", `Bearer ${ownerTokenA}`)
      .set("X-Branch-Id", branchA1Id.toString())
      .set("Idempotency-Key", `legit-pay-2-${Date.now()}`)
      .send({ amount: 1400, method: "upi" });
    expect(pay2.status).toBe(201);
    expect(pay2.body.data.invoice.amountPaid).toBe(1900);
    expect(pay2.body.data.invoice.amountDue).toBe(0);
    expect(pay2.body.data.invoice.paymentStatus).toBe("paid");
  });

  it("34. voiding an idempotent payment reverses balance accurately while keeping idempotency key record intact", async () => {
    const apt = await createTestAppointment();
    const createRes = await request(app)
      .post("/api/v1/billing/invoices")
      .set("Authorization", `Bearer ${ownerTokenA}`)
      .set("X-Branch-Id", branchA1Id.toString())
      .send({ appointmentId: apt._id.toString() });
    const invoiceId = createRes.body.data._id;

    await request(app)
      .post(`/api/v1/billing/invoices/${invoiceId}/finalize`)
      .set("Authorization", `Bearer ${ownerTokenA}`)
      .set("X-Branch-Id", branchA1Id.toString())
      .send();

    const idempotencyKey = `void-idemp-${Date.now()}`;

    const pay = await request(app)
      .post(`/api/v1/billing/invoices/${invoiceId}/payments`)
      .set("Authorization", `Bearer ${ownerTokenA}`)
      .set("X-Branch-Id", branchA1Id.toString())
      .set("Idempotency-Key", idempotencyKey)
      .send({ amount: 500, method: "cash" });

    const paymentId = pay.body.data.payment._id;

    // Void the payment
    const voidRes = await request(app)
      .post(`/api/v1/billing/payments/${paymentId}/void`)
      .set("Authorization", `Bearer ${ownerTokenA}`)
      .set("X-Branch-Id", branchA1Id.toString())
      .send({ reason: "Customer card chargeback void" });

    expect(voidRes.status).toBe(200);
    expect(voidRes.body.data.payment.status).toBe("voided");
    expect(voidRes.body.data.payment.idempotencyKey).toBe(idempotencyKey);
    expect(voidRes.body.data.invoice.amountPaid).toBe(0);
    expect(voidRes.body.data.invoice.amountDue).toBe(1900);
    expect(voidRes.body.data.invoice.paymentStatus).toBe("unpaid");
  });
});


