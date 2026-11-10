import { describe, expect, it, beforeEach, afterEach, jest } from "@jest/globals";
import crypto from "crypto";
import request from "supertest";
import mongoose from "mongoose";
import app from "../../../app.mjs";
import { Organization } from "../../../src/models/organizations/organization.model.js";
import { Branch } from "../../../src/models/branches/branch.model.js";
import { Customer } from "../../../src/models/customers/customer.model.js";
import { Staff } from "../../../src/models/staff/staff.model.js";
import { Service } from "../../../src/models/services/service.model.js";
import { ServiceCategory } from "../../../src/models/services/serviceCategory.model.js";
import { Role } from "../../../src/models/roles/role.model.js";
import { Permission } from "../../../src/models/permissions/permission.model.js";
import { User } from "../../../src/models/users/user.model.js";
import { Subscription } from "../../../src/models/subscriptions/subscription.model.js";
import { SubscriptionPlan } from "../../../src/models/subscriptions/subscriptionPlan.model.js";
import { SubscriptionUsage } from "../../../src/models/subscriptions/subscriptionUsage.model.js";
import { SubscriptionConsumptionChallenge } from "../../../src/models/subscriptions/subscriptionConsumptionChallenge.model.js";
import { Appointment } from "../../../src/models/appointments/appointment.model.js";
import { AuditLog } from "../../../src/models/audit/auditLog.model.js";
import { smsQueue } from "../../../src/queues/client.js";
import { processSmsJob } from "../../../src/workers/notification.worker.js";
import jwt from "jsonwebtoken";
import { env } from "../../../src/config/env.js";
import { redis } from "../../../src/utils/redis.js";
import { getIsolatedTestMongoUri } from "../testSetup.js";

jest.spyOn(redis, "get").mockResolvedValue(null);
jest.spyOn(redis, "setex").mockResolvedValue("OK");


// Relative future date helper to prevent fixture staleness
const getFutureDateStr = (daysAhead = 30) => {
  const d = new Date(Date.now() + daysAhead * 86400000);
  return d.toISOString().split("T")[0];
};

