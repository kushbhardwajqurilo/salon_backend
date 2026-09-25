import { describe, expect, it, beforeEach, afterEach, jest } from "@jest/globals";
import request from "supertest";
import mongoose from "mongoose";
import app from "../../../app.mjs";
import { Organization } from "../../../src/models/organizations/organization.model.js";
import { Branch } from "../../../src/models/branches/branch.model.js";
import { Service } from "../../../src/models/services/service.model.js";
import { ServiceCategory } from "../../../src/models/services/serviceCategory.model.js";
import { Role } from "../../../src/models/roles/role.model.js";
import { Permission } from "../../../src/models/permissions/permission.model.js";
import { User } from "../../../src/models/users/user.model.js";
import { SubscriptionPlan } from "../../../src/models/subscriptions/subscriptionPlan.model.js";
import { AuditLog } from "../../../src/models/audit/auditLog.model.js";
import jwt from "jsonwebtoken";
import { env } from "../../../src/config/env.js";
import { redis } from "../../../src/utils/redis.js";

jest.spyOn(redis, "get").mockResolvedValue(null);
jest.spyOn(redis, "setex").mockResolvedValue("OK");

describe("SubscriptionPlan Module Integration Tests", () => {
  jest.setTimeout(30000);

  let orgA, orgB;
  let branchA1, branchB1;
  let ownerToken, ownerUser;
  let serviceA1, serviceA2, categoryA;

  beforeAll(async () => {
    let testUri = process.env.MONGO_URI || "mongodb://127.0.0.1:27017/saloon_erp_test";
    if (testUri.includes("?")) {
      const parts = testUri.split("?");
      testUri = parts[0].replace(/\/([^\/]+)$/, "/saloon_erp_plan_test") + "?" + parts[1];
    } else {
      testUri = testUri.replace(/\/([^\/]+)$/, "/saloon_erp_plan_test");
    }
    await mongoose.connect(testUri);
  });

  afterAll(async () => {
    await SubscriptionPlan.deleteMany({});
    await AuditLog.deleteMany({});
    await Service.deleteMany({});
    await ServiceCategory.deleteMany({});
    await User.deleteMany({});
    await Role.deleteMany({});
    await Permission.deleteMany({});
    await Branch.deleteMany({});
    await Organization.deleteMany({});
    await mongoose.connection.close();
  });

  beforeEach(async () => {
    await SubscriptionPlan.deleteMany({});
    await AuditLog.deleteMany({});
    await Service.deleteMany({});
    await ServiceCategory.deleteMany({});
    await User.deleteMany({});
    await Role.deleteMany({});
    await Permission.deleteMany({});
    await Branch.deleteMany({});
    await Organization.deleteMany({});

    // 1. Organizations
    orgA = await Organization.create({
      name: "Plan Test Salon A",
      slug: "plan-test-salon-a",
    });

    orgB = await Organization.create({
      name: "Plan Test Salon B",
      slug: "plan-test-salon-b",
    });

    // 2. Branches
    branchA1 = await Branch.create({
      name: "Branch A1",
      organizationId: orgA._id,
      isActive: true,
      address: "100 A1 Street, NY",
    });

    branchB1 = await Branch.create({
      name: "Branch B1",
      organizationId: orgB._id,
      isActive: true,
      address: "200 B1 Street, NY",
    });

    // 3. Permissions & Role
    const permView = await Permission.create({
      name: "subscriptions.view",
      module: "Subscriptions",
      action: "View",
      description: "View subscriptions and plans",
    });

    const permConfig = await Permission.create({
      name: "subscriptions.configure",
      module: "Subscriptions",
      action: "Configure",
      description: "Configure subscriptions and plans",
    });

    const ownerRole = await Role.create({
      name: "owner",
      description: "Full owner access",
      permissions: [permView._id, permConfig._id],
      isSystem: true,
    });

    // 4. User & Auth Token
    ownerUser = await User.create({
      name: "Plan Owner",
      username: "planowner",
      email: "planowner@salon.com",
      password: "HashedPassword123!",
      phone: "+12125550200",
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

    // 5. Category & Services
    categoryA = await ServiceCategory.create({
      name: "Salon A Category",
      organizationId: orgA._id,
      branchId: branchA1._id,
    });

    serviceA1 = await Service.create({
      name: "Bridal Glow Facial",
      serviceCode: "BGF-01",
      organizationId: orgA._id,
      categoryId: categoryA._id,
      duration: 60,
      pricing: { basePrice: 2000 },
      status: "active",
    });

    serviceA2 = await Service.create({
      name: "Bridal Hair Styling",
      serviceCode: "BHS-02",
      organizationId: orgA._id,
      categoryId: categoryA._id,
      duration: 45,
      pricing: { basePrice: 1500 },
      status: "active",
    });
  });

  describe("POST /api/v1/subscription-plans - Create Plan Template", () => {
    it("should successfully create a subscription plan template", async () => {
      const res = await request(app)
        .post("/api/v1/subscription-plans")
        .set("Authorization", `Bearer ${ownerToken}`)
        .send({
          name: "Bridal Glow Package",
          code: "PLAN-BRIDAL-01",
          description: "Exclusive bridal pre-wedding package",
          suggestedPrice: 12000,
          validityMonths: 6,
          entitlements: [
            { serviceId: serviceA1._id.toString(), quantity: 5 },
            { serviceId: serviceA2._id.toString(), quantity: 3 },
          ],
          permittedBranchIds: [branchA1._id.toString()],
        });

      expect(res.status).toBe(201);
      expect(res.body.success).toBe(true);
      expect(res.body.data.name).toBe("Bridal Glow Package");
      expect(res.body.data.code).toBe("PLAN-BRIDAL-01");
      expect(res.body.data.suggestedPrice).toBe(12000);
      expect(res.body.data.validityMonths).toBe(6);
      expect(res.body.data.entitlements).toHaveLength(2);
      expect(res.body.data.isActive).toBe(true);
    });

    it("should reject duplicate code within the same organization", async () => {
      await SubscriptionPlan.create({
        organizationId: orgA._id,
        name: "Existing Plan",
        code: "PLAN-DUPLICATE",
        suggestedPrice: 5000,
        validityMonths: 3,
        entitlements: [{ serviceId: serviceA1._id, quantity: 2 }],
      });

      const res = await request(app)
        .post("/api/v1/subscription-plans")
        .set("Authorization", `Bearer ${ownerToken}`)
        .send({
          name: "Another Plan",
          code: "PLAN-DUPLICATE",
          suggestedPrice: 7000,
          validityMonths: 6,
          entitlements: [{ serviceId: serviceA1._id.toString(), quantity: 1 }],
        });

      expect(res.status).toBe(409);
      expect(res.body.message).toMatch(/already exists in this organization/);
    });
  });

  describe("GET /api/v1/subscription-plans - List Plans", () => {
    it("should list subscription plans organization-scoped without branch filter", async () => {
      await SubscriptionPlan.create({
        organizationId: orgA._id,
        name: "Plan Alpha",
        code: "ALPHA-01",
        suggestedPrice: 3000,
        validityMonths: 3,
        entitlements: [{ serviceId: serviceA1._id, quantity: 2 }],
        isActive: true,
      });

      await SubscriptionPlan.create({
        organizationId: orgA._id,
        name: "Plan Beta Inactive",
        code: "BETA-02",
        suggestedPrice: 4000,
        validityMonths: 6,
        entitlements: [{ serviceId: serviceA2._id, quantity: 3 }],
        isActive: false,
      });

      const res = await request(app)
        .get("/api/v1/subscription-plans?status=active")
        .set("Authorization", `Bearer ${ownerToken}`);

      expect(res.status).toBe(200);
      expect(res.body.data).toHaveLength(1);
      expect(res.body.data[0].name).toBe("Plan Alpha");
    });
  });

  describe("PUT & DELETE /api/v1/subscription-plans/:id", () => {
    it("should update and then soft-delete subscription plan", async () => {
      const plan = await SubscriptionPlan.create({
        organizationId: orgA._id,
        name: "Original Plan",
        suggestedPrice: 5000,
        validityMonths: 3,
        entitlements: [{ serviceId: serviceA1._id, quantity: 2 }],
      });

      const updateRes = await request(app)
        .put(`/api/v1/subscription-plans/${plan._id}`)
        .set("Authorization", `Bearer ${ownerToken}`)
        .send({
          suggestedPrice: 6500,
          description: "Updated description",
        });

      expect(updateRes.status).toBe(200);
      expect(updateRes.body.data.suggestedPrice).toBe(6500);

      const deleteRes = await request(app)
        .delete(`/api/v1/subscription-plans/${plan._id}`)
        .set("Authorization", `Bearer ${ownerToken}`);

      expect(deleteRes.status).toBe(200);

      const fetched = await SubscriptionPlan.findOne({
        _id: plan._id,
        isDeleted: false,
      });
      expect(fetched).toBeNull();
    });
  });
});
