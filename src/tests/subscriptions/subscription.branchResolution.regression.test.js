import dns from "dns";
import { describe, expect, it, beforeAll, afterAll, jest } from "@jest/globals";
import crypto from "crypto";
import request from "supertest";
import mongoose from "mongoose";

try {
  dns.setServers(["8.8.8.8", "1.1.1.1"]);
} catch (_) {}

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
import { Invoice } from "../../../src/models/billing/invoice.model.js";
import { Payment } from "../../../src/models/billing/payment.model.js";
import { AuditLog } from "../../../src/models/audit/auditLog.model.js";
import jwt from "jsonwebtoken";
import { env } from "../../../src/config/env.js";
import { redis } from "../../../src/utils/redis.js";

jest.spyOn(redis, "get").mockResolvedValue(null);
jest.spyOn(redis, "setex").mockResolvedValue("OK");

describe("Subscription Sale Branch Resolution Regression Tests", () => {
  jest.setTimeout(45000);

  let orgA;
  let branchA, branchB, branchCInactive;
  let ownerToken, branchBStaffToken, branchAStaffToken;
  let ownerUser, branchBStaffUser, branchAStaffUser;
  let customerWithHomeBranchA;
  let serviceOrg;
  let categoryOrg;

  beforeAll(async () => {
    let testUri = process.env.MONGO_URI || "mongodb://127.0.0.1:27017/saloon_erp_test";
    if (testUri.includes("?")) {
      const parts = testUri.split("?");
      testUri = parts[0].replace(/\/([^\/]+)$/, "/saloon_erp_sub_branch_reg_test") + "?" + parts[1];
    } else {
      testUri = testUri.replace(/\/([^\/]+)$/, "/saloon_erp_sub_branch_reg_test");
    }
    await mongoose.connect(testUri);

    // 1. Create Organization
    orgA = await Organization.create({
      name: "Branch Resolution Test Salon Org",
      slug: `branch-res-test-${Date.now()}`,
      status: "active",
      currency: "INR",
      timezone: "Asia/Kolkata",
    });

    // 2. Create Branches
    branchA = await Branch.create({
      name: "Branch A - North",
      organizationId: orgA._id,
      isActive: true,
      address: "123 North St, Metropolis",
    });

    branchB = await Branch.create({
      name: "Branch B - South",
      organizationId: orgA._id,
      isActive: true,
      address: "456 South St, Metropolis",
    });

    branchCInactive = await Branch.create({
      name: "Branch C - Inactive",
      organizationId: orgA._id,
      isActive: false,
      address: "789 East St, Metropolis",
    });

    // 3. Create Permissions & Roles
    const requiredPermissions = [
      "subscriptions.sell",
      "subscriptions.view",
      "subscriptions.redeem",
      "subscriptions.configure",
      "billing.view",
      "billing.checkout",
    ];

    for (const perm of requiredPermissions) {
      await Permission.findOneAndUpdate(
        { name: perm },
        { name: perm, module: perm.split(".")[0], description: `Test permission ${perm}` },
        { upsert: true, returnDocument: "after" }
      );
    }

    const allPermDocs = await Permission.find({ name: { $in: requiredPermissions } });

    const ownerRole = await Role.create({
      name: "Owner Role",
      organizationId: orgA._id,
      permissions: allPermDocs.map((p) => p._id),
      isSystem: true,
    });

    const staffRole = await Role.create({
      name: "Staff Role",
      organizationId: orgA._id,
      permissions: allPermDocs.map((p) => p._id),
      isSystem: false,
    });

    // 4. Create Users
    // Owner with org-wide access
    ownerUser = await User.create({
      name: "Org Owner",
      email: `owner_${Date.now()}@testsalon.com`,
      phone: "+919999000001",
      password: "HashedPassword123!",
      organizationId: orgA._id,
      role: ownerRole._id,
      hasOrgWideAccess: true,
      branchAccess: [],
      status: "active",
    });

    ownerToken = jwt.sign(
      {
        id: ownerUser._id.toString(),
        userId: ownerUser._id.toString(),
        organizationId: orgA._id.toString(),
        role: "owner",
        hasOrgWideAccess: true,
        branchAccess: [],
      },
      env.JWT_SECRET || "test-secret",
      { expiresIn: "2h" }
    );

    // Staff user restricted exclusively to Branch B
    branchBStaffUser = await User.create({
      name: "Staff Branch B Only",
      email: `staffb_${Date.now()}@testsalon.com`,
      phone: "+919999000002",
      password: "HashedPassword123!",
      organizationId: orgA._id,
      role: staffRole._id,
      hasOrgWideAccess: false,
      branchAccess: [{ branchId: branchB._id, branchName: "Branch B - South", isActive: true }],
      status: "active",
    });

    branchBStaffToken = jwt.sign(
      {
        id: branchBStaffUser._id.toString(),
        userId: branchBStaffUser._id.toString(),
        organizationId: orgA._id.toString(),
        role: "staff",
        hasOrgWideAccess: false,
        branchAccess: [{ branchId: branchB._id.toString(), branchName: "Branch B - South", isActive: true }],
      },
      env.JWT_SECRET || "test-secret",
      { expiresIn: "2h" }
    );

    // Staff user restricted exclusively to Branch A
    branchAStaffUser = await User.create({
      name: "Staff Branch A Only",
      email: `staffa_${Date.now()}@testsalon.com`,
      phone: "+919999000003",
      password: "HashedPassword123!",
      organizationId: orgA._id,
      role: staffRole._id,
      hasOrgWideAccess: false,
      branchAccess: [{ branchId: branchA._id, branchName: "Branch A - North", isActive: true }],
      status: "active",
    });

    branchAStaffToken = jwt.sign(
      {
        id: branchAStaffUser._id.toString(),
        userId: branchAStaffUser._id.toString(),
        organizationId: orgA._id.toString(),
        role: "staff",
        hasOrgWideAccess: false,
        branchAccess: [{ branchId: branchA._id.toString(), branchName: "Branch A - North", isActive: true }],
      },
      env.JWT_SECRET || "test-secret",
      { expiresIn: "2h" }
    );

    // 5. Category & Services
    categoryOrg = await ServiceCategory.create({
      name: "Hair & Styling",
      organizationId: orgA._id,
    });

    serviceOrg = await Service.create({
      name: "Master Haircut",
      serviceCode: "MHC-101",
      organizationId: orgA._id,
      categoryId: categoryOrg._id,
      duration: 45,
      pricing: { basePrice: 1200 },
      status: "active",
    });

    // 6. Customer whose homeBranchId is Branch A
    customerWithHomeBranchA = await Customer.create({
      name: "Sarah Connor",
      phone: "+919876543299",
      organizationId: orgA._id,
      homeBranchId: branchA._id,
      status: "active",
    });
  });

  afterAll(async () => {
    await Payment.deleteMany({});
    await Invoice.deleteMany({});
    await SubscriptionUsage.deleteMany({});
    await Subscription.deleteMany({});
    await SubscriptionPlan.deleteMany({});
    await Service.deleteMany({});
    await ServiceCategory.deleteMany({});
    await AuditLog.deleteMany({});
    await User.deleteMany({});
    await Role.deleteMany({});
    await Customer.deleteMany({});
    await Branch.deleteMany({});
    await Organization.deleteMany({});
    await mongoose.disconnect();
  });

  describe("1. Authoritative Selling Branch Resolution & Invoicing", () => {
    it("should assign subscription invoice to active selling Branch B even when customer home branch is Branch A", async () => {
      // Customer has homeBranchId = Branch A
      // Seller operates on Branch B (X-Branch-Id: branchB._id)
      const res = await request(app)
        .post("/api/v1/subscriptions")
        .set("Authorization", `Bearer ${branchBStaffToken}`)
        .set("X-Branch-Id", branchB._id.toString())
        .send({
          customerId: customerWithHomeBranchA._id.toString(),
          price: 4500,
          entitlements: [{ serviceId: serviceOrg._id.toString(), quantity: 4 }],
          permittedBranchIds: [branchA._id.toString(), branchB._id.toString()],
          startDate: "2026-10-01",
          endDate: "2026-12-31",
          notes: "Sold at Branch B to Branch A customer",
        });

      expect(res.status).toBe(201);
      expect(res.body.success).toBe(true);
      const sub = res.body.data;
      expect(sub.subscriptionCode).toMatch(/^SUB-\d{8}-\d{4}$/);
      expect(sub.invoice).toBeDefined();

      const invoice = sub.invoice;
      // CRITICAL ASSERTION: The invoice branchId must be Branch B, NOT Customer's home branch (Branch A)
      expect(invoice.branchId.toString()).toBe(branchB._id.toString());
      expect(invoice.branchId.toString()).not.toBe(customerWithHomeBranchA.homeBranchId.toString());

      // Verify invoice appears in Branch B's branch-scoped invoice list
      const listBranchBRes = await request(app)
        .get("/api/v1/billing/invoices")
        .set("Authorization", `Bearer ${ownerToken}`)
        .set("X-Branch-Id", branchB._id.toString());

      expect(listBranchBRes.status).toBe(200);
      const invoiceIdsBranchB = listBranchBRes.body.data.map((inv) => inv._id.toString());
      expect(invoiceIdsBranchB).toContain(invoice._id.toString());

      // Verify invoice is NOT present in Branch A's branch-scoped invoice list
      const listBranchARes = await request(app)
        .get("/api/v1/billing/invoices")
        .set("Authorization", `Bearer ${ownerToken}`)
        .set("X-Branch-Id", branchA._id.toString());

      expect(listBranchARes.status).toBe(200);
      const invoiceIdsBranchA = listBranchARes.body.data.map((inv) => inv._id.toString());
      expect(invoiceIdsBranchA).not.toContain(invoice._id.toString());
    });

    it("should reject subscription sale if client passes unvalidated body branchId that mismatches active selling branch", async () => {
      // Caller has access only to Branch B, passes X-Branch-Id: branchB, but attempts body branchId: branchA
      // Server-side middleware must override/enforce active branch or controller must bind from req.branchId
      const res = await request(app)
        .post("/api/v1/subscriptions")
        .set("Authorization", `Bearer ${branchBStaffToken}`)
        .set("X-Branch-Id", branchB._id.toString())
        .send({
          customerId: customerWithHomeBranchA._id.toString(),
          price: 3000,
          branchId: branchA._id.toString(), // Tampered body
          entitlements: [{ serviceId: serviceOrg._id.toString(), quantity: 2 }],
          startDate: "2026-10-01",
          endDate: "2026-12-31",
        });

      // Request must succeed under Branch B context without allowing Branch A spoofing
      expect(res.status).toBe(201);
      const sub = res.body.data;
      expect(sub.invoice.branchId.toString()).toBe(branchB._id.toString());
      expect(sub.invoice.branchId.toString()).not.toBe(branchA._id.toString());
    });
  });

  describe("2. Validation of Branch Context Header & Error Handling", () => {
    it("should return 400 Bad Request if X-Branch-Id header is missing", async () => {
      const res = await request(app)
        .post("/api/v1/subscriptions")
        .set("Authorization", `Bearer ${ownerToken}`)
        .send({
          customerId: customerWithHomeBranchA._id.toString(),
          price: 2000,
          entitlements: [{ serviceId: serviceOrg._id.toString(), quantity: 2 }],
          startDate: "2026-10-01",
          endDate: "2026-12-31",
        });

      expect(res.status).toBe(400);
      expect(res.body.message).toMatch(/X-Branch-Id header is required/);
    });

    it("should return 400 Bad Request if X-Branch-Id is 'all'", async () => {
      const res = await request(app)
        .post("/api/v1/subscriptions")
        .set("Authorization", `Bearer ${ownerToken}`)
        .set("X-Branch-Id", "all")
        .send({
          customerId: customerWithHomeBranchA._id.toString(),
          price: 2000,
          entitlements: [{ serviceId: serviceOrg._id.toString(), quantity: 2 }],
          startDate: "2026-10-01",
          endDate: "2026-12-31",
        });

      expect(res.status).toBe(400);
      expect(res.body.message).toMatch(/X-Branch-Id header is required/);
    });

    it("should return 400 Bad Request if X-Branch-Id is not a valid ObjectId", async () => {
      const res = await request(app)
        .post("/api/v1/subscriptions")
        .set("Authorization", `Bearer ${ownerToken}`)
        .set("X-Branch-Id", "not-a-valid-object-id")
        .send({
          customerId: customerWithHomeBranchA._id.toString(),
          price: 2000,
          entitlements: [{ serviceId: serviceOrg._id.toString(), quantity: 2 }],
          startDate: "2026-10-01",
          endDate: "2026-12-31",
        });

      expect(res.status).toBe(400);
      expect(res.body.message).toMatch(/Invalid branch ID format/);
    });

    it("should return 404 Not Found if branch does not exist or is inactive", async () => {
      // Inactive branch C
      const resInactive = await request(app)
        .post("/api/v1/subscriptions")
        .set("Authorization", `Bearer ${ownerToken}`)
        .set("X-Branch-Id", branchCInactive._id.toString())
        .send({
          customerId: customerWithHomeBranchA._id.toString(),
          price: 2000,
          entitlements: [{ serviceId: serviceOrg._id.toString(), quantity: 2 }],
          startDate: "2026-10-01",
          endDate: "2026-12-31",
        });

      expect(resInactive.status).toBe(404);

      // Non-existent branch ObjectId
      const nonExistentBranchId = new mongoose.Types.ObjectId().toString();
      const resMissing = await request(app)
        .post("/api/v1/subscriptions")
        .set("Authorization", `Bearer ${ownerToken}`)
        .set("X-Branch-Id", nonExistentBranchId)
        .send({
          customerId: customerWithHomeBranchA._id.toString(),
          price: 2000,
          entitlements: [{ serviceId: serviceOrg._id.toString(), quantity: 2 }],
          startDate: "2026-10-01",
          endDate: "2026-12-31",
        });

      expect(resMissing.status).toBe(404);
    });

    it("should return 403 Forbidden if user lacks authorization to active selling branch", async () => {
      // branchBStaffUser only has access to Branch B; trying to sell under Branch A
      const res = await request(app)
        .post("/api/v1/subscriptions")
        .set("Authorization", `Bearer ${branchBStaffToken}`)
        .set("X-Branch-Id", branchA._id.toString())
        .send({
          customerId: customerWithHomeBranchA._id.toString(),
          price: 2000,
          entitlements: [{ serviceId: serviceOrg._id.toString(), quantity: 2 }],
          startDate: "2026-10-01",
          endDate: "2026-12-31",
        });

      expect(res.status).toBe(403);
      expect(res.body.message).toMatch(/Access denied/);
    });
  });

  describe("3. Cross-Branch Redemption Semantics", () => {
    it("should allow subscription sold at Branch B to be redeemed at Branch A when permittedBranchIds includes Branch A", async () => {
      // 1. Sell subscription at Branch B
      const sellRes = await request(app)
        .post("/api/v1/subscriptions")
        .set("Authorization", `Bearer ${branchBStaffToken}`)
        .set("X-Branch-Id", branchB._id.toString())
        .send({
          customerId: customerWithHomeBranchA._id.toString(),
          price: 2400,
          entitlements: [{ serviceId: serviceOrg._id.toString(), quantity: 2 }],
          permittedBranchIds: [branchA._id.toString(), branchB._id.toString()],
          startDate: "2026-10-01",
          endDate: "2026-12-31",
          notes: "Multi-branch package",
        });

      expect(sellRes.status).toBe(201);
      const subId = sellRes.body.data._id;
      // Invoice was issued at Branch B
      expect(sellRes.body.data.invoice.branchId.toString()).toBe(branchB._id.toString());

      // 2. Request OTP from Branch A
      const otpRes = await request(app)
        .post(`/api/v1/subscriptions/${subId}/send-otp`)
        .set("Authorization", `Bearer ${branchAStaffToken}`)
        .set("X-Branch-Id", branchA._id.toString())
        .send({ branchId: branchA._id.toString() });

      expect(otpRes.status).toBe(200);

      // Seed known OTP on customer
      const custDoc = await Customer.findById(customerWithHomeBranchA._id);
      const knownOtp = "654321";
      custDoc.otp = crypto.createHash("sha256").update(knownOtp).digest("hex");
      custDoc.otpExpires = new Date(Date.now() + 300000);
      await custDoc.save();

      // 3. Redeem entitlement at Branch A
      const redeemRes = await request(app)
        .post(`/api/v1/subscriptions/${subId}/redeem`)
        .set("Authorization", `Bearer ${branchAStaffToken}`)
        .set("X-Branch-Id", branchA._id.toString())
        .send({
          branchId: branchA._id.toString(),
          otp: knownOtp,
          services: [{ serviceId: serviceOrg._id.toString(), quantity: 1 }],
        });

      expect(redeemRes.status).toBe(200);
      expect(redeemRes.body.data.subscription.entitlements[0].usedQuantity).toBe(1);
      expect(redeemRes.body.data.subscription.entitlements[0].remainingQuantity).toBe(1);
    });

    it("should reject redemption at Branch B if subscription permittedBranchIds is restricted solely to Branch A", async () => {
      // Sell subscription at Branch A restricted exclusively to Branch A
      const sellRes = await request(app)
        .post("/api/v1/subscriptions")
        .set("Authorization", `Bearer ${branchAStaffToken}`)
        .set("X-Branch-Id", branchA._id.toString())
        .send({
          customerId: customerWithHomeBranchA._id.toString(),
          price: 1500,
          entitlements: [{ serviceId: serviceOrg._id.toString(), quantity: 1 }],
          permittedBranchIds: [branchA._id.toString()],
          startDate: "2026-10-01",
          endDate: "2026-12-31",
        });

      expect(sellRes.status).toBe(201);
      const subId = sellRes.body.data._id;

      // Request OTP from Branch B
      const otpRes = await request(app)
        .post(`/api/v1/subscriptions/${subId}/send-otp`)
        .set("Authorization", `Bearer ${branchBStaffToken}`)
        .set("X-Branch-Id", branchB._id.toString())
        .send({ branchId: branchB._id.toString() });

      expect(otpRes.status).toBe(403);
      expect(otpRes.body.message).toMatch(/not valid for redemption at this branch/i);
    });
  });

  describe("4. Subscription Renewal Branch Resolution", () => {
    it("should assign renewal invoice to active selling Branch B when renewed at Branch B", async () => {
      // 1. Initial subscription sold at Branch A
      const initialSubRes = await request(app)
        .post("/api/v1/subscriptions")
        .set("Authorization", `Bearer ${branchAStaffToken}`)
        .set("X-Branch-Id", branchA._id.toString())
        .send({
          customerId: customerWithHomeBranchA._id.toString(),
          price: 2000,
          entitlements: [{ serviceId: serviceOrg._id.toString(), quantity: 2 }],
          startDate: "2026-10-01",
          endDate: "2026-10-31",
        });

      expect(initialSubRes.status).toBe(201);
      const initialSubId = initialSubRes.body.data._id;

      // 2. Customer visits Branch B to renew subscription
      const renewRes = await request(app)
        .post(`/api/v1/subscriptions/${initialSubId}/renew`)
        .set("Authorization", `Bearer ${branchBStaffToken}`)
        .set("X-Branch-Id", branchB._id.toString())
        .send({
          price: 2200,
          startDate: "2026-11-01",
          endDate: "2026-11-30",
          billImmediately: true,
          notes: "Renewed at Branch B",
        });

      expect(renewRes.status).toBe(201);
      const renewedSub = renewRes.body.data;
      expect(renewedSub.invoice).toBeDefined();

      // Renewal invoice MUST be assigned to Branch B
      expect(renewedSub.invoice.branchId.toString()).toBe(branchB._id.toString());
      expect(renewedSub.invoice.branchId.toString()).not.toBe(branchA._id.toString());

      // Verify invoice appears in Branch B invoice list
      const listRes = await request(app)
        .get("/api/v1/billing/invoices")
        .set("Authorization", `Bearer ${ownerToken}`)
        .set("X-Branch-Id", branchB._id.toString());

      expect(listRes.status).toBe(200);
      const ids = listRes.body.data.map((inv) => inv._id.toString());
      expect(ids).toContain(renewedSub.invoice._id.toString());
    });

    it("should reject renewal if X-Branch-Id header is missing", async () => {
      // Create subscription
      const subRes = await request(app)
        .post("/api/v1/subscriptions")
        .set("Authorization", `Bearer ${ownerToken}`)
        .set("X-Branch-Id", branchA._id.toString())
        .send({
          customerId: customerWithHomeBranchA._id.toString(),
          price: 1000,
          entitlements: [{ serviceId: serviceOrg._id.toString(), quantity: 1 }],
          startDate: "2026-10-01",
          endDate: "2026-10-31",
        });

      expect(subRes.status).toBe(201);

      // Attempt renewal without X-Branch-Id
      const renewRes = await request(app)
        .post(`/api/v1/subscriptions/${subRes.body.data._id}/renew`)
        .set("Authorization", `Bearer ${ownerToken}`)
        .send({
          endDate: "2026-12-31",
        });

      expect(renewRes.status).toBe(400);
      expect(renewRes.body.message).toMatch(/X-Branch-Id header is required/);
    });

    it("should reject renewal of a cancelled subscription", async () => {
      // 1. Create subscription
      const subRes = await request(app)
        .post("/api/v1/subscriptions")
        .set("Authorization", `Bearer ${ownerToken}`)
        .set("X-Branch-Id", branchA._id.toString())
        .send({
          customerId: customerWithHomeBranchA._id.toString(),
          price: 1200,
          entitlements: [{ serviceId: serviceOrg._id.toString(), quantity: 1 }],
          startDate: "2026-10-01",
          endDate: "2026-10-31",
        });
      expect(subRes.status).toBe(201);
      const subId = subRes.body.data._id;

      // 2. Cancel subscription
      const cancelRes = await request(app)
        .patch(`/api/v1/subscriptions/${subId}/cancel`)
        .set("Authorization", `Bearer ${ownerToken}`)
        .send({ reason: "Customer requested cancellation" });
      expect(cancelRes.status).toBe(200);

      // 3. Attempt renewal -> should be rejected
      const renewRes = await request(app)
        .post(`/api/v1/subscriptions/${subId}/renew`)
        .set("Authorization", `Bearer ${ownerToken}`)
        .set("X-Branch-Id", branchA._id.toString())
        .send({
          endDate: "2026-12-31",
        });

      expect(renewRes.status).toBe(400);
      expect(renewRes.body.message).toMatch(/Cancelled subscriptions cannot be renewed/);
    });

    it("should reject renewal if price is negative or endDate is before startDate", async () => {
      const subRes = await request(app)
        .post("/api/v1/subscriptions")
        .set("Authorization", `Bearer ${ownerToken}`)
        .set("X-Branch-Id", branchA._id.toString())
        .send({
          customerId: customerWithHomeBranchA._id.toString(),
          price: 1500,
          entitlements: [{ serviceId: serviceOrg._id.toString(), quantity: 1 }],
          startDate: "2026-10-01",
          endDate: "2026-10-31",
        });
      expect(subRes.status).toBe(201);
      const subId = subRes.body.data._id;

      // Negative price
      const negPriceRes = await request(app)
        .post(`/api/v1/subscriptions/${subId}/renew`)
        .set("Authorization", `Bearer ${ownerToken}`)
        .set("X-Branch-Id", branchA._id.toString())
        .send({
          price: -500,
          endDate: "2026-12-31",
        });
      expect(negPriceRes.status).toBe(400);

      // End date before start date
      const invalidDateRes = await request(app)
        .post(`/api/v1/subscriptions/${subId}/renew`)
        .set("Authorization", `Bearer ${ownerToken}`)
        .set("X-Branch-Id", branchA._id.toString())
        .send({
          startDate: "2026-12-31",
          endDate: "2026-10-01",
        });
      expect(invalidDateRes.status).toBe(400);
      expect(invalidDateRes.body.message).toMatch(/strictly after start date/i);
    });
  });

  describe("5. Selling Branch B Excluded from Permitted Redemption Branches", () => {
    it("should successfully sell at Branch B with invoice assigned to Branch B even when permittedBranchIds contains only Branch A", async () => {
      // Selling at Branch B, but benefits are valid for redemption ONLY at Branch A
      const res = await request(app)
        .post("/api/v1/subscriptions")
        .set("Authorization", `Bearer ${branchBStaffToken}`)
        .set("X-Branch-Id", branchB._id.toString())
        .send({
          customerId: customerWithHomeBranchA._id.toString(),
          price: 5000,
          entitlements: [{ serviceId: serviceOrg._id.toString(), quantity: 5 }],
          permittedBranchIds: [branchA._id.toString()], // Only redeemable at Branch A
          startDate: "2026-10-01",
          endDate: "2026-12-31",
          notes: "Promotional package for Branch A sold at Branch B",
        });

      expect(res.status).toBe(201);
      expect(res.body.success).toBe(true);

      const sub = res.body.data;
      expect(sub.invoice).toBeDefined();
      // Invoice branchId is authoritative selling branch (Branch B)
      expect(sub.invoice.branchId.toString()).toBe(branchB._id.toString());
      // Sub permittedBranchIds is only Branch A
      expect(sub.permittedBranchIds.map((b) => b.toString())).toEqual([branchA._id.toString()]);

      // Complete invoice response shape contract verification
      const inv = sub.invoice;
      expect(inv.invoiceNumber).toMatch(/^INV-\d{8}-\d{4}$/);
      expect(inv.invoiceType).toBe("subscription");
      expect(inv.subtotal).toBe(5000);
      expect(inv.grossPayable).toBe(5000);
      expect(inv.payableAmount).toBe(5000);
      expect(inv.amountPaid).toBe(0);
      expect(inv.amountDue).toBe(5000);
      expect(inv.paymentStatus).toBe("unpaid");
      expect(inv.status).toBe("draft");
      expect(inv.lines).toHaveLength(1);
      expect(inv.lines[0].lineType).toBe("subscription");
      expect(inv.lines[0].unitPrice).toBe(5000);
      expect(inv.lines[0].lineTotal).toBe(5000);

      // Verify redemption is blocked at Branch B
      const otpBranchBRes = await request(app)
        .post(`/api/v1/subscriptions/${sub._id}/send-otp`)
        .set("Authorization", `Bearer ${branchBStaffToken}`)
        .set("X-Branch-Id", branchB._id.toString())
        .send({ branchId: branchB._id.toString() });

      expect(otpBranchBRes.status).toBe(403);
      expect(otpBranchBRes.body.message).toMatch(/not valid for redemption at this branch/i);

      // Reset customer's OTP rate-limit cooldown for clean test execution
      await Customer.findByIdAndUpdate(customerWithHomeBranchA._id, {
        $unset: { otpResendUntil: 1 },
      });

      // But OTP request at Branch A succeeds
      const otpBranchARes = await request(app)
        .post(`/api/v1/subscriptions/${sub._id}/send-otp`)
        .set("Authorization", `Bearer ${branchAStaffToken}`)
        .set("X-Branch-Id", branchA._id.toString())
        .send({ branchId: branchA._id.toString() });

      expect(otpBranchARes.status).toBe(200);
    });
  });
});

