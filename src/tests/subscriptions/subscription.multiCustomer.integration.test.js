import { describe, expect, it, beforeEach, afterEach, jest, beforeAll, afterAll } from "@jest/globals";
import request from "supertest";
import mongoose from "mongoose";
import app from "../../../app.mjs";
import { Organization } from "../../models/organizations/organization.model.js";
import { Branch } from "../../models/branches/branch.model.js";
import { Customer } from "../../models/customers/customer.model.js";
import { Service } from "../../models/services/service.model.js";
import { ServiceCategory } from "../../models/services/serviceCategory.model.js";
import { Role } from "../../models/roles/role.model.js";
import { Permission } from "../../models/permissions/permission.model.js";
import { User } from "../../models/users/user.model.js";
import { Subscription } from "../../models/subscriptions/subscription.model.js";
import { SubscriptionUsage } from "../../models/subscriptions/subscriptionUsage.model.js";
import { Appointment } from "../../models/appointments/appointment.model.js";
import { SubscriptionConsumptionChallenge } from "../../models/subscriptions/subscriptionConsumptionChallenge.model.js";
import { Invoice } from "../../models/billing/invoice.model.js";
import { Payment } from "../../models/billing/payment.model.js";
import { AuditLog } from "../../models/audit/auditLog.model.js";
import jwt from "jsonwebtoken";
import { env } from "../../config/env.js";
import { redis } from "../../utils/redis.js";

jest.spyOn(redis, "get").mockResolvedValue(null);
jest.spyOn(redis, "setex").mockResolvedValue("OK");

