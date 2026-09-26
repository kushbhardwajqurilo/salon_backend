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
import jwt from "jsonwebtoken";
import { env } from "../../../src/config/env.js";
import { redis } from "../../../src/utils/redis.js";

jest.spyOn(redis, "get").mockResolvedValue(null);
jest.spyOn(redis, "setex").mockResolvedValue("OK");

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
    let testUri = process.env.MONGO_URI || "mongodb://127.0.0.1:27017/saloon_erp_test";
    if (testUri.includes("?")) {
      const parts = testUri.split("?");
      testUri = parts[0].replace(/\/([^\/]+)$/, "/saloon_erp_appt_sub_test") + "?" + parts[1];
    } else {
      testUri = testUri.replace(/\/([^\/]+)$/, "/saloon_erp_appt_sub_test");
    }
    await mongoose.connect(testUri);
  });

  afterAll(async () => {
    delete process.env.ALLOW_STANDALONE_TRANSACTION_FALLBACK;
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
          appointmentDate: "2026-10-15",
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
          appointmentDate: "2026-10-15",
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
          appointmentDate: "2026-10-20",
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
          appointmentDate: "2026-10-21",
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
          appointmentDate: "2026-10-25",
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
          appointmentDate: "2026-10-28",
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
          appointmentDate: "2026-10-29",
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
  });
});