describe("Appointment ↔ Subscription Integration Flow Tests", () => {
  jest.setTimeout(35000);

  let orgA, orgB;
  let branchA1, branchA2;
  let ownerToken, staffToken;
  let ownerUser, staffUser;
  let customerA, customerB;
  let serviceA1, serviceA2;
  let categoryA;
  let staffMember;

  beforeAll(async () => {
    process.env.ALLOW_STANDALONE_TRANSACTION_FALLBACK = "true";
    const testUri = getIsolatedTestMongoUri("appt_sub_test");
    await mongoose.connect(testUri);
    try {
      await SubscriptionConsumptionChallenge.collection.dropIndexes();
    } catch (e) {
      // ignore if collection or indexes do not exist yet
    }
    await SubscriptionConsumptionChallenge.syncIndexes();
  });

  afterAll(async () => {
    await SubscriptionConsumptionChallenge.deleteMany({});
    await Appointment.deleteMany({});
    await SubscriptionUsage.deleteMany({});
    await Subscription.deleteMany({});
    await SubscriptionPlan.deleteMany({});
    await AuditLog.deleteMany({});
    await Staff.deleteMany({});
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
    await SubscriptionConsumptionChallenge.deleteMany({});
    await Appointment.deleteMany({});
    await SubscriptionUsage.deleteMany({});
    await Subscription.deleteMany({});
    await SubscriptionPlan.deleteMany({});
    await AuditLog.deleteMany({});
    await Staff.deleteMany({});
    await Service.deleteMany({});
    await ServiceCategory.deleteMany({});
    await Customer.deleteMany({});
    await User.deleteMany({});
    await Role.deleteMany({});
    await Permission.deleteMany({});
    await Branch.deleteMany({});
    await Organization.deleteMany({});

    orgA = await Organization.create({ name: "Hair Co Org", code: "HCO" });
    orgB = await Organization.create({ name: "Other Org", code: "OTH" });

    branchA1 = await Branch.create({
      organizationId: orgA._id,
      name: "Downtown Branch",
      code: "DT-01",
      timezone: "Asia/Kolkata",
      isActive: true,
    });

    branchA2 = await Branch.create({
      organizationId: orgA._id,
      name: "Uptown Branch",
      code: "UT-02",
      timezone: "Asia/Kolkata",
      isActive: true,
    });

    categoryA = await ServiceCategory.create({
      organizationId: orgA._id,
      name: "Hair Styling",
    });

    serviceA1 = await Service.create({
      organizationId: orgA._id,
      name: "Classic Haircut",
      categoryId: categoryA._id,
      duration: 30,
      pricing: { basePrice: 500 },
      status: "active",
    });

    serviceA2 = await Service.create({
      organizationId: orgA._id,
      name: "Beard Trim",
      categoryId: categoryA._id,
      duration: 15,
      pricing: { basePrice: 200 },
      status: "active",
    });

    customerA = await Customer.create({
      organizationId: orgA._id,
      name: "Alice Smith",
      phone: "+919876543210",
      email: "alice@example.com",
      homeBranchId: branchA1._id,
      status: "active",
    });

    customerB = await Customer.create({
      organizationId: orgA._id,
      name: "Bob Jones",
      phone: "+919876543211",
      email: "bob@example.com",
      homeBranchId: branchA1._id,
      status: "active",
    });

    staffMember = await Staff.create({
      organizationId: orgA._id,
      name: "Charlie Stylist",
      phone: "+919123456789",
      email: `charlie_${Date.now()}@salon.com`,
      designation: "Stylist",
      staffCode: `STF-${Date.now()}`,
      joiningDate: new Date(),
      primaryBranchId: branchA1._id,
      status: "active",
    });

    // Permissions setup
    const permNames = [
      "appointments.view",
      "appointments.create",
      "appointments.reschedule",
      "appointments.cancel",
      "appointments.update_status",
      "appointments.delete",
      "subscriptions.view",
      "subscriptions.sell",
      "subscriptions.redeem",
      "billing.checkout",
      "billing.view",
    ];

    const permDocs = await Promise.all(
      permNames.map((name) =>
        Permission.create({
          name,
          module: "Appointments",
          action: name.split(".")[1],
          description: name,
        })
      )
    );

    const ownerRole = await Role.create({
      name: "Owner Role",
      description: "Owner Role Description",
      organizationId: orgA._id,
      permissions: permDocs.map((p) => p._id),
      isSystemRole: false,
    });

    ownerUser = await User.create({
      name: "Owner User",
      email: "owner@hairco.com",
      phone: "+919999999991",
      password: "password123",
      organizationId: orgA._id,
      role: ownerRole._id,
      hasOrgWideAccess: true,
      branchAccess: [
        { branchId: branchA1._id, branchName: "Downtown Branch", isActive: true },
        { branchId: branchA2._id, branchName: "Uptown Branch", isActive: true },
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

  describe("1. Booking & Update Validation with Applied Subscriptions", () => {
    it("successfully creates appointment with appliedSubscriptionId without decrementing balance", async () => {
      const sub = await Subscription.create({
        organizationId: orgA._id,
        customerId: customerA._id,
        subscriptionCode: "SUB-2026-0001",
        price: 1000,
        entitlements: [
          {
            serviceId: serviceA1._id,
            serviceName: "Classic Haircut",
            totalQuantity: 3,
            usedQuantity: 0,
            remainingQuantity: 3,
          },
        ],
        permittedBranchIds: [branchA1._id],
        startDate: new Date("2026-01-01"),
        endDate: new Date("2026-12-31"),
        status: "active",
      });

      const res = await request(app)
        .post("/api/v1/appointments")
        .set("Authorization", `Bearer ${ownerToken}`)
        .send({
          branchId: branchA1._id.toString(),
          customerId: customerA._id.toString(),
          staffId: staffMember._id.toString(),
          services: [
            {
              serviceId: serviceA1._id.toString(),
              appliedSubscriptionId: sub._id.toString(),
            },
          ],
          appointmentDate: getFutureDateStr(25),
          startTime: "10:00",
          bookingType: "advance",
        });

      expect(res.status).toBe(201);
      expect(res.body.data.services[0].appliedSubscriptionId).toBe(sub._id.toString());
      expect(res.body.data.services[0].isRedeemedViaSubscription).toBe(false);

      // Verify balance was NOT touched
      const refreshedSub = await Subscription.findById(sub._id);
      expect(refreshedSub.entitlements[0].remainingQuantity).toBe(3);
      expect(refreshedSub.entitlements[0].usedQuantity).toBe(0);

      // Verify no SubscriptionUsage was created
      const usageCount = await SubscriptionUsage.countDocuments({ subscriptionId: sub._id });
      expect(usageCount).toBe(0);
    });

    it("rejects booking if subscription belongs to another customer", async () => {
      const subB = await Subscription.create({
        organizationId: orgA._id,
        customerId: customerB._id, // Belongs to Customer B
        subscriptionCode: "SUB-2026-0002",
        price: 1000,
        entitlements: [
          {
            serviceId: serviceA1._id,
            serviceName: "Classic Haircut",
            totalQuantity: 2,
            usedQuantity: 0,
            remainingQuantity: 2,
          },
        ],
        permittedBranchIds: [branchA1._id],
        startDate: new Date("2026-01-01"),
        endDate: new Date("2026-12-31"),
        status: "active",
      });

      const res = await request(app)
        .post("/api/v1/appointments")
        .set("Authorization", `Bearer ${ownerToken}`)
        .send({
          branchId: branchA1._id.toString(),
          customerId: customerA._id.toString(), // Customer A trying to use B's sub
          services: [
            {
              serviceId: serviceA1._id.toString(),
              appliedSubscriptionId: subB._id.toString(),
            },
          ],
          appointmentDate: "2026-10-15",
          startTime: "10:00",
          bookingType: "advance",
        });

      expect(res.status).toBe(400);
      expect(res.body.message).toContain("does not belong to this customer");
    });

    it("rejects booking if subscription is expired or inactive", async () => {
      const expiredSub = await Subscription.create({
        organizationId: orgA._id,
        customerId: customerA._id,
        subscriptionCode: "SUB-2026-EXP",
        price: 1000,
        entitlements: [
          {
            serviceId: serviceA1._id,
            serviceName: "Classic Haircut",
            totalQuantity: 2,
            usedQuantity: 0,
            remainingQuantity: 2,
          },
        ],
        permittedBranchIds: [],
        startDate: new Date("2026-01-01"),
        endDate: new Date("2026-02-01"), // In past
        status: "active",
      });

      const res = await request(app)
        .post("/api/v1/appointments")
        .set("Authorization", `Bearer ${ownerToken}`)
        .send({
          branchId: branchA1._id.toString(),
          customerId: customerA._id.toString(),
          services: [
            {
              serviceId: serviceA1._id.toString(),
              appliedSubscriptionId: expiredSub._id.toString(),
            },
          ],
          appointmentDate: "2026-10-15",
          startTime: "10:00",
          bookingType: "advance",
        });

      expect(res.status).toBe(400);
      expect(res.body.message).toContain("expired");
    });

    it("rejects booking if subscription does not permit target branch", async () => {
      const branchRestrictedSub = await Subscription.create({
        organizationId: orgA._id,
        customerId: customerA._id,
        subscriptionCode: "SUB-2026-BR",
        price: 1000,
        entitlements: [
          {
            serviceId: serviceA1._id,
            serviceName: "Classic Haircut",
            totalQuantity: 2,
            usedQuantity: 0,
            remainingQuantity: 2,
          },
        ],
        permittedBranchIds: [branchA2._id], // Uptown only
        startDate: new Date("2026-01-01"),
        endDate: new Date("2026-12-31"),
        status: "active",
      });

      const res = await request(app)
        .post("/api/v1/appointments")
        .set("Authorization", `Bearer ${ownerToken}`)
        .send({
          branchId: branchA1._id.toString(), // Booking at Downtown
          customerId: customerA._id.toString(),
          services: [
            {
              serviceId: serviceA1._id.toString(),
              appliedSubscriptionId: branchRestrictedSub._id.toString(),
            },
          ],
          appointmentDate: "2026-10-15",
          startTime: "10:00",
          bookingType: "advance",
        });

      expect(res.status).toBe(403);
      expect(res.body.message).toContain("not valid at this branch");
    });

    it("rejects booking if subscription does not cover the requested service", async () => {
      const nonCoveringSub = await Subscription.create({
        organizationId: orgA._id,
        customerId: customerA._id,
        subscriptionCode: "SUB-NO-COVER",
        price: 1000,
        entitlements: [
          {
            serviceId: serviceA2._id, // Covers Beard Trim only
            serviceName: "Beard Trim",
            totalQuantity: 2,
            usedQuantity: 0,
            remainingQuantity: 2,
          },
        ],
        permittedBranchIds: [branchA1._id],
        startDate: new Date("2026-01-01"),
        endDate: new Date("2026-12-31"),
        status: "active",
      });

      const res = await request(app)
        .post("/api/v1/appointments")
        .set("Authorization", `Bearer ${ownerToken}`)
        .send({
          branchId: branchA1._id.toString(),
          customerId: customerA._id.toString(),
          services: [
            {
              serviceId: serviceA1._id.toString(), // Requesting Classic Haircut
              appliedSubscriptionId: nonCoveringSub._id.toString(),
            },
          ],
          appointmentDate: "2026-10-15",
          startTime: "10:00",
          bookingType: "advance",
        });

      expect(res.status).toBe(400);
      expect(res.body.message).toContain("does not contain an entitlement for this service");
    });

    it("rejects booking if subscription entitlement is exhausted (remainingQuantity = 0)", async () => {
      const exhaustedSub = await Subscription.create({
        organizationId: orgA._id,
        customerId: customerA._id,
        subscriptionCode: "SUB-EXHAUSTED",
        price: 1000,
        entitlements: [
          {
            serviceId: serviceA1._id,
            serviceName: "Classic Haircut",
            totalQuantity: 2,
            usedQuantity: 2,
            remainingQuantity: 0,
          },
        ],
        permittedBranchIds: [branchA1._id],
        startDate: new Date("2026-01-01"),
        endDate: new Date("2026-12-31"),
        status: "active",
      });

      const res = await request(app)
        .post("/api/v1/appointments")
        .set("Authorization", `Bearer ${ownerToken}`)
        .send({
          branchId: branchA1._id.toString(),
          customerId: customerA._id.toString(),
          services: [
            {
              serviceId: serviceA1._id.toString(),
              appliedSubscriptionId: exhaustedSub._id.toString(),
            },
          ],
          appointmentDate: "2026-10-15",
          startTime: "10:00",
          bookingType: "advance",
        });

      expect(res.status).toBe(409);
      expect(res.body.message).toContain("no remaining quantity");
    });

    it("persists appliedSubscriptionId independently of customPrice without decrementing or creating usage", async () => {
      const sub = await Subscription.create({
        organizationId: orgA._id,
        customerId: customerA._id,
        subscriptionCode: "SUB-CUSTOM-PRICE",
        price: 1200,
        entitlements: [
          {
            serviceId: serviceA1._id,
            serviceName: "Classic Haircut",
            totalQuantity: 3,
            usedQuantity: 0,
            remainingQuantity: 3,
          },
        ],
        permittedBranchIds: [branchA1._id],
        startDate: new Date("2026-01-01"),
        endDate: new Date("2026-12-31"),
        status: "active",
      });

      const res = await request(app)
        .post("/api/v1/appointments")
        .set("Authorization", `Bearer ${ownerToken}`)
        .send({
          branchId: branchA1._id.toString(),
          customerId: customerA._id.toString(),
          services: [
            {
              serviceId: serviceA1._id.toString(),
              customPrice: 750, // Custom override price kept distinct from subscription
              appliedSubscriptionId: sub._id.toString(),
            },
          ],
          appointmentDate: getFutureDateStr(25),
          startTime: "10:00",
          bookingType: "advance",
        });

      expect(res.status).toBe(201);
      const createdService = res.body.data.services[0];
      expect(createdService.appliedSubscriptionId).toBe(sub._id.toString());
      expect(createdService.price).toBe(750);
      expect(createdService.isRedeemedViaSubscription).toBe(false);
      expect(createdService.subscriptionUsageId).toBeNull();

      // Entitlement remains intact
      const freshSub = await Subscription.findById(sub._id);
      expect(freshSub.entitlements[0].remainingQuantity).toBe(3);
      expect(freshSub.entitlements[0].usedQuantity).toBe(0);

      // No usage record
      const usages = await SubscriptionUsage.find({ subscriptionId: sub._id });
      expect(usages).toHaveLength(0);
    });
  });

  describe("2. OTP Challenge Lifecycle & Multi-Appointment Isolation", () => {
    let activeSub, appointment1, appointment2;

    beforeEach(async () => {
      activeSub = await Subscription.create({
        organizationId: orgA._id,
        customerId: customerA._id,
        subscriptionCode: "SUB-CHALLENGE-01",
        price: 1500,
        entitlements: [
          {
            serviceId: serviceA1._id,
            serviceName: "Classic Haircut",
            totalQuantity: 5,
            usedQuantity: 0,
            remainingQuantity: 5,
          },
        ],
        permittedBranchIds: [branchA1._id],
        startDate: new Date("2026-01-01"),
        endDate: new Date("2026-12-31"),
        status: "active",
      });

      const createApt1 = await request(app)
        .post("/api/v1/appointments")
        .set("Authorization", `Bearer ${ownerToken}`)
        .send({
          branchId: branchA1._id.toString(),
          customerId: customerA._id.toString(),
          staffId: staffMember._id.toString(),
          services: [
            {
              serviceId: serviceA1._id.toString(),
              appliedSubscriptionId: activeSub._id.toString(),
            },
          ],
          appointmentDate: getFutureDateStr(30),
          startTime: "10:00",
          bookingType: "advance",
        });
      appointment1 = createApt1.body.data;

      const createApt2 = await request(app)
        .post("/api/v1/appointments")
        .set("Authorization", `Bearer ${ownerToken}`)
        .send({
          branchId: branchA1._id.toString(),
          customerId: customerA._id.toString(),
          services: [
            {
              serviceId: serviceA1._id.toString(),
              appliedSubscriptionId: activeSub._id.toString(),
            },
          ],
          appointmentDate: getFutureDateStr(31),
          startTime: "14:00",
          bookingType: "advance",
        });
      appointment2 = createApt2.body.data;
    });

    it("rejects OTP request if appointment is not in_progress", async () => {
      const res = await request(app)
        .post(`/api/v1/appointments/${appointment1.id}/request-consumption-otp`)
        .set("Authorization", `Bearer ${ownerToken}`)
        .send({ branchId: branchA1._id.toString() });

      expect(res.status).toBe(400);
      expect(res.body.message).toContain("in_progress");
    });

    it("generates challenge, enqueues SMS without exposing raw OTP, and enforces 60s cooldown", async () => {
      // Move to in_progress
      await Appointment.findByIdAndUpdate(appointment1.id, { status: "in_progress" });

      const res = await request(app)
        .post(`/api/v1/appointments/${appointment1.id}/request-consumption-otp`)
        .set("Authorization", `Bearer ${ownerToken}`)
        .send({ branchId: branchA1._id.toString() });

      expect(res.status).toBe(200);
      expect(res.body.data.expiresIn).toBe(300);
      expect(res.body.data.resendAfter).toBe(60);
      expect(res.body.data.otp).toBeUndefined(); // Raw OTP NEVER in response

      const challenge = await SubscriptionConsumptionChallenge.findOne({
        appointmentId: appointment1.id,
      });
      expect(challenge).toBeDefined();
      expect(challenge.otpHash).toHaveLength(64); // SHA-256

      // Rapid request within 60s cooldown triggers 429
      const resCooldown = await request(app)
        .post(`/api/v1/appointments/${appointment1.id}/request-consumption-otp`)
        .set("Authorization", `Bearer ${ownerToken}`)
        .send({ branchId: branchA1._id.toString() });

      expect(resCooldown.status).toBe(429);
      expect(resCooldown.body.message).toContain("Too many OTP requests");
    });

    it("isolates challenges between two appointments for the same customer", async () => {
      await Appointment.findByIdAndUpdate(appointment1.id, { status: "in_progress" });
      await Appointment.findByIdAndUpdate(appointment2.id, { status: "in_progress" });

      // Request OTP for appointment 1
      await request(app)
        .post(`/api/v1/appointments/${appointment1.id}/request-consumption-otp`)
        .set("Authorization", `Bearer ${ownerToken}`)
        .send({ branchId: branchA1._id.toString() });

      // Request OTP for appointment 2
      await request(app)
        .post(`/api/v1/appointments/${appointment2.id}/request-consumption-otp`)
        .set("Authorization", `Bearer ${ownerToken}`)
        .send({ branchId: branchA1._id.toString() });

      const challenges = await SubscriptionConsumptionChallenge.find({
        customerId: customerA._id,
      });

      expect(challenges).toHaveLength(2);
      expect(challenges[0].appointmentId.toString()).not.toBe(challenges[1].appointmentId.toString());
    });
  });

  describe("3. Completion & Atomic Entitlement Consumption", () => {
    let activeSub, appointment;

    beforeEach(async () => {
      activeSub = await Subscription.create({
        organizationId: orgA._id,
        customerId: customerA._id,
        subscriptionCode: "SUB-COMPLETE-01",
        price: 2000,
        entitlements: [
          {
            serviceId: serviceA1._id,
            serviceName: "Classic Haircut",
            totalQuantity: 2,
            usedQuantity: 0,
            remainingQuantity: 2,
          },
          {
            serviceId: serviceA2._id,
            serviceName: "Beard Trim",
            totalQuantity: 1,
            usedQuantity: 0,
            remainingQuantity: 1,
          },
        ],
        permittedBranchIds: [branchA1._id],
        startDate: new Date("2026-01-01"),
        endDate: new Date("2026-12-31"),
        status: "active",
      });

      // Multi-service subscription appointment
      const createApt = await request(app)
        .post("/api/v1/appointments")
        .set("Authorization", `Bearer ${ownerToken}`)
        .send({
          branchId: branchA1._id.toString(),
          customerId: customerA._id.toString(),
          staffId: staffMember._id.toString(),
          services: [
            {
              serviceId: serviceA1._id.toString(),
              appliedSubscriptionId: activeSub._id.toString(),
            },
            {
              serviceId: serviceA2._id.toString(),
              appliedSubscriptionId: activeSub._id.toString(),
            },
          ],
          appointmentDate: getFutureDateStr(10),
          startTime: "11:00",
          bookingType: "advance",
        });
      appointment = createApt.body.data;
      await Appointment.findByIdAndUpdate(appointment.id, { status: "in_progress" });
    });

    it("rejects wrong OTP, tracks attempts, and exhausts after 5 tries", async () => {
      // Create challenge with known raw OTP
      const rawOtp = "445566";
      const otpHash = crypto.createHash("sha256").update(rawOtp).digest("hex");
      await SubscriptionConsumptionChallenge.create({
        organizationId: orgA._id,
        branchId: branchA1._id,
        appointmentId: appointment.id,
        subscriptionIds: [activeSub._id],
        customerId: customerA._id,
        serviceIds: [serviceA1._id, serviceA2._id],
        serviceLines: [
          {
            appointmentServiceId: appointment.services[0]._id,
            serviceId: serviceA1._id,
            appliedSubscriptionId: activeSub._id,
            customerId: customerA._id,
          },
          {
            appointmentServiceId: appointment.services[1]._id,
            serviceId: serviceA2._id,
            appliedSubscriptionId: activeSub._id,
            customerId: customerA._id,
          },
        ],
        otpHash,
        attempts: 4, // 1 attempt remaining
        resendAvailableAt: new Date(Date.now() + 60000),
        expiresAt: new Date(Date.now() + 300000),
        status: "pending",
      });

      const res = await request(app)
        .post(`/api/v1/appointments/${appointment.id}/complete-with-subscription`)
        .set("Authorization", `Bearer ${ownerToken}`)
        .send({ branchId: branchA1._id.toString(), otp: "999999" });

      expect(res.status).toBe(400);
      expect(res.body.message).toContain("Invalid OTP");

      // Now challenge should be exhausted
      const ch = await SubscriptionConsumptionChallenge.findOne({ appointmentId: appointment.id });
      expect(ch.status).toBe("exhausted");

      // Next attempt returns 429
      const resExhausted = await request(app)
        .post(`/api/v1/appointments/${appointment.id}/complete-with-subscription`)
        .set("Authorization", `Bearer ${ownerToken}`)
        .send({ branchId: branchA1._id.toString(), otp: rawOtp });

      expect(resExhausted.status).toBe(429);
      expect(resExhausted.body.message).toContain("Too many incorrect OTP attempts");
    });

    it("rejects completion if OTP challenge was generated for another customer, subscription or service", async () => {
      const otherCust = await Customer.create({
        organizationId: orgA._id,
        homeBranchId: branchA1._id,
        name: "Different Customer",
        phone: "+919811199999",
      });
      const rawOtp = "112233";
      const otpHash = crypto.createHash("sha256").update(rawOtp).digest("hex");

      // 1. Cross-customer binding test
      const chWrongCust = await SubscriptionConsumptionChallenge.create({
        organizationId: orgA._id,
        branchId: branchA1._id,
        appointmentId: appointment.id,
        subscriptionIds: [activeSub._id],
        customerId: otherCust._id, // Wrong customer
        serviceIds: [serviceA1._id, serviceA2._id],
        otpHash,
        attempts: 0,
        resendAvailableAt: new Date(Date.now() + 60000),
        expiresAt: new Date(Date.now() + 300000),
        status: "pending",
      });

      const resWrongCust = await request(app)
        .post(`/api/v1/appointments/${appointment.id}/complete-with-subscription`)
        .set("Authorization", `Bearer ${ownerToken}`)
        .send({ branchId: branchA1._id.toString(), otp: rawOtp });

      expect(resWrongCust.status).toBe(400);
      expect(resWrongCust.body.message).toContain("OTP challenge does not match the customer on this appointment");

      // 2. Mismatched subscription binding test
      await SubscriptionConsumptionChallenge.findByIdAndUpdate(chWrongCust._id, {
        customerId: customerA._id,
        subscriptionIds: [new mongoose.Types.ObjectId()], // Wrong subscription
        status: "pending",
      });

      const resWrongSub = await request(app)
        .post(`/api/v1/appointments/${appointment.id}/complete-with-subscription`)
        .set("Authorization", `Bearer ${ownerToken}`)
        .send({ branchId: branchA1._id.toString(), otp: rawOtp });

      expect(resWrongSub.status).toBe(400);
      expect(resWrongSub.body.message).toContain("OTP challenge does not match the subscriptions applied to this appointment");

      // 3. Mismatched service binding test
      await SubscriptionConsumptionChallenge.findByIdAndUpdate(chWrongCust._id, {
        subscriptionIds: [activeSub._id],
        serviceIds: [serviceA1._id], // Missing serviceA2
        serviceLines: [
          {
            appointmentServiceId: appointment.services[0]._id,
            serviceId: serviceA1._id,
            appliedSubscriptionId: activeSub._id,
            customerId: customerA._id,
          },
        ],
        status: "pending",
      });

      const resWrongService = await request(app)
        .post(`/api/v1/appointments/${appointment.id}/complete-with-subscription`)
        .set("Authorization", `Bearer ${ownerToken}`)
        .send({ branchId: branchA1._id.toString(), otp: rawOtp });

      expect(resWrongService.status).toBe(400);
      expect(resWrongService.body.message).toContain("OTP challenge does not match the services on this appointment");

      // 4. Missing customerId test
      await SubscriptionConsumptionChallenge.findByIdAndUpdate(chWrongCust._id, {
        $unset: { customerId: 1 },
        serviceIds: [serviceA1._id, serviceA2._id],
        status: "pending",
      });

      const resMissingCust = await request(app)
        .post(`/api/v1/appointments/${appointment.id}/complete-with-subscription`)
        .set("Authorization", `Bearer ${ownerToken}`)
        .send({ branchId: branchA1._id.toString(), otp: rawOtp });

      expect(resMissingCust.status).toBe(400);
      expect(resMissingCust.body.message).toContain("missing required customer binding");

      // 5. Empty subscriptionIds test
      await SubscriptionConsumptionChallenge.findByIdAndUpdate(chWrongCust._id, {
        customerId: customerA._id,
        subscriptionIds: [],
        status: "pending",
      });

      const resEmptySubs = await request(app)
        .post(`/api/v1/appointments/${appointment.id}/complete-with-subscription`)
        .set("Authorization", `Bearer ${ownerToken}`)
        .send({ branchId: branchA1._id.toString(), otp: rawOtp });

      expect(resEmptySubs.status).toBe(400);
      expect(resEmptySubs.body.message).toContain("missing required subscription bindings");

      // 6. Empty serviceIds test
      await SubscriptionConsumptionChallenge.findByIdAndUpdate(chWrongCust._id, {
        subscriptionIds: [activeSub._id],
        serviceIds: [],
        status: "pending",
      });

      const resEmptyServices = await request(app)
        .post(`/api/v1/appointments/${appointment.id}/complete-with-subscription`)
        .set("Authorization", `Bearer ${ownerToken}`)
        .send({ branchId: branchA1._id.toString(), otp: rawOtp });

      expect(resEmptyServices.status).toBe(400);
      expect(resEmptyServices.body.message).toContain("missing required service bindings");

      // 7. Substituted appointment service line test via serviceLines binding
      await SubscriptionConsumptionChallenge.findByIdAndUpdate(chWrongCust._id, {
        serviceIds: [serviceA1._id, serviceA2._id],
        serviceLines: [
          {
            appointmentServiceId: new mongoose.Types.ObjectId(), // Non-existent service line
            serviceId: serviceA1._id,
            appliedSubscriptionId: activeSub._id,
            customerId: customerA._id,
          },
          {
            appointmentServiceId: new mongoose.Types.ObjectId(),
            serviceId: serviceA2._id,
            appliedSubscriptionId: activeSub._id,
            customerId: customerA._id,
          },
        ],
        status: "pending",
      });

      const resSubstitutedLine = await request(app)
        .post(`/api/v1/appointments/${appointment.id}/complete-with-subscription`)
        .set("Authorization", `Bearer ${ownerToken}`)
        .send({ branchId: branchA1._id.toString(), otp: rawOtp });

      expect(resSubstitutedLine.status).toBe(400);
      expect(resSubstitutedLine.body.message).toContain("Appointment service line binding does not match OTP challenge");

      // 8. Service line customerId redirection / mismatch test
      await SubscriptionConsumptionChallenge.findByIdAndUpdate(chWrongCust._id, {
        serviceLines: [
          {
            appointmentServiceId: appointment.services[0]._id,
            serviceId: serviceA1._id,
            appliedSubscriptionId: activeSub._id,
            customerId: otherCust._id, // Beneficiary redirected on service line
          },
          {
            appointmentServiceId: appointment.services[1]._id,
            serviceId: serviceA2._id,
            appliedSubscriptionId: activeSub._id,
            customerId: customerA._id,
          },
        ],
        status: "pending",
      });

      const resRedirectedBeneficiary = await request(app)
        .post(`/api/v1/appointments/${appointment.id}/complete-with-subscription`)
        .set("Authorization", `Bearer ${ownerToken}`)
        .send({ branchId: branchA1._id.toString(), otp: rawOtp });

      expect(resRedirectedBeneficiary.status).toBe(400);
      expect(resRedirectedBeneficiary.body.message).toContain("Appointment service line binding does not match OTP challenge");

      // 9. Service line missing customerId rejection test
      await SubscriptionConsumptionChallenge.collection.updateOne(
        { _id: chWrongCust._id },
        {
          $set: {
            serviceLines: [
              {
                appointmentServiceId: appointment.services[0]._id,
                serviceId: serviceA1._id,
                appliedSubscriptionId: activeSub._id,
                customerId: null, // Missing customerId on service line
              },
              {
                appointmentServiceId: appointment.services[1]._id,
                serviceId: serviceA2._id,
                appliedSubscriptionId: activeSub._id,
                customerId: customerA._id,
              },
            ],
            status: "pending",
          },
        }
      );

      const resMissingLineCustomer = await request(app)
        .post(`/api/v1/appointments/${appointment.id}/complete-with-subscription`)
        .set("Authorization", `Bearer ${ownerToken}`)
        .send({ branchId: branchA1._id.toString(), otp: rawOtp });

      expect(resMissingLineCustomer.status).toBe(400);
      expect(resMissingLineCustomer.body.message).toMatch(/OTP challenge contains incomplete service line bindings|Appointment service line binding does not match OTP challenge/);

      // 10. Duplicate identical catalog services require distinct one-to-one challenge line matches
      await SubscriptionConsumptionChallenge.collection.updateOne(
        { _id: chWrongCust._id },
        {
          $set: {
            serviceLines: [
              {
                appointmentServiceId: appointment.services[0]._id,
                serviceId: serviceA1._id,
                appliedSubscriptionId: activeSub._id,
                customerId: customerA._id,
              },
              {
                appointmentServiceId: appointment.services[0]._id, // Duplicate appointmentServiceId, cannot cover second appointment line
                serviceId: serviceA1._id,
                appliedSubscriptionId: activeSub._id,
                customerId: customerA._id,
              },
            ],
            status: "pending",
          },
        }
      );

      const resDuplicateLineBinding = await request(app)
        .post(`/api/v1/appointments/${appointment.id}/complete-with-subscription`)
        .set("Authorization", `Bearer ${ownerToken}`)
        .send({ branchId: branchA1._id.toString(), otp: rawOtp });

      expect(resDuplicateLineBinding.status).toBe(400);
      expect(resDuplicateLineBinding.body.message).toContain("Appointment service line binding does not match OTP challenge");

      // Clean up test challenge
      await SubscriptionConsumptionChallenge.findByIdAndDelete(chWrongCust._id);
    });

    it("completes appointment, decrements multi-service entitlements, creates usages, and prevents replay", async () => {
      const rawOtp = "123456";
      const otpHash = crypto.createHash("sha256").update(rawOtp).digest("hex");
      await SubscriptionConsumptionChallenge.create({
        organizationId: orgA._id,
        branchId: branchA1._id,
        appointmentId: appointment.id,
        subscriptionIds: [activeSub._id],
        customerId: customerA._id,
        serviceIds: [serviceA1._id, serviceA2._id],
        serviceLines: [
          {
            appointmentServiceId: appointment.services[0]._id,
            serviceId: serviceA1._id,
            appliedSubscriptionId: activeSub._id,
            customerId: customerA._id,
          },
          {
            appointmentServiceId: appointment.services[1]._id,
            serviceId: serviceA2._id,
            appliedSubscriptionId: activeSub._id,
            customerId: customerA._id,
          },
        ],
        otpHash,
        attempts: 0,
        resendAvailableAt: new Date(Date.now() + 60000),
        expiresAt: new Date(Date.now() + 300000),
        status: "pending",
      });

      const res = await request(app)
        .post(`/api/v1/appointments/${appointment.id}/complete-with-subscription`)
        .set("Authorization", `Bearer ${ownerToken}`)
        .send({ branchId: branchA1._id.toString(), otp: rawOtp });

      expect(res.status).toBe(200);
      expect(res.body.data.status).toBe("completed");
      expect(res.body.data.completedAt).toBeDefined();
      expect(res.body.data.slotMinutes).toEqual([]);

      // Verify service lines redeemed
      const apt = await Appointment.findById(appointment.id);
      expect(apt.services[0].isRedeemedViaSubscription).toBe(true);
      expect(apt.services[0].subscriptionUsageId).toBeDefined();
      expect(apt.services[1].isRedeemedViaSubscription).toBe(true);
      expect(apt.services[1].subscriptionUsageId).toBeDefined();

      // Verify entitlements decremented correctly
      const sub = await Subscription.findById(activeSub._id);
      expect(sub.entitlements[0].remainingQuantity).toBe(1); // 2 - 1 = 1
      expect(sub.entitlements[0].usedQuantity).toBe(1);
      expect(sub.entitlements[1].remainingQuantity).toBe(0); // 1 - 1 = 0
      expect(sub.entitlements[1].usedQuantity).toBe(1);

      // Verify SubscriptionUsage records contain appointmentId
      const usages = await SubscriptionUsage.find({ appointmentId: appointment.id });
      expect(usages).toHaveLength(2);
      expect(usages[0].appointmentId.toString()).toBe(appointment.id.toString());

      // Verify AuditLogs created
      const audits = await AuditLog.find({ "metadata.appointmentId": apt._id });
      expect(audits.length).toBeGreaterThan(0);

      // Verify challenge cannot be replayed
      const resReplay = await request(app)
        .post(`/api/v1/appointments/${appointment.id}/complete-with-subscription`)
        .set("Authorization", `Bearer ${ownerToken}`)
        .send({ branchId: branchA1._id.toString(), otp: rawOtp });

      expect(resReplay.status).toBe(400); // Appointment already completed
    });

    it("prevents completing subscription appointments via ordinary status route without OTP", async () => {
      const res = await request(app)
        .patch(`/api/v1/appointments/${appointment.id}/status`)
        .set("Authorization", `Bearer ${ownerToken}`)
        .send({ branchId: branchA1._id.toString(), status: "completed" });

      expect(res.status).toBe(400);
      expect(res.body.message).toContain("must be completed via OTP verification");
    });

    it("successfully handles an appointment containing services backed by two different subscriptions", async () => {
      // Create second subscription for Customer A
      const secondSub = await Subscription.create({
        organizationId: orgA._id,
        customerId: customerA._id,
        subscriptionCode: "SUB-COMPLETE-02",
        price: 1500,
        entitlements: [
          {
            serviceId: serviceA2._id,
            serviceName: "Beard Trim",
            totalQuantity: 3,
            usedQuantity: 0,
            remainingQuantity: 3,
          },
        ],
        permittedBranchIds: [branchA1._id],
        startDate: new Date("2026-01-01"),
        endDate: new Date("2026-12-31"),
        status: "active",
      });

      // Create appointment with serviceA1 from activeSub and serviceA2 from secondSub
      const createRes = await request(app)
        .post("/api/v1/appointments")
        .set("Authorization", `Bearer ${ownerToken}`)
        .send({
          branchId: branchA1._id.toString(),
          customerId: customerA._id.toString(),
          staffId: staffMember._id.toString(),
          services: [
            {
              serviceId: serviceA1._id.toString(),
              appliedSubscriptionId: activeSub._id.toString(),
            },
            {
              serviceId: serviceA2._id.toString(),
              appliedSubscriptionId: secondSub._id.toString(),
            },
          ],
          appointmentDate: getFutureDateStr(15),
          startTime: "15:00",
          bookingType: "advance",
        });

      const multiSubApt = createRes.body.data;
      await Appointment.findByIdAndUpdate(multiSubApt.id, { status: "in_progress" });

      // Request OTP for the appointment
      const otpReq = await request(app)
        .post(`/api/v1/appointments/${multiSubApt.id}/request-consumption-otp`)
        .set("Authorization", `Bearer ${ownerToken}`)
        .send({ branchId: branchA1._id.toString() });

      expect(otpReq.status).toBe(200);

      // Verify challenge holds both subscription IDs
      const challenge = await SubscriptionConsumptionChallenge.findOne({
        appointmentId: multiSubApt.id,
      });
      expect(challenge).toBeDefined();
      expect(challenge.subscriptionIds).toHaveLength(2);
      expect(challenge.subscriptionIds.map((s) => s.toString())).toEqual(
        expect.arrayContaining([activeSub._id.toString(), secondSub._id.toString()])
      );

      // Complete with known OTP
      const testOtp = "654321";
      challenge.otpHash = crypto.createHash("sha256").update(testOtp).digest("hex");
      await challenge.save();

      const completeRes = await request(app)
        .post(`/api/v1/appointments/${multiSubApt.id}/complete-with-subscription`)
        .set("Authorization", `Bearer ${ownerToken}`)
        .send({ branchId: branchA1._id.toString(), otp: testOtp });

      expect(completeRes.status).toBe(200);
      expect(completeRes.body.data.status).toBe("completed");

      // Verify entitlements decremented across BOTH distinct subscriptions
      const freshSub1 = await Subscription.findById(activeSub._id);
      expect(freshSub1.entitlements[0].remainingQuantity).toBe(1); // 2 - 1 = 1

      const freshSub2 = await Subscription.findById(secondSub._id);
      expect(freshSub2.entitlements[0].remainingQuantity).toBe(2); // 3 - 1 = 2

      // Verify 2 usage records created, each referencing its respective subscription
      const usages = await SubscriptionUsage.find({ appointmentId: multiSubApt.id });
      expect(usages).toHaveLength(2);
      const usageSubIds = usages.map((u) => u.subscriptionId.toString());
      expect(usageSubIds).toContain(activeSub._id.toString());
      expect(usageSubIds).toContain(secondSub._id.toString());
    });

    it("atomically redeems mixed appointment: Service A (Sub A) + Service B (Sub B) + Service C (Regular)", async () => {
      // Create third service for regular non-subscription booking
      const ServiceModel = mongoose.model("Service");
      const serviceRegular = await ServiceModel.create({
        organizationId: orgA._id,
        categoryId: categoryA._id,
        name: "Head Massage (Regular)",
        duration: 30,
        pricing: { basePrice: 600, branchPricing: [] },
        tax: { applicable: false, rate: 0 },
        gender: "unisex",
        status: "active",
      });

      // Sub A with Classic Haircut
      const subA = await Subscription.create({
        organizationId: orgA._id,
        customerId: customerA._id,
        subscriptionCode: "SUB-MIXED-A",
        price: 1500,
        entitlements: [
          {
            serviceId: serviceA1._id,
            serviceName: "Classic Haircut",
            totalQuantity: 4,
            usedQuantity: 0,
            remainingQuantity: 4,
          },
        ],
        permittedBranchIds: [branchA1._id],
        startDate: new Date("2026-01-01"),
        endDate: new Date("2026-12-31"),
        status: "active",
      });

      // Sub B with Beard Trim
      const subB = await Subscription.create({
        organizationId: orgA._id,
        customerId: customerA._id,
        subscriptionCode: "SUB-MIXED-B",
        price: 1000,
        entitlements: [
          {
            serviceId: serviceA2._id,
            serviceName: "Beard Trim",
            totalQuantity: 2,
            usedQuantity: 0,
            remainingQuantity: 2,
          },
        ],
        permittedBranchIds: [branchA1._id],
        startDate: new Date("2026-01-01"),
        endDate: new Date("2026-12-31"),
        status: "active",
      });

      // Book appointment containing Service A (Sub A), Service B (Sub B), and Service C (Regular)
      const createRes = await request(app)
        .post("/api/v1/appointments")
        .set("Authorization", `Bearer ${ownerToken}`)
        .send({
          branchId: branchA1._id.toString(),
          customerId: customerA._id.toString(),
          staffId: staffMember._id.toString(),
          services: [
            {
              serviceId: serviceA1._id.toString(),
              appliedSubscriptionId: subA._id.toString(),
            },
            {
              serviceId: serviceA2._id.toString(),
              appliedSubscriptionId: subB._id.toString(),
            },
            {
              serviceId: serviceRegular._id.toString(),
              // No appliedSubscriptionId -> Regular paid service
            },
          ],
          appointmentDate: getFutureDateStr(16),
          startTime: "16:00",
          bookingType: "advance",
        });

      expect(createRes.status).toBe(201);
      const mixedApt = createRes.body.data;
      expect(mixedApt.services).toHaveLength(3);

      // Verify line snapshot statuses
      expect(mixedApt.services[0].appliedSubscriptionId).toBe(subA._id.toString());
      expect(mixedApt.services[0].isRedeemedViaSubscription).toBe(false);

      expect(mixedApt.services[1].appliedSubscriptionId).toBe(subB._id.toString());
      expect(mixedApt.services[1].isRedeemedViaSubscription).toBe(false);

      expect(mixedApt.services[2].appliedSubscriptionId).toBeNull();
      expect(mixedApt.services[2].isRedeemedViaSubscription).toBe(false);

      // Move to in_progress
      await Appointment.findByIdAndUpdate(mixedApt.id, { status: "in_progress" });

      // Request OTP
      const otpReq = await request(app)
        .post(`/api/v1/appointments/${mixedApt.id}/request-consumption-otp`)
        .set("Authorization", `Bearer ${ownerToken}`)
        .send({ branchId: branchA1._id.toString() });

      expect(otpReq.status).toBe(200);

      // Challenge covers both distinct subscription IDs (Sub A and Sub B)
      const challenge = await SubscriptionConsumptionChallenge.findOne({
        appointmentId: mixedApt.id,
      });
      expect(challenge.subscriptionIds).toHaveLength(2);
      expect(challenge.serviceIds).toHaveLength(2); // Only the 2 subscription-backed services

      // Complete with test OTP
      const testOtp = "998877";
      challenge.otpHash = crypto.createHash("sha256").update(testOtp).digest("hex");
      await challenge.save();

      const completeRes = await request(app)
        .post(`/api/v1/appointments/${mixedApt.id}/complete-with-subscription`)
        .set("Authorization", `Bearer ${ownerToken}`)
        .send({ branchId: branchA1._id.toString(), otp: testOtp });

      expect(completeRes.status).toBe(200);
      expect(completeRes.body.data.status).toBe("completed");

      // Verify Service A redeemed, Service B redeemed, Service C regular (isRedeemedViaSubscription remains false)
      const finalApt = await Appointment.findById(mixedApt.id);
      expect(finalApt.services[0].isRedeemedViaSubscription).toBe(true);
      expect(finalApt.services[0].subscriptionUsageId).toBeDefined();

      expect(finalApt.services[1].isRedeemedViaSubscription).toBe(true);
      expect(finalApt.services[1].subscriptionUsageId).toBeDefined();

      expect(finalApt.services[2].isRedeemedViaSubscription).toBe(false);
      expect(finalApt.services[2].subscriptionUsageId).toBeNull();

      // Verify Sub A decremented: 4 -> 3
      const freshSubA = await Subscription.findById(subA._id);
      expect(freshSubA.entitlements[0].remainingQuantity).toBe(3);
      expect(freshSubA.entitlements[0].usedQuantity).toBe(1);

      // Verify Sub B decremented: 2 -> 1
      const freshSubB = await Subscription.findById(subB._id);
      expect(freshSubB.entitlements[0].remainingQuantity).toBe(1);
      expect(freshSubB.entitlements[0].usedQuantity).toBe(1);

      // Verify exactly 2 SubscriptionUsage records created (none for Regular service)
      const usages = await SubscriptionUsage.find({ appointmentId: mixedApt.id });
      expect(usages).toHaveLength(2);
      const usageServiceIds = usages.map((u) => u.serviceId.toString());
      expect(usageServiceIds).toContain(serviceA1._id.toString());
      expect(usageServiceIds).toContain(serviceA2._id.toString());
      expect(usageServiceIds).not.toContain(serviceRegular._id.toString());
    });

    it("rolls back completely if any subscription entitlement cannot be consumed during multi-service completion", async () => {
      // Exhaust serviceA2 in activeSub beforehand
      await Subscription.updateOne(
        { _id: activeSub._id, "entitlements.serviceId": serviceA2._id },
        { $set: { "entitlements.$.remainingQuantity": 0 } }
      );

      const testOtp = "112233";
      await SubscriptionConsumptionChallenge.create({
        organizationId: orgA._id,
        branchId: branchA1._id,
        appointmentId: appointment.id,
        subscriptionIds: [activeSub._id],
        customerId: customerA._id,
        serviceIds: [serviceA1._id, serviceA2._id],
        otpHash: crypto.createHash("sha256").update(testOtp).digest("hex"),
        attempts: 0,
        resendAvailableAt: new Date(Date.now() + 60000),
        expiresAt: new Date(Date.now() + 300000),
        status: "pending",
      });

      const res = await request(app)
        .post(`/api/v1/appointments/${appointment.id}/complete-with-subscription`)
        .set("Authorization", `Bearer ${ownerToken}`)
        .send({ branchId: branchA1._id.toString(), otp: testOtp });

      expect([400, 409]).toContain(res.status);

      // Verify appointment is STILL in_progress
      const apt = await Appointment.findById(appointment.id);
      expect(apt.status).toBe("in_progress");
      expect(apt.services[0].isRedeemedViaSubscription).toBe(false);
      expect(apt.services[1].isRedeemedViaSubscription).toBe(false);

      // Verify no entitlements were consumed (serviceA1 remains at 2)
      const sub = await Subscription.findById(activeSub._id);
      expect(sub.entitlements[0].remainingQuantity).toBe(2);

      // Verify no usages were created
      const usages = await SubscriptionUsage.find({ appointmentId: appointment.id });
      expect(usages).toHaveLength(0);
    });

    it("verifies service pricing snapshot immutability: changing service.pricing.basePrice does not affect historical appointment line price", async () => {
      // 1. Create appointment with basePrice = serviceA1.pricing.basePrice (500)
      const resBooking = await request(app)
        .post("/api/v1/appointments")
        .set("Authorization", `Bearer ${ownerToken}`)
        .send({
          branchId: branchA1._id.toString(),
          customerId: customerA._id.toString(),
          services: [{ serviceId: serviceA1._id.toString() }],
          appointmentDate: getFutureDateStr(30),
          startTime: "10:00",
          bookingType: "advance",
        });

      expect(resBooking.status).toBe(201);
      const bookedAptId = resBooking.body.data._id;
      expect(resBooking.body.data.services[0].price).toBe(500);

      // 2. Mutate Service master basePrice to 750
      await Service.updateOne({ _id: serviceA1._id }, { $set: { "pricing.basePrice": 750 } });

      // 3. Query historical appointment and verify resolved price remains 500
      const resGet = await request(app)
        .get(`/api/v1/appointments/${bookedAptId}?branchId=${branchA1._id.toString()}`)
        .set("Authorization", `Bearer ${ownerToken}`);

      expect(resGet.status).toBe(200);
      expect(resGet.body.data.services[0].price).toBe(500);
      expect(resGet.body.data.pricing.subtotal).toBe(500);
    });

    it("customPrice overrides basePrice, and negative price is strictly rejected", async () => {
      // Negative customPrice rejected
      const negRes = await request(app)
        .post("/api/v1/appointments")
        .set("Authorization", `Bearer ${ownerToken}`)
        .send({
          branchId: branchA1._id.toString(),
          customerId: customerA._id.toString(),
          services: [{ serviceId: serviceA1._id.toString(), customPrice: -50 }],
          appointmentDate: getFutureDateStr(30),
          startTime: "11:00",
          bookingType: "advance",
        });
      expect(negRes.status).toBe(400);

      // Positive customPrice overrides basePrice
      const customRes = await request(app)
        .post("/api/v1/appointments")
        .set("Authorization", `Bearer ${ownerToken}`)
        .send({
          branchId: branchA1._id.toString(),
          customerId: customerA._id.toString(),
          services: [{ serviceId: serviceA1._id.toString(), customPrice: 175 }],
          appointmentDate: getFutureDateStr(30),
          startTime: "11:00",
          bookingType: "advance",
        });
      expect(customRes.status).toBe(201);
      expect(customRes.body.data.services[0].price).toBe(175);
      expect(customRes.body.data.pricing.subtotal).toBe(175);
    });

    it("deterministically auto-selects earliest-expiring subscription when customer owns multiple subscriptions for same service", async () => {
      // Create Subscription A (expires in 10 days, remaining 2)
      const subEarliest = await Subscription.create({
        organizationId: orgA._id,
        customerId: customerA._id,
        subscriptionCode: "SUB-EARLIEST-01",
        price: 500,
        startDate: new Date(),
        endDate: new Date(Date.now() + 10 * 86400000), // 10 days
        status: "active",
        permittedBranchIds: [branchA1._id],
        entitlements: [{
          serviceId: serviceA1._id,
          serviceName: serviceA1.name,
          totalQuantity: 2,
          usedQuantity: 0,
          remainingQuantity: 2,
        }],
      });

      // Create Subscription B (expires in 60 days, remaining 5)
      const subLater = await Subscription.create({
        organizationId: orgA._id,
        customerId: customerA._id,
        subscriptionCode: "SUB-LATER-01",
        price: 1200,
        startDate: new Date(),
        endDate: new Date(Date.now() + 60 * 86400000), // 60 days
        status: "active",
        permittedBranchIds: [branchA1._id],
        entitlements: [{
          serviceId: serviceA1._id,
          serviceName: serviceA1.name,
          totalQuantity: 5,
          usedQuantity: 0,
          remainingQuantity: 5,
        }],
      });

      // Book with appliedSubscriptionId: "auto"
      const resAuto = await request(app)
        .post("/api/v1/appointments")
        .set("Authorization", `Bearer ${ownerToken}`)
        .send({
          branchId: branchA1._id.toString(),
          customerId: customerA._id.toString(),
          services: [{ serviceId: serviceA1._id.toString(), appliedSubscriptionId: "auto" }],
          appointmentDate: getFutureDateStr(30),
          startTime: "14:00",
          bookingType: "advance",
        });

      expect(resAuto.status).toBe(201);
      // Deterministic selection rule: subEarliest must be chosen!
      expect(resAuto.body.data.services[0].appliedSubscriptionId).toBe(subEarliest._id.toString());
    });

    it("subscription coverage does NOT turn service economic price into 0 in appointment snapshot or billing subtotal", async () => {
      // 1. Create appointment covered by activeSub
      const res = await request(app)
        .post("/api/v1/appointments")
        .set("Authorization", `Bearer ${ownerToken}`)
        .send({
          branchId: branchA1._id.toString(),
          customerId: customerA._id.toString(),
          services: [
            {
              serviceId: serviceA1._id.toString(), // basePrice 500
              appliedSubscriptionId: activeSub._id.toString(),
            },
          ],
          appointmentDate: getFutureDateStr(30),
          startTime: "16:00",
          bookingType: "advance",
        });

      expect(res.status).toBe(201);
      const apt = res.body.data;

      // Economic price is preserved at catalog basePrice (500), not zeroed out
      expect(apt.services[0].price).toBe(500);
      expect(apt.pricing.subtotal).toBe(500);
      expect(apt.pricing.total).toBe(500);
    });

    it("concurrent completion requests cannot double-consume entitlements or duplicate appointment completion", async () => {
      // Create new appointment in_progress with 1 entitlement needed
      const createApt = await request(app)
        .post("/api/v1/appointments")
        .set("Authorization", `Bearer ${ownerToken}`)
        .send({
          branchId: branchA1._id.toString(),
          customerId: customerA._id.toString(),
          services: [
            {
              serviceId: serviceA1._id.toString(),
              appliedSubscriptionId: activeSub._id.toString(),
            },
          ],
          appointmentDate: getFutureDateStr(31),
          startTime: "11:00",
          bookingType: "advance",
        });

      const concurrentApt = createApt.body.data;
      await Appointment.findByIdAndUpdate(concurrentApt.id, { status: "in_progress" });

      const testOtp = "778899";
      await SubscriptionConsumptionChallenge.create({
        organizationId: orgA._id,
        branchId: branchA1._id,
        appointmentId: concurrentApt.id,
        subscriptionIds: [activeSub._id],
        customerId: customerA._id,
        serviceIds: [serviceA1._id],
        serviceLines: [
          {
            appointmentServiceId: concurrentApt.services[0]._id,
            serviceId: serviceA1._id,
            appliedSubscriptionId: activeSub._id,
            customerId: customerA._id,
          },
        ],
        otpHash: crypto.createHash("sha256").update(testOtp).digest("hex"),
        attempts: 0,
        resendAvailableAt: new Date(Date.now() + 60000),
        expiresAt: new Date(Date.now() + 300000),
        status: "pending",
      });

      const subBefore = await Subscription.findById(activeSub._id);
      const remainingBefore = subBefore.entitlements[0].remainingQuantity;

      // Fire 2 concurrent requests
      const [res1, res2] = await Promise.all([
        request(app)
          .post(`/api/v1/appointments/${concurrentApt.id}/complete-with-subscription`)
          .set("Authorization", `Bearer ${ownerToken}`)
          .send({ branchId: branchA1._id.toString(), otp: testOtp }),
        request(app)
          .post(`/api/v1/appointments/${concurrentApt.id}/complete-with-subscription`)
          .set("Authorization", `Bearer ${ownerToken}`)
          .send({ branchId: branchA1._id.toString(), otp: testOtp }),
      ]);

      const statuses = [res1.status, res2.status];
      // Exactly 1 must succeed with 200, the other must be rejected (400 or 409)
      expect(statuses).toContain(200);
      expect(statuses.some((s) => s === 400 || s === 409)).toBe(true);

      // Verify entitlement was decremented by exactly 1
      const subAfter = await Subscription.findById(activeSub._id);
      expect(subAfter.entitlements[0].remainingQuantity).toBe(remainingBefore - 1);

      // Verify exactly 1 usage record exists for this appointment
      const usages = await SubscriptionUsage.find({ appointmentId: concurrentApt.id });
      expect(usages).toHaveLength(1);
    });
  });

  describe("4. Regression Suite: Subscription Selection vs. Actual Redemption Semantics", () => {
    it("proves selection of subscription during booking & editing assigns coverage without decrementing entitlements or falsely marking redemption", async () => {
      // 1. Create active subscription with 2 entitlements
      const sub = await Subscription.create({
        organizationId: orgA._id,
        customerId: customerA._id,
        subscriptionCode: `SUB-SEM-${Date.now()}`,
        price: 1500,
        entitlements: [
          {
            serviceId: serviceA1._id,
            serviceName: "Classic Haircut",
            totalQuantity: 2,
            usedQuantity: 0,
            remainingQuantity: 2,
          },
        ],
        permittedBranchIds: [branchA1._id],
        startDate: new Date("2026-01-01"),
        endDate: new Date("2026-12-31"),
        status: "active",
      });

      // 2. Create appointment selecting the subscription
      const createRes = await request(app)
        .post("/api/v1/appointments")
        .set("Authorization", `Bearer ${ownerToken}`)
        .send({
          branchId: branchA1._id.toString(),
          customerId: customerA._id.toString(),
          staffId: staffMember._id.toString(),
          services: [
            {
              serviceId: serviceA1._id.toString(),
              appliedSubscriptionId: sub._id.toString(),
            },
          ],
          appointmentDate: getFutureDateStr(35),
          startTime: "10:00",
          bookingType: "advance",
        });

      expect(createRes.status).toBe(201);
      const bookedService = createRes.body.data.services[0];
      expect(bookedService.appliedSubscriptionId).toBe(sub._id.toString());
      expect(bookedService.isRedeemedViaSubscription).toBe(false);
      expect(bookedService.subscriptionUsageId).toBeNull();

      // Entitlements intact
      let subDoc = await Subscription.findById(sub._id);
      expect(subDoc.entitlements[0].remainingQuantity).toBe(2);
      expect(subDoc.entitlements[0].usedQuantity).toBe(0);

      // 3. Edit appointment services (update / preview & commit lifecycle)
      const editRes = await request(app)
        .put(`/api/v1/appointments/${createRes.body.data._id}`)
        .set("Authorization", `Bearer ${ownerToken}`)
        .send({
          branchId: branchA1._id.toString(),
          services: [
            {
              serviceId: serviceA1._id.toString(),
              appliedSubscriptionId: sub._id.toString(),
            },
          ],
        });

      expect(editRes.status).toBe(200);
      const editedService = editRes.body.data.services[0];
      expect(editedService.appliedSubscriptionId).toBe(sub._id.toString());
      expect(editedService.isRedeemedViaSubscription).toBe(false);
      expect(editedService.subscriptionUsageId).toBeNull();

      // Entitlements still intact and no usage records
      subDoc = await Subscription.findById(sub._id);
      expect(subDoc.entitlements[0].remainingQuantity).toBe(2);
      const usageCount = await SubscriptionUsage.countDocuments({ subscriptionId: sub._id });
      expect(usageCount).toBe(0);
    });

    it("proves createInvoiceFromAppointment applies eligible coverage without consuming entitlements or creating usage", async () => {
      const sub = await Subscription.create({
        organizationId: orgA._id,
        customerId: customerA._id,
        subscriptionCode: `SUB-INV-${Date.now()}`,
        price: 1500,
        entitlements: [
          {
            serviceId: serviceA1._id,
            serviceName: "Classic Haircut",
            totalQuantity: 2,
            usedQuantity: 0,
            remainingQuantity: 2,
          },
        ],
        permittedBranchIds: [branchA1._id],
        startDate: new Date("2026-01-01"),
        endDate: new Date("2026-12-31"),
        status: "active",
      });

      const appointment = await Appointment.create({
        organizationId: orgA._id,
        branchId: branchA1._id,
        appointmentCode: `APT-INV-${Date.now()}`,
        customerId: customerA._id,
        staffId: staffMember._id,
        appointmentDate: getFutureDateStr(36),
        startTime: "11:00",
        endTime: "11:30",
        startAt: new Date(),
        endAt: new Date(Date.now() + 1800000),
        bookingType: "advance",
        status: "scheduled",
        totalDuration: 30,
        services: [
          {
            serviceType: "registered",
            serviceId: serviceA1._id,
            name: "Classic Haircut",
            duration: 30,
            price: 500,
            appliedSubscriptionId: sub._id,
            isRedeemedViaSubscription: false,
            subscriptionUsageId: null,
          },
        ],
        pricing: { subtotal: 500, discount: 0, total: 500 },
      });

      // Create draft invoice from appointment
      const invoiceRes = await request(app)
        .post("/api/v1/billing/invoices")
        .set("Authorization", `Bearer ${ownerToken}`)
        .send({
          branchId: branchA1._id.toString(),
          appointmentId: appointment._id.toString(),
        });

      expect(invoiceRes.status).toBe(201);
      const invoice = invoiceRes.body.data;
      expect(invoice.lines[0].isCoveredBySubscription).toBe(true);
      expect(invoice.lines[0].subscriptionCoveredAmount).toBe(500);
      expect(invoice.lines[0].customerPayable).toBe(0);
      expect(invoice.payableAmount).toBe(0);

      // Verify that invoice creation did NOT consume subscription balance
      const subDoc = await Subscription.findById(sub._id);
      expect(subDoc.entitlements[0].remainingQuantity).toBe(2);
      expect(subDoc.entitlements[0].usedQuantity).toBe(0);

      const usageCount = await SubscriptionUsage.countDocuments({ subscriptionId: sub._id });
      expect(usageCount).toBe(0);

      // Appointment service record remains unconsumed
      const aptDoc = await Appointment.findById(appointment._id);
      expect(aptDoc.services[0].isRedeemedViaSubscription).toBe(false);
      expect(aptDoc.services[0].subscriptionUsageId).toBeNull();
    });

    it("proves OTP-verified completion records actual consumption exactly once and repeated completion cannot double-consume", async () => {
      const sub = await Subscription.create({
        organizationId: orgA._id,
        customerId: customerA._id,
        subscriptionCode: `SUB-EXEC-${Date.now()}`,
        price: 1500,
        entitlements: [
          {
            serviceId: serviceA1._id,
            serviceName: "Classic Haircut",
            totalQuantity: 3,
            usedQuantity: 0,
            remainingQuantity: 3,
          },
        ],
        permittedBranchIds: [branchA1._id],
        startDate: new Date("2026-01-01"),
        endDate: new Date("2026-12-31"),
        status: "active",
      });

      const appointment = await Appointment.create({
        organizationId: orgA._id,
        branchId: branchA1._id,
        appointmentCode: `APT-EXEC-${Date.now()}`,
        customerId: customerA._id,
        staffId: staffMember._id,
        appointmentDate: getFutureDateStr(37),
        startTime: "12:00",
        endTime: "12:30",
        startAt: new Date(),
        endAt: new Date(Date.now() + 1800000),
        bookingType: "advance",
        status: "in_progress",
        totalDuration: 30,
        services: [
          {
            serviceType: "registered",
            serviceId: serviceA1._id,
            name: "Classic Haircut",
            duration: 30,
            price: 500,
            appliedSubscriptionId: sub._id,
            isRedeemedViaSubscription: false,
            subscriptionUsageId: null,
          },
        ],
        pricing: { subtotal: 500, discount: 0, total: 500 },
      });

      const testOtp = "778899";
      await SubscriptionConsumptionChallenge.create({
        organizationId: orgA._id,
        branchId: branchA1._id,
        appointmentId: appointment._id,
        subscriptionIds: [sub._id],
        customerId: customerA._id,
        serviceIds: [serviceA1._id],
        serviceLines: [
          {
            appointmentServiceId: appointment.services[0]._id,
            serviceId: serviceA1._id,
            appliedSubscriptionId: sub._id,
            customerId: customerA._id,
          },
        ],
        otpHash: crypto.createHash("sha256").update(testOtp).digest("hex"),
        attempts: 0,
        resendAvailableAt: new Date(Date.now() + 60000),
        expiresAt: new Date(Date.now() + 300000),
        status: "pending",
      });

      // 1st completion attempt: should succeed and consume entitlement exactly once
      const compRes1 = await request(app)
        .post(`/api/v1/appointments/${appointment._id}/complete-with-subscription`)
        .set("Authorization", `Bearer ${ownerToken}`)
        .send({ branchId: branchA1._id.toString(), otp: testOtp });

      expect(compRes1.status).toBe(200);
      expect(compRes1.body.data.status).toBe("completed");
      expect(compRes1.body.data.services[0].isRedeemedViaSubscription).toBe(true);
      expect(compRes1.body.data.services[0].subscriptionUsageId).toBeDefined();

      const subAfter1 = await Subscription.findById(sub._id);
      expect(subAfter1.entitlements[0].remainingQuantity).toBe(2);
      expect(subAfter1.entitlements[0].usedQuantity).toBe(1);

      const usagesAfter1 = await SubscriptionUsage.find({ appointmentId: appointment._id });
      expect(usagesAfter1).toHaveLength(1);
      expect(usagesAfter1[0].serviceId.toString()).toBe(serviceA1._id.toString());

      // 2nd completion attempt: must be strictly rejected and CANNOT consume twice
      const compRes2 = await request(app)
        .post(`/api/v1/appointments/${appointment._id}/complete-with-subscription`)
        .set("Authorization", `Bearer ${ownerToken}`)
        .send({ branchId: branchA1._id.toString(), otp: testOtp });

      expect(compRes2.status).toBe(400);

      // Verify entitlement balance remained untouched (still remaining: 2, used: 1)
      const subAfter2 = await Subscription.findById(sub._id);
      expect(subAfter2.entitlements[0].remainingQuantity).toBe(2);
      expect(subAfter2.entitlements[0].usedQuantity).toBe(1);

      // Verify no duplicate usage record created
      const usagesAfter2 = await SubscriptionUsage.find({ appointmentId: appointment._id });
      expect(usagesAfter2).toHaveLength(1);
    });

    it("proves existing completed appointments retain correct historical billing and redemption data", async () => {
      const historicalSubId = new mongoose.Types.ObjectId();
      const historicalUsageId = new mongoose.Types.ObjectId();

      const completedApt = await Appointment.create({
        organizationId: orgA._id,
        branchId: branchA1._id,
        appointmentCode: `APT-HIST-${Date.now()}`,
        customerId: customerA._id,
        staffId: staffMember._id,
        appointmentDate: "2026-01-15",
        startTime: "14:00",
        endTime: "14:30",
        startAt: new Date("2026-01-15T14:00:00Z"),
        endAt: new Date("2026-01-15T14:30:00Z"),
        bookingType: "advance",
        status: "completed",
        totalDuration: 30,
        services: [
          {
            serviceType: "registered",
            serviceId: serviceA1._id,
            name: "Classic Haircut",
            duration: 30,
            price: 500,
            appliedSubscriptionId: historicalSubId,
            isRedeemedViaSubscription: true,
            subscriptionUsageId: historicalUsageId,
          },
        ],
        pricing: { subtotal: 500, discount: 0, total: 500 },
      });

      // Fetch via GET /appointments/:id
      const getRes = await request(app)
        .get(`/api/v1/appointments/${completedApt._id}?branchId=${branchA1._id.toString()}`)
        .set("Authorization", `Bearer ${ownerToken}`);

      expect(getRes.status).toBe(200);
      const svc = getRes.body.data.services[0];
      expect(svc.isRedeemedViaSubscription).toBe(true);
      expect(svc.appliedSubscriptionId.toString()).toBe(historicalSubId.toString());
      expect(svc.subscriptionUsageId.toString()).toBe(historicalUsageId.toString());

      // Create invoice from already completed appointment with historical redemption
      const invRes = await request(app)
        .post("/api/v1/billing/invoices")
        .set("Authorization", `Bearer ${ownerToken}`)
        .send({
          branchId: branchA1._id.toString(),
          appointmentId: completedApt._id.toString(),
        });

      expect(invRes.status).toBe(201);
      const invLine = invRes.body.data.lines[0];
      expect(invLine.isCoveredBySubscription).toBe(true);
      expect(invLine.appliedSubscriptionId.toString()).toBe(historicalSubId.toString());
      expect(invLine.subscriptionUsageId.toString()).toBe(historicalUsageId.toString());
      expect(invLine.subscriptionCoveredAmount).toBe(500);
      expect(invLine.customerPayable).toBe(0);
    });
  });

  describe("5. Exact Service-Line Validation — Fail Closed Regression Suite", () => {
    let testApt;
    let testSub;
    let testSub2;
    const testOtp = "123456";
    const otpHash = crypto.createHash("sha256").update(testOtp).digest("hex");

    beforeEach(async () => {
      // Create subscription for customerA covering serviceA1 and serviceA2
      testSub = await Subscription.create({
        organizationId: orgA._id,
        branchId: branchA1._id,
        subscriptionCode: `SUB-TEST-${Date.now()}-${Math.floor(Math.random() * 1000)}`,
        price: 1000,
        customerId: customerA._id,
        startDate: new Date(),
        endDate: new Date(Date.now() + 30 * 24 * 60 * 60 * 1000),
        status: "active",
        entitlements: [
          {
            serviceId: serviceA1._id,
            serviceName: "Classic Haircut",
            totalQuantity: 5,
            usedQuantity: 0,
            remainingQuantity: 5,
          },
          {
            serviceId: serviceA2._id,
            serviceName: "Beard Trim",
            totalQuantity: 5,
            usedQuantity: 0,
            remainingQuantity: 5,
          },
        ],
        permittedBranchIds: [branchA1._id],
      });

      testSub2 = await Subscription.create({
        organizationId: orgA._id,
        branchId: branchA1._id,
        subscriptionCode: `SUB-TEST2-${Date.now()}-${Math.floor(Math.random() * 1000)}`,
        price: 1000,
        customerId: customerA._id,
        startDate: new Date(),
        endDate: new Date(Date.now() + 30 * 24 * 60 * 60 * 1000),
        status: "active",
        entitlements: [
          {
            serviceId: serviceA1._id,
            serviceName: "Classic Haircut",
            totalQuantity: 5,
            usedQuantity: 0,
            remainingQuantity: 5,
          },
        ],
        permittedBranchIds: [branchA1._id],
      });

      // Create in-progress appointment with 2 subscription service lines
      testApt = await Appointment.create({
        organizationId: orgA._id,
        branchId: branchA1._id,
        appointmentCode: `APT-VAL-${Date.now()}-${Math.floor(Math.random() * 1000)}`,
        customerId: customerA._id,
        staffId: staffMember._id,
        appointmentDate: "2026-05-10",
        startTime: "10:00",
        endTime: "11:00",
        startAt: new Date("2026-05-10T10:00:00Z"),
        endAt: new Date("2026-05-10T11:00:00Z"),
        bookingType: "advance",
        status: "in_progress",
        totalDuration: 60,
        services: [
          {
            serviceType: "registered",
            serviceId: serviceA1._id,
            name: "Classic Haircut",
            duration: 30,
            price: 500,
            appliedSubscriptionId: testSub._id,
            isRedeemedViaSubscription: false,
            subscriptionUsageId: null,
          },
          {
            serviceType: "registered",
            serviceId: serviceA2._id,
            name: "Beard Trim",
            duration: 30,
            price: 300,
            appliedSubscriptionId: testSub._id,
            isRedeemedViaSubscription: false,
            subscriptionUsageId: null,
          },
        ],
        pricing: { subtotal: 800, discount: 0, total: 800 },
      });
    });

    afterEach(async () => {
      await SubscriptionConsumptionChallenge.deleteMany({ appointmentId: testApt._id });
    });

    // 1. Missing serviceLines
    it("1. rejects completion if challenge.serviceLines is missing entirely", async () => {
      await SubscriptionConsumptionChallenge.create({
        organizationId: orgA._id,
        branchId: branchA1._id,
        appointmentId: testApt._id,
        customerId: customerA._id,
        subscriptionIds: [testSub._id],
        serviceIds: [serviceA1._id, serviceA2._id],
        otpHash,
        status: "pending",
        attempts: 0,
        resendAvailableAt: new Date(Date.now() + 60000),
        expiresAt: new Date(Date.now() + 300000),
      });

      const res = await request(app)
        .post(`/api/v1/appointments/${testApt._id}/complete-with-subscription`)
        .set("Authorization", `Bearer ${ownerToken}`)
        .send({ branchId: branchA1._id.toString(), otp: testOtp });

      expect(res.status).toBe(400);
      expect(res.body.message).toContain("OTP challenge is missing required service line bindings");

      // Assert non-completion and untouched entitlements
      const aptAfter = await Appointment.findById(testApt._id);
      expect(aptAfter.status).toBe("in_progress");
      expect(aptAfter.services[0].isRedeemedViaSubscription).toBe(false);
      expect(aptAfter.services[1].isRedeemedViaSubscription).toBe(false);

      const subAfter = await Subscription.findById(testSub._id);
      expect(subAfter.entitlements[0].remainingQuantity).toBe(5);
      expect(subAfter.entitlements[0].usedQuantity).toBe(0);
      expect(subAfter.entitlements[1].remainingQuantity).toBe(5);
      expect(subAfter.entitlements[1].usedQuantity).toBe(0);
    });

    // 2. Empty serviceLines
    it("2. rejects completion if challenge.serviceLines is an empty array", async () => {
      await SubscriptionConsumptionChallenge.create({
        organizationId: orgA._id,
        branchId: branchA1._id,
        appointmentId: testApt._id,
        customerId: customerA._id,
        subscriptionIds: [testSub._id],
        serviceIds: [serviceA1._id, serviceA2._id],
        serviceLines: [],
        otpHash,
        status: "pending",
        attempts: 0,
        resendAvailableAt: new Date(Date.now() + 60000),
        expiresAt: new Date(Date.now() + 300000),
      });

      const res = await request(app)
        .post(`/api/v1/appointments/${testApt._id}/complete-with-subscription`)
        .set("Authorization", `Bearer ${ownerToken}`)
        .send({ branchId: branchA1._id.toString(), otp: testOtp });

      expect(res.status).toBe(400);
      expect(res.body.message).toContain("OTP challenge is missing required service line bindings");

      // Assert non-completion and untouched entitlements
      const aptAfter = await Appointment.findById(testApt._id);
      expect(aptAfter.status).toBe("in_progress");
      expect(aptAfter.services[0].isRedeemedViaSubscription).toBe(false);
      expect(aptAfter.services[1].isRedeemedViaSubscription).toBe(false);

      const subAfter = await Subscription.findById(testSub._id);
      expect(subAfter.entitlements[0].remainingQuantity).toBe(5);
      expect(subAfter.entitlements[0].usedQuantity).toBe(0);
      expect(subAfter.entitlements[1].remainingQuantity).toBe(5);
      expect(subAfter.entitlements[1].usedQuantity).toBe(0);
    });

    // 3. Incorrect line count
    it("3. rejects completion if challenge.serviceLines count differs from appointment subscription lines", async () => {
      await SubscriptionConsumptionChallenge.create({
        organizationId: orgA._id,
        branchId: branchA1._id,
        appointmentId: testApt._id,
        customerId: customerA._id,
        subscriptionIds: [testSub._id],
        serviceIds: [serviceA1._id, serviceA2._id],
        serviceLines: [
          {
            appointmentServiceId: testApt.services[0]._id,
            serviceId: serviceA1._id,
            appliedSubscriptionId: testSub._id,
            customerId: customerA._id,
          },
        ], // Only 1 line for 2 appointment subscription lines
        otpHash,
        status: "pending",
        attempts: 0,
        resendAvailableAt: new Date(Date.now() + 60000),
        expiresAt: new Date(Date.now() + 300000),
      });

      const res = await request(app)
        .post(`/api/v1/appointments/${testApt._id}/complete-with-subscription`)
        .set("Authorization", `Bearer ${ownerToken}`)
        .send({ branchId: branchA1._id.toString(), otp: testOtp });

      expect(res.status).toBe(400);
      expect(res.body.message).toContain("Appointment service lines do not match OTP challenge");

      // Assert non-completion and untouched entitlements
      const aptAfter = await Appointment.findById(testApt._id);
      expect(aptAfter.status).toBe("in_progress");
      expect(aptAfter.services[0].isRedeemedViaSubscription).toBe(false);
      expect(aptAfter.services[1].isRedeemedViaSubscription).toBe(false);

      const subAfter = await Subscription.findById(testSub._id);
      expect(subAfter.entitlements[0].remainingQuantity).toBe(5);
      expect(subAfter.entitlements[0].usedQuantity).toBe(0);
      expect(subAfter.entitlements[1].remainingQuantity).toBe(5);
      expect(subAfter.entitlements[1].usedQuantity).toBe(0);
    });

    // 4. Missing customerId on line
    it("4. rejects completion if any challenge service line is missing customerId", async () => {
      const challenge = await SubscriptionConsumptionChallenge.create({
        organizationId: orgA._id,
        branchId: branchA1._id,
        appointmentId: testApt._id,
        customerId: customerA._id,
        subscriptionIds: [testSub._id],
        serviceIds: [serviceA1._id, serviceA2._id],
        serviceLines: [
          {
            appointmentServiceId: testApt.services[0]._id,
            serviceId: serviceA1._id,
            appliedSubscriptionId: testSub._id,
            customerId: customerA._id,
          },
          {
            appointmentServiceId: testApt.services[1]._id,
            serviceId: serviceA2._id,
            appliedSubscriptionId: testSub._id,
            customerId: customerA._id,
          },
        ],
        otpHash,
        status: "pending",
        attempts: 0,
        resendAvailableAt: new Date(Date.now() + 60000),
        expiresAt: new Date(Date.now() + 300000),
      });

      // Remove customerId on second line directly via collection update
      await SubscriptionConsumptionChallenge.collection.updateOne(
        { _id: challenge._id },
        { $unset: { "serviceLines.1.customerId": 1 } }
      );

      const res = await request(app)
        .post(`/api/v1/appointments/${testApt._id}/complete-with-subscription`)
        .set("Authorization", `Bearer ${ownerToken}`)
        .send({ branchId: branchA1._id.toString(), otp: testOtp });

      expect(res.status).toBe(400);
      expect(res.body.message).toContain("OTP challenge contains incomplete service line bindings");

      // Assert non-completion and untouched entitlements
      const aptAfter = await Appointment.findById(testApt._id);
      expect(aptAfter.status).toBe("in_progress");
      expect(aptAfter.services[0].isRedeemedViaSubscription).toBe(false);
      expect(aptAfter.services[1].isRedeemedViaSubscription).toBe(false);

      const subAfter = await Subscription.findById(testSub._id);
      expect(subAfter.entitlements[0].remainingQuantity).toBe(5);
      expect(subAfter.entitlements[0].usedQuantity).toBe(0);
      expect(subAfter.entitlements[1].remainingQuantity).toBe(5);
      expect(subAfter.entitlements[1].usedQuantity).toBe(0);
    });

    // 5. Wrong appointment service-line ID
    it("5. rejects completion if challenge service line references a wrong appointmentServiceId", async () => {
      await SubscriptionConsumptionChallenge.create({
        organizationId: orgA._id,
        branchId: branchA1._id,
        appointmentId: testApt._id,
        customerId: customerA._id,
        subscriptionIds: [testSub._id],
        serviceIds: [serviceA1._id, serviceA2._id],
        serviceLines: [
          {
            appointmentServiceId: testApt.services[0]._id,
            serviceId: serviceA1._id,
            appliedSubscriptionId: testSub._id,
            customerId: customerA._id,
          },
          {
            appointmentServiceId: new mongoose.Types.ObjectId(), // Wrong line id
            serviceId: serviceA2._id,
            appliedSubscriptionId: testSub._id,
            customerId: customerA._id,
          },
        ],
        otpHash,
        status: "pending",
        attempts: 0,
        resendAvailableAt: new Date(Date.now() + 60000),
        expiresAt: new Date(Date.now() + 300000),
      });

      const res = await request(app)
        .post(`/api/v1/appointments/${testApt._id}/complete-with-subscription`)
        .set("Authorization", `Bearer ${ownerToken}`)
        .send({ branchId: branchA1._id.toString(), otp: testOtp });

      expect(res.status).toBe(400);
      expect(res.body.message).toContain("Appointment service line binding does not match OTP challenge");

      // Assert non-completion and untouched entitlements
      const aptAfter = await Appointment.findById(testApt._id);
      expect(aptAfter.status).toBe("in_progress");
      expect(aptAfter.services[0].isRedeemedViaSubscription).toBe(false);
      expect(aptAfter.services[1].isRedeemedViaSubscription).toBe(false);

      const subAfter = await Subscription.findById(testSub._id);
      expect(subAfter.entitlements[0].remainingQuantity).toBe(5);
      expect(subAfter.entitlements[0].usedQuantity).toBe(0);
      expect(subAfter.entitlements[1].remainingQuantity).toBe(5);
      expect(subAfter.entitlements[1].usedQuantity).toBe(0);
    });

    // 6. Wrong applied subscription ID
    it("6. rejects completion if challenge service line references a wrong appliedSubscriptionId", async () => {
      await SubscriptionConsumptionChallenge.create({
        organizationId: orgA._id,
        branchId: branchA1._id,
        appointmentId: testApt._id,
        customerId: customerA._id,
        subscriptionIds: [testSub._id, testSub2._id],
        serviceIds: [serviceA1._id, serviceA2._id],
        serviceLines: [
          {
            appointmentServiceId: testApt.services[0]._id,
            serviceId: serviceA1._id,
            appliedSubscriptionId: testSub2._id, // Wrong subscription for line 0 (which has testSub)
            customerId: customerA._id,
          },
          {
            appointmentServiceId: testApt.services[1]._id,
            serviceId: serviceA2._id,
            appliedSubscriptionId: testSub._id,
            customerId: customerA._id,
          },
        ],
        otpHash,
        status: "pending",
        attempts: 0,
        resendAvailableAt: new Date(Date.now() + 60000),
        expiresAt: new Date(Date.now() + 300000),
      });

      const res = await request(app)
        .post(`/api/v1/appointments/${testApt._id}/complete-with-subscription`)
        .set("Authorization", `Bearer ${ownerToken}`)
        .send({ branchId: branchA1._id.toString(), otp: testOtp });

      expect(res.status).toBe(400);
      expect(res.body.message).toContain("Appointment service line binding does not match OTP challenge");

      // Assert non-completion and untouched entitlements
      const aptAfter = await Appointment.findById(testApt._id);
      expect(aptAfter.status).toBe("in_progress");
      expect(aptAfter.services[0].isRedeemedViaSubscription).toBe(false);
      expect(aptAfter.services[1].isRedeemedViaSubscription).toBe(false);

      const subAfter = await Subscription.findById(testSub._id);
      expect(subAfter.entitlements[0].remainingQuantity).toBe(5);
      expect(subAfter.entitlements[0].usedQuantity).toBe(0);
      expect(subAfter.entitlements[1].remainingQuantity).toBe(5);
      expect(subAfter.entitlements[1].usedQuantity).toBe(0);
    });

    // 7. Wrong customer ID
    it("7. rejects completion if challenge service line customerId does not match appointment beneficiary customer", async () => {
      const otherCust = await Customer.create({
        organizationId: orgA._id,
        homeBranchId: branchA1._id,
        name: "Mismatch Line Beneficiary",
        phone: "+919999900011",
      });

      await SubscriptionConsumptionChallenge.create({
        organizationId: orgA._id,
        branchId: branchA1._id,
        appointmentId: testApt._id,
        customerId: customerA._id,
        subscriptionIds: [testSub._id],
        serviceIds: [serviceA1._id, serviceA2._id],
        serviceLines: [
          {
            appointmentServiceId: testApt.services[0]._id,
            serviceId: serviceA1._id,
            appliedSubscriptionId: testSub._id,
            customerId: customerA._id,
          },
          {
            appointmentServiceId: testApt.services[1]._id,
            serviceId: serviceA2._id,
            appliedSubscriptionId: testSub._id,
            customerId: otherCust._id, // Wrong beneficiary customer on line 1
          },
        ],
        otpHash,
        status: "pending",
        attempts: 0,
        resendAvailableAt: new Date(Date.now() + 60000),
        expiresAt: new Date(Date.now() + 300000),
      });

      const res = await request(app)
        .post(`/api/v1/appointments/${testApt._id}/complete-with-subscription`)
        .set("Authorization", `Bearer ${ownerToken}`)
        .send({ branchId: branchA1._id.toString(), otp: testOtp });

      expect(res.status).toBe(400);
      expect(res.body.message).toContain("Appointment service line binding does not match OTP challenge");

      // Assert non-completion and untouched entitlements
      const aptAfter = await Appointment.findById(testApt._id);
      expect(aptAfter.status).toBe("in_progress");
      expect(aptAfter.services[0].isRedeemedViaSubscription).toBe(false);
      expect(aptAfter.services[1].isRedeemedViaSubscription).toBe(false);

      const subAfter = await Subscription.findById(testSub._id);
      expect(subAfter.entitlements[0].remainingQuantity).toBe(5);
      expect(subAfter.entitlements[0].usedQuantity).toBe(0);
      expect(subAfter.entitlements[1].remainingQuantity).toBe(5);
      expect(subAfter.entitlements[1].usedQuantity).toBe(0);
    });

    // 8. Duplicate challenge-line reuse
    it("8. rejects completion if a challenge line is reused for multiple appointment lines", async () => {
      await SubscriptionConsumptionChallenge.create({
        organizationId: orgA._id,
        branchId: branchA1._id,
        appointmentId: testApt._id,
        customerId: customerA._id,
        subscriptionIds: [testSub._id],
        serviceIds: [serviceA1._id, serviceA2._id],
        serviceLines: [
          {
            appointmentServiceId: testApt.services[0]._id,
            serviceId: serviceA1._id,
            appliedSubscriptionId: testSub._id,
            customerId: customerA._id,
          },
          {
            // Reusing appointmentServiceId of line 0
            appointmentServiceId: testApt.services[0]._id,
            serviceId: serviceA1._id,
            appliedSubscriptionId: testSub._id,
            customerId: customerA._id,
          },
        ],
        otpHash,
        status: "pending",
        attempts: 0,
        resendAvailableAt: new Date(Date.now() + 60000),
        expiresAt: new Date(Date.now() + 300000),
      });

      const res = await request(app)
        .post(`/api/v1/appointments/${testApt._id}/complete-with-subscription`)
        .set("Authorization", `Bearer ${ownerToken}`)
        .send({ branchId: branchA1._id.toString(), otp: testOtp });

      expect(res.status).toBe(400);
      expect(res.body.message).toContain("Appointment service line binding does not match OTP challenge");

      // Assert non-completion and untouched entitlements
      const aptAfter = await Appointment.findById(testApt._id);
      expect(aptAfter.status).toBe("in_progress");
      expect(aptAfter.services[0].isRedeemedViaSubscription).toBe(false);
      expect(aptAfter.services[1].isRedeemedViaSubscription).toBe(false);

      const subAfter = await Subscription.findById(testSub._id);
      expect(subAfter.entitlements[0].remainingQuantity).toBe(5);
      expect(subAfter.entitlements[0].usedQuantity).toBe(0);
      expect(subAfter.entitlements[1].remainingQuantity).toBe(5);
      expect(subAfter.entitlements[1].usedQuantity).toBe(0);
    });

    // 9. Two appointment lines using the same catalog service but different appointment line IDs
    it("9. rejects cross-matched line IDs and accepts distinct one-to-one matching for two appointment lines of same catalog service", async () => {
      // Create appointment with two identical catalog service lines
      const dupServiceApt = await Appointment.create({
        organizationId: orgA._id,
        branchId: branchA1._id,
        appointmentCode: `APT-DUP-${Date.now()}`,
        customerId: customerA._id,
        staffId: staffMember._id,
        appointmentDate: "2026-05-11",
        startTime: "12:00",
        endTime: "13:00",
        startAt: new Date("2026-05-11T12:00:00Z"),
        endAt: new Date("2026-05-11T13:00:00Z"),
        bookingType: "advance",
        status: "in_progress",
        totalDuration: 60,
        services: [
          {
            serviceType: "registered",
            serviceId: serviceA1._id,
            name: "Classic Haircut #1",
            duration: 30,
            price: 500,
            appliedSubscriptionId: testSub._id,
            isRedeemedViaSubscription: false,
          },
          {
            serviceType: "registered",
            serviceId: serviceA1._id, // Same catalog service
            name: "Classic Haircut #2",
            duration: 30,
            price: 500,
            appliedSubscriptionId: testSub._id,
            isRedeemedViaSubscription: false,
          },
        ],
        pricing: { subtotal: 1000, discount: 0, total: 1000 },
      });

      const line0Id = dupServiceApt.services[0]._id;
      const line1Id = dupServiceApt.services[1]._id;
      expect(line0Id.toString()).not.toBe(line1Id.toString());

      // Try challenge with duplicate line0Id covering both lines
      const invalidChal = await SubscriptionConsumptionChallenge.create({
        organizationId: orgA._id,
        branchId: branchA1._id,
        appointmentId: dupServiceApt._id,
        customerId: customerA._id,
        subscriptionIds: [testSub._id],
        serviceIds: [serviceA1._id, serviceA1._id],
        serviceLines: [
          {
            appointmentServiceId: line0Id,
            serviceId: serviceA1._id,
            appliedSubscriptionId: testSub._id,
            customerId: customerA._id,
          },
          {
            appointmentServiceId: line0Id, // Duplicate line id!
            serviceId: serviceA1._id,
            appliedSubscriptionId: testSub._id,
            customerId: customerA._id,
          },
        ],
        otpHash,
        status: "pending",
        attempts: 0,
        resendAvailableAt: new Date(Date.now() + 60000),
        expiresAt: new Date(Date.now() + 300000),
      });

      const resInvalid = await request(app)
        .post(`/api/v1/appointments/${dupServiceApt._id}/complete-with-subscription`)
        .set("Authorization", `Bearer ${ownerToken}`)
        .send({ branchId: branchA1._id.toString(), otp: testOtp });

      expect(resInvalid.status).toBe(400);
      expect(resInvalid.body.message).toContain("Appointment service line binding does not match OTP challenge");

      // Assert non-completion and untouched entitlements on failure
      const dupAptAfter = await Appointment.findById(dupServiceApt._id);
      expect(dupAptAfter.status).toBe("in_progress");
      expect(dupAptAfter.services[0].isRedeemedViaSubscription).toBe(false);
      expect(dupAptAfter.services[1].isRedeemedViaSubscription).toBe(false);

      const subBeforeValid = await Subscription.findById(testSub._id);
      expect(subBeforeValid.entitlements.find((e) => e.serviceId.equals(serviceA1._id)).remainingQuantity).toBe(5);

      // Now update challenge with distinct exact one-to-one matching line0Id and line1Id
      await SubscriptionConsumptionChallenge.findByIdAndUpdate(invalidChal._id, {
        serviceLines: [
          {
            appointmentServiceId: line0Id,
            serviceId: serviceA1._id,
            appliedSubscriptionId: testSub._id,
            customerId: customerA._id,
          },
          {
            appointmentServiceId: line1Id,
            serviceId: serviceA1._id,
            appliedSubscriptionId: testSub._id,
            customerId: customerA._id,
          },
        ],
      });

      const resValid = await request(app)
        .post(`/api/v1/appointments/${dupServiceApt._id}/complete-with-subscription`)
        .set("Authorization", `Bearer ${ownerToken}`)
        .send({ branchId: branchA1._id.toString(), otp: testOtp });

      expect(resValid.status).toBe(200);
      expect(resValid.body.data.status).toBe("completed");
    });

    // 10. Valid exact one-to-one matching
    it("10. completes appointment successfully with valid exact one-to-one service-line matching", async () => {
      await SubscriptionConsumptionChallenge.create({
        organizationId: orgA._id,
        branchId: branchA1._id,
        appointmentId: testApt._id,
        customerId: customerA._id,
        subscriptionIds: [testSub._id],
        serviceIds: [serviceA1._id, serviceA2._id],
        serviceLines: [
          {
            appointmentServiceId: testApt.services[0]._id,
            serviceId: serviceA1._id,
            appliedSubscriptionId: testSub._id,
            customerId: customerA._id,
          },
          {
            appointmentServiceId: testApt.services[1]._id,
            serviceId: serviceA2._id,
            appliedSubscriptionId: testSub._id,
            customerId: customerA._id,
          },
        ],
        otpHash,
        status: "pending",
        attempts: 0,
        resendAvailableAt: new Date(Date.now() + 60000),
        expiresAt: new Date(Date.now() + 300000),
      });

      const res = await request(app)
        .post(`/api/v1/appointments/${testApt._id}/complete-with-subscription`)
        .set("Authorization", `Bearer ${ownerToken}`)
        .send({ branchId: branchA1._id.toString(), otp: testOtp });

      expect(res.status).toBe(200);
      expect(res.body.data.status).toBe("completed");
      expect(res.body.data.services[0].isRedeemedViaSubscription).toBe(true);
      expect(res.body.data.services[1].isRedeemedViaSubscription).toBe(true);

      const subAfter = await Subscription.findById(testSub._id);
      expect(subAfter.entitlements.find((e) => e.serviceId.equals(serviceA1._id)).remainingQuantity).toBe(4);
      expect(subAfter.entitlements.find((e) => e.serviceId.equals(serviceA2._id)).remainingQuantity).toBe(4);
    });

    // 11. Missing appointmentServiceId on challenge line
    it("11. rejects completion if challenge service line is missing appointmentServiceId", async () => {
      const challenge = await SubscriptionConsumptionChallenge.create({
        organizationId: orgA._id,
        branchId: branchA1._id,
        appointmentId: testApt._id,
        customerId: customerA._id,
        subscriptionIds: [testSub._id],
        serviceIds: [serviceA1._id, serviceA2._id],
        serviceLines: [
          {
            appointmentServiceId: testApt.services[0]._id,
            serviceId: serviceA1._id,
            appliedSubscriptionId: testSub._id,
            customerId: customerA._id,
          },
          {
            appointmentServiceId: testApt.services[1]._id,
            serviceId: serviceA2._id,
            appliedSubscriptionId: testSub._id,
            customerId: customerA._id,
          },
        ],
        otpHash,
        status: "pending",
        attempts: 0,
        resendAvailableAt: new Date(Date.now() + 60000),
        expiresAt: new Date(Date.now() + 300000),
      });

      await SubscriptionConsumptionChallenge.collection.updateOne(
        { _id: challenge._id },
        { $unset: { "serviceLines.0.appointmentServiceId": 1 } }
      );

      const res = await request(app)
        .post(`/api/v1/appointments/${testApt._id}/complete-with-subscription`)
        .set("Authorization", `Bearer ${ownerToken}`)
        .send({ branchId: branchA1._id.toString(), otp: testOtp });

      expect(res.status).toBe(400);
      expect(res.body.message).toContain("OTP challenge contains incomplete service line bindings");

      // Assert non-completion and untouched entitlements
      const aptAfter = await Appointment.findById(testApt._id);
      expect(aptAfter.status).toBe("in_progress");
      expect(aptAfter.services[0].isRedeemedViaSubscription).toBe(false);
      expect(aptAfter.services[1].isRedeemedViaSubscription).toBe(false);

      const subAfter = await Subscription.findById(testSub._id);
      expect(subAfter.entitlements[0].remainingQuantity).toBe(5);
      expect(subAfter.entitlements[1].remainingQuantity).toBe(5);
    });

    // 12. Missing serviceId on challenge line
    it("12. rejects completion if challenge service line is missing serviceId", async () => {
      const challenge = await SubscriptionConsumptionChallenge.create({
        organizationId: orgA._id,
        branchId: branchA1._id,
        appointmentId: testApt._id,
        customerId: customerA._id,
        subscriptionIds: [testSub._id],
        serviceIds: [serviceA1._id, serviceA2._id],
        serviceLines: [
          {
            appointmentServiceId: testApt.services[0]._id,
            serviceId: serviceA1._id,
            appliedSubscriptionId: testSub._id,
            customerId: customerA._id,
          },
          {
            appointmentServiceId: testApt.services[1]._id,
            serviceId: serviceA2._id,
            appliedSubscriptionId: testSub._id,
            customerId: customerA._id,
          },
        ],
        otpHash,
        status: "pending",
        attempts: 0,
        resendAvailableAt: new Date(Date.now() + 60000),
        expiresAt: new Date(Date.now() + 300000),
      });

      await SubscriptionConsumptionChallenge.collection.updateOne(
        { _id: challenge._id },
        { $unset: { "serviceLines.0.serviceId": 1 } }
      );

      const res = await request(app)
        .post(`/api/v1/appointments/${testApt._id}/complete-with-subscription`)
        .set("Authorization", `Bearer ${ownerToken}`)
        .send({ branchId: branchA1._id.toString(), otp: testOtp });

      expect(res.status).toBe(400);
      expect(res.body.message).toContain("OTP challenge contains incomplete service line bindings");

      // Assert non-completion and untouched entitlements
      const aptAfter = await Appointment.findById(testApt._id);
      expect(aptAfter.status).toBe("in_progress");
      expect(aptAfter.services[0].isRedeemedViaSubscription).toBe(false);
      expect(aptAfter.services[1].isRedeemedViaSubscription).toBe(false);

      const subAfter = await Subscription.findById(testSub._id);
      expect(subAfter.entitlements[0].remainingQuantity).toBe(5);
      expect(subAfter.entitlements[1].remainingQuantity).toBe(5);
    });

    // 13. Missing appliedSubscriptionId on challenge line
    it("13. rejects completion if challenge service line is missing appliedSubscriptionId", async () => {
      const challenge = await SubscriptionConsumptionChallenge.create({
        organizationId: orgA._id,
        branchId: branchA1._id,
        appointmentId: testApt._id,
        customerId: customerA._id,
        subscriptionIds: [testSub._id],
        serviceIds: [serviceA1._id, serviceA2._id],
        serviceLines: [
          {
            appointmentServiceId: testApt.services[0]._id,
            serviceId: serviceA1._id,
            appliedSubscriptionId: testSub._id,
            customerId: customerA._id,
          },
          {
            appointmentServiceId: testApt.services[1]._id,
            serviceId: serviceA2._id,
            appliedSubscriptionId: testSub._id,
            customerId: customerA._id,
          },
        ],
        otpHash,
        status: "pending",
        attempts: 0,
        resendAvailableAt: new Date(Date.now() + 60000),
        expiresAt: new Date(Date.now() + 300000),
      });

      await SubscriptionConsumptionChallenge.collection.updateOne(
        { _id: challenge._id },
        { $unset: { "serviceLines.0.appliedSubscriptionId": 1 } }
      );

      const res = await request(app)
        .post(`/api/v1/appointments/${testApt._id}/complete-with-subscription`)
        .set("Authorization", `Bearer ${ownerToken}`)
        .send({ branchId: branchA1._id.toString(), otp: testOtp });

      expect(res.status).toBe(400);
      expect(res.body.message).toContain("OTP challenge contains incomplete service line bindings");

      // Assert non-completion and untouched entitlements
      const aptAfter = await Appointment.findById(testApt._id);
      expect(aptAfter.status).toBe("in_progress");
      expect(aptAfter.services[0].isRedeemedViaSubscription).toBe(false);
      expect(aptAfter.services[1].isRedeemedViaSubscription).toBe(false);

      const subAfter = await Subscription.findById(testSub._id);
      expect(subAfter.entitlements[0].remainingQuantity).toBe(5);
      expect(subAfter.entitlements[1].remainingQuantity).toBe(5);
    });

    // 14. serviceLines: null
    it("14. rejects completion if challenge.serviceLines is null", async () => {
      const challenge = await SubscriptionConsumptionChallenge.create({
        organizationId: orgA._id,
        branchId: branchA1._id,
        appointmentId: testApt._id,
        customerId: customerA._id,
        subscriptionIds: [testSub._id],
        serviceIds: [serviceA1._id, serviceA2._id],
        serviceLines: [
          {
            appointmentServiceId: testApt.services[0]._id,
            serviceId: serviceA1._id,
            appliedSubscriptionId: testSub._id,
            customerId: customerA._id,
          },
        ],
        otpHash,
        status: "pending",
        attempts: 0,
        resendAvailableAt: new Date(Date.now() + 60000),
        expiresAt: new Date(Date.now() + 300000),
      });

      await SubscriptionConsumptionChallenge.collection.updateOne(
        { _id: challenge._id },
        { $set: { serviceLines: null } }
      );

      const res = await request(app)
        .post(`/api/v1/appointments/${testApt._id}/complete-with-subscription`)
        .set("Authorization", `Bearer ${ownerToken}`)
        .send({ branchId: branchA1._id.toString(), otp: testOtp });

      expect(res.status).toBe(400);
      expect(res.body.message).toContain("OTP challenge is missing required service line bindings");

      // Assert non-completion and untouched entitlements
      const aptAfter = await Appointment.findById(testApt._id);
      expect(aptAfter.status).toBe("in_progress");
      expect(aptAfter.services[0].isRedeemedViaSubscription).toBe(false);
      expect(aptAfter.services[1].isRedeemedViaSubscription).toBe(false);

      const subAfter = await Subscription.findById(testSub._id);
      expect(subAfter.entitlements[0].remainingQuantity).toBe(5);
      expect(subAfter.entitlements[1].remainingQuantity).toBe(5);
    });

    // 15. serviceLines is not an array (e.g. object / string / number)
    it("15. rejects completion if challenge.serviceLines is not an array", async () => {
      const challenge = await SubscriptionConsumptionChallenge.create({
        organizationId: orgA._id,
        branchId: branchA1._id,
        appointmentId: testApt._id,
        customerId: customerA._id,
        subscriptionIds: [testSub._id],
        serviceIds: [serviceA1._id, serviceA2._id],
        serviceLines: [
          {
            appointmentServiceId: testApt.services[0]._id,
            serviceId: serviceA1._id,
            appliedSubscriptionId: testSub._id,
            customerId: customerA._id,
          },
        ],
        otpHash,
        status: "pending",
        attempts: 0,
        resendAvailableAt: new Date(Date.now() + 60000),
        expiresAt: new Date(Date.now() + 300000),
      });

      await SubscriptionConsumptionChallenge.collection.updateOne(
        { _id: challenge._id },
        { $set: { serviceLines: "invalid_non_array_string" } }
      );

      const res = await request(app)
        .post(`/api/v1/appointments/${testApt._id}/complete-with-subscription`)
        .set("Authorization", `Bearer ${ownerToken}`)
        .send({ branchId: branchA1._id.toString(), otp: testOtp });

      expect(res.status).toBe(400);
      expect(res.body.message).toContain("OTP challenge is missing required service line bindings");

      // Assert non-completion and untouched entitlements
      const aptAfter = await Appointment.findById(testApt._id);
      expect(aptAfter.status).toBe("in_progress");
      expect(aptAfter.services[0].isRedeemedViaSubscription).toBe(false);
      expect(aptAfter.services[1].isRedeemedViaSubscription).toBe(false);

      const subAfter = await Subscription.findById(testSub._id);
      expect(subAfter.entitlements[0].remainingQuantity).toBe(5);
      expect(subAfter.entitlements[1].remainingQuantity).toBe(5);
    });

    // 16. Wrong serviceId on challenge line
    it("16. rejects completion if challenge service line has wrong serviceId", async () => {
      const wrongService = await Service.create({
        organizationId: orgA._id,
        name: "Completely Different Service",
        categoryId: categoryA._id,
        duration: 45,
        pricing: { basePrice: 600 },
        status: "active",
      });

      await SubscriptionConsumptionChallenge.create({
        organizationId: orgA._id,
        branchId: branchA1._id,
        appointmentId: testApt._id,
        customerId: customerA._id,
        subscriptionIds: [testSub._id],
        serviceIds: [serviceA1._id, serviceA2._id],
        serviceLines: [
          {
            appointmentServiceId: testApt.services[0]._id,
            serviceId: wrongService._id, // Wrong service ID
            appliedSubscriptionId: testSub._id,
            customerId: customerA._id,
          },
          {
            appointmentServiceId: testApt.services[1]._id,
            serviceId: serviceA2._id,
            appliedSubscriptionId: testSub._id,
            customerId: customerA._id,
          },
        ],
        otpHash,
        status: "pending",
        attempts: 0,
        resendAvailableAt: new Date(Date.now() + 60000),
        expiresAt: new Date(Date.now() + 300000),
      });

      const res = await request(app)
        .post(`/api/v1/appointments/${testApt._id}/complete-with-subscription`)
        .set("Authorization", `Bearer ${ownerToken}`)
        .send({ branchId: branchA1._id.toString(), otp: testOtp });

      expect(res.status).toBe(400);
      expect(res.body.message).toContain("Appointment service line binding does not match OTP challenge");

      // Assert non-completion and untouched entitlements
      const aptAfter = await Appointment.findById(testApt._id);
      expect(aptAfter.status).toBe("in_progress");
      expect(aptAfter.services[0].isRedeemedViaSubscription).toBe(false);
      expect(aptAfter.services[1].isRedeemedViaSubscription).toBe(false);

      const subAfter = await Subscription.findById(testSub._id);
      expect(subAfter.entitlements[0].remainingQuantity).toBe(5);
      expect(subAfter.entitlements[1].remainingQuantity).toBe(5);
    });
  });

  describe("6. Subscription OTP Challenge Concurrency & Active State Guards", () => {
    let concSub, concApt;

    beforeEach(async () => {
      concSub = await Subscription.create({
        organizationId: orgA._id,
        branchId: branchA1._id,
        subscriptionCode: `SUB-CONC-${Date.now()}-${Math.floor(Math.random() * 1000)}`,
        price: 1000,
        customerId: customerA._id,
        startDate: new Date(),
        endDate: new Date(Date.now() + 30 * 24 * 60 * 60 * 1000),
        status: "active",
        entitlements: [
          {
            serviceId: serviceA1._id,
            serviceName: "Classic Haircut",
            totalQuantity: 5,
            usedQuantity: 0,
            remainingQuantity: 5,
          },
        ],
        permittedBranchIds: [branchA1._id],
      });

      concApt = await Appointment.create({
        organizationId: orgA._id,
        branchId: branchA1._id,
        appointmentCode: `APT-CONC-${Date.now()}-${Math.floor(Math.random() * 1000)}`,
        customerId: customerA._id,
        staffId: staffMember._id,
        appointmentDate: "2026-05-15",
        startTime: "15:00",
        endTime: "15:30",
        startAt: new Date("2026-05-15T15:00:00Z"),
        endAt: new Date("2026-05-15T15:30:00Z"),
        bookingType: "advance",
        status: "in_progress",
        totalDuration: 30,
        services: [
          {
            serviceType: "registered",
            serviceId: serviceA1._id,
            name: "Classic Haircut",
            duration: 30,
            price: 500,
            appliedSubscriptionId: concSub._id,
            isRedeemedViaSubscription: false,
          },
        ],
        pricing: { subtotal: 500, discount: 0, total: 500 },
      });
    });

    afterEach(async () => {
      await SubscriptionConsumptionChallenge.deleteMany({ appointmentId: concApt._id });
    });

    it("rejects requesting a new OTP when previous challenge is in_redemption (HTTP 409)", async () => {
      // Create a challenge in 'in_redemption' status
      await SubscriptionConsumptionChallenge.create({
        organizationId: orgA._id,
        branchId: branchA1._id,
        appointmentId: concApt._id,
        customerId: customerA._id,
        subscriptionIds: [concSub._id],
        serviceIds: [serviceA1._id],
        serviceLines: [
          {
            appointmentServiceId: concApt.services[0]._id,
            serviceId: serviceA1._id,
            appliedSubscriptionId: concSub._id,
            customerId: customerA._id,
          },
        ],
        otpHash: "hash123",
        attempts: 0,
        resendAvailableAt: new Date(Date.now() - 1000), // cooldown expired
        expiresAt: new Date(Date.now() + 300000),
        status: "in_redemption",
        redemptionState: "in_redemption",
      });

      const res = await request(app)
        .post(`/api/v1/appointments/${concApt._id}/request-consumption-otp`)
        .set("Authorization", `Bearer ${ownerToken}`)
        .send({ branchId: branchA1._id.toString() });

      expect(res.status).toBe(409);
      expect(res.body.message).toContain("redemption is currently in progress or awaiting reconciliation");

      // Verify no second challenge was created
      const count = await SubscriptionConsumptionChallenge.countDocuments({ appointmentId: concApt._id });
      expect(count).toBe(1);

      // Entitlement balance remains untouched
      const sub = await Subscription.findById(concSub._id);
      expect(sub.entitlements[0].remainingQuantity).toBe(5);
    });

    it("rejects requesting a new OTP when previous challenge is restoring (HTTP 409)", async () => {
      await SubscriptionConsumptionChallenge.create({
        organizationId: orgA._id,
        branchId: branchA1._id,
        appointmentId: concApt._id,
        customerId: customerA._id,
        subscriptionIds: [concSub._id],
        serviceIds: [serviceA1._id],
        serviceLines: [
          {
            appointmentServiceId: concApt.services[0]._id,
            serviceId: serviceA1._id,
            appliedSubscriptionId: concSub._id,
            customerId: customerA._id,
          },
        ],
        otpHash: "hash123",
        attempts: 0,
        resendAvailableAt: new Date(Date.now() - 1000),
        expiresAt: new Date(Date.now() + 300000),
        status: "in_redemption",
        redemptionState: "restoring",
        reconciliationClaimedAt: new Date(),
      });

      const res = await request(app)
        .post(`/api/v1/appointments/${concApt._id}/request-consumption-otp`)
        .set("Authorization", `Bearer ${ownerToken}`)
        .send({ branchId: branchA1._id.toString() });

      expect(res.status).toBe(409);
      expect(res.body.message).toContain("redemption is currently in progress or awaiting reconciliation");

      const count = await SubscriptionConsumptionChallenge.countDocuments({ appointmentId: concApt._id });
      expect(count).toBe(1);
    });

    it("rejects requesting a new OTP while reconciliation is actively claiming the previous challenge (HTTP 409)", async () => {
      await SubscriptionConsumptionChallenge.create({
        organizationId: orgA._id,
        branchId: branchA1._id,
        appointmentId: concApt._id,
        customerId: customerA._id,
        subscriptionIds: [concSub._id],
        serviceIds: [serviceA1._id],
        serviceLines: [
          {
            appointmentServiceId: concApt.services[0]._id,
            serviceId: serviceA1._id,
            appliedSubscriptionId: concSub._id,
            customerId: customerA._id,
          },
        ],
        otpHash: "hash123",
        attempts: 0,
        resendAvailableAt: new Date(Date.now() - 1000),
        expiresAt: new Date(Date.now() - 1000), // expired
        status: "in_redemption",
        redemptionState: "decremented",
      });

      const res = await request(app)
        .post(`/api/v1/appointments/${concApt._id}/request-consumption-otp`)
        .set("Authorization", `Bearer ${ownerToken}`)
        .send({ branchId: branchA1._id.toString() });

      expect(res.status).toBe(409);
      expect(res.body.message).toContain("redemption is currently in progress or awaiting reconciliation");
    });

    it("handles two concurrent OTP requests for the same appointment safely", async () => {
      // Fire 2 concurrent OTP requests
      const [res1, res2] = await Promise.all([
        request(app)
          .post(`/api/v1/appointments/${concApt._id}/request-consumption-otp`)
          .set("Authorization", `Bearer ${ownerToken}`)
          .send({ branchId: branchA1._id.toString() }),
        request(app)
          .post(`/api/v1/appointments/${concApt._id}/request-consumption-otp`)
          .set("Authorization", `Bearer ${ownerToken}`)
          .send({ branchId: branchA1._id.toString() }),
      ]);

      const statuses = [res1.status, res2.status];
      // Exactly 1 must succeed with 200, the other must fail with 429 (cooldown) or 409 (conflict)
      expect(statuses).toContain(200);
      expect(statuses.some((s) => s === 429 || s === 409)).toBe(true);

      // Verify exactly ONE challenge exists for this appointment
      const activeChallenges = await SubscriptionConsumptionChallenge.find({
        appointmentId: concApt._id,
        status: { $in: ["pending", "in_redemption"] },
      });
      expect(activeChallenges).toHaveLength(1);
    });

    it("prevents old redemption attempt racing with a new OTP request from double-consuming", async () => {
      const oldOtp = "112233";
      const oldOtpHash = crypto.createHash("sha256").update(oldOtp).digest("hex");

      // Setup initial challenge
      const chal = await SubscriptionConsumptionChallenge.create({
        organizationId: orgA._id,
        branchId: branchA1._id,
        appointmentId: concApt._id,
        customerId: customerA._id,
        subscriptionIds: [concSub._id],
        serviceIds: [serviceA1._id],
        serviceLines: [
          {
            appointmentServiceId: concApt.services[0]._id,
            serviceId: serviceA1._id,
            appliedSubscriptionId: concSub._id,
            customerId: customerA._id,
          },
        ],
        otpHash: oldOtpHash,
        attempts: 0,
        resendAvailableAt: new Date(Date.now() - 1000), // expired cooldown
        expiresAt: new Date(Date.now() + 300000),
        status: "pending",
        redemptionState: "pending",
      });

      // Claim redemption lock on old challenge
      chal.status = "in_redemption";
      chal.redemptionState = "in_redemption";
      await chal.save();

      // Now a new OTP request arrives while old challenge is in_redemption
      const newOtpReq = await request(app)
        .post(`/api/v1/appointments/${concApt._id}/request-consumption-otp`)
        .set("Authorization", `Bearer ${ownerToken}`)
        .send({ branchId: branchA1._id.toString() });

      // Must be blocked with 409
      expect(newOtpReq.status).toBe(409);

      // Verify no second challenge created
      const allChallenges = await SubscriptionConsumptionChallenge.find({ appointmentId: concApt._id });
      expect(allChallenges).toHaveLength(1);
      expect(allChallenges[0].status).toBe("in_redemption");
    });

    it("allows a new OTP request after the old challenge is successfully reconciled", async () => {
      // Create old challenge that was reconciled to terminal state
      await SubscriptionConsumptionChallenge.create({
        organizationId: orgA._id,
        branchId: branchA1._id,
        appointmentId: concApt._id,
        customerId: customerA._id,
        subscriptionIds: [concSub._id],
        serviceIds: [serviceA1._id],
        serviceLines: [
          {
            appointmentServiceId: concApt.services[0]._id,
            serviceId: serviceA1._id,
            appliedSubscriptionId: concSub._id,
            customerId: customerA._id,
          },
        ],
        otpHash: "hashOld",
        attempts: 5,
        resendAvailableAt: new Date(Date.now() - 1000),
        expiresAt: new Date(Date.now() - 1000),
        status: "exhausted",
        redemptionState: "reconciled",
      });

      // Request new OTP
      const res = await request(app)
        .post(`/api/v1/appointments/${concApt._id}/request-consumption-otp`)
        .set("Authorization", `Bearer ${ownerToken}`)
        .send({ branchId: branchA1._id.toString() });

      expect(res.status).toBe(200);
      expect(res.body.data.expiresIn).toBe(300);

      // Verify a new pending challenge was created alongside the exhausted one
      const pendingChal = await SubscriptionConsumptionChallenge.findOne({
        appointmentId: concApt._id,
        status: "pending",
      });
      expect(pendingChal).toBeDefined();
      expect(pendingChal.redemptionState).toBe("pending");
    });

    it("confirms that one appointment service line can never be decremented twice through two different challenges", async () => {
      const rawOtp1 = "111111";
      const chal1 = await SubscriptionConsumptionChallenge.create({
        organizationId: orgA._id,
        branchId: branchA1._id,
        appointmentId: concApt._id,
        customerId: customerA._id,
        subscriptionIds: [concSub._id],
        serviceIds: [serviceA1._id],
        serviceLines: [
          {
            appointmentServiceId: concApt.services[0]._id,
            serviceId: serviceA1._id,
            appliedSubscriptionId: concSub._id,
            customerId: customerA._id,
          },
        ],
        otpHash: crypto.createHash("sha256").update(rawOtp1).digest("hex"),
        attempts: 0,
        resendAvailableAt: new Date(Date.now() + 60000),
        expiresAt: new Date(Date.now() + 300000),
        status: "pending",
        redemptionState: "pending",
      });

      // Complete via challenge 1
      const res1 = await request(app)
        .post(`/api/v1/appointments/${concApt._id}/complete-with-subscription`)
        .set("Authorization", `Bearer ${ownerToken}`)
        .send({ branchId: branchA1._id.toString(), otp: rawOtp1 });

      expect(res1.status).toBe(200);
      expect(res1.body.data.status).toBe("completed");

      // Verify entitlement was decremented by 1 (remaining: 4, used: 1)
      const subAfter1 = await Subscription.findById(concSub._id);
      expect(subAfter1.entitlements[0].remainingQuantity).toBe(4);
      expect(subAfter1.entitlements[0].usedQuantity).toBe(1);

      // Try to create/execute a second challenge for the already completed service line
      const rawOtp2 = "222222";
      const chal2 = await SubscriptionConsumptionChallenge.create({
        organizationId: orgA._id,
        branchId: branchA1._id,
        appointmentId: concApt._id,
        customerId: customerA._id,
        subscriptionIds: [concSub._id],
        serviceIds: [serviceA1._id],
        serviceLines: [
          {
            appointmentServiceId: concApt.services[0]._id,
            serviceId: serviceA1._id,
            appliedSubscriptionId: concSub._id,
            customerId: customerA._id,
          },
        ],
        otpHash: crypto.createHash("sha256").update(rawOtp2).digest("hex"),
        attempts: 0,
        resendAvailableAt: new Date(Date.now() + 60000),
        expiresAt: new Date(Date.now() + 300000),
        status: "pending",
        redemptionState: "pending",
      });

      const res2 = await request(app)
        .post(`/api/v1/appointments/${concApt._id}/complete-with-subscription`)
        .set("Authorization", `Bearer ${ownerToken}`)
        .send({ branchId: branchA1._id.toString(), otp: rawOtp2 });

      // Must fail because appointment is already completed and service line already redeemed
      expect(res2.status).toBe(400);

      // Entitlement balance MUST still be 4 (never decremented twice)
      const subAfter2 = await Subscription.findById(concSub._id);
      expect(subAfter2.entitlements[0].remainingQuantity).toBe(4);
      expect(subAfter2.entitlements[0].usedQuantity).toBe(1);
    });

    it("allows a new OTP request after ordinary OTP expiry (status: expired, redemptionState: pending)", async () => {
      // Create an expired challenge where status is expired and redemptionState is pending (no redemption work attempted)
      await SubscriptionConsumptionChallenge.deleteMany({ appointmentId: concApt._id });
      await SubscriptionConsumptionChallenge.create({
        organizationId: orgA._id,
        branchId: branchA1._id,
        appointmentId: concApt._id,
        customerId: customerA._id,
        subscriptionIds: [concSub._id],
        serviceIds: [serviceA1._id],
        serviceLines: [
          {
            appointmentServiceId: concApt.services[0]._id,
            serviceId: serviceA1._id,
            appliedSubscriptionId: concSub._id,
            customerId: customerA._id,
          },
        ],
        otpHash: "hashExpired",
        attempts: 1,
        resendAvailableAt: new Date(Date.now() - 60000),
        expiresAt: new Date(Date.now() - 30000),
        status: "expired",
        redemptionState: "pending",
      });

      // Ensure appointment is in_progress
      await Appointment.findByIdAndUpdate(concApt._id, {
        status: "in_progress",
        "services.0.isRedeemedViaSubscription": false,
      });

      const res = await request(app)
        .post(`/api/v1/appointments/${concApt._id}/request-consumption-otp`)
        .set("Authorization", `Bearer ${ownerToken}`)
        .send({ branchId: branchA1._id.toString() });

      expect(res.status).toBe(200);
      expect(res.body.data.expiresIn).toBe(300);

      const activeChallenge = await SubscriptionConsumptionChallenge.findOne({
        appointmentId: concApt._id,
        status: "pending",
      });
      expect(activeChallenge).toBeDefined();
      expect(activeChallenge.redemptionState).toBe("pending");
      expect(activeChallenge.expiresAt.getTime()).toBeGreaterThan(Date.now());
    });

    it("atomically transitions an expired status: pending challenge to expired and allows a new OTP without E11000", async () => {
      await SubscriptionConsumptionChallenge.deleteMany({ appointmentId: concApt._id });
      // Create a challenge that expired while still retaining status: 'pending' and redemptionState: 'pending'
      const oldExpiredPending = await SubscriptionConsumptionChallenge.create({
        organizationId: orgA._id,
        branchId: branchA1._id,
        appointmentId: concApt._id,
        customerId: customerA._id,
        subscriptionIds: [concSub._id],
        serviceIds: [serviceA1._id],
        serviceLines: [
          {
            appointmentServiceId: concApt.services[0]._id,
            serviceId: serviceA1._id,
            appliedSubscriptionId: concSub._id,
            customerId: customerA._id,
          },
        ],
        otpHash: "hashExpiredPending",
        attempts: 0,
        resendAvailableAt: new Date(Date.now() - 60000),
        expiresAt: new Date(Date.now() - 10000), // Expired!
        status: "pending",
        redemptionState: "pending",
      });

      await Appointment.findByIdAndUpdate(concApt._id, {
        status: "in_progress",
        "services.0.isRedeemedViaSubscription": false,
      });

      // Request new OTP - must transition the old pending challenge to expired, preventing E11000 index collision
      const res = await request(app)
        .post(`/api/v1/appointments/${concApt._id}/request-consumption-otp`)
        .set("Authorization", `Bearer ${ownerToken}`)
        .send({ branchId: branchA1._id.toString() });

      expect(res.status).toBe(200);
      expect(res.body.data.expiresIn).toBe(300);

      // Verify the old challenge was transitioned to 'expired'
      const oldCheck = await SubscriptionConsumptionChallenge.findById(oldExpiredPending._id);
      expect(oldCheck.status).toBe("expired");

      // Verify new pending challenge is created
      const newActive = await SubscriptionConsumptionChallenge.findOne({
        appointmentId: concApt._id,
        status: "pending",
      });
      expect(newActive).toBeDefined();
      expect(newActive._id.toString()).not.toBe(oldExpiredPending._id.toString());
      expect(newActive.expiresAt.getTime()).toBeGreaterThan(Date.now());
    });

    it("never expires or replaces an expired challenge that has in_redemption CAS lock", async () => {
      await SubscriptionConsumptionChallenge.deleteMany({ appointmentId: concApt._id });
      // Create challenge with status: 'in_redemption' whose OTP timestamp is past
      await SubscriptionConsumptionChallenge.create({
        organizationId: orgA._id,
        branchId: branchA1._id,
        appointmentId: concApt._id,
        customerId: customerA._id,
        subscriptionIds: [concSub._id],
        serviceIds: [serviceA1._id],
        serviceLines: [
          {
            appointmentServiceId: concApt.services[0]._id,
            serviceId: serviceA1._id,
            appliedSubscriptionId: concSub._id,
            customerId: customerA._id,
          },
        ],
        otpHash: "hashInRedemp",
        attempts: 0,
        resendAvailableAt: new Date(Date.now() - 60000),
        expiresAt: new Date(Date.now() - 10000), // Expired timestamp
        status: "in_redemption",
        redemptionState: "in_redemption",
      });

      const res = await request(app)
        .post(`/api/v1/appointments/${concApt._id}/request-consumption-otp`)
        .set("Authorization", `Bearer ${ownerToken}`)
        .send({ branchId: branchA1._id.toString() });

      expect(res.status).toBe(409);
      expect(res.body.message).toMatch(/redemption is currently in progress or awaiting reconciliation/i);

      // Verify status was NOT modified to 'expired'
      const check = await SubscriptionConsumptionChallenge.findOne({ appointmentId: concApt._id });
      expect(check.status).toBe("in_redemption");
      expect(check.redemptionState).toBe("in_redemption");
    });

    it("blocks new OTP request when an expired challenge has unresolved decrement or restoration work", async () => {
      await SubscriptionConsumptionChallenge.deleteMany({ appointmentId: concApt._id });

      // Create an expired challenge that still has unresolved decrement work (redemptionState: 'decremented')
      await SubscriptionConsumptionChallenge.create({
        organizationId: orgA._id,
        branchId: branchA1._id,
        appointmentId: concApt._id,
        customerId: customerA._id,
        subscriptionIds: [concSub._id],
        serviceIds: [serviceA1._id],
        serviceLines: [
          {
            appointmentServiceId: concApt.services[0]._id,
            serviceId: serviceA1._id,
            appliedSubscriptionId: concSub._id,
            customerId: customerA._id,
          },
        ],
        otpHash: "hashUnresolved",
        attempts: 1,
        resendAvailableAt: new Date(Date.now() - 60000),
        expiresAt: new Date(Date.now() - 30000), // OTP expired
        status: "expired",
        redemptionState: "decremented", // but has pending/unresolved decrement!
      });

      const res = await request(app)
        .post(`/api/v1/appointments/${concApt._id}/request-consumption-otp`)
        .set("Authorization", `Bearer ${ownerToken}`)
        .send({ branchId: branchA1._id.toString() });

      expect(res.status).toBe(409);
      expect(res.body.message).toMatch(/redemption is currently in progress or awaiting reconciliation/i);
    });

    it("proves the database partial unique index blocks concurrent challenges across non-terminal states", async () => {
      await SubscriptionConsumptionChallenge.deleteMany({ appointmentId: concApt._id });

      // 1. Create active challenge with redemptionState: 'restoring'
      await SubscriptionConsumptionChallenge.create({
        organizationId: orgA._id,
        branchId: branchA1._id,
        appointmentId: concApt._id,
        customerId: customerA._id,
        subscriptionIds: [concSub._id],
        serviceIds: [serviceA1._id],
        serviceLines: [
          {
            appointmentServiceId: concApt.services[0]._id,
            serviceId: serviceA1._id,
            appliedSubscriptionId: concSub._id,
            customerId: customerA._id,
          },
        ],
        otpHash: "hashDBGuard",
        attempts: 0,
        resendAvailableAt: new Date(Date.now() + 60000),
        expiresAt: new Date(Date.now() + 300000),
        status: "expired",
        redemptionState: "restoring",
      });

      // Attempt direct MongoDB insert of a new pending challenge for same appointment
      let duplicateError = null;
      try {
        await SubscriptionConsumptionChallenge.create({
          organizationId: orgA._id,
          branchId: branchA1._id,
          appointmentId: concApt._id,
          customerId: customerA._id,
          subscriptionIds: [concSub._id],
          serviceIds: [serviceA1._id],
          serviceLines: [
            {
              appointmentServiceId: concApt.services[0]._id,
              serviceId: serviceA1._id,
              appliedSubscriptionId: concSub._id,
              customerId: customerA._id,
            },
          ],
          otpHash: "hashDBGuard2",
          attempts: 0,
          resendAvailableAt: new Date(Date.now() + 60000),
          expiresAt: new Date(Date.now() + 300000),
          status: "pending",
          redemptionState: "pending",
        });
      } catch (err) {
        duplicateError = err;
      }

      expect(duplicateError).toBeDefined();
      expect(duplicateError.code).toBe(11000);
    });

    it("resend lifecycle: updates existing challenge after 60s cooldown, rotates hash, and preserves document identity", async () => {
      await SubscriptionConsumptionChallenge.deleteMany({ appointmentId: concApt._id });

      await Appointment.findByIdAndUpdate(concApt._id, {
        status: "in_progress",
        "services.0.isRedeemedViaSubscription": false,
      });

      // 1. Initial OTP request creates challenge
      const res1 = await request(app)
        .post(`/api/v1/appointments/${concApt._id}/request-consumption-otp`)
        .set("Authorization", `Bearer ${ownerToken}`)
        .send({ branchId: branchA1._id.toString() });

      expect(res1.status).toBe(200);

      const chal1 = await SubscriptionConsumptionChallenge.findOne({ appointmentId: concApt._id });
      expect(chal1).toBeDefined();
      const initialChalId = chal1._id.toString();
      const initialOtpHash = chal1.otpHash;

      // 2. Resend before 60s cooldown returns 429
      const res2 = await request(app)
        .post(`/api/v1/appointments/${concApt._id}/request-consumption-otp`)
        .set("Authorization", `Bearer ${ownerToken}`)
        .send({ branchId: branchA1._id.toString() });

      expect(res2.status).toBe(429);
      expect(res2.body.message).toMatch(/Too many OTP requests/i);

      // 3. Fast-forward cooldown (resendAvailableAt in past, expiresAt still valid)
      await SubscriptionConsumptionChallenge.findByIdAndUpdate(initialChalId, {
        resendAvailableAt: new Date(Date.now() - 5000),
      });

      // 4. Resend after 60s cooldown succeeds
      const res3 = await request(app)
        .post(`/api/v1/appointments/${concApt._id}/request-consumption-otp`)
        .set("Authorization", `Bearer ${ownerToken}`)
        .send({ branchId: branchA1._id.toString() });

      expect(res3.status).toBe(200);

      // Verify same document ID is updated, OTP hash is rotated, attempts reset, and count is exactly 1
      const allChallenges = await SubscriptionConsumptionChallenge.find({ appointmentId: concApt._id });
      expect(allChallenges).toHaveLength(1);
      expect(allChallenges[0]._id.toString()).toBe(initialChalId);
      expect(allChallenges[0].otpHash).not.toBe(initialOtpHash);
      expect(allChallenges[0].status).toBe("pending");
      expect(allChallenges[0].redemptionState).toBe("pending");
    });

    it("concurrent resend requests cannot bypass cooldown or create duplicate challenges", async () => {
      await SubscriptionConsumptionChallenge.deleteMany({ appointmentId: concApt._id });

      await Appointment.findByIdAndUpdate(concApt._id, {
        status: "in_progress",
        "services.0.isRedeemedViaSubscription": false,
      });

      // Create an existing challenge whose cooldown has just expired
      const existing = await SubscriptionConsumptionChallenge.create({
        organizationId: orgA._id,
        branchId: branchA1._id,
        appointmentId: concApt._id,
        customerId: customerA._id,
        subscriptionIds: [concSub._id],
        serviceIds: [serviceA1._id],
        serviceLines: [
          {
            appointmentServiceId: concApt.services[0]._id,
            serviceId: serviceA1._id,
            appliedSubscriptionId: concSub._id,
            customerId: customerA._id,
          },
        ],
        otpHash: "hashExisting",
        attempts: 0,
        resendAvailableAt: new Date(Date.now() - 1000), // cooldown expired
        expiresAt: new Date(Date.now() + 300000),
        status: "pending",
        redemptionState: "pending",
      });

      // Fire 2 concurrent resend requests
      const [r1, r2] = await Promise.all([
        request(app)
          .post(`/api/v1/appointments/${concApt._id}/request-consumption-otp`)
          .set("Authorization", `Bearer ${ownerToken}`)
          .send({ branchId: branchA1._id.toString() }),
        request(app)
          .post(`/api/v1/appointments/${concApt._id}/request-consumption-otp`)
          .set("Authorization", `Bearer ${ownerToken}`)
          .send({ branchId: branchA1._id.toString() }),
      ]);

      const statuses = [r1.status, r2.status].sort();
      // One request must succeed (200), and the other must be rejected (429 or 409)
      expect(statuses[0]).toBe(200);
      expect([409, 429]).toContain(statuses[1]);

      // Exactly one document must remain
      const totalChallenges = await SubscriptionConsumptionChallenge.find({ appointmentId: concApt._id });
      expect(totalChallenges).toHaveLength(1);
      expect(totalChallenges[0]._id.toString()).toBe(existing._id.toString());
    });

    it("expiry vs redemption CAS race: redemption CAS prevents expiry; expiry prevents redemption CAS", async () => {
      await SubscriptionConsumptionChallenge.deleteMany({ appointmentId: concApt._id });

      // Scenario A: Redemption CAS wins first (status: in_redemption)
      const chalA = await SubscriptionConsumptionChallenge.create({
        organizationId: orgA._id,
        branchId: branchA1._id,
        appointmentId: concApt._id,
        customerId: customerA._id,
        subscriptionIds: [concSub._id],
        serviceIds: [serviceA1._id],
        serviceLines: [
          {
            appointmentServiceId: concApt.services[0]._id,
            serviceId: serviceA1._id,
            appliedSubscriptionId: concSub._id,
            customerId: customerA._id,
          },
        ],
        otpHash: "hashA",
        attempts: 0,
        resendAvailableAt: new Date(Date.now() - 10000),
        expiresAt: new Date(Date.now() - 5000), // expired timestamp
        status: "in_redemption",
        redemptionState: "in_redemption",
      });

      // An expiry transition query must NOT touch chalA
      const expiryResultA = await SubscriptionConsumptionChallenge.updateMany(
        {
          appointmentId: concApt._id,
          status: "pending",
          redemptionState: "pending",
          expiresAt: { $lte: new Date() },
        },
        { $set: { status: "expired" } }
      );
      expect(expiryResultA.modifiedCount).toBe(0);

      const checkA = await SubscriptionConsumptionChallenge.findById(chalA._id);
      expect(checkA.status).toBe("in_redemption");

      // Scenario B: Expiry transition wins first (status: expired)
      await SubscriptionConsumptionChallenge.deleteMany({ appointmentId: concApt._id });
      const chalB = await SubscriptionConsumptionChallenge.create({
        organizationId: orgA._id,
        branchId: branchA1._id,
        appointmentId: concApt._id,
        customerId: customerA._id,
        subscriptionIds: [concSub._id],
        serviceIds: [serviceA1._id],
        serviceLines: [
          {
            appointmentServiceId: concApt.services[0]._id,
            serviceId: serviceA1._id,
            appliedSubscriptionId: concSub._id,
            customerId: customerA._id,
          },
        ],
        otpHash: "hashB",
        attempts: 0,
        resendAvailableAt: new Date(Date.now() - 10000),
        expiresAt: new Date(Date.now() - 5000),
        status: "pending",
        redemptionState: "pending",
      });

      // Expiry runs
      const expiryResultB = await SubscriptionConsumptionChallenge.updateMany(
        {
          appointmentId: concApt._id,
          status: "pending",
          redemptionState: "pending",
          expiresAt: { $lte: new Date() },
        },
        { $set: { status: "expired" } }
      );
      expect(expiryResultB.modifiedCount).toBe(1);

      // Now redemption CAS tries to acquire chalB
      const lockedB = await SubscriptionConsumptionChallenge.findOneAndUpdate(
        {
          _id: chalB._id,
          status: "pending",
          redemptionState: "pending",
          expiresAt: { $gt: new Date() },
        },
        { $set: { status: "in_redemption" } },
        { returnDocument: "after" }
      );
      expect(lockedB).toBeNull(); // CAS rejected because chalB is expired!
    });

    it("preserves attempts count across resends and blocks resend if challenge is exhausted", async () => {
      await SubscriptionConsumptionChallenge.deleteMany({ appointmentId: concApt._id });
      await Appointment.findByIdAndUpdate(concApt._id, {
        status: "in_progress",
        "services.0.isRedeemedViaSubscription": false,
      });

      // 1. Create a challenge with 2 existing failed verification attempts
      const chal = await SubscriptionConsumptionChallenge.create({
        organizationId: orgA._id,
        branchId: branchA1._id,
        appointmentId: concApt._id,
        customerId: customerA._id,
        subscriptionIds: [concSub._id],
        serviceIds: [serviceA1._id],
        serviceLines: [
          {
            appointmentServiceId: concApt.services[0]._id,
            serviceId: serviceA1._id,
            appliedSubscriptionId: concSub._id,
            customerId: customerA._id,
          },
        ],
        otpHash: "hashExistingAttempts",
        attempts: 2,
        resendAvailableAt: new Date(Date.now() - 5000), // cooldown elapsed
        expiresAt: new Date(Date.now() + 300000),
        status: "pending",
        redemptionState: "pending",
      });

      // Resend OTP
      const res = await request(app)
        .post(`/api/v1/appointments/${concApt._id}/request-consumption-otp`)
        .set("Authorization", `Bearer ${ownerToken}`)
        .send({ branchId: branchA1._id.toString() });

      expect(res.status).toBe(200);

      // Verify attempts was preserved at 2, NOT reset to 0
      const updated = await SubscriptionConsumptionChallenge.findById(chal._id);
      expect(updated.attempts).toBe(2);

      // Now set attempts to 5 and exhausted
      await SubscriptionConsumptionChallenge.findByIdAndUpdate(chal._id, {
        attempts: 5,
        status: "exhausted",
        resendAvailableAt: new Date(Date.now() - 5000),
      });

      // Requesting resend on an exhausted challenge must be rejected with 429
      const resExhausted = await request(app)
        .post(`/api/v1/appointments/${concApt._id}/request-consumption-otp`)
        .set("Authorization", `Bearer ${ownerToken}`)
        .send({ branchId: branchA1._id.toString() });

      expect(resExhausted.status).toBe(429);
      expect(resExhausted.body.message).toMatch(/exhausted/i);
    });

    it("handles ambiguous SMS queue insertion failure without deleting or invalidating initial challenge", async () => {
      await SubscriptionConsumptionChallenge.deleteMany({ appointmentId: concApt._id });
      await Appointment.findByIdAndUpdate(concApt._id, {
        status: "in_progress",
        "services.0.isRedeemedViaSubscription": false,
      });

      // Capture the exact raw OTP sent to queue mock
      let capturedJobData = null;
      let capturedJobOpts = null;
      const queueSpy = jest.spyOn(smsQueue, "add").mockImplementationOnce(async (jobName, data, opts) => {
        capturedJobData = data;
        capturedJobOpts = opts;
        // Simulate Redis accepted the job, but client experienced socket/ack timeout
        throw new Error("Redis write ACK timeout (ambiguous insertion)");
      });

      const res = await request(app)
        .post(`/api/v1/appointments/${concApt._id}/request-consumption-otp`)
        .set("Authorization", `Bearer ${ownerToken}`)
        .send({ branchId: branchA1._id.toString() });

      expect(res.status).toBe(500);
      expect(res.body.message).toMatch(/Failed to dispatch OTP SMS/i);

      // Verify idempotent jobId was provided to prevent duplicate BullMQ deliveries
      expect(capturedJobOpts).toBeDefined();
      expect(capturedJobOpts.jobId).toMatch(/^sub_otp_/);

      // Crucial: The challenge is NOT deleted!
      const challenge = await SubscriptionConsumptionChallenge.findOne({ appointmentId: concApt._id });
      expect(challenge).not.toBeNull();
      expect(challenge.dispatchStatus).toBe("failed");
      expect(challenge.dispatchJobId).toBe(capturedJobOpts.jobId);
      expect(challenge.status).toBe("pending");

      // Verify that if SMS is delivered to user, the OTP is VALID and can successfully complete the appointment!
      const verifyRes = await request(app)
        .post(`/api/v1/appointments/${concApt._id}/complete-with-subscription`)
        .set("Authorization", `Bearer ${ownerToken}`)
        .send({
          branchId: branchA1._id.toString(),
          otp: capturedJobData.otp,
        });

      expect(verifyRes.status).toBe(200);
      expect(verifyRes.body.success).toBe(true);

      queueSpy.mockRestore();
    });

    it("handles ambiguous SMS queue insertion failure on resend without corrupting active OTP", async () => {
      await SubscriptionConsumptionChallenge.deleteMany({ appointmentId: concApt._id });
      await Appointment.findByIdAndUpdate(concApt._id, {
        status: "in_progress",
        "services.0.isRedeemedViaSubscription": false,
      });

      const initialOtpHash = "initialHashSafe";
      const chal = await SubscriptionConsumptionChallenge.create({
        organizationId: orgA._id,
        branchId: branchA1._id,
        appointmentId: concApt._id,
        customerId: customerA._id,
        subscriptionIds: [concSub._id],
        serviceIds: [serviceA1._id],
        serviceLines: [
          {
            appointmentServiceId: concApt.services[0]._id,
            serviceId: serviceA1._id,
            appliedSubscriptionId: concSub._id,
            customerId: customerA._id,
          },
        ],
        otpHash: initialOtpHash,
        attempts: 1,
        dispatchSeq: 1,
        dispatchJobId: `sub_otp_${concApt._id}_1`,
        dispatchStatus: "queued",
        resendAvailableAt: new Date(Date.now() - 5000),
        expiresAt: new Date(Date.now() + 300000),
        status: "pending",
        redemptionState: "pending",
      });

      let capturedJobData = null;
      let capturedJobOpts = null;
      const queueSpy = jest.spyOn(smsQueue, "add").mockImplementationOnce(async (jobName, data, opts) => {
        capturedJobData = data;
        capturedJobOpts = opts;
        throw new Error("Redis write timeout on resend (ambiguous)");
      });

      const res = await request(app)
        .post(`/api/v1/appointments/${concApt._id}/request-consumption-otp`)
        .set("Authorization", `Bearer ${ownerToken}`)
        .send({ branchId: branchA1._id.toString() });

      expect(res.status).toBe(500);
      expect(res.body.message).toMatch(/Failed to dispatch OTP SMS/i);

      // Verify the challenge retains the rotated OTP and idempotent jobId, marked dispatchStatus: "failed"
      const persisted = await SubscriptionConsumptionChallenge.findById(chal._id);
      expect(persisted.dispatchStatus).toBe("failed");
      expect(persisted.dispatchSeq).toBe(2);
      expect(persisted.dispatchJobId).toBe(capturedJobOpts.jobId);
      expect(persisted.attempts).toBe(1); // attempt count strictly preserved across resends

      // If user receives SMS despite ambiguous error, the OTP is valid!
      const verifyRes = await request(app)
        .post(`/api/v1/appointments/${concApt._id}/complete-with-subscription`)
        .set("Authorization", `Bearer ${ownerToken}`)
        .send({
          branchId: branchA1._id.toString(),
          otp: capturedJobData.otp,
        });

      expect(verifyRes.status).toBe(200);
      expect(verifyRes.body.success).toBe(true);

      queueSpy.mockRestore();
    });

    it("retry after failed dispatch successfully queues with advanced dispatch sequence and redeems", async () => {
      await SubscriptionConsumptionChallenge.deleteMany({ appointmentId: concApt._id });
      await Appointment.findByIdAndUpdate(concApt._id, {
        status: "in_progress",
        "services.0.isRedeemedViaSubscription": false,
      });

      // 1. Initial attempt fails queueing ambiguously
      const queueSpy = jest.spyOn(smsQueue, "add").mockRejectedValueOnce(new Error("Network glitch to Redis"));

      const res1 = await request(app)
        .post(`/api/v1/appointments/${concApt._id}/request-consumption-otp`)
        .set("Authorization", `Bearer ${ownerToken}`)
        .send({ branchId: branchA1._id.toString() });

      expect(res1.status).toBe(500);
      queueSpy.mockRestore();

      // Because resendAvailableAt was reset to now on initial dispatch failure, client can retry immediately
      let retryJobData = null;
      let retryJobOpts = null;
      const retrySpy = jest.spyOn(smsQueue, "add").mockImplementationOnce(async (jobName, data, opts) => {
        retryJobData = data;
        retryJobOpts = opts;
        return { id: opts.jobId };
      });

      const res2 = await request(app)
        .post(`/api/v1/appointments/${concApt._id}/request-consumption-otp`)
        .set("Authorization", `Bearer ${ownerToken}`)
        .send({ branchId: branchA1._id.toString() });

      expect(res2.status).toBe(200);
      expect(res2.body.success).toBe(true);
      expect(retryJobOpts.jobId).toMatch(/_2$/); // sequence incremented to 2

      const updatedChal = await SubscriptionConsumptionChallenge.findOne({ appointmentId: concApt._id });
      expect(updatedChal.dispatchStatus).toBe("queued");
      expect(updatedChal.dispatchSeq).toBe(2);

      // Verify OTP redemption succeeds with the retried OTP
      const verifyRes = await request(app)
        .post(`/api/v1/appointments/${concApt._id}/complete-with-subscription`)
        .set("Authorization", `Bearer ${ownerToken}`)
        .send({
          branchId: branchA1._id.toString(),
          otp: retryJobData.otp,
        });

      expect(verifyRes.status).toBe(200);
      expect(verifyRes.body.success).toBe(true);

      retrySpy.mockRestore();
    });

    it("allows a new OTP request after an exhausted challenge has genuinely expired", async () => {
      await SubscriptionConsumptionChallenge.deleteMany({ appointmentId: concApt._id });
      await Appointment.findByIdAndUpdate(concApt._id, {
        status: "in_progress",
        "services.0.isRedeemedViaSubscription": false,
      });

      // 1. Create an exhausted challenge whose validity period is still active
      const chal = await SubscriptionConsumptionChallenge.create({
        organizationId: orgA._id,
        branchId: branchA1._id,
        appointmentId: concApt._id,
        customerId: customerA._id,
        subscriptionIds: [concSub._id],
        serviceIds: [serviceA1._id],
        serviceLines: [
          {
            appointmentServiceId: concApt.services[0]._id,
            serviceId: serviceA1._id,
            appliedSubscriptionId: concSub._id,
            customerId: customerA._id,
          },
        ],
        otpHash: "hashExhaustedActive",
        attempts: 5,
        resendAvailableAt: new Date(Date.now() - 5000),
        expiresAt: new Date(Date.now() + 300000), // active validity!
        status: "exhausted",
        redemptionState: "pending",
      });

      // While active, requesting a new OTP is blocked with 429
      const resBlocked = await request(app)
        .post(`/api/v1/appointments/${concApt._id}/request-consumption-otp`)
        .set("Authorization", `Bearer ${ownerToken}`)
        .send({ branchId: branchA1._id.toString() });

      expect(resBlocked.status).toBe(429);
      expect(resBlocked.body.message).toMatch(/exhausted/i);

      // 2. Now let its validity period expire
      await SubscriptionConsumptionChallenge.findByIdAndUpdate(chal._id, {
        expiresAt: new Date(Date.now() - 10000),
      });

      // Request new OTP - must succeed and issue a brand-new challenge
      const resAllowed = await request(app)
        .post(`/api/v1/appointments/${concApt._id}/request-consumption-otp`)
        .set("Authorization", `Bearer ${ownerToken}`)
        .send({ branchId: branchA1._id.toString() });

      expect(resAllowed.status).toBe(200);
      expect(resAllowed.body.data.expiresIn).toBe(300);

      const activeChallenge = await SubscriptionConsumptionChallenge.findOne({
        appointmentId: concApt._id,
        status: "pending",
      });
      expect(activeChallenge).toBeDefined();
      expect(activeChallenge._id.toString()).not.toBe(chal._id.toString());
      expect(activeChallenge.attempts).toBe(0);
    });

    it("worker drops delayed stale OTP job after resend has issued a newer sequence and OTP", async () => {
      await SubscriptionConsumptionChallenge.deleteMany({ appointmentId: concApt._id });
      await Appointment.findByIdAndUpdate(concApt._id, {
        status: "in_progress",
        "services.0.isRedeemedViaSubscription": false,
      });

      // 1. Customer requests initial OTP (seq 1)
      let job1Data = null;
      let job1Opts = null;
      const queueSpy = jest.spyOn(smsQueue, "add").mockImplementationOnce(async (name, data, opts) => {
        job1Data = data;
        job1Opts = opts;
        return { id: opts.jobId };
      });

      const res1 = await request(app)
        .post(`/api/v1/appointments/${concApt._id}/request-consumption-otp`)
        .set("Authorization", `Bearer ${ownerToken}`)
        .send({ branchId: branchA1._id.toString() });

      expect(res1.status).toBe(200);
      queueSpy.mockRestore();

      // 2. Simulate 60s cooldown elapsing, customer requests resend (seq 2)
      await SubscriptionConsumptionChallenge.findOneAndUpdate(
        { appointmentId: concApt._id },
        { resendAvailableAt: new Date(Date.now() - 1000) }
      );

      let job2Data = null;
      let job2Opts = null;
      const resendSpy = jest.spyOn(smsQueue, "add").mockImplementationOnce(async (name, data, opts) => {
        job2Data = data;
        job2Opts = opts;
        return { id: opts.jobId };
      });

      const res2 = await request(app)
        .post(`/api/v1/appointments/${concApt._id}/request-consumption-otp`)
        .set("Authorization", `Bearer ${ownerToken}`)
        .send({ branchId: branchA1._id.toString() });

      expect(res2.status).toBe(200);
      resendSpy.mockRestore();

      expect(job2Data.dispatchSeq).toBe(2);
      expect(job1Data.dispatchSeq).toBe(1);
      expect(job2Data.otp).not.toBe(job1Data.otp);

      // 3. Now simulate delayed execution of the stale BullMQ job 1 (seq 1)
      const staleJob = {
        id: job1Opts.jobId,
        name: "sendOtpSMS",
        data: job1Data,
      };

      const workerResStale = await processSmsJob(staleJob);
      // Must return false and NOT dispatch SMS because seq 1 !== active seq 2
      expect(workerResStale).toBe(false);

      // 4. Now simulate execution of the active BullMQ job 2 (seq 2)
      const activeJob = {
        id: job2Opts.jobId,
        name: "sendOtpSMS",
        data: job2Data,
      };

      const workerResActive = await processSmsJob(activeJob);
      // Must succeed (smsService returns { success: true, ... })
      expect(workerResActive).toBeTruthy();
      expect(workerResActive.success).toBe(true);
    });

    it("worker drops OTP job if challenge has already been redeemed or expired", async () => {
      await SubscriptionConsumptionChallenge.deleteMany({ appointmentId: concApt._id });
      await Appointment.findByIdAndUpdate(concApt._id, {
        status: "in_progress",
        "services.0.isRedeemedViaSubscription": false,
      });

      let jobData = null;
      let jobOpts = null;
      const queueSpy = jest.spyOn(smsQueue, "add").mockImplementationOnce(async (name, data, opts) => {
        jobData = data;
        jobOpts = opts;
        return { id: opts.jobId };
      });

      const res = await request(app)
        .post(`/api/v1/appointments/${concApt._id}/request-consumption-otp`)
        .set("Authorization", `Bearer ${ownerToken}`)
        .send({ branchId: branchA1._id.toString() });

      expect(res.status).toBe(200);
      queueSpy.mockRestore();

      // Redeem challenge
      const redeemRes = await request(app)
        .post(`/api/v1/appointments/${concApt._id}/complete-with-subscription`)
        .set("Authorization", `Bearer ${ownerToken}`)
        .send({
          branchId: branchA1._id.toString(),
          otp: jobData.otp,
        });

      expect(redeemRes.status).toBe(200);

      // Now delayed job runs after redemption
      const delayedJob = {
        id: jobOpts.jobId,
        name: "sendOtpSMS",
        data: jobData,
      };

      const workerRes = await processSmsJob(delayedJob);
      // Must be dropped because challenge is now completed/not pending
      expect(workerRes).toBe(false);
    });
  });

  describe("7. Production Readiness — Member Entitlement Isolation, Empty Members & ACID Transaction Enforcement", () => {
    let regOrg, regBranch, regStaff, regService1, regService2;
    let customerPayer, customerMemberA, customerMemberB, legacyCustomer;
    let regToken;

    beforeEach(async () => {
      regOrg = await Organization.create({
        name: `Org-PR-${Date.now()}`,
        slug: `org-pr-${Date.now()}-${Math.floor(Math.random() * 1000)}`,
        status: "active",
      });

      regBranch = await Branch.create({
        organizationId: regOrg._id,
        name: "Main Branch",
        slug: `branch-${Date.now()}`,
        status: "active",
      });

      const permNames = [
        "appointments.create",
        "appointments.update",
        "appointments.update_status",
        "appointments.view",
        "appointments.complete",
        "subscriptions.view",
        "subscriptions.sell",
        "subscriptions.redeem",
      ];

      const permDocs = await Promise.all(
        permNames.map((name) =>
          Permission.findOneAndUpdate(
            { name },
            {
              $setOnInsert: {
                name,
                module: "Appointments",
                action: name.split(".")[1],
                description: name,
              },
            },
            { upsert: true, new: true }
          )
        )
      );

      const role = await Role.create({
        organizationId: regOrg._id,
        name: `Admin-${Date.now()}`,
        permissions: permDocs.map((p) => p._id),
      });

      const user = await User.create({
        name: "PR Admin",
        email: `admin-${Date.now()}@test.com`,
        phone: `+9198${Date.now().toString().slice(-8)}`,
        password: "Password123!",
        organizationId: regOrg._id,
        role: role._id,
        hasOrgWideAccess: true,
        branchAccess: [
          { branchId: regBranch._id, branchName: "Main Branch", isActive: true },
        ],
        status: "active",
      });

      regToken = jwt.sign(
        {
          id: user._id.toString(),
          userId: user._id.toString(),
          organizationId: regOrg._id.toString(),
          role: "owner",
          hasOrgWideAccess: true,
        },
        env.JWT_SECRET || "test-jwt-secret",
        { expiresIn: "1h" }
      );

      regStaff = await Staff.create({
        organizationId: regOrg._id,
        primaryBranchId: regBranch._id,
        branchIds: [regBranch._id],
        name: "Test Stylist",
        email: `stylist-${Date.now()}@test.com`,
        phone: "+919876500001",
        designation: "Stylist",
        staffCode: `STF-PR-${Date.now()}`,
        joiningDate: new Date(),
        status: "active",
      });

      const cat = await ServiceCategory.create({
        organizationId: regOrg._id,
        name: "Hair Care",
      });

      regService1 = await Service.create({
        organizationId: regOrg._id,
        categoryId: cat._id,
        name: "PR Service 1",
        duration: 30,
        pricing: { basePrice: 500 },
        status: "active",
      });

      regService2 = await Service.create({
        organizationId: regOrg._id,
        categoryId: cat._id,
        name: "PR Service 2",
        duration: 45,
        pricing: { basePrice: 800 },
        status: "active",
      });

      customerPayer = await Customer.create({
        organizationId: regOrg._id,
        name: "Payer Cust",
        phone: "+919876543201",
        homeBranchId: regBranch._id,
        status: "active",
      });

      customerMemberA = await Customer.create({
        organizationId: regOrg._id,
        name: "Member A",
        phone: "+919876543202",
        homeBranchId: regBranch._id,
        status: "active",
      });

      customerMemberB = await Customer.create({
        organizationId: regOrg._id,
        name: "Member B",
        phone: "+919876543203",
        homeBranchId: regBranch._id,
        status: "active",
      });

      legacyCustomer = await Customer.create({
        organizationId: regOrg._id,
        name: "Legacy Cust",
        phone: "+919876543204",
        homeBranchId: regBranch._id,
        status: "active",
      });
    });

    describe("Member entitlement isolation", () => {
      it("1. allows redemption when member has positive allocated entitlement", async () => {
        const sub = await Subscription.create({
          organizationId: regOrg._id,
          branchId: regBranch._id,
          subscriptionCode: `SUB-PR-1-${Date.now()}`,
          price: 2000,
          customerId: customerPayer._id,
          startDate: new Date(),
          endDate: new Date(Date.now() + 30 * 24 * 60 * 60 * 1000),
          status: "active",
          members: [
            {
              customerId: customerMemberA._id,
              status: "active",
              entitlements: [
                {
                  serviceId: regService1._id,
                  serviceName: "PR Service 1",
                  totalQuantity: 2,
                  usedQuantity: 0,
                  remainingQuantity: 2,
                },
              ],
            },
          ],
          entitlements: [
            {
              serviceId: regService1._id,
              serviceName: "PR Service 1",
              totalQuantity: 2,
              usedQuantity: 0,
              remainingQuantity: 2,
            },
          ],
        });

        const apt = await Appointment.create({
          organizationId: regOrg._id,
          branchId: regBranch._id,
          appointmentCode: `APT-PR-1-${Date.now()}`,
          customerId: customerMemberA._id,
          staffId: regStaff._id,
          appointmentDate: "2026-06-01",
          startTime: "10:00",
          endTime: "10:30",
          startAt: new Date("2026-06-01T10:00:00Z"),
          endAt: new Date("2026-06-01T10:30:00Z"),
          bookingType: "advance",
          status: "in_progress",
          totalDuration: 30,
          pricing: {
            subtotal: 500,
            discount: 0,
            total: 500,
          },
          services: [
            {
              _id: new mongoose.Types.ObjectId(),
              serviceType: "registered",
              serviceId: regService1._id,
              name: "PR Service 1",
              duration: 30,
              price: 500,
              appliedSubscriptionId: sub._id,
              isRedeemedViaSubscription: false,
            },
          ],
        });

        const rawOtp = "123456";
        const otpHash = crypto.createHash("sha256").update(rawOtp).digest("hex");
        await SubscriptionConsumptionChallenge.create({
          organizationId: regOrg._id,
          branchId: regBranch._id,
          appointmentId: apt._id,
          subscriptionIds: [sub._id],
          customerId: customerMemberA._id,
          serviceIds: [regService1._id],
          serviceLines: [
            {
              appointmentServiceId: apt.services[0]._id,
              serviceId: regService1._id,
              appliedSubscriptionId: sub._id,
              customerId: customerMemberA._id,
            },
          ],
          otpHash,
          attempts: 0,
          resendAvailableAt: new Date(Date.now() + 60000),
          expiresAt: new Date(Date.now() + 300000),
          status: "pending",
          redemptionState: "pending",
        });

        const res = await request(app)
          .post(`/api/v1/appointments/${apt._id}/complete-with-subscription`)
          .set("Authorization", `Bearer ${regToken}`)
          .send({
            branchId: regBranch._id.toString(),
            otp: rawOtp,
          });

        expect(res.status).toBe(200);
        expect(res.body.data.status).toBe("completed");

        const subAfter = await Subscription.findById(sub._id);
        expect(subAfter.members[0].entitlements[0].remainingQuantity).toBe(1);
      });

      it("2. rejects redemption when member has zero remaining quantity even if root aggregate has positive balance", async () => {
        const sub = await Subscription.create({
          organizationId: regOrg._id,
          branchId: regBranch._id,
          subscriptionCode: `SUB-PR-2-${Date.now()}`,
          price: 2000,
          customerId: customerPayer._id,
          startDate: new Date(),
          endDate: new Date(Date.now() + 30 * 24 * 60 * 60 * 1000),
          status: "active",
          members: [
            {
              customerId: customerMemberA._id,
              status: "active",
              entitlements: [
                {
                  serviceId: regService1._id,
                  serviceName: "PR Service 1",
                  totalQuantity: 2,
                  usedQuantity: 2,
                  remainingQuantity: 0, // Member has 0
                },
              ],
            },
          ],
          entitlements: [
            {
              serviceId: regService1._id,
              serviceName: "PR Service 1",
              totalQuantity: 5,
              usedQuantity: 2,
              remainingQuantity: 3, // Root aggregate still has 3!
            },
          ],
        });

        const apt = await Appointment.create({
          organizationId: regOrg._id,
          branchId: regBranch._id,
          appointmentCode: `APT-PR-2-${Date.now()}`,
          customerId: customerMemberA._id,
          staffId: regStaff._id,
          appointmentDate: "2026-06-01",
          startTime: "11:00",
          endTime: "11:30",
          startAt: new Date("2026-06-01T11:00:00Z"),
          endAt: new Date("2026-06-01T11:30:00Z"),
          bookingType: "advance",
          status: "in_progress",
          totalDuration: 30,
          pricing: {
            subtotal: 500,
            discount: 0,
            total: 500,
          },
          services: [
            {
              _id: new mongoose.Types.ObjectId(),
              serviceType: "registered",
              serviceId: regService1._id,
              name: "PR Service 1",
              duration: 30,
              price: 500,
              appliedSubscriptionId: sub._id,
              isRedeemedViaSubscription: false,
            },
          ],
        });

        const rawOtp = "123456";
        const otpHash = crypto.createHash("sha256").update(rawOtp).digest("hex");
        await SubscriptionConsumptionChallenge.create({
          organizationId: regOrg._id,
          branchId: regBranch._id,
          appointmentId: apt._id,
          subscriptionIds: [sub._id],
          customerId: customerMemberA._id,
          serviceIds: [regService1._id],
          serviceLines: [
            {
              appointmentServiceId: apt.services[0]._id,
              serviceId: regService1._id,
              appliedSubscriptionId: sub._id,
              customerId: customerMemberA._id,
            },
          ],
          otpHash,
          attempts: 0,
          resendAvailableAt: new Date(Date.now() + 60000),
          expiresAt: new Date(Date.now() + 300000),
          status: "pending",
          redemptionState: "pending",
        });

        const res = await request(app)
          .post(`/api/v1/appointments/${apt._id}/complete-with-subscription`)
          .set("Authorization", `Bearer ${regToken}`)
          .send({
            branchId: regBranch._id.toString(),
            otp: rawOtp,
          });

        expect(res.status).toBe(409);
        expect(res.body.message).toMatch(/no remaining quantity/i);

        // Assert negative redemption invariants
        const aptAfter = await Appointment.findById(apt._id);
        expect(aptAfter.status).toBe("in_progress");
        expect(aptAfter.services[0].isRedeemedViaSubscription).toBe(false);

        const subAfter = await Subscription.findById(sub._id);
        expect(subAfter.members[0].entitlements[0].remainingQuantity).toBe(0);
        // Direct storage check verifies root aggregate balance in database was unaffected
        const rawSub = await Subscription.collection.findOne({ _id: sub._id });
        expect(rawSub.entitlements[0].remainingQuantity).toBe(3);

        const usages = await SubscriptionUsage.find({ appointmentId: apt._id });
        expect(usages).toHaveLength(0);
      });

      it("3. rejects redemption when member has no allocation for requested service while root has positive quantity", async () => {
        const sub = await Subscription.create({
          organizationId: regOrg._id,
          branchId: regBranch._id,
          subscriptionCode: `SUB-PR-3-${Date.now()}`,
          price: 2500,
          customerId: customerPayer._id,
          startDate: new Date(),
          endDate: new Date(Date.now() + 30 * 24 * 60 * 60 * 1000),
          status: "active",
          members: [
            {
              customerId: customerMemberA._id,
              status: "active",
              entitlements: [
                {
                  serviceId: regService1._id,
                  serviceName: "PR Service 1",
                  totalQuantity: 2,
                  usedQuantity: 0,
                  remainingQuantity: 2,
                },
                // regService2 is NOT allocated to Member A
              ],
            },
          ],
          entitlements: [
            {
              serviceId: regService1._id,
              serviceName: "PR Service 1",
              totalQuantity: 2,
              usedQuantity: 0,
              remainingQuantity: 2,
            },
            {
              serviceId: regService2._id,
              serviceName: "PR Service 2",
              totalQuantity: 3,
              usedQuantity: 0,
              remainingQuantity: 3, // Root has Service 2!
            },
          ],
        });

        const apt = await Appointment.create({
          organizationId: regOrg._id,
          branchId: regBranch._id,
          appointmentCode: `APT-PR-3-${Date.now()}`,
          customerId: customerMemberA._id,
          staffId: regStaff._id,
          appointmentDate: "2026-06-01",
          startTime: "12:00",
          endTime: "12:45",
          startAt: new Date("2026-06-01T12:00:00Z"),
          endAt: new Date("2026-06-01T12:45:00Z"),
          bookingType: "advance",
          status: "in_progress",
          totalDuration: 45,
          pricing: {
            subtotal: 800,
            discount: 0,
            total: 800,
          },
          services: [
            {
              _id: new mongoose.Types.ObjectId(),
              serviceType: "registered",
              serviceId: regService2._id,
              name: "PR Service 2",
              duration: 45,
              price: 800,
              appliedSubscriptionId: sub._id,
              isRedeemedViaSubscription: false,
            },
          ],
        });

        const rawOtp = "123456";
        const otpHash = crypto.createHash("sha256").update(rawOtp).digest("hex");
        await SubscriptionConsumptionChallenge.create({
          organizationId: regOrg._id,
          branchId: regBranch._id,
          appointmentId: apt._id,
          subscriptionIds: [sub._id],
          customerId: customerMemberA._id,
          serviceIds: [regService2._id],
          serviceLines: [
            {
              appointmentServiceId: apt.services[0]._id,
              serviceId: regService2._id,
              appliedSubscriptionId: sub._id,
              customerId: customerMemberA._id,
            },
          ],
          otpHash,
          attempts: 0,
          resendAvailableAt: new Date(Date.now() + 60000),
          expiresAt: new Date(Date.now() + 300000),
          status: "pending",
          redemptionState: "pending",
        });

        const res = await request(app)
          .post(`/api/v1/appointments/${apt._id}/complete-with-subscription`)
          .set("Authorization", `Bearer ${regToken}`)
          .send({
            branchId: regBranch._id.toString(),
            otp: rawOtp,
          });

        expect(res.status).toBe(400);
        expect(res.body.message).toMatch(/does not contain an entitlement for this service/i);

        // Negative invariants
        const aptAfter = await Appointment.findById(apt._id);
        expect(aptAfter.status).toBe("in_progress");
        const usages = await SubscriptionUsage.find({ appointmentId: apt._id });
        expect(usages).toHaveLength(0);
      });

      it("4. rejects redemption when customer is not listed in subscription.members", async () => {
        const sub = await Subscription.create({
          organizationId: regOrg._id,
          branchId: regBranch._id,
          subscriptionCode: `SUB-PR-4-${Date.now()}`,
          price: 2000,
          customerId: customerPayer._id,
          startDate: new Date(),
          endDate: new Date(Date.now() + 30 * 24 * 60 * 60 * 1000),
          status: "active",
          members: [
            {
              customerId: customerMemberA._id,
              status: "active",
              entitlements: [
                {
                  serviceId: regService1._id,
                  serviceName: "PR Service 1",
                  totalQuantity: 2,
                  usedQuantity: 0,
                  remainingQuantity: 2,
                },
              ],
            },
          ],
          entitlements: [
            {
              serviceId: regService1._id,
              serviceName: "PR Service 1",
              totalQuantity: 2,
              usedQuantity: 0,
              remainingQuantity: 2,
            },
          ],
        });

        // Appointment is for Member B who is NOT in subscription.members
        const apt = await Appointment.create({
          organizationId: regOrg._id,
          branchId: regBranch._id,
          appointmentCode: `APT-PR-4-${Date.now()}`,
          customerId: customerMemberB._id,
          staffId: regStaff._id,
          appointmentDate: "2026-06-01",
          startTime: "13:00",
          endTime: "13:30",
          startAt: new Date("2026-06-01T13:00:00Z"),
          endAt: new Date("2026-06-01T13:30:00Z"),
          bookingType: "advance",
          status: "in_progress",
          totalDuration: 30,
          pricing: {
            subtotal: 500,
            discount: 0,
            total: 500,
          },
          services: [
            {
              _id: new mongoose.Types.ObjectId(),
              serviceType: "registered",
              serviceId: regService1._id,
              name: "PR Service 1",
              duration: 30,
              price: 500,
              appliedSubscriptionId: sub._id,
              isRedeemedViaSubscription: false,
            },
          ],
        });

        const rawOtp = "123456";
        const otpHash = crypto.createHash("sha256").update(rawOtp).digest("hex");
        await SubscriptionConsumptionChallenge.create({
          organizationId: regOrg._id,
          branchId: regBranch._id,
          appointmentId: apt._id,
          subscriptionIds: [sub._id],
          customerId: customerMemberB._id,
          serviceIds: [regService1._id],
          serviceLines: [
            {
              appointmentServiceId: apt.services[0]._id,
              serviceId: regService1._id,
              appliedSubscriptionId: sub._id,
              customerId: customerMemberB._id,
            },
          ],
          otpHash,
          attempts: 0,
          resendAvailableAt: new Date(Date.now() + 60000),
          expiresAt: new Date(Date.now() + 300000),
          status: "pending",
          redemptionState: "pending",
        });

        const res = await request(app)
          .post(`/api/v1/appointments/${apt._id}/complete-with-subscription`)
          .set("Authorization", `Bearer ${regToken}`)
          .send({
            branchId: regBranch._id.toString(),
            otp: rawOtp,
          });

        expect(res.status).toBe(400);
        expect(res.body.message).toMatch(/does not belong to this customer/i);

        const aptAfter = await Appointment.findById(apt._id);
        expect(aptAfter.status).toBe("in_progress");
        const usages = await SubscriptionUsage.find({ appointmentId: apt._id });
        expect(usages).toHaveLength(0);
      });

      it("5. allows redemption when payer is explicitly listed as an eligible member", async () => {
        const sub = await Subscription.create({
          organizationId: regOrg._id,
          branchId: regBranch._id,
          subscriptionCode: `SUB-PR-5-${Date.now()}`,
          price: 2000,
          customerId: customerPayer._id,
          startDate: new Date(),
          endDate: new Date(Date.now() + 30 * 24 * 60 * 60 * 1000),
          status: "active",
          members: [
            {
              customerId: customerPayer._id, // Payer is explicitly in members!
              status: "active",
              entitlements: [
                {
                  serviceId: regService1._id,
                  serviceName: "PR Service 1",
                  totalQuantity: 3,
                  usedQuantity: 0,
                  remainingQuantity: 3,
                },
              ],
            },
          ],
          entitlements: [
            {
              serviceId: regService1._id,
              serviceName: "PR Service 1",
              totalQuantity: 3,
              usedQuantity: 0,
              remainingQuantity: 3,
            },
          ],
        });

        const apt = await Appointment.create({
          organizationId: regOrg._id,
          branchId: regBranch._id,
          appointmentCode: `APT-PR-5-${Date.now()}`,
          customerId: customerPayer._id,
          staffId: regStaff._id,
          appointmentDate: "2026-06-01",
          startTime: "14:00",
          endTime: "14:30",
          startAt: new Date("2026-06-01T14:00:00Z"),
          endAt: new Date("2026-06-01T14:30:00Z"),
          bookingType: "advance",
          status: "in_progress",
          totalDuration: 30,
          pricing: {
            subtotal: 500,
            discount: 0,
            total: 500,
          },
          services: [
            {
              _id: new mongoose.Types.ObjectId(),
              serviceType: "registered",
              serviceId: regService1._id,
              name: "PR Service 1",
              duration: 30,
              price: 500,
              appliedSubscriptionId: sub._id,
              isRedeemedViaSubscription: false,
            },
          ],
        });

        const rawOtp = "123456";
        const otpHash = crypto.createHash("sha256").update(rawOtp).digest("hex");
        await SubscriptionConsumptionChallenge.create({
          organizationId: regOrg._id,
          branchId: regBranch._id,
          appointmentId: apt._id,
          subscriptionIds: [sub._id],
          customerId: customerPayer._id,
          serviceIds: [regService1._id],
          serviceLines: [
            {
              appointmentServiceId: apt.services[0]._id,
              serviceId: regService1._id,
              appliedSubscriptionId: sub._id,
              customerId: customerPayer._id,
            },
          ],
          otpHash,
          attempts: 0,
          resendAvailableAt: new Date(Date.now() + 60000),
          expiresAt: new Date(Date.now() + 300000),
          status: "pending",
          redemptionState: "pending",
        });

        const res = await request(app)
          .post(`/api/v1/appointments/${apt._id}/complete-with-subscription`)
          .set("Authorization", `Bearer ${regToken}`)
          .send({
            branchId: regBranch._id.toString(),
            otp: rawOtp,
          });

        expect(res.status).toBe(200);
        expect(res.body.data.status).toBe("completed");

        const subAfter = await Subscription.findById(sub._id);
        expect(subAfter.members[0].entitlements[0].remainingQuantity).toBe(2);
      });
    });

    describe("Empty versus missing members handling", () => {
      it("6. rejects redemption when members is explicitly an empty array []", async () => {
        const subDoc = {
          _id: new mongoose.Types.ObjectId(),
          organizationId: regOrg._id,
          branchId: regBranch._id,
          subscriptionCode: `SUB-PR-6-${Date.now()}`,
          price: 2000,
          customerId: customerPayer._id,
          startDate: new Date(),
          endDate: new Date(Date.now() + 30 * 24 * 60 * 60 * 1000),
          status: "active",
          isDeleted: false,
          members: [], // Explicit empty array stored in MongoDB!
          entitlements: [
            {
              _id: new mongoose.Types.ObjectId(),
              serviceId: regService1._id,
              serviceName: "PR Service 1",
              totalQuantity: 3,
              usedQuantity: 0,
              remainingQuantity: 3,
            },
          ],
          createdAt: new Date(),
          updatedAt: new Date(),
        };
        await Subscription.collection.insertOne(subDoc);

        const apt = await Appointment.create({
          organizationId: regOrg._id,
          branchId: regBranch._id,
          appointmentCode: `APT-PR-6-${Date.now()}`,
          customerId: customerPayer._id,
          staffId: regStaff._id,
          appointmentDate: "2026-06-01",
          startTime: "15:00",
          endTime: "15:30",
          startAt: new Date("2026-06-01T15:00:00Z"),
          endAt: new Date("2026-06-01T15:30:00Z"),
          bookingType: "advance",
          status: "in_progress",
          totalDuration: 30,
          pricing: {
            subtotal: 500,
            discount: 0,
            total: 500,
          },
          services: [
            {
              _id: new mongoose.Types.ObjectId(),
              serviceType: "registered",
              serviceId: regService1._id,
              name: "PR Service 1",
              duration: 30,
              price: 500,
              appliedSubscriptionId: subDoc._id,
              isRedeemedViaSubscription: false,
            },
          ],
        });

        const rawOtp = "123456";
        const otpHash = crypto.createHash("sha256").update(rawOtp).digest("hex");
        await SubscriptionConsumptionChallenge.create({
          organizationId: regOrg._id,
          branchId: regBranch._id,
          appointmentId: apt._id,
          subscriptionIds: [subDoc._id],
          customerId: customerPayer._id,
          serviceIds: [regService1._id],
          serviceLines: [
            {
              appointmentServiceId: apt.services[0]._id,
              serviceId: regService1._id,
              appliedSubscriptionId: subDoc._id,
              customerId: customerPayer._id,
            },
          ],
          otpHash,
          attempts: 0,
          resendAvailableAt: new Date(Date.now() + 60000),
          expiresAt: new Date(Date.now() + 300000),
          status: "pending",
          redemptionState: "pending",
        });

        const res = await request(app)
          .post(`/api/v1/appointments/${apt._id}/complete-with-subscription`)
          .set("Authorization", `Bearer ${regToken}`)
          .send({
            branchId: regBranch._id.toString(),
            otp: rawOtp,
          });

        expect(res.status).toBe(400);
        expect(res.body.message).toMatch(/does not belong to this customer/i);

        const aptAfter = await Appointment.findById(apt._id);
        expect(aptAfter.status).toBe("in_progress");
        const usages = await SubscriptionUsage.find({ appointmentId: apt._id });
        expect(usages).toHaveLength(0);
      });

      it("7. preserves legacy owner behavior when members is genuinely undefined", async () => {
        // Direct MongoDB collection insert to ensure members field is genuinely undefined
        const subDoc = {
          _id: new mongoose.Types.ObjectId(),
          organizationId: regOrg._id,
          branchId: regBranch._id,
          subscriptionCode: `SUB-PR-7-${Date.now()}`,
          price: 2000,
          customerId: legacyCustomer._id,
          startDate: new Date(),
          endDate: new Date(Date.now() + 30 * 24 * 60 * 60 * 1000),
          status: "active",
          isDeleted: false,
          entitlements: [
            {
              _id: new mongoose.Types.ObjectId(),
              serviceId: regService1._id,
              serviceName: "PR Service 1",
              totalQuantity: 3,
              usedQuantity: 0,
              remainingQuantity: 3,
            },
          ],
          createdAt: new Date(),
          updatedAt: new Date(),
        };
        await Subscription.collection.insertOne(subDoc);

        const apt = await Appointment.create({
          organizationId: regOrg._id,
          branchId: regBranch._id,
          appointmentCode: `APT-PR-7-${Date.now()}`,
          customerId: legacyCustomer._id,
          staffId: regStaff._id,
          appointmentDate: "2026-06-01",
          startTime: "16:00",
          endTime: "16:30",
          startAt: new Date("2026-06-01T16:00:00Z"),
          endAt: new Date("2026-06-01T16:30:00Z"),
          bookingType: "advance",
          status: "in_progress",
          totalDuration: 30,
          pricing: {
            subtotal: 500,
            discount: 0,
            total: 500,
          },
          services: [
            {
              _id: new mongoose.Types.ObjectId(),
              serviceType: "registered",
              serviceId: regService1._id,
              name: "PR Service 1",
              duration: 30,
              price: 500,
              appliedSubscriptionId: subDoc._id,
              isRedeemedViaSubscription: false,
            },
          ],
        });

        const rawOtp = "123456";
        const otpHash = crypto.createHash("sha256").update(rawOtp).digest("hex");
        await SubscriptionConsumptionChallenge.create({
          organizationId: regOrg._id,
          branchId: regBranch._id,
          appointmentId: apt._id,
          subscriptionIds: [subDoc._id],
          customerId: legacyCustomer._id,
          serviceIds: [regService1._id],
          serviceLines: [
            {
              appointmentServiceId: apt.services[0]._id,
              serviceId: regService1._id,
              appliedSubscriptionId: subDoc._id,
              customerId: legacyCustomer._id,
            },
          ],
          otpHash,
          attempts: 0,
          resendAvailableAt: new Date(Date.now() + 60000),
          expiresAt: new Date(Date.now() + 300000),
          status: "pending",
          redemptionState: "pending",
        });

        const res = await request(app)
          .post(`/api/v1/appointments/${apt._id}/complete-with-subscription`)
          .set("Authorization", `Bearer ${regToken}`)
          .send({
            branchId: regBranch._id.toString(),
            otp: rawOtp,
          });

        expect(res.status).toBe(200);
        expect(res.body.data.status).toBe("completed");

        const subAfter = await Subscription.findById(subDoc._id);
        expect(subAfter.entitlements[0].remainingQuantity).toBe(2);
      });

      it("8. rejects redemption on legacy subscription when customer does not match legacy customerId", async () => {
        const subDoc = {
          _id: new mongoose.Types.ObjectId(),
          organizationId: regOrg._id,
          branchId: regBranch._id,
          subscriptionCode: `SUB-PR-8-${Date.now()}`,
          price: 2000,
          customerId: legacyCustomer._id, // Owned by legacyCustomer
          startDate: new Date(),
          endDate: new Date(Date.now() + 30 * 24 * 60 * 60 * 1000),
          status: "active",
          isDeleted: false,
          entitlements: [
            {
              _id: new mongoose.Types.ObjectId(),
              serviceId: regService1._id,
              serviceName: "PR Service 1",
              totalQuantity: 3,
              usedQuantity: 0,
              remainingQuantity: 3,
            },
          ],
          createdAt: new Date(),
          updatedAt: new Date(),
        };
        await Subscription.collection.insertOne(subDoc);

        // Appointment is for customerMemberA, not legacyCustomer
        const apt = await Appointment.create({
          organizationId: regOrg._id,
          branchId: regBranch._id,
          appointmentCode: `APT-PR-8-${Date.now()}`,
          customerId: customerMemberA._id,
          staffId: regStaff._id,
          appointmentDate: "2026-06-01",
          startTime: "17:00",
          endTime: "17:30",
          startAt: new Date("2026-06-01T17:00:00Z"),
          endAt: new Date("2026-06-01T17:30:00Z"),
          bookingType: "advance",
          status: "in_progress",
          totalDuration: 30,
          pricing: {
            subtotal: 500,
            discount: 0,
            total: 500,
          },
          services: [
            {
              _id: new mongoose.Types.ObjectId(),
              serviceType: "registered",
              serviceId: regService1._id,
              name: "PR Service 1",
              duration: 30,
              price: 500,
              appliedSubscriptionId: subDoc._id,
              isRedeemedViaSubscription: false,
            },
          ],
        });

        const rawOtp = "123456";
        const otpHash = crypto.createHash("sha256").update(rawOtp).digest("hex");
        await SubscriptionConsumptionChallenge.create({
          organizationId: regOrg._id,
          branchId: regBranch._id,
          appointmentId: apt._id,
          subscriptionIds: [subDoc._id],
          customerId: customerMemberA._id,
          serviceIds: [regService1._id],
          serviceLines: [
            {
              appointmentServiceId: apt.services[0]._id,
              serviceId: regService1._id,
              appliedSubscriptionId: subDoc._id,
              customerId: customerMemberA._id,
            },
          ],
          otpHash,
          attempts: 0,
          resendAvailableAt: new Date(Date.now() + 60000),
          expiresAt: new Date(Date.now() + 300000),
          status: "pending",
          redemptionState: "pending",
        });

        const res = await request(app)
          .post(`/api/v1/appointments/${apt._id}/complete-with-subscription`)
          .set("Authorization", `Bearer ${regToken}`)
          .send({
            branchId: regBranch._id.toString(),
            otp: rawOtp,
          });

        expect(res.status).toBe(400);
        expect(res.body.message).toMatch(/does not belong to this customer/i);

        const aptAfter = await Appointment.findById(apt._id);
        expect(aptAfter.status).toBe("in_progress");
        const usages = await SubscriptionUsage.find({ appointmentId: apt._id });
        expect(usages).toHaveLength(0);
      });
    });

    describe("Transaction safety enforcement", () => {
      it("9. fails closed with HTTP 500 when transaction support is unavailable", async () => {
        const sub = await Subscription.create({
          organizationId: regOrg._id,
          branchId: regBranch._id,
          subscriptionCode: `SUB-PR-9-${Date.now()}`,
          price: 2000,
          customerId: customerPayer._id,
          startDate: new Date(),
          endDate: new Date(Date.now() + 30 * 24 * 60 * 60 * 1000),
          status: "active",
          members: [
            {
              customerId: customerMemberA._id,
              status: "active",
              entitlements: [
                {
                  serviceId: regService1._id,
                  serviceName: "PR Service 1",
                  totalQuantity: 2,
                  usedQuantity: 0,
                  remainingQuantity: 2,
                },
              ],
            },
          ],
          entitlements: [
            {
              serviceId: regService1._id,
              serviceName: "PR Service 1",
              totalQuantity: 2,
              usedQuantity: 0,
              remainingQuantity: 2,
            },
          ],
        });

        const apt = await Appointment.create({
          organizationId: regOrg._id,
          branchId: regBranch._id,
          appointmentCode: `APT-PR-9-${Date.now()}`,
          customerId: customerMemberA._id,
          staffId: regStaff._id,
          appointmentDate: "2026-06-01",
          startTime: "18:00",
          endTime: "18:30",
          startAt: new Date("2026-06-01T18:00:00Z"),
          endAt: new Date("2026-06-01T18:30:00Z"),
          bookingType: "advance",
          status: "in_progress",
          totalDuration: 30,
          pricing: {
            subtotal: 500,
            discount: 0,
            total: 500,
          },
          services: [
            {
              _id: new mongoose.Types.ObjectId(),
              serviceType: "registered",
              serviceId: regService1._id,
              name: "PR Service 1",
              duration: 30,
              price: 500,
              appliedSubscriptionId: sub._id,
              isRedeemedViaSubscription: false,
            },
          ],
        });

        const rawOtp = "123456";
        const otpHash = crypto.createHash("sha256").update(rawOtp).digest("hex");
        await SubscriptionConsumptionChallenge.create({
          organizationId: regOrg._id,
          branchId: regBranch._id,
          appointmentId: apt._id,
          subscriptionIds: [sub._id],
          customerId: customerMemberA._id,
          serviceIds: [regService1._id],
          serviceLines: [
            {
              appointmentServiceId: apt.services[0]._id,
              serviceId: regService1._id,
              appliedSubscriptionId: sub._id,
              customerId: customerMemberA._id,
            },
          ],
          otpHash,
          attempts: 0,
          resendAvailableAt: new Date(Date.now() + 60000),
          expiresAt: new Date(Date.now() + 300000),
          status: "pending",
          redemptionState: "pending",
        });

        // Simulate standalone / non-replica topology
        const origClient = mongoose.connection.client;
        mongoose.connection.client = {
          ...origClient,
          topology: {
            description: {
              type: "Single",
            },
          },
        };

        try {
          const res = await request(app)
            .post(`/api/v1/appointments/${apt._id}/complete-with-subscription`)
            .set("Authorization", `Bearer ${regToken}`)
            .send({
              branchId: regBranch._id.toString(),
              otp: rawOtp,
            });

          expect(res.status).toBe(500);
          expect(res.body.message).toMatch(
            /ACID transaction support is required for this operation but unavailable in the database environment/
          );

          // Assert negative redemption invariants
          const aptAfter = await Appointment.findById(apt._id);
          expect(aptAfter.status).toBe("in_progress");
          expect(aptAfter.services[0].isRedeemedViaSubscription).toBe(false);

          const subAfter = await Subscription.findById(sub._id);
          expect(subAfter.members[0].entitlements[0].remainingQuantity).toBe(2);

          const usages = await SubscriptionUsage.find({ appointmentId: apt._id });
          expect(usages).toHaveLength(0);
        } finally {
          mongoose.connection.client = origClient;
        }
      });

      it("10. proves ALLOW_STANDALONE_TRANSACTION_FALLBACK=true cannot permit non-transactional redemption in standalone mode", async () => {
        const sub = await Subscription.create({
          organizationId: regOrg._id,
          branchId: regBranch._id,
          subscriptionCode: `SUB-PR-10-${Date.now()}`,
          price: 2000,
          customerId: customerPayer._id,
          startDate: new Date(),
          endDate: new Date(Date.now() + 30 * 24 * 60 * 60 * 1000),
          status: "active",
          members: [
            {
              customerId: customerMemberA._id,
              status: "active",
              entitlements: [
                {
                  serviceId: regService1._id,
                  serviceName: "PR Service 1",
                  totalQuantity: 2,
                  usedQuantity: 0,
                  remainingQuantity: 2,
                },
              ],
            },
          ],
          entitlements: [
            {
              serviceId: regService1._id,
              serviceName: "PR Service 1",
              totalQuantity: 2,
              usedQuantity: 0,
              remainingQuantity: 2,
            },
          ],
        });

        const apt = await Appointment.create({
          organizationId: regOrg._id,
          branchId: regBranch._id,
          appointmentCode: `APT-PR-10-${Date.now()}`,
          customerId: customerMemberA._id,
          staffId: regStaff._id,
          appointmentDate: "2026-06-01",
          startTime: "19:00",
          endTime: "19:30",
          startAt: new Date("2026-06-01T19:00:00Z"),
          endAt: new Date("2026-06-01T19:30:00Z"),
          bookingType: "advance",
          status: "in_progress",
          totalDuration: 30,
          pricing: {
            subtotal: 500,
            discount: 0,
            total: 500,
          },
          services: [
            {
              _id: new mongoose.Types.ObjectId(),
              serviceType: "registered",
              serviceId: regService1._id,
              name: "PR Service 1",
              duration: 30,
              price: 500,
              appliedSubscriptionId: sub._id,
              isRedeemedViaSubscription: false,
            },
          ],
        });

        const rawOtp = "123456";
        const otpHash = crypto.createHash("sha256").update(rawOtp).digest("hex");
        await SubscriptionConsumptionChallenge.create({
          organizationId: regOrg._id,
          branchId: regBranch._id,
          appointmentId: apt._id,
          subscriptionIds: [sub._id],
          customerId: customerMemberA._id,
          serviceIds: [regService1._id],
          serviceLines: [
            {
              appointmentServiceId: apt.services[0]._id,
              serviceId: regService1._id,
              appliedSubscriptionId: sub._id,
              customerId: customerMemberA._id,
            },
          ],
          otpHash,
          attempts: 0,
          resendAvailableAt: new Date(Date.now() + 60000),
          expiresAt: new Date(Date.now() + 300000),
          status: "pending",
          redemptionState: "pending",
        });

        const origClient = mongoose.connection.client;
        const oldFlag = process.env.ALLOW_STANDALONE_TRANSACTION_FALLBACK;
        process.env.ALLOW_STANDALONE_TRANSACTION_FALLBACK = "true";

        mongoose.connection.client = {
          ...origClient,
          topology: {
            description: {
              type: "Single",
            },
          },
        };

        try {
          const res = await request(app)
            .post(`/api/v1/appointments/${apt._id}/complete-with-subscription`)
            .set("Authorization", `Bearer ${regToken}`)
            .send({
              branchId: regBranch._id.toString(),
              otp: rawOtp,
            });

          expect(res.status).toBe(500);
          expect(res.body.message).toMatch(
            /ACID transaction support is required for this operation/
          );

          // Assert negative redemption invariants
          const aptAfter = await Appointment.findById(apt._id);
          expect(aptAfter.status).toBe("in_progress");
          expect(aptAfter.services[0].isRedeemedViaSubscription).toBe(false);

          const subAfter = await Subscription.findById(sub._id);
          expect(subAfter.members[0].entitlements[0].remainingQuantity).toBe(2);

          const usages = await SubscriptionUsage.find({ appointmentId: apt._id });
          expect(usages).toHaveLength(0);
        } finally {
          mongoose.connection.client = origClient;
          if (oldFlag !== undefined) {
            process.env.ALLOW_STANDALONE_TRANSACTION_FALLBACK = oldFlag;
          } else {
            delete process.env.ALLOW_STANDALONE_TRANSACTION_FALLBACK;
          }
        }
      });
    });
  });
});

