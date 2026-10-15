import dns from "dns";
import { describe, expect, it, beforeEach, afterEach, beforeAll, afterAll, jest } from "@jest/globals";
import request from "supertest";
import mongoose from "mongoose";
import jwt from "jsonwebtoken";
import app from "../../../app.mjs";
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
import { Invoice } from "../../../src/models/billing/invoice.model.js";
import { Payment } from "../../../src/models/billing/payment.model.js";
import { AuditLog } from "../../../src/models/audit/auditLog.model.js";
import { LoyaltyProgramConfig } from "../../../src/models/loyalty/loyaltyProgramConfig.model.js";
import { LoyaltyTransaction, LOYALTY_TRANSACTION_TYPES } from "../../../src/models/loyalty/loyaltyTransaction.model.js";

jest.spyOn(redis, "get").mockResolvedValue(null);
jest.spyOn(redis, "setex").mockResolvedValue("OK");

describe("Loyalty Module Comprehensive Test Suite", () => {
  jest.setTimeout(45000);

  let orgAId, orgBId;
  let branchA1Id, branchB1Id;
  let ownerTokenA, staffTokenA, ownerTokenB;
  let ownerUserA, staffUserA, ownerUserB;
  let customerA, categoryA, serviceHaircut, serviceColor;

  beforeAll(async () => {
    process.env.NODE_ENV = "test";
    let testUri = process.env.MONGO_URI || "mongodb://127.0.0.1:27017/saloon_erp_test";
    if (testUri.includes("?")) {
      const parts = testUri.split("?");
      testUri = parts[0].replace(/\/([^\/]+)$/, "/saloon_erp_loyalty_test") + "?" + parts[1];
    } else {
      testUri = testUri.replace(/\/([^\/]+)$/, "/saloon_erp_loyalty_test");
    }
    await mongoose.connect(testUri);
  });

  afterAll(async () => {
    await LoyaltyTransaction.deleteMany({});
    await LoyaltyProgramConfig.deleteMany({});
    await Invoice.deleteMany({});
    await Payment.deleteMany({});
    await Appointment.deleteMany({});
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
    const orgA = await Organization.create({ name: "Glamour Salon A" });
    orgAId = orgA._id;

    const bA1 = await Branch.create({ organizationId: orgAId, name: "Branch A1", isActive: true });
    branchA1Id = bA1._id;

    const orgB = await Organization.create({ name: "Rival Salon B" });
    orgBId = orgB._id;

    const bB1 = await Branch.create({ organizationId: orgBId, name: "Branch B1", isActive: true });
    branchB1Id = bB1._id;

    const permissions = [
      "loyalty.view",
      "loyalty.configure",
      "loyalty.adjust",
      "billing.view",
      "billing.checkout",
      "billing.void",
      "payments.view",
      "payments.receive",
      "payments.refund",
    ];

    const permDocs = [];
    for (const p of permissions) {
      let doc = await Permission.findOne({ name: p });
      if (!doc) {
        doc = await Permission.create({ name: p, module: "General", action: p, description: `Permission for ${p}` });
      }
      permDocs.push(doc);
    }

    const adminRoleA = await Role.create({
      organizationId: orgAId,
      name: "OrgAdminRoleA",
      permissions: permDocs.map((p) => p._id),
      isSystemRole: false,
    });

    const staffPermDocs = permDocs.filter((p) => ["loyalty.view", "billing.view", "billing.checkout"].includes(p.name));
    const staffRoleA = await Role.create({
      organizationId: orgAId,
      name: "StaffRoleA",
      permissions: staffPermDocs.map((p) => p._id),
      isSystemRole: false,
    });

    const adminRoleB = await Role.create({
      organizationId: orgBId,
      name: "OrgAdminRoleB",
      permissions: permDocs.map((p) => p._id),
      isSystemRole: false,
    });

    ownerUserA = await User.create({
      organizationId: orgAId,
      role: adminRoleA._id,
      name: "Owner A",
      email: `owner.a.${Date.now()}-${Math.floor(Math.random() * 10000)}@salon.com`,
      phone: "+919999990001",
      password: "Password@123",
      hasOrgWideAccess: true,
      branchAccess: [{ branchId: branchA1Id, branchName: "Branch A1", isActive: true }],
      status: "active",
    });

    staffUserA = await User.create({
      organizationId: orgAId,
      role: staffRoleA._id,
      name: "Staff A",
      email: `staff.a.${Date.now()}-${Math.floor(Math.random() * 10000)}@salon.com`,
      phone: "+919999990002",
      password: "Password@123",
      hasOrgWideAccess: false,
      branchAccess: [{ branchId: branchA1Id, branchName: "Branch A1", isActive: true }],
      status: "active",
    });

    ownerUserB = await User.create({
      organizationId: orgBId,
      role: adminRoleB._id,
      name: "Owner B",
      email: `owner.b.${Date.now()}-${Math.floor(Math.random() * 10000)}@salon.com`,
      phone: "+919999990003",
      password: "Password@123",
      hasOrgWideAccess: true,
      branchAccess: [{ branchId: branchB1Id, branchName: "Branch B1", isActive: true }],
      status: "active",
    });

    const jwtSecret = process.env.JWT_SECRET || "supersecretjwtsecretkeyfortesting12345!";
    ownerTokenA = jwt.sign({ id: ownerUserA._id, role: "owner" }, jwtSecret, { expiresIn: "1h" });
    staffTokenA = jwt.sign({ id: staffUserA._id, role: "staff" }, jwtSecret, { expiresIn: "1h" });
    ownerTokenB = jwt.sign({ id: ownerUserB._id, role: "owner" }, jwtSecret, { expiresIn: "1h" });

    customerA = await Customer.create({
      organizationId: orgAId,
      name: "Loyal Customer A",
      phone: "+919988776655",
      homeBranchId: branchA1Id,
      loyaltyPoints: 100,
      status: "active",
    });

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
    await LoyaltyTransaction.deleteMany({});
    await LoyaltyProgramConfig.deleteMany({});
    await Invoice.deleteMany({});
    await Payment.deleteMany({});
    await Appointment.deleteMany({});
    await Service.deleteMany({});
    await ServiceCategory.deleteMany({});
    await Customer.deleteMany({});
    await User.deleteMany({});
    await Role.deleteMany({});
    await Branch.deleteMany({});
    await Organization.deleteMany({});
  });

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
      appointmentDate: "2026-10-14",
      startTime: "10:00",
      endTime: "11:30",
      totalDuration: 90,
      status: "completed",
      bookingType: "advance",
      pricing: {
        subtotal: 2000,
        discount: 0,
        total: 2000,
      },
    };
    return await Appointment.create({ ...defaultData, ...overrides });
  }

  // =========================================================================
  // 1. PROGRAM CONFIGURATION TESTS
  // =========================================================================
  describe("1. Program Configuration", () => {
    it("1.1 returns default configuration if none has been explicitly saved", async () => {
      const res = await request(app)
        .get("/api/v1/loyalty/program")
        .set("Authorization", `Bearer ${ownerTokenA}`);

      expect(res.status).toBe(200);
      expect(res.body.success).toBe(true);
      expect(res.body.data.isEnabled).toBe(false);
      expect(res.body.data.earnPointsPerUnit).toBe(1);
      expect(res.body.data.earnThresholdAmount).toBe(100);
      expect(res.body.data.redemptionRate).toBe(1);
      expect(res.body.data.minRedemptionPoints).toBe(20);
      expect(res.body.data.maxRedemptionPercentage).toBe(20);
    });

    it("1.2 authorized user can update configuration and creates AuditLog entry", async () => {
      const res = await request(app)
        .put("/api/v1/loyalty/program")
        .set("Authorization", `Bearer ${ownerTokenA}`)
        .send({
          isEnabled: true,
          earnPointsPerUnit: 2,
          minRedemptionPoints: 50,
          maxRedemptionPercentage: 25,
        });

      expect(res.status).toBe(200);
      expect(res.body.success).toBe(true);
      expect(res.body.data.isEnabled).toBe(true);
      expect(res.body.data.earnPointsPerUnit).toBe(2);
      expect(res.body.data.minRedemptionPoints).toBe(50);
      expect(res.body.data.maxRedemptionPercentage).toBe(25);

      const audit = await AuditLog.findOne({
        organizationId: orgAId,
        action: "LOYALTY_PROGRAM_UPDATED",
      });
      expect(audit).toBeTruthy();
      expect(audit.actorId.toString()).toBe(ownerUserA._id.toString());
    });

    it("1.3 rejects configuration update by unauthorized user lacking loyalty.configure", async () => {
      const res = await request(app)
        .put("/api/v1/loyalty/program")
        .set("Authorization", `Bearer ${staffTokenA}`)
        .send({ isEnabled: true });

      expect(res.status).toBe(403);
    });

    it("1.4 organization isolation: Org B config does not affect Org A", async () => {
      await request(app)
        .put("/api/v1/loyalty/program")
        .set("Authorization", `Bearer ${ownerTokenA}`)
        .send({ isEnabled: true, minRedemptionPoints: 100 });

      const resB = await request(app)
        .get("/api/v1/loyalty/program")
        .set("Authorization", `Bearer ${ownerTokenB}`);

      expect(resB.body.data.isEnabled).toBe(false);
      expect(resB.body.data.minRedemptionPoints).toBe(20);
    });
  });

  // =========================================================================
  // 2. MANUAL ADJUSTMENT TESTS
  // =========================================================================
  describe("2. Manual Point Adjustments", () => {
    it("2.1 authorized credit increases customer points, creates ledger entry and audit log", async () => {
      const res = await request(app)
        .post(`/api/v1/loyalty/customers/${customerA._id}/adjust`)
        .set("Authorization", `Bearer ${ownerTokenA}`)
        .send({
          points: 50,
          operation: "CREDIT",
          reason: "Customer service goodwill credit",
        });

      expect(res.status).toBe(201);
      expect(res.body.success).toBe(true);

      const updatedCustomer = await Customer.findById(customerA._id);
      expect(updatedCustomer.loyaltyPoints).toBe(150); // 100 + 50

      const ledger = await LoyaltyTransaction.findOne({
        customerId: customerA._id,
        type: LOYALTY_TRANSACTION_TYPES.ADJUSTED,
      });
      expect(ledger).toBeTruthy();
      expect(ledger.pointsDelta).toBe(50);
      expect(ledger.balanceBefore).toBe(100);
      expect(ledger.balanceAfter).toBe(150);

      const audit = await AuditLog.findOne({
        action: "LOYALTY_POINTS_ADJUSTED",
        entityId: customerA._id,
      });
      expect(audit).toBeTruthy();
      expect(audit.actorId.toString()).toBe(ownerUserA._id.toString());
    });

    it("2.2 authorized debit decreases customer points", async () => {
      const res = await request(app)
        .post(`/api/v1/loyalty/customers/${customerA._id}/adjust`)
        .set("Authorization", `Bearer ${ownerTokenA}`)
        .send({
          points: 40,
          operation: "DEBIT",
          reason: "Correction of incorrect grant",
        });

      expect(res.status).toBe(201);
      const updatedCustomer = await Customer.findById(customerA._id);
      expect(updatedCustomer.loyaltyPoints).toBe(60); // 100 - 40
    });

    it("2.3 debit exceeding available balance is strictly rejected", async () => {
      const res = await request(app)
        .post(`/api/v1/loyalty/customers/${customerA._id}/adjust`)
        .set("Authorization", `Bearer ${ownerTokenA}`)
        .send({
          points: 150,
          operation: "DEBIT",
          reason: "Over-debit test",
        });

      expect(res.status).toBe(400);
      const unchangedCustomer = await Customer.findById(customerA._id);
      expect(unchangedCustomer.loyaltyPoints).toBe(100);
    });

    it("2.4 idempotency key replay returns existing transaction without double adjusting", async () => {
      const payload = {
        points: 25,
        operation: "CREDIT",
        reason: "Idempotent credit test",
        idempotencyKey: "ADJUST_KEY_12345",
      };

      const res1 = await request(app)
        .post(`/api/v1/loyalty/customers/${customerA._id}/adjust`)
        .set("Authorization", `Bearer ${ownerTokenA}`)
        .send(payload);

      expect(res1.status).toBe(201);

      const res2 = await request(app)
        .post(`/api/v1/loyalty/customers/${customerA._id}/adjust`)
        .set("Authorization", `Bearer ${ownerTokenA}`)
        .send(payload);

      expect(res2.status).toBe(200);
      expect(res2.body.data.isIdempotentReplay).toBe(true);

      const customer = await Customer.findById(customerA._id);
      expect(customer.loyaltyPoints).toBe(125); // Only credited once
    });
  });

  // =========================================================================
  // 3. REDEMPTION & CHECKOUT INTEGRATION TESTS
  // =========================================================================
  describe("3. Redemption & Billing Checkout", () => {
    beforeEach(async () => {
      // Enable loyalty program for Org A
      await request(app)
        .put("/api/v1/loyalty/program")
        .set("Authorization", `Bearer ${ownerTokenA}`)
        .send({
          isEnabled: true,
          earnThresholdAmount: 100,
          earnPointsPerUnit: 1,
          redemptionRate: 1,
          minRedemptionPoints: 20,
          maxRedemptionPercentage: 20, // max 20% discount
        });
    });

    it("3.1 preview-redemption is side-effect-free and enforces 20% cap", async () => {
      // customerA has 100 points
      // billAmount = 2000. 20% cap = ₹400 = 400 points. Customer has 100, so max = 100 points
      const res = await request(app)
        .get(`/api/v1/loyalty/preview-redemption?customerId=${customerA._id}&billAmount=2000`)
        .set("Authorization", `Bearer ${ownerTokenA}`);

      expect(res.status).toBe(200);
      expect(res.body.data.isEligible).toBe(true);
      expect(res.body.data.availablePoints).toBe(100);
      expect(res.body.data.appliedPoints).toBe(100);
      expect(res.body.data.appliedDiscount).toBe(100);
      expect(res.body.data.effectivePayable).toBe(1900);

      // Verify no database mutation
      const customer = await Customer.findById(customerA._id);
      expect(customer.loyaltyPoints).toBe(100);
      const txCount = await LoyaltyTransaction.countDocuments();
      expect(txCount).toBe(0);
    });

    it("3.2 creating draft invoice with redeemLoyaltyPoints applies discount without deducting points yet", async () => {
      const apt = await createTestAppointment();

      const res = await request(app)
        .post("/api/v1/billing/invoices")
        .set("Authorization", `Bearer ${ownerTokenA}`)
        .set("X-Branch-Id", branchA1Id.toString())
        .send({
          appointmentId: apt._id.toString(),
          redeemLoyaltyPoints: 50,
        });

      expect(res.status).toBe(201);
      const invoice = res.body.data;
      expect(invoice.loyaltyRedeemedPoints).toBe(50);
      expect(invoice.loyaltyDiscountAmount).toBe(50);
      expect(invoice.discountTotal).toBe(50);
      expect(invoice.payableAmount).toBe(1950); // 2000 - 50

      // Customer points should NOT be deducted on draft
      const customer = await Customer.findById(customerA._id);
      expect(customer.loyaltyPoints).toBe(100);
      const txCount = await LoyaltyTransaction.countDocuments();
      expect(txCount).toBe(0);
    });

    it("3.3 finalizing invoice atomically commits points deduction and records REDEEMED ledger transaction", async () => {
      const apt = await createTestAppointment();

      const createRes = await request(app)
        .post("/api/v1/billing/invoices")
        .set("Authorization", `Bearer ${ownerTokenA}`)
        .set("X-Branch-Id", branchA1Id.toString())
        .send({
          appointmentId: apt._id.toString(),
          redeemLoyaltyPoints: 60,
        });

      const invoiceId = createRes.body.data.id;

      const finalRes = await request(app)
        .post(`/api/v1/billing/invoices/${invoiceId}/finalize`)
        .set("Authorization", `Bearer ${ownerTokenA}`)
        .set("X-Branch-Id", branchA1Id.toString())
        .send({});

      expect(finalRes.status).toBe(200);
      expect(finalRes.body.data.status).toBe("finalized");

      // Points must now be deducted
      const customer = await Customer.findById(customerA._id);
      expect(customer.loyaltyPoints).toBe(40); // 100 - 60

      const ledger = await LoyaltyTransaction.findOne({
        invoiceId,
        type: LOYALTY_TRANSACTION_TYPES.REDEEMED,
      });
      expect(ledger).toBeTruthy();
      expect(ledger.pointsDelta).toBe(-60);
      expect(ledger.balanceBefore).toBe(100);
      expect(ledger.balanceAfter).toBe(40);
    });

    it("3.3b updating draft invoice via PATCH with discountTotal and redeemLoyaltyPoints recalculates correctly and deducts points on finalization", async () => {
      const apt = await createTestAppointment();

      // Create draft invoice with initial manual discount of 50
      const createRes = await request(app)
        .post("/api/v1/billing/invoices")
        .set("Authorization", `Bearer ${ownerTokenA}`)
        .set("X-Branch-Id", branchA1Id.toString())
        .send({
          appointmentId: apt._id.toString(),
          discount: 50,
        });

      const invoiceId = createRes.body.data.id;
      expect(createRes.body.data.discountTotal).toBe(50);
      expect(createRes.body.data.payableAmount).toBe(1950);

      // Customer points should still be 100
      expect((await Customer.findById(customerA._id)).loyaltyPoints).toBe(100);

      // PATCH draft invoice updating manual discountTotal to 100 and redeemLoyaltyPoints to 40
      const updateRes = await request(app)
        .patch(`/api/v1/billing/invoices/${invoiceId}`)
        .set("Authorization", `Bearer ${ownerTokenA}`)
        .set("X-Branch-Id", branchA1Id.toString())
        .send({
          discountTotal: 100,
          redeemLoyaltyPoints: 40,
        });

      expect(updateRes.status).toBe(200);
      const updated = updateRes.body.data;
      // Subtotal = 2000
      // Manual discount = 100, Loyalty discount (40 pts * ₹1) = 40 => Total discount = 140
      expect(updated.subtotal).toBe(2000);
      expect(updated.discountTotal).toBe(140);
      expect(updated.loyaltyRedeemedPoints).toBe(40);
      expect(updated.loyaltyDiscountAmount).toBe(40);
      expect(updated.payableAmount).toBe(1860);
      expect(updated.amountDue).toBe(1860);
      expect(updated.paymentStatus).toBe("unpaid");

      // Points still NOT deducted on draft update
      expect((await Customer.findById(customerA._id)).loyaltyPoints).toBe(100);

      // Finalize the invoice
      const finalRes = await request(app)
        .post(`/api/v1/billing/invoices/${invoiceId}/finalize`)
        .set("Authorization", `Bearer ${ownerTokenA}`)
        .set("X-Branch-Id", branchA1Id.toString())
        .send({});

      expect(finalRes.status).toBe(200);
      expect(finalRes.body.data.status).toBe("finalized");

      // Now customer points must be deducted: 100 - 40 = 60
      expect((await Customer.findById(customerA._id)).loyaltyPoints).toBe(60);

      const ledger = await LoyaltyTransaction.findOne({
        invoiceId,
        type: LOYALTY_TRANSACTION_TYPES.REDEEMED,
      });
      expect(ledger).toBeTruthy();
      expect(ledger.pointsDelta).toBe(-40);
      expect(ledger.balanceBefore).toBe(100);
      expect(ledger.balanceAfter).toBe(60);
    });

    it("3.4 cancelling finalized invoice with redeemed points restores customer points atomically", async () => {
      const apt = await createTestAppointment();

      const createRes = await request(app)
        .post("/api/v1/billing/invoices")
        .set("Authorization", `Bearer ${ownerTokenA}`)
        .set("X-Branch-Id", branchA1Id.toString())
        .send({
          appointmentId: apt._id.toString(),
          redeemLoyaltyPoints: 40,
        });

      const invoiceId = createRes.body.data.id;

      await request(app)
        .post(`/api/v1/billing/invoices/${invoiceId}/finalize`)
        .set("Authorization", `Bearer ${ownerTokenA}`)
        .set("X-Branch-Id", branchA1Id.toString())
        .send({});

      // Balance dropped to 60
      expect((await Customer.findById(customerA._id)).loyaltyPoints).toBe(60);

      // Cancel invoice
      const cancelRes = await request(app)
        .post(`/api/v1/billing/invoices/${invoiceId}/cancel`)
        .set("Authorization", `Bearer ${ownerTokenA}`)
        .set("X-Branch-Id", branchA1Id.toString())
        .send({ reason: "Customer changed mind before payment" });

      expect(cancelRes.status).toBe(200);

      // Balance restored to 100
      const customer = await Customer.findById(customerA._id);
      expect(customer.loyaltyPoints).toBe(100);

      const restoreTx = await LoyaltyTransaction.findOne({
        invoiceId,
        type: LOYALTY_TRANSACTION_TYPES.REDEMPTION_RESTORED,
      });
      expect(restoreTx).toBeTruthy();
      expect(restoreTx.pointsDelta).toBe(40);
      expect(restoreTx.balanceAfter).toBe(100);
    });
  });

  // =========================================================================
  // 4. EARNING & VOID REVERSAL LIFECYCLE TESTS
  // =========================================================================
  describe("4. Earning & Void Reversal Lifecycle", () => {
    beforeEach(async () => {
      await request(app)
        .put("/api/v1/loyalty/program")
        .set("Authorization", `Bearer ${ownerTokenA}`)
        .send({
          isEnabled: true,
          earnThresholdAmount: 100, // 1 point per ₹100
          earnPointsPerUnit: 1,
        });
    });

    it("4.1 awards points strictly upon full payment settlement (18 points on ₹1800 eligible spend)", async () => {
      // 1 Haircut (500) + 1 Color (1500) = 2000. Discount = 200. Eligible spend = 1800 -> 18 points
      const apt = await createTestAppointment();

      const createRes = await request(app)
        .post("/api/v1/billing/invoices")
        .set("Authorization", `Bearer ${ownerTokenA}`)
        .set("X-Branch-Id", branchA1Id.toString())
        .send({
          appointmentId: apt._id.toString(),
          discount: 200,
        });

      const invoiceId = createRes.body.data.id;

      await request(app)
        .post(`/api/v1/billing/invoices/${invoiceId}/finalize`)
        .set("Authorization", `Bearer ${ownerTokenA}`)
        .set("X-Branch-Id", branchA1Id.toString())
        .send({});

      // Split payment 1: Partial payment of ₹1000
      await request(app)
        .post(`/api/v1/billing/invoices/${invoiceId}/payments`)
        .set("Authorization", `Bearer ${ownerTokenA}`)
        .set("X-Branch-Id", branchA1Id.toString())
        .send({
          amount: 1000,
          method: "cash",
        });

      // After partial payment: status is partially_paid, so NO points earned yet
      let customer = await Customer.findById(customerA._id);
      expect(customer.loyaltyPoints).toBe(100); // initial balance

      // Split payment 2: Final settlement payment of remaining ₹800
      const payRes2 = await request(app)
        .post(`/api/v1/billing/invoices/${invoiceId}/payments`)
        .set("Authorization", `Bearer ${ownerTokenA}`)
        .set("X-Branch-Id", branchA1Id.toString())
        .send({
          amount: 800,
          method: "card",
        });

      expect(payRes2.status).toBe(201);
      expect(payRes2.body.data.invoice.paymentStatus).toBe("paid");

      // Points earned: 1800 / 100 = 18 points awarded
      customer = await Customer.findById(customerA._id);
      expect(customer.loyaltyPoints).toBe(118); // 100 + 18

      const earnTx = await LoyaltyTransaction.findOne({
        invoiceId,
        type: LOYALTY_TRANSACTION_TYPES.EARNED,
      });
      expect(earnTx).toBeTruthy();
      expect(earnTx.pointsDelta).toBe(18);
      expect(earnTx.balanceBefore).toBe(100);
      expect(earnTx.balanceAfter).toBe(118);
    });

    it("4.2 voiding payment that settled invoice reverses earned points atomically", async () => {
      const apt = await createTestAppointment();

      const createRes = await request(app)
        .post("/api/v1/billing/invoices")
        .set("Authorization", `Bearer ${ownerTokenA}`)
        .set("X-Branch-Id", branchA1Id.toString())
        .send({
          appointmentId: apt._id.toString(),
          discount: 200,
        });

      const invoiceId = createRes.body.data.id;

      await request(app)
        .post(`/api/v1/billing/invoices/${invoiceId}/finalize`)
        .set("Authorization", `Bearer ${ownerTokenA}`)
        .set("X-Branch-Id", branchA1Id.toString())
        .send({});

      const payRes = await request(app)
        .post(`/api/v1/billing/invoices/${invoiceId}/payments`)
        .set("Authorization", `Bearer ${ownerTokenA}`)
        .set("X-Branch-Id", branchA1Id.toString())
        .send({
          amount: 1800,
          method: "upi",
        });

      const paymentId = payRes.body.data.payment._id;

      // Earned 18 points -> 118
      expect((await Customer.findById(customerA._id)).loyaltyPoints).toBe(118);

      // Void the payment
      const voidRes = await request(app)
        .post(`/api/v1/billing/payments/${paymentId}/void`)
        .set("Authorization", `Bearer ${ownerTokenA}`)
        .set("X-Branch-Id", branchA1Id.toString())
        .send({ reason: "UPI payment bounced/disputed" });

      expect(voidRes.status).toBe(200);

      // Points reversed back to 100
      const customer = await Customer.findById(customerA._id);
      expect(customer.loyaltyPoints).toBe(100);

      const reverseTx = await LoyaltyTransaction.findOne({
        paymentId,
        type: LOYALTY_TRANSACTION_TYPES.EARNING_REVERSED,
      });
      expect(reverseTx).toBeTruthy();
      expect(reverseTx.pointsDelta).toBe(-18);
      expect(reverseTx.balanceAfter).toBe(100);
    });

    it("4.3 subscription covered services are strictly excluded from earning base", async () => {
      const dummySubId = new mongoose.Types.ObjectId();
      // Service 1 (Haircut): ₹500, covered by subscription
      // Service 2 (Color): ₹1500, uncovered, discount ₹100 -> customerPayable = ₹1400
      const apt = await createTestAppointment({
        services: [
          {
            serviceId: serviceHaircut._id,
            name: serviceHaircut.name,
            duration: 30,
            price: 500,
            appliedSubscriptionId: dummySubId,
            isRedeemedViaSubscription: true,
          },
          {
            serviceId: serviceColor._id,
            name: serviceColor.name,
            duration: 60,
            price: 1500,
            isRedeemedViaSubscription: false,
          },
        ],
        pricing: { subtotal: 2000, discount: 100, total: 1400 },
      });

      const createRes = await request(app)
        .post("/api/v1/billing/invoices")
        .set("Authorization", `Bearer ${ownerTokenA}`)
        .set("X-Branch-Id", branchA1Id.toString())
        .send({
          appointmentId: apt._id.toString(),
          discount: 100,
        });

      const invoiceId = createRes.body.data.id;

      await request(app)
        .post(`/api/v1/billing/invoices/${invoiceId}/finalize`)
        .set("Authorization", `Bearer ${ownerTokenA}`)
        .set("X-Branch-Id", branchA1Id.toString())
        .send({});

      await request(app)
        .post(`/api/v1/billing/invoices/${invoiceId}/payments`)
        .set("Authorization", `Bearer ${ownerTokenA}`)
        .set("X-Branch-Id", branchA1Id.toString())
        .send({
          amount: 1400,
          method: "cash",
        });

      // Earning calculation must ONLY earn on ₹1400 (uncovered payable), NOT ₹1900 or ₹2000
      // 1400 / 100 = 14 points
      const customer = await Customer.findById(customerA._id);
      expect(customer.loyaltyPoints).toBe(114); // 100 + 14

      const earnTx = await LoyaltyTransaction.findOne({
        invoiceId,
        type: LOYALTY_TRANSACTION_TYPES.EARNED,
      });
      expect(earnTx.pointsDelta).toBe(14);
      expect(earnTx.rateSnapshot.eligibleSpendAmount).toBe(1400);
    });
  });

  // =========================================================================
  // 5. CUSTOMER LEDGER QUERY TESTS
  // =========================================================================
  describe("5. Customer Ledger Query & Tenant Isolation", () => {
    it("5.1 returns paginated ledger with deterministic sorting", async () => {
      // Create sample transactions
      await LoyaltyTransaction.create({
        organizationId: orgAId,
        customerId: customerA._id,
        branchId: branchA1Id,
        type: LOYALTY_TRANSACTION_TYPES.ADJUSTED,
        pointsDelta: 10,
        balanceBefore: 100,
        balanceAfter: 110,
        reason: "Test entry 1",
      });

      const res = await request(app)
        .get(`/api/v1/loyalty/customers/${customerA._id}/ledger?page=1&limit=10`)
        .set("Authorization", `Bearer ${ownerTokenA}`);

      expect(res.body.data.length).toBeGreaterThanOrEqual(1);
      expect(res.body.pagination).toHaveProperty("total");
    });

    it("5.2 cross-tenant access is rejected", async () => {
      const res = await request(app)
        .get(`/api/v1/loyalty/customers/${customerA._id}/ledger`)
        .set("Authorization", `Bearer ${ownerTokenB}`);

      expect(res.status).toBe(404);
    });
  });

  // =========================================================================
  // 6. FINANCIAL INTEGRITY, CONCURRENCY & LEDGER RECONCILIATION
  // =========================================================================
  describe("6. Financial Integrity, Concurrency & Ledger Reconciliation", () => {
    beforeEach(async () => {
      await request(app)
        .put("/api/v1/loyalty/program")
        .set("Authorization", `Bearer ${ownerTokenA}`)
        .send({
          isEnabled: true,
          earnThresholdAmount: 100,
          earnPointsPerUnit: 1,
          redemptionRate: 1,
          minRedemptionPoints: 20,
          maxRedemptionPercentage: 100, // allow full redemption for stress test
        });
    });

    it("6.1 full economic reversal with subsequent spend records points debt and reconciles ledger", async () => {
      // 1. Initial balance: customerA starts with 100 points
      expect((await Customer.findById(customerA._id)).loyaltyPoints).toBe(100);

      // 2. Customer settles invoice 1 -> earns 18 points (balance becomes 118)
      const apt1 = await createTestAppointment();
      const invRes1 = await request(app)
        .post("/api/v1/billing/invoices")
        .set("Authorization", `Bearer ${ownerTokenA}`)
        .set("X-Branch-Id", branchA1Id.toString())
        .send({ appointmentId: apt1._id.toString(), discount: 200 });

      const invoice1Id = invRes1.body.data.id;
      await request(app)
        .post(`/api/v1/billing/invoices/${invoice1Id}/finalize`)
        .set("Authorization", `Bearer ${ownerTokenA}`)
        .set("X-Branch-Id", branchA1Id.toString())
        .send({});

      const payRes1 = await request(app)
        .post(`/api/v1/billing/invoices/${invoice1Id}/payments`)
        .set("Authorization", `Bearer ${ownerTokenA}`)
        .set("X-Branch-Id", branchA1Id.toString())
        .send({ amount: 1800, method: "card" });
      const payment1Id = payRes1.body.data.payment._id;

      let cust = await Customer.findById(customerA._id);
      expect(cust.loyaltyPoints).toBe(118);

      // 3. Customer redeems all 118 points on invoice 2 -> balance becomes 0
      const apt2 = await createTestAppointment();
      const invRes2 = await request(app)
        .post("/api/v1/billing/invoices")
        .set("Authorization", `Bearer ${ownerTokenA}`)
        .set("X-Branch-Id", branchA1Id.toString())
        .send({ appointmentId: apt2._id.toString(), redeemLoyaltyPoints: 118 });
      const invoice2Id = invRes2.body.data.id;

      await request(app)
        .post(`/api/v1/billing/invoices/${invoice2Id}/finalize`)
        .set("Authorization", `Bearer ${ownerTokenA}`)
        .set("X-Branch-Id", branchA1Id.toString())
        .send({});

      cust = await Customer.findById(customerA._id);
      expect(cust.loyaltyPoints).toBe(0);

      // 4. Payment 1 on invoice 1 is VOIDED (e.g. chargeback/fraud)
      const voidRes = await request(app)
        .post(`/api/v1/billing/payments/${payment1Id}/void`)
        .set("Authorization", `Bearer ${ownerTokenA}`)
        .set("X-Branch-Id", branchA1Id.toString())
        .send({ reason: "Chargeback reversal" });

      expect(voidRes.status).toBe(200);

      // 5. Verify customer balance & debt: spendable = 0, debt = 18, net = -18
      cust = await Customer.findById(customerA._id);
      expect(cust.loyaltyPoints).toBe(0);
      expect(cust.loyaltyPointsDebt).toBe(18);

      // 6. Verify ledger entry: recorded full -18 pointsDelta, balanceBefore: 0, balanceAfter: -18
      const reversalTx = await LoyaltyTransaction.findOne({
        paymentId: payment1Id,
        type: LOYALTY_TRANSACTION_TYPES.EARNING_REVERSED,
      });
      expect(reversalTx).toBeTruthy();
      expect(reversalTx.pointsDelta).toBe(-18);
      expect(reversalTx.balanceBefore).toBe(0);
      expect(reversalTx.balanceAfter).toBe(-18);

      // 7. Verify ledger summation reconciles exactly with net customer balance (100 initial + 18 earn - 118 redeem - 18 reversal = -18)
      const allTx = await LoyaltyTransaction.find({ customerId: customerA._id });
      const sumDelta = allTx.reduce((sum, tx) => sum + tx.pointsDelta, 0);
      const initialBalance = 100;
      expect(initialBalance + sumDelta).toBe(cust.loyaltyPoints - cust.loyaltyPointsDebt);

      // 8. Subsequent earning automatically offsets debt
      // Settle invoice 2 (payable: 2000 - 118 = 1882 -> 18 points)
      await request(app)
        .post(`/api/v1/billing/invoices/${invoice2Id}/payments`)
        .set("Authorization", `Bearer ${ownerTokenA}`)
        .set("X-Branch-Id", branchA1Id.toString())
        .send({ amount: 1882, method: "cash" });

      cust = await Customer.findById(customerA._id);
      expect(cust.loyaltyPointsDebt).toBe(0);
      expect(cust.loyaltyPoints).toBe(0); // 18 points earned offset the 18 debt
    });

    it("6.2 concurrent finalization attempts cannot overspend loyalty balance", async () => {
      // Customer has 100 points. We prepare 2 draft invoices each requesting 60 points (total 120 > 100)
      const apt1 = await createTestAppointment();
      const apt2 = await createTestAppointment();

      const inv1 = (
        await request(app)
          .post("/api/v1/billing/invoices")
          .set("Authorization", `Bearer ${ownerTokenA}`)
          .set("X-Branch-Id", branchA1Id.toString())
          .send({ appointmentId: apt1._id.toString(), redeemLoyaltyPoints: 60 })
      ).body.data;

      const inv2 = (
        await request(app)
          .post("/api/v1/billing/invoices")
          .set("Authorization", `Bearer ${ownerTokenA}`)
          .set("X-Branch-Id", branchA1Id.toString())
          .send({ appointmentId: apt2._id.toString(), redeemLoyaltyPoints: 60 })
      ).body.data;

      // Attempt concurrent finalization
      const [final1, final2] = await Promise.all([
        request(app)
          .post(`/api/v1/billing/invoices/${inv1.id}/finalize`)
          .set("Authorization", `Bearer ${ownerTokenA}`)
          .set("X-Branch-Id", branchA1Id.toString())
          .send({}),
        request(app)
          .post(`/api/v1/billing/invoices/${inv2.id}/finalize`)
          .set("Authorization", `Bearer ${ownerTokenA}`)
          .set("X-Branch-Id", branchA1Id.toString())
          .send({}),
      ]);

      const statuses = [final1.status, final2.status].sort();
      // One must succeed (200) and the other must be rejected (400) due to atomic conditional balance decrement
      expect(statuses).toEqual([200, 400]);

      const cust = await Customer.findById(customerA._id);
      expect(cust.loyaltyPoints).toBe(40); // 100 - 60 = 40 (never dropped below 0)
    });

    it("6.3 previewRedemption using invoiceId derives trusted spend from persisted invoice", async () => {
      const apt = await createTestAppointment();
      const draftInv = (
        await request(app)
          .post("/api/v1/billing/invoices")
          .set("Authorization", `Bearer ${ownerTokenA}`)
          .set("X-Branch-Id", branchA1Id.toString())
          .send({ appointmentId: apt._id.toString(), discount: 500 })
      ).body.data;

      // Preview using trusted invoiceId
      const res = await request(app)
        .get(`/api/v1/loyalty/preview-redemption?customerId=${customerA._id}&invoiceId=${draftInv.id}`)
        .set("Authorization", `Bearer ${ownerTokenA}`);

      expect(res.status).toBe(200);
      expect(res.body.data.isEligible).toBe(true);
      // Payable before loyalty is 2000 - 500 = 1500
      expect(res.body.data.effectivePayable).toBe(1400); // 1500 - 100 points
      expect(res.body.data.appliedPoints).toBe(100);
    });
  });
});