describe("Multi-Customer Subscriptions, Member Isolation & Exact Idempotency Tests", () => {
  jest.setTimeout(45000);

  let org;
  let branch1, branch2;
  let ownerToken;
  let customerPayer, customerMemberA, customerMemberB;
  let serviceHairCut, serviceSpa;
  let category;

  beforeAll(async () => {
    process.env.ALLOW_STANDALONE_TRANSACTION_FALLBACK = "true";
    const testUri = process.env.TEST_MONGO_URI || "mongodb://127.0.0.1:27017/saloon_erp_multi_sub_test";
    await mongoose.connect(testUri);
  });

  afterAll(async () => {
    await Payment.deleteMany({});
    await Invoice.deleteMany({});
    await Appointment.deleteMany({});
    await SubscriptionUsage.deleteMany({});
    await SubscriptionConsumptionChallenge.deleteMany({});
    await Subscription.deleteMany({});
    await AuditLog.deleteMany({});
    await Service.deleteMany({});
    await ServiceCategory.deleteMany({});
    await Customer.deleteMany({});
    await User.deleteMany({});
    await Role.deleteMany({});
    await Permission.deleteMany({});
    await Branch.deleteMany({});
    await Organization.deleteMany({});
    await mongoose.disconnect();
  });

  beforeEach(async () => {
    await Payment.deleteMany({});
    await Invoice.deleteMany({});
    await Appointment.deleteMany({});
    await SubscriptionUsage.deleteMany({});
    await SubscriptionConsumptionChallenge.deleteMany({});
    await Subscription.deleteMany({});
    await AuditLog.deleteMany({});
    await Service.deleteMany({});
    await ServiceCategory.deleteMany({});
    await Customer.deleteMany({});
    await User.deleteMany({});
    await Role.deleteMany({});
    await Permission.deleteMany({});
    await Branch.deleteMany({});
    await Organization.deleteMany({});

    // 1. Setup Org & Branches
    org = await Organization.create({
      name: "Luxury Multi-Member Salon Org",
      status: "active",
      currency: "INR",
      timezone: "Asia/Kolkata",
    });

    branch1 = await Branch.create({
      organizationId: org._id,
      name: "Downtown Flagship",
      address: "123 Main St, Mumbai, MH, 400001, India",
      phone: "+919800000001",
      isActive: true,
    });

    branch2 = await Branch.create({
      organizationId: org._id,
      name: "Suburban Outlet",
      address: "456 Side Rd, Mumbai, MH, 400050, India",
      phone: "+919800000002",
      isActive: true,
    });

    // 2. Setup Super Admin Owner User & Tokens
    const permissionNames = [
      "subscriptions.sell",
      "subscriptions.view",
      "subscriptions.configure",
      "subscriptions.redeem",
      "billing.create",
      "billing.view",
      "billing.checkout",
      "payments.receive",
      "appointments.create",
      "appointments.view",
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

    const superAdminRole = await Role.create({
      organizationId: org._id,
      name: "Organization Owner",
      isCustom: false,
      permissions: permissions.map((p) => p._id),
    });

    const ownerUser = await User.create({
      organizationId: org._id,
      name: "Owner User",
      email: `owner_${Date.now()}@salon.com`,
      phone: "+919820000099",
      password: "HashedPassword123!",
      role: superAdminRole._id,
      hasOrgWideAccess: true,
      branchAccess: [
        { branchId: branch1._id, branchName: "Downtown Flagship", isActive: true },
        { branchId: branch2._id, branchName: "Suburban Outlet", isActive: true },
      ],
      status: "active",
    });

    ownerToken = jwt.sign(
      {
        id: ownerUser._id.toString(),
        userId: ownerUser._id.toString(),
        organizationId: org._id.toString(),
        role: "owner",
        hasOrgWideAccess: true,
      },
      env.JWT_SECRET,
      { expiresIn: "1h" }
    );

    // 3. Customers: Payer, Member A, Member B
    customerPayer = await Customer.create({
      organizationId: org._id,
      homeBranchId: branch1._id,
      name: "Corporate Payer",
      phone: "+919811111111",
      email: "payer@corp.com",
      status: "active",
    });

    customerMemberA = await Customer.create({
      organizationId: org._id,
      homeBranchId: branch1._id,
      name: "Beneficiary Alice",
      phone: "+919822222222",
      email: "alice@family.com",
      status: "active",
    });

    customerMemberB = await Customer.create({
      organizationId: org._id,
      homeBranchId: branch1._id,
      name: "Beneficiary Bob",
      phone: "+919833333333",
      email: "bob@family.com",
      status: "active",
    });

    // 4. Catalog Services
    category = await ServiceCategory.create({
      organizationId: org._id,
      name: "Hair & Wellness",
    });

    serviceHairCut = await Service.create({
      organizationId: org._id,
      categoryId: category._id,
      name: "Signature Haircut",
      duration: 45,
      price: 1000,
      pricing: { basePrice: 1000 },
      status: "active",
    });

    serviceSpa = await Service.create({
      organizationId: org._id,
      categoryId: category._id,
      name: "Relaxing Spa",
      duration: 60,
      price: 2500,
      pricing: { basePrice: 2500 },
      status: "active",
    });
  });

  describe("1. Multi-Customer Subscription Creation & Validation", () => {
    it("creates a subscription with shared price and isolated per-member allocations", async () => {
      const res = await request(app)
        .post("/api/v1/subscriptions")
        .set("Authorization", `Bearer ${ownerToken}`)
        .set("x-branch-id", branch1._id.toString())
        .send({
          payerCustomerId: customerPayer._id.toString(),
          price: 6000,
          startDate: "2026-11-01",
          endDate: "2027-11-01",
          billImmediately: true,
          branchId: branch1._id.toString(),
          members: [
            {
              customerId: customerMemberA._id.toString(),
              entitlements: [
                { serviceId: serviceHairCut._id.toString(), quantity: 3 },
                { serviceId: serviceSpa._id.toString(), quantity: 1 },
              ],
            },
            {
              customerId: customerMemberB._id.toString(),
              entitlements: [
                { serviceId: serviceHairCut._id.toString(), quantity: 2 },
              ],
            },
          ],
        });

      expect(res.status).toBe(201);
      const sub = res.body.data;
      expect(sub.price).toBe(6000);
      expect(sub.status).toBe("pending_payment");
      expect(sub.payerCustomerId.toString()).toBe(customerPayer._id.toString());
      expect(sub.members).toHaveLength(2);

      const memberA = sub.members.find((m) => m.customerId.toString() === customerMemberA._id.toString());
      expect(memberA.entitlements).toHaveLength(2);
      expect(memberA.entitlements.find((e) => e.serviceName === "Signature Haircut").totalQuantity).toBe(3);

      const memberB = sub.members.find((m) => m.customerId.toString() === customerMemberB._id.toString());
      expect(memberB.entitlements).toHaveLength(1);
      expect(memberB.entitlements[0].totalQuantity).toBe(2);

      // Verify invoice was created strictly for the payer customer
      const invoice = await Invoice.findById(sub.invoiceId);
      expect(invoice).toBeDefined();
      expect(invoice.customerId.toString()).toBe(customerPayer._id.toString());
      expect(invoice.payableAmount).toBe(6000);
      expect(invoice.lines).toHaveLength(1);
      expect(invoice.lines[0].lineType).toBe("subscription");
    });

    it("rejects duplicate member customerIds in creation payload", async () => {
      const res = await request(app)
        .post("/api/v1/subscriptions")
        .set("Authorization", `Bearer ${ownerToken}`)
        .set("x-branch-id", branch1._id.toString())
        .send({
          payerCustomerId: customerPayer._id.toString(),
          price: 5000,
          startDate: "2026-11-01",
          endDate: "2027-11-01",
          members: [
            {
              customerId: customerMemberA._id.toString(),
              entitlements: [{ serviceId: serviceHairCut._id.toString(), quantity: 1 }],
            },
            {
              customerId: customerMemberA._id.toString(), // Duplicate
              entitlements: [{ serviceId: serviceSpa._id.toString(), quantity: 1 }],
            },
          ],
        });

      expect(res.status).toBe(400);
      expect(res.body.message).toMatch(/duplicate customer/i);
    });
  });

  describe("2. Member Allocation Isolation & Balance Guards", () => {
    it("ensures Customer A's redemption only decrements Customer A's balance and never Customer B's balance", async () => {
      // Create active multi-customer subscription
      const sub = await Subscription.create({
        organizationId: org._id,
        payerCustomerId: customerPayer._id,
        customerId: customerPayer._id,
        subscriptionCode: `SUB-${Date.now()}-001`,
        price: 5000,
        status: "active",
        startDate: new Date("2026-10-01"),
        endDate: new Date("2027-10-01"),
        members: [
          {
            customerId: customerMemberA._id,
            status: "active",
            entitlements: [
              {
                serviceId: serviceHairCut._id,
                serviceName: "Signature Haircut",
                totalQuantity: 2,
                usedQuantity: 0,
                remainingQuantity: 2,
              },
            ],
          },
          {
            customerId: customerMemberB._id,
            status: "active",
            entitlements: [
              {
                serviceId: serviceHairCut._id,
                serviceName: "Signature Haircut",
                totalQuantity: 1,
                usedQuantity: 0,
                remainingQuantity: 1,
              },
            ],
          },
        ],
      });

      // Send OTP to Customer A
      const otpRes = await request(app)
        .post(`/api/v1/subscriptions/${sub._id}/send-otp`)
        .set("Authorization", `Bearer ${ownerToken}`)
        .set("x-branch-id", branch1._id.toString())
        .send({
          memberCustomerId: customerMemberA._id.toString(),
        });

      expect(otpRes.status).toBe(200);

      // Fetch customer A's OTP hash from customer record
      const updatedCustomerA = await Customer.findById(customerMemberA._id);
      expect(updatedCustomerA.otp).toBeDefined();

      // Redeem for Customer A using manual mode with authorized reason
      const redeemRes = await request(app)
        .post(`/api/v1/subscriptions/${sub._id}/redeem`)
        .set("Authorization", `Bearer ${ownerToken}`)
        .set("x-branch-id", branch1._id.toString())
        .send({
          memberCustomerId: customerMemberA._id.toString(),
          isManual: true,
          reason: "Customer verified in-salon VIP member",
          services: [{ serviceId: serviceHairCut._id.toString(), quantity: 1 }],
        });

      expect(redeemRes.status).toBe(200);

      // Verify DB: Customer A remaining: 1, Customer B remaining: 1
      const persistedSub = await Subscription.findById(sub._id);
      const memA = persistedSub.members.find((m) => m.customerId.toString() === customerMemberA._id.toString());
      const memB = persistedSub.members.find((m) => m.customerId.toString() === customerMemberB._id.toString());

      expect(memA.entitlements[0].usedQuantity).toBe(1);
      expect(memA.entitlements[0].remainingQuantity).toBe(1);

      expect(memB.entitlements[0].usedQuantity).toBe(0);
      expect(memB.entitlements[0].remainingQuantity).toBe(1); // Customer B completely untouched

      // Check SubscriptionUsage audit record
      const usage = await SubscriptionUsage.findOne({ subscriptionId: sub._id });
      expect(usage).toBeDefined();
      expect(usage.customerId.toString()).toBe(customerMemberA._id.toString());
      expect(usage.serviceName).toBe("Signature Haircut");
    });

    it("prevents Customer B from redeeming when Customer B's balance is 0 even if Customer A has balance remaining", async () => {
      const sub = await Subscription.create({
        organizationId: org._id,
        payerCustomerId: customerPayer._id,
        customerId: customerPayer._id,
        subscriptionCode: `SUB-${Date.now()}-002`,
        price: 5000,
        status: "active",
        startDate: new Date("2026-10-01"),
        endDate: new Date("2027-10-01"),
        members: [
          {
            customerId: customerMemberA._id,
            status: "active",
            entitlements: [
              {
                serviceId: serviceHairCut._id,
                serviceName: "Signature Haircut",
                totalQuantity: 5,
                usedQuantity: 0,
                remainingQuantity: 5,
              },
            ],
          },
          {
            customerId: customerMemberB._id,
            status: "exhausted",
            entitlements: [
              {
                serviceId: serviceHairCut._id,
                serviceName: "Signature Haircut",
                totalQuantity: 1,
                usedQuantity: 1,
                remainingQuantity: 0, // Exhausted
              },
            ],
          },
        ],
      });

      const res = await request(app)
        .post(`/api/v1/subscriptions/${sub._id}/redeem`)
        .set("Authorization", `Bearer ${ownerToken}`)
        .set("x-branch-id", branch1._id.toString())
        .send({
          memberCustomerId: customerMemberB._id.toString(),
          isManual: true,
          reason: "Customer B attempt",
          services: [{ serviceId: serviceHairCut._id.toString(), quantity: 1 }],
        });

      expect(res.status).toBe(400);
      expect(res.body.message).toMatch(/not an active member|insufficient balance/i);
    });
  });

  describe("3. Repeated Service Line Items & Exact AppointmentServiceId Identity", () => {
    it("distinguishes two identical services on one appointment and correctly redeems them with unique appointmentServiceId tracking", async () => {
      const sub = await Subscription.create({
        organizationId: org._id,
        payerCustomerId: customerPayer._id,
        customerId: customerPayer._id,
        subscriptionCode: `SUB-${Date.now()}-003`,
        price: 3000,
        status: "active",
        startDate: new Date("2026-10-01"),
        endDate: new Date("2027-10-01"),
        members: [
          {
            customerId: customerMemberA._id,
            status: "active",
            entitlements: [
              {
                serviceId: serviceHairCut._id,
                serviceName: "Signature Haircut",
                totalQuantity: 4,
                usedQuantity: 0,
                remainingQuantity: 4,
              },
            ],
          },
        ],
      });

      // Appointment with TWO separate instances of the same service (e.g. hair wash + hair cut or repeated procedure)
      const apt = await Appointment.create({
        organizationId: org._id,
        branchId: branch1._id,
        customerId: customerMemberA._id,
        appointmentCode: `APT-${Date.now()}-REP`,
        appointmentDate: "2026-11-15",
        startTime: "11:00",
        endTime: "12:30",
        totalDuration: 90,
        startAt: new Date("2026-11-15T11:00:00Z"),
        endAt: new Date("2026-11-15T12:30:00Z"),
        bookingType: "advance",
        status: "in_progress",
        pricing: { subtotal: 2000, discount: 0, total: 2000 },
        services: [
          {
            serviceType: "registered",
            serviceId: serviceHairCut._id,
            name: "Signature Haircut",
            duration: 45,
            price: 1000,
            appliedSubscriptionId: sub._id,
            isRedeemedViaSubscription: false,
          },
          {
            serviceType: "registered",
            serviceId: serviceHairCut._id,
            name: "Signature Haircut",
            duration: 45,
            price: 1000,
            appliedSubscriptionId: sub._id,
            isRedeemedViaSubscription: false,
          },
        ],
      });

      expect(apt.services[0]._id.toString()).not.toBe(apt.services[1]._id.toString());

      // Setup OTP Challenge for this appointment
      const rawOtp = "123456";
      const crypto = await import("crypto");
      const otpHash = crypto.createHash("sha256").update(rawOtp).digest("hex");

      await SubscriptionConsumptionChallenge.create({
        organizationId: org._id,
        branchId: branch1._id,
        appointmentId: apt._id,
        subscriptionIds: [sub._id],
        customerId: customerMemberA._id,
        serviceIds: [serviceHairCut._id, serviceHairCut._id],
        otpHash,
        attempts: 0,
        resendAvailableAt: new Date(Date.now() + 60000),
        expiresAt: new Date(Date.now() + 300000),
        status: "pending",
        redemptionState: "pending",
      });

      // Execute completion via appointment service
      const { AppointmentService } = await import("../../services/appointments/appointment.service.js");
      const appointmentService = new AppointmentService();
      const userId = new mongoose.Types.ObjectId().toString();
      const completedApt = await appointmentService.completeWithSubscription(
        apt._id.toString(),
        { branchId: branch1._id.toString(), otp: rawOtp },
        org._id.toString(),
        userId
      );

      expect(completedApt.status).toBe("completed");
      expect(completedApt.services[0].isRedeemedViaSubscription).toBe(true);
      expect(completedApt.services[1].isRedeemedViaSubscription).toBe(true);
      expect(completedApt.services[0].subscriptionUsageId.toString()).not.toBe(
        completedApt.services[1].subscriptionUsageId.toString()
      );

      // Verify two distinct usage records created with exact appointmentServiceIds
      const usages = await SubscriptionUsage.find({ appointmentId: apt._id });
      expect(usages).toHaveLength(2);
      const usedServiceIds = usages.map((u) => u.appointmentServiceId.toString());
      expect(usedServiceIds).toContain(apt.services[0]._id.toString());
      expect(usedServiceIds).toContain(apt.services[1]._id.toString());

      // Verify subscription balance decreased by 2
      const freshSub = await Subscription.findById(sub._id);
      expect(freshSub.members[0].entitlements[0].remainingQuantity).toBe(2);
      expect(freshSub.members[0].entitlements[0].usedQuantity).toBe(2);
    });
  });

  describe("4. Standalone Recovery & Idempotent Retry", () => {
    it("ensures retrying a verified appointment completion does not double-decrement entitlements", async () => {
      const sub = await Subscription.create({
        organizationId: org._id,
        payerCustomerId: customerPayer._id,
        customerId: customerPayer._id,
        subscriptionCode: `SUB-${Date.now()}-004`,
        price: 2000,
        status: "active",
        startDate: new Date("2026-10-01"),
        endDate: new Date("2027-10-01"),
        members: [
          {
            customerId: customerMemberA._id,
            status: "active",
            entitlements: [
              {
                serviceId: serviceHairCut._id,
                serviceName: "Signature Haircut",
                totalQuantity: 2,
                usedQuantity: 0,
                remainingQuantity: 2,
              },
            ],
          },
        ],
      });

      const apt = await Appointment.create({
        organizationId: org._id,
        branchId: branch1._id,
        customerId: customerMemberA._id,
        appointmentCode: `APT-${Date.now()}-IDEM`,
        appointmentDate: "2026-11-20",
        startTime: "14:00",
        endTime: "14:45",
        totalDuration: 45,
        startAt: new Date("2026-11-20T14:00:00Z"),
        endAt: new Date("2026-11-20T14:45:00Z"),
        bookingType: "advance",
        status: "in_progress",
        pricing: { subtotal: 1000, discount: 0, total: 1000 },
        services: [
          {
            serviceType: "registered",
            serviceId: serviceHairCut._id,
            name: "Signature Haircut",
            duration: 45,
            price: 1000,
            appliedSubscriptionId: sub._id,
            isRedeemedViaSubscription: false,
          },
        ],
      });

      const rawOtp = "654321";
      const crypto = await import("crypto");
      const otpHash = crypto.createHash("sha256").update(rawOtp).digest("hex");

      const challenge = await SubscriptionConsumptionChallenge.create({
        organizationId: org._id,
        branchId: branch1._id,
        appointmentId: apt._id,
        subscriptionIds: [sub._id],
        customerId: customerMemberA._id,
        serviceIds: [serviceHairCut._id],
        otpHash,
        attempts: 0,
        resendAvailableAt: new Date(Date.now() + 60000),
        expiresAt: new Date(Date.now() + 300000),
        status: "pending",
        redemptionState: "pending",
      });

      const { AppointmentService } = await import("../../services/appointments/appointment.service.js");
      const appointmentService = new AppointmentService();
      const userId = new mongoose.Types.ObjectId().toString();

      // First execution
      await appointmentService.completeWithSubscription(
        apt._id.toString(),
        { branchId: branch1._id.toString(), otp: rawOtp },
        org._id.toString(),
        userId
      );

      // Verify challenge marked verified and completed
      const updatedChallenge = await SubscriptionConsumptionChallenge.findById(challenge._id);
      expect(updatedChallenge.status).toBe("verified");
      expect(updatedChallenge.redemptionState).toBe("completed");

      // Verify remaining quantity is 1
      const subAfterFirst = await Subscription.findById(sub._id);
      expect(subAfterFirst.members[0].entitlements[0].remainingQuantity).toBe(1);

      // Retry execution (e.g. client timeout or network retry)
      await expect(
        appointmentService.completeWithSubscription(
          apt._id.toString(),
          { branchId: branch1._id.toString(), otp: rawOtp },
          org._id.toString(),
          userId
        )
      ).rejects.toThrow();

      // Balance must NOT have been decremented again
      const subAfterRetry = await Subscription.findById(sub._id);
      expect(subAfterRetry.members[0].entitlements[0].remainingQuantity).toBe(1);
    });

    it("reconciles interrupted redemptions: restores balance if appointment did not complete, and finalizes if appointment completed", async () => {
      const { subscriptionService } = await import("../../services/subscriptions/subscription.service.js");

      // 1. Interrupted redemption: decrements recorded, but appointment NEVER completed (e.g. process crash before appointment update)
      const sub1 = await Subscription.create({
        organizationId: org._id,
        payerCustomerId: customerPayer._id,
        customerId: customerPayer._id,
        subscriptionCode: `SUB-RECON-${Date.now()}-001`,
        price: 2000,
        status: "active",
        startDate: new Date("2026-10-01"),
        endDate: new Date("2027-10-01"),
        members: [
          {
            customerId: customerMemberA._id,
            status: "active",
            entitlements: [
              {
                serviceId: serviceHairCut._id,
                serviceName: "Signature Haircut",
                totalQuantity: 2,
                usedQuantity: 1,
                remainingQuantity: 1, // Already decremented by crashed process
              },
            ],
          },
        ],
      });

      const uncompletedApt = await Appointment.create({
        organizationId: org._id,
        branchId: branch1._id,
        customerId: customerMemberA._id,
        appointmentCode: `APT-CRASH-${Date.now()}`,
        appointmentDate: "2026-11-01",
        startTime: "12:00",
        endTime: "12:30",
        status: "in_progress", // Did not reach completed!
        bookingType: "advance",
        startAt: new Date(),
        endAt: new Date(Date.now() + 1800000),
        totalDuration: 30,
        pricing: { subtotal: 500, discount: 0, total: 500 },
        services: [{ serviceId: serviceHairCut._id, name: "Signature Haircut", price: 500, duration: 30, isRedeemedViaSubscription: false }],
      });

      const crashedChallenge = await SubscriptionConsumptionChallenge.create({
        organizationId: org._id,
        branchId: branch1._id,
        appointmentId: uncompletedApt._id,
        subscriptionIds: [sub1._id],
        customerId: customerMemberA._id,
        serviceIds: [serviceHairCut._id],
        otpHash: "hash123",
        attempts: 0,
        resendAvailableAt: new Date(Date.now() + 60000),
        expiresAt: new Date(Date.now() + 300000),
        status: "in_redemption",
        redemptionState: "decremented",
        decrements: [
          {
            subscriptionId: sub1._id,
            memberCustomerId: customerMemberA._id,
            serviceId: serviceHairCut._id,
            quantity: 1,
            decrementedAt: new Date(),
            isDecremented: true,
            isRestored: false,
          },
        ],
      });

      // Run reconciliation with maxAgeMinutes: 0 so it immediately inspects the crashed challenge
      const reconResult = await subscriptionService.reconcileIncompleteRedemptions(org._id, { maxAgeMinutes: 0 });
      expect(reconResult.inspected).toBeGreaterThanOrEqual(1);
      expect(reconResult.reconciledRestored).toBeGreaterThanOrEqual(1);

      // Verify entitlement was restored
      const restoredSub = await Subscription.findById(sub1._id);
      expect(restoredSub.members[0].entitlements[0].remainingQuantity).toBe(2);
      expect(restoredSub.members[0].entitlements[0].usedQuantity).toBe(0);

      // Verify challenge marked reconciled
      const updatedChallenge = await SubscriptionConsumptionChallenge.findById(crashedChallenge._id);
      expect(updatedChallenge.status).toBe("exhausted");
      expect(updatedChallenge.redemptionState).toBe("reconciled");

      // Verify repeating reconciliation does NOT restore again (idempotency check)
      const repeatResult = await subscriptionService.reconcileIncompleteRedemptions(org._id, { maxAgeMinutes: 0 });
      expect(repeatResult.reconciledRestored).toBe(0);
      const subAfterRepeat = await Subscription.findById(sub1._id);
      expect(subAfterRepeat.members[0].entitlements[0].remainingQuantity).toBe(2);
    });

    it("handles crash before decrement: does not restore non-applied decrements", async () => {
      const { subscriptionService } = await import("../../services/subscriptions/subscription.service.js");

      const subCrashBeforeDec = await Subscription.create({
        organizationId: org._id,
        payerCustomerId: customerPayer._id,
        customerId: customerPayer._id,
        subscriptionCode: `SUB-CRASH-BEFORE-DEC-${Date.now()}`,
        price: 2000,
        status: "active",
        startDate: new Date("2026-10-01"),
        endDate: new Date("2027-10-01"),
        members: [
          {
            customerId: customerMemberA._id,
            status: "active",
            entitlements: [
              {
                serviceId: serviceHairCut._id,
                serviceName: "Signature Haircut",
                totalQuantity: 2,
                usedQuantity: 0,
                remainingQuantity: 2, // Never decremented!
              },
            ],
          },
        ],
      });

      const apt = await Appointment.create({
        organizationId: org._id,
        branchId: branch1._id,
        customerId: customerMemberA._id,
        appointmentCode: `APT-CRASH-PREDEC-${Date.now()}`,
        appointmentDate: "2026-11-01",
        startTime: "12:00",
        endTime: "12:30",
        status: "in_progress",
        bookingType: "advance",
        startAt: new Date(),
        endAt: new Date(Date.now() + 1800000),
        totalDuration: 30,
        pricing: { subtotal: 500, discount: 0, total: 500 },
        services: [{ serviceId: serviceHairCut._id, name: "Signature Haircut", price: 500, duration: 30, isRedeemedViaSubscription: false }],
      });

      // Challenge created and locked in redemption, with intent recorded, but crashed BEFORE decrement (isDecremented: false)
      const challengeBeforeDec = await SubscriptionConsumptionChallenge.create({
        organizationId: org._id,
        branchId: branch1._id,
        appointmentId: apt._id,
        subscriptionIds: [subCrashBeforeDec._id],
        customerId: customerMemberA._id,
        serviceIds: [serviceHairCut._id],
        otpHash: "hashpredec",
        attempts: 0,
        resendAvailableAt: new Date(Date.now() + 60000),
        expiresAt: new Date(Date.now() + 300000),
        status: "in_redemption",
        redemptionState: "in_redemption",
        decrements: [
          {
            subscriptionId: subCrashBeforeDec._id,
            memberCustomerId: customerMemberA._id,
            serviceId: serviceHairCut._id,
            quantity: 1,
            decrementedAt: null,
            isDecremented: false, // NOT decremented before crash
            isRestored: false,
          },
        ],
      });

      const reconResult = await subscriptionService.reconcileIncompleteRedemptions(org._id, { maxAgeMinutes: 0 });
      // Must NOT restore balance because isDecremented was false
      const subReloaded = await Subscription.findById(subCrashBeforeDec._id);
      expect(subReloaded.members[0].entitlements[0].remainingQuantity).toBe(2);
      expect(subReloaded.members[0].entitlements[0].usedQuantity).toBe(0);

      const chalReloaded = await SubscriptionConsumptionChallenge.findById(challengeBeforeDec._id);
      expect(chalReloaded.status).toBe("exhausted");
      expect(chalReloaded.redemptionState).toBe("reconciled");
    });

    it("handles crash during restoration: atomic claim ensures subsequent reconciliation pass does not double restore", async () => {
      const { subscriptionService } = await import("../../services/subscriptions/subscription.service.js");

      const subCrashMidRestore = await Subscription.create({
        organizationId: org._id,
        payerCustomerId: customerPayer._id,
        customerId: customerPayer._id,
        subscriptionCode: `SUB-CRASH-MIDRESTORE-${Date.now()}`,
        price: 2000,
        status: "active",
        startDate: new Date("2026-10-01"),
        endDate: new Date("2027-10-01"),
        members: [
          {
            customerId: customerMemberA._id,
            status: "active",
            entitlements: [
              {
                serviceId: serviceHairCut._id,
                serviceName: "Signature Haircut",
                totalQuantity: 2,
                usedQuantity: 1,
                remainingQuantity: 1, // Decremented prior to crash
              },
            ],
          },
        ],
      });

      const apt = await Appointment.create({
        organizationId: org._id,
        branchId: branch1._id,
        customerId: customerMemberA._id,
        appointmentCode: `APT-CRASH-MIDRESTORE-${Date.now()}`,
        appointmentDate: "2026-11-01",
        startTime: "12:00",
        endTime: "12:30",
        status: "in_progress",
        bookingType: "advance",
        startAt: new Date(),
        endAt: new Date(Date.now() + 1800000),
        totalDuration: 30,
        pricing: { subtotal: 500, discount: 0, total: 500 },
        services: [{ serviceId: serviceHairCut._id, name: "Signature Haircut", price: 500, duration: 30, isRedeemedViaSubscription: false }],
      });

      // Simulate a challenge where restoration claimed the entry (isRestored: true) and restored balance, but process crashed before challenge state marked reconciled
      const challengeMidRestore = await SubscriptionConsumptionChallenge.create({
        organizationId: org._id,
        branchId: branch1._id,
        appointmentId: apt._id,
        subscriptionIds: [subCrashMidRestore._id],
        customerId: customerMemberA._id,
        serviceIds: [serviceHairCut._id],
        otpHash: "hashmidrestore",
        attempts: 0,
        resendAvailableAt: new Date(Date.now() + 60000),
        expiresAt: new Date(Date.now() + 300000),
        status: "in_redemption",
        redemptionState: "restoring", // Crashed in 'restoring' state
        decrements: [
          {
            subscriptionId: subCrashMidRestore._id,
            memberCustomerId: customerMemberA._id,
            serviceId: serviceHairCut._id,
            quantity: 1,
            decrementedAt: new Date(),
            isDecremented: true,
            isRestored: true, // Already restored before the crash!
          },
        ],
      });

      // Manually restore the subscription balance to simulate the pre-crash state where entitlement was restored
      await subscriptionService.subscriptionRepo.atomicRestoreMemberEntitlement(
        subCrashMidRestore._id,
        org._id,
        customerMemberA._id,
        serviceHairCut._id,
        1
      );

      // Verify subscription balance is now 2
      let subCheck = await Subscription.findById(subCrashMidRestore._id);
      expect(subCheck.members[0].entitlements[0].remainingQuantity).toBe(2);

      // Run reconciliation again (e.g. background worker wakes up after crash)
      await subscriptionService.reconcileIncompleteRedemptions(org._id, { maxAgeMinutes: 0 });

      // Balance must STILL be 2 (must not have double-restored to 3)
      subCheck = await Subscription.findById(subCrashMidRestore._id);
      expect(subCheck.members[0].entitlements[0].remainingQuantity).toBe(2);
      expect(subCheck.members[0].entitlements[0].usedQuantity).toBe(0);

      const challengeFinal = await SubscriptionConsumptionChallenge.findById(challengeMidRestore._id);
      expect(challengeFinal.status).toBe("exhausted");
      expect(challengeFinal.redemptionState).toBe("reconciled");
    });
  });

  describe("5. Migration Safety for Partially Migrated Records", () => {
    it("preserves existing multi-member allocations when migrating records missing payerCustomerId", async () => {
      const { migrateSubscriptionsToMultiCustomer } = await import("../../scripts/migrateSubscriptionsToMultiCustomer.js");

      // Partially migrated record: already has multi-member allocation, but missing payerCustomerId
      const existingMembers = [
        {
          customerId: customerMemberA._id,
          status: "active",
          permittedBranchIds: [branch1._id],
          entitlements: [
            {
              serviceId: serviceHairCut._id,
              serviceName: "Signature Haircut",
              totalQuantity: 5,
              usedQuantity: 1,
              remainingQuantity: 4,
            },
          ],
        },
        {
          customerId: customerMemberB._id,
          status: "active",
          permittedBranchIds: [branch1._id],
          entitlements: [
            {
              serviceId: serviceHairCut._id,
              serviceName: "Signature Haircut",
              totalQuantity: 3,
              usedQuantity: 0,
              remainingQuantity: 3,
            },
          ],
        },
      ];

      // Insert directly to bypass model validation hook
      const partialDoc = {
        organizationId: org._id,
        customerId: customerPayer._id,
        subscriptionCode: `SUB-PARTIAL-${Date.now()}`,
        price: 8000,
        status: "active",
        startDate: new Date("2026-10-01"),
        endDate: new Date("2027-10-01"),
        members: existingMembers,
        isDeleted: false,
        // Notice: payerCustomerId is intentionally missing
      };
      const inserted = await Subscription.collection.insertOne(partialDoc);
      const insertedId = inserted.insertedId;

      // Run migration
      const result = await migrateSubscriptionsToMultiCustomer(false);
      expect(result.migratedCount).toBeGreaterThanOrEqual(1);

      // Verify the record was updated with payerCustomerId WITHOUT corrupting existing members
      const reloaded = await Subscription.findById(insertedId);
      expect(reloaded.payerCustomerId.toString()).toBe(customerPayer._id.toString());
      expect(reloaded.members).toHaveLength(2);
      expect(reloaded.members[0].customerId.toString()).toBe(customerMemberA._id.toString());
      expect(reloaded.members[1].customerId.toString()).toBe(customerMemberB._id.toString());
      expect(reloaded.members[0].entitlements[0].remainingQuantity).toBe(4);
      expect(reloaded.members[1].entitlements[0].remainingQuantity).toBe(3);
    });
  });
});
