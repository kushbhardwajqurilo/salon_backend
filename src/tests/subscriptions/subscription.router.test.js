import { describe, expect, it, beforeEach, afterEach, jest } from "@jest/globals";
import crypto from "crypto";
import request from "supertest";
import mongoose from "mongoose";
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
import { AuditLog } from "../../../src/models/audit/auditLog.model.js";
import jwt from "jsonwebtoken";
import { env } from "../../../src/config/env.js";
import { redis } from "../../../src/utils/redis.js";

jest.spyOn(redis, "get").mockResolvedValue(null);
jest.spyOn(redis, "setex").mockResolvedValue("OK");

describe("Subscription Module Integration Tests", () => {
  jest.setTimeout(30000);

  let orgA, orgB;
  let branchA1, branchA2, branchB1;
  let ownerToken, staffToken;
  let ownerUser, staffUser;
  let customerA;
  let serviceA1, serviceA2;
  let categoryA;

  beforeAll(async () => {
    let testUri = process.env.MONGO_URI || "mongodb://127.0.0.1:27017/saloon_erp_test";
    if (testUri.includes("?")) {
      const parts = testUri.split("?");
      testUri = parts[0].replace(/\/([^\/]+)$/, "/saloon_erp_sub_test") + "?" + parts[1];
    } else {
      testUri = testUri.replace(/\/([^\/]+)$/, "/saloon_erp_sub_test");
    }
    await mongoose.connect(testUri);
  });

  afterAll(async () => {
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
    // 1. Clean DB
    await Appointment.deleteMany({});
    await SubscriptionUsage.deleteMany({});
    await Subscription.deleteMany({});
    await SubscriptionPlan.deleteMany({});
    await Service.deleteMany({});
    await ServiceCategory.deleteMany({});
    await Customer.deleteMany({});
    await User.deleteMany({});
    await Role.deleteMany({});
    await Permission.deleteMany({});
    await Branch.deleteMany({});
    await Organization.deleteMany({});

    // 2. Setup Organizations
    orgA = await Organization.create({
      name: "Salon Elegance",
      slug: "salon-elegance",
    });

    orgB = await Organization.create({
      name: "Rival Salon",
      slug: "rival-salon",
    });

    // 3. Branches
    branchA1 = await Branch.create({
      name: "Downtown Branch",
      organizationId: orgA._id,
      isActive: true,
      address: "123 Downtown St, New York, NY",
    });

    branchA2 = await Branch.create({
      name: "Uptown Branch",
      organizationId: orgA._id,
      isActive: true,
      address: "456 Uptown Ave, New York, NY",
    });

    branchB1 = await Branch.create({
      name: "Brooklyn Branch",
      organizationId: orgB._id,
      isActive: true,
      address: "789 Brooklyn Rd, New York, NY",
    });

    // 4. Permissions & Roles
    const permSell = await Permission.create({
      name: "subscriptions.sell",
      module: "Subscriptions",
      action: "Sell",
      description: "Sell subscriptions",
    });
    const permView = await Permission.create({
      name: "subscriptions.view",
      module: "Subscriptions",
      action: "View",
      description: "View subscriptions",
    });
    const permConfigure = await Permission.create({
      name: "subscriptions.configure",
      module: "Subscriptions",
      action: "Configure",
      description: "Configure subscriptions",
    });
    const permRedeem = await Permission.create({
      name: "subscriptions.redeem",
      module: "Subscriptions",
      action: "Redeem",
      description: "Redeem subscriptions",
    });

    const ownerRole = await Role.create({
      name: "owner",
      description: "Full owner permissions",
      permissions: [permSell._id, permView._id, permConfigure._id, permRedeem._id],
      isSystem: true,
    });

    // 5. Users & Auth Tokens
    ownerUser = await User.create({
      name: "Owner Alice",
      username: "owneralice",
      email: "owner@salonelegance.com",
      password: "HashedPassword123!",
      phone: "+12125550100",
      organizationId: orgA._id,
      role: ownerRole._id,
      isVerified: true,
      status: "active",
      hasOrgWideAccess: true,
      branchAccess: [],
    });

    ownerToken = jwt.sign(
      {
        id: ownerUser._id.toString(),
        sub: ownerUser._id.toString(),
        userId: ownerUser._id.toString(),
        organizationId: orgA._id.toString(),
        role: "owner",
        hasOrgWideAccess: true,
        branchAccess: [],
      },
      env.JWT_SECRET || "test-secret",
      { expiresIn: "1h" }
    );

    // 6. Category & Services
    categoryA = await ServiceCategory.create({
      name: "Hair Services",
      organizationId: orgA._id,
      branchId: branchA1._id,
    });

    serviceA1 = await Service.create({
      name: "Signature Haircut",
      serviceCode: "SHC-01",
      organizationId: orgA._id,
      categoryId: categoryA._id,
      duration: 45,
      pricing: { basePrice: 800 },
      status: "active",
    });

    serviceA2 = await Service.create({
      name: "Express Blowdry",
      serviceCode: "EBD-02",
      organizationId: orgA._id,
      categoryId: categoryA._id,
      duration: 30,
      pricing: { basePrice: 500 },
      status: "active",
    });

    // 7. Customer
    customerA = await Customer.create({
      name: "Emma Stone",
      phone: "+919876543210",
      organizationId: orgA._id,
      homeBranchId: branchA1._id,
      status: "active",
    });
  });

  describe("POST /api/v1/subscriptions - Create Subscription", () => {
    it("should successfully create a customer subscription with customer-specific price and entitlements", async () => {
      const res = await request(app)
        .post("/api/v1/subscriptions")
        .set("Authorization", `Bearer ${ownerToken}`)
        .send({
          customerId: customerA._id.toString(),
          price: 3500, // Custom negotiated package price
          entitlements: [
            { serviceId: serviceA1._id.toString(), quantity: 5 },
            { serviceId: serviceA2._id.toString(), quantity: 3 },
          ],
          permittedBranchIds: [branchA1._id.toString()],
          startDate: "2026-10-01",
          endDate: "2026-12-31",
          notes: "Autumn Special",
        });

      if (res.status !== 201) {
        console.log("CREATE_SUBSCRIPTION_ERROR:", res.status, res.body);
      }
      expect(res.status).toBe(201);
      expect(res.body.success).toBe(true);
      expect(res.body.data.subscriptionCode).toMatch(/^SUB-\d{8}-\d{4}$/);
      expect(res.body.data.price).toBe(3500);
      expect(res.body.data.entitlements).toHaveLength(2);
      expect(res.body.data.entitlements[0].serviceName).toBe("Signature Haircut");
      expect(res.body.data.entitlements[0].remainingQuantity).toBe(5);
    });

    it("should reject creation if service belongs to another organization", async () => {
      // Create service in Org B
      const categoryB = await ServiceCategory.create({
        name: "Foreign Category",
        organizationId: orgB._id,
        branchId: branchB1._id,
      });
      const serviceB = await Service.create({
        name: "Foreign Massage",
        serviceCode: "FM-01",
        organizationId: orgB._id,
        categoryId: categoryB._id,
        duration: 60,
        pricing: { basePrice: 1500 },
        status: "active",
      });

      const res = await request(app)
        .post("/api/v1/subscriptions")
        .set("Authorization", `Bearer ${ownerToken}`)
        .send({
          customerId: customerA._id.toString(),
          price: 1000,
          entitlements: [{ serviceId: serviceB._id.toString(), quantity: 1 }],
          startDate: "2026-10-01",
          endDate: "2026-12-31",
        });

      expect(res.status).toBe(404);
      expect(res.body.message).toMatch(/not found in this organization/);
    });
  });

  describe("End-to-End Redemption Lifecycle via API", () => {
    it("should send OTP, verify OTP, atomically deduct entitlement, record usage, and list usage history", async () => {
      // 1. Create Subscription
      const createRes = await request(app)
        .post("/api/v1/subscriptions")
        .set("Authorization", `Bearer ${ownerToken}`)
        .send({
          customerId: customerA._id.toString(),
          price: 2400,
          entitlements: [{ serviceId: serviceA1._id.toString(), quantity: 3 }],
          permittedBranchIds: [branchA1._id.toString(), branchA2._id.toString()],
          startDate: "2026-10-01",
          endDate: "2026-12-31",
        });

      expect(createRes.status).toBe(201);
      const subId = createRes.body.data._id;

      // 2. Request Redemption OTP
      const otpRes = await request(app)
        .post(`/api/v1/subscriptions/${subId}/send-otp`)
        .set("Authorization", `Bearer ${ownerToken}`)
        .set("X-Branch-Id", branchA1._id.toString())
        .send({ branchId: branchA1._id.toString() });

      expect(otpRes.status).toBe(200);
      expect(otpRes.body.success).toBe(true);

      // Verify OTP stored on Customer (we fetch the updated customer doc)
      const updatedCustomer = await Customer.findById(customerA._id);
      expect(updatedCustomer.otp).toBeDefined();

      // For test verification, manually seed known OTP
      const knownOtp = "789123";
      updatedCustomer.otp = crypto.createHash("sha256").update(knownOtp).digest("hex");
      updatedCustomer.otpExpires = new Date(Date.now() + 300000);
      await updatedCustomer.save();

      // 3. Redeem service entitlement using OTP
      const redeemRes = await request(app)
        .post(`/api/v1/subscriptions/${subId}/redeem`)
        .set("Authorization", `Bearer ${ownerToken}`)
        .set("X-Branch-Id", branchA1._id.toString())
        .send({
          branchId: branchA1._id.toString(),
          otp: knownOtp,
          services: [{ serviceId: serviceA1._id.toString(), quantity: 2 }],
        });

      expect(redeemRes.status).toBe(200);
      expect(redeemRes.body.success).toBe(true);
      expect(redeemRes.body.data.subscription.entitlements[0].usedQuantity).toBe(2);
      expect(redeemRes.body.data.subscription.entitlements[0].remainingQuantity).toBe(1);

      // 4. Retrieve Subscription Details
      const getRes = await request(app)
        .get(`/api/v1/subscriptions/${subId}`)
        .set("Authorization", `Bearer ${ownerToken}`);

      expect(getRes.status).toBe(200);
      expect(getRes.body.data.entitlements[0].remainingQuantity).toBe(1);

      // 5. Retrieve Subscription Usage History
      const usageRes = await request(app)
        .get(`/api/v1/subscriptions/${subId}/usage`)
        .set("Authorization", `Bearer ${ownerToken}`);

      expect(usageRes.status).toBe(200);
      expect(usageRes.body.data).toHaveLength(1);
      expect(usageRes.body.data[0].serviceName).toBe("Signature Haircut");
      expect(usageRes.body.data[0].quantity).toBe(2);
      expect(usageRes.body.data[0].verificationMethod).toBe("otp");
    });

    it("should link subscription to planId and update appointment service line item upon redemption", async () => {
      // 1. Create a Subscription Plan
      const plan = await SubscriptionPlan.create({
        organizationId: orgA._id,
        name: "Bridal Package 5x",
        code: "BP-5X",
        suggestedPrice: 4000,
        validityMonths: 6,
        entitlements: [{ serviceId: serviceA1._id, quantity: 5 }],
      });

      // 2. Create Customer Subscription referencing planId (with customized price 3800)
      const createRes = await request(app)
        .post("/api/v1/subscriptions")
        .set("Authorization", `Bearer ${ownerToken}`)
        .send({
          customerId: customerA._id.toString(),
          planId: plan._id.toString(),
          price: 3800,
          entitlements: [{ serviceId: serviceA1._id.toString(), quantity: 5 }],
          startDate: "2026-10-01",
          endDate: "2027-04-01",
        });

      expect(createRes.status).toBe(201);
      expect(createRes.body.data.planId).toBe(plan._id.toString());
      expect(createRes.body.data.price).toBe(3800);
      const subId = createRes.body.data._id;

      // 3. Create an Appointment with serviceA1
      const appointment = await Appointment.create({
        organizationId: orgA._id,
        branchId: branchA1._id,
        appointmentCode: "APT-20261001-0001",
        customerId: customerA._id,
        bookingType: "walk_in",
        appointmentDate: "2026-10-01",
        startTime: "10:00",
        endTime: "10:45",
        startAt: new Date("2026-10-01T10:00:00Z"),
        endAt: new Date("2026-10-01T10:45:00Z"),
        totalDuration: 45,
        services: [
          {
            serviceId: serviceA1._id,
            name: "Signature Haircut",
            duration: 45,
            price: 800,
            isRedeemedViaSubscription: false,
            subscriptionUsageId: null,
          },
        ],
        pricing: { subtotal: 800, discount: 0, total: 800 },
      });

      // 4. Send OTP and seed known OTP
      await request(app)
        .post(`/api/v1/subscriptions/${subId}/send-otp`)
        .set("Authorization", `Bearer ${ownerToken}`)
        .set("X-Branch-Id", branchA1._id.toString())
        .send({ branchId: branchA1._id.toString() });

      const knownOtp = "456789";
      const customer = await Customer.findById(customerA._id);
      customer.otp = crypto.createHash("sha256").update(knownOtp).digest("hex");
      customer.otpExpires = new Date(Date.now() + 300000);
      await customer.save();

      // 5. Redeem with appointmentId
      const redeemRes = await request(app)
        .post(`/api/v1/subscriptions/${subId}/redeem`)
        .set("Authorization", `Bearer ${ownerToken}`)
        .set("X-Branch-Id", branchA1._id.toString())
        .send({
          branchId: branchA1._id.toString(),
          otp: knownOtp,
          services: [{ serviceId: serviceA1._id.toString(), quantity: 1 }],
          appointmentId: appointment._id.toString(),
        });

      expect(redeemRes.status).toBe(200);
      const usageId = redeemRes.body.data.usage[0]._id;

      // 6. Verify Appointment service line item updated
      const updatedAppointment = await Appointment.findById(appointment._id);
      expect(updatedAppointment.services[0].isRedeemedViaSubscription).toBe(true);
      expect(updatedAppointment.services[0].subscriptionUsageId.toString()).toBe(
        usageId.toString()
      );
    });
  });
});
