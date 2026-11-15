import { describe, expect, it, beforeAll, afterAll, beforeEach, jest } from "@jest/globals";
import request from "supertest";
import mongoose from "mongoose";
import app from "../../../app.mjs";
import { Organization } from "../../../src/models/organizations/organization.model.js";
import { Branch } from "../../../src/models/branches/branch.model.js";
import { Role } from "../../../src/models/roles/role.model.js";
import { Permission } from "../../../src/models/permissions/permission.model.js";
import { User } from "../../../src/models/users/user.model.js";
import { Coupon } from "../../../src/models/coupons/coupon.model.js";
import jwt from "jsonwebtoken";
import { env } from "../../../src/config/env.js";
import { redis } from "../../../src/utils/redis.js";
import { getIsolatedTestMongoUri } from "../testSetup.js";

jest.spyOn(redis, "get").mockResolvedValue(null);
jest.spyOn(redis, "setex").mockResolvedValue("OK");

describe("Coupons Module - Stage 1 Management Integration Tests", () => {
  jest.setTimeout(30000);

  let orgA, orgB;
  let branchA1, branchA2, branchB1;
  let ownerTokenOrgA, ownerTokenOrgB, staffNoPermToken;
  let ownerUserOrgA, ownerUserOrgB, staffUser;
  let viewOnlyToken;

  beforeAll(async () => {
    const testUri = getIsolatedTestMongoUri("coupon_test");
    await mongoose.connect(testUri);
  });

  afterAll(async () => {
    await Coupon.deleteMany({});
    await User.deleteMany({});
    await Role.deleteMany({});
    await Permission.deleteMany({});
    await Branch.deleteMany({});
    await Organization.deleteMany({});
    await mongoose.connection.close();
  });

  beforeEach(async () => {
    await Coupon.deleteMany({});
    await User.deleteMany({});
    await Role.deleteMany({});
    await Permission.deleteMany({});
    await Branch.deleteMany({});
    await Organization.deleteMany({});

    // 1. Create Organizations
    orgA = await Organization.create({
      name: "Salon Org A",
      code: "ORGA",
      slug: "salon-org-a",
      email: "orga@test.com",
    });

    orgB = await Organization.create({
      name: "Salon Org B",
      code: "ORGB",
      slug: "salon-org-b",
      email: "orgb@test.com",
    });

    // 2. Create Branches
    branchA1 = await Branch.create({
      name: "Branch A1",
      organizationId: orgA._id,
      isActive: true,
    });

    branchA2 = await Branch.create({
      name: "Branch A2",
      organizationId: orgA._id,
      isActive: false, // Inactive branch for testing validation
    });

    branchB1 = await Branch.create({
      name: "Branch B1",
      organizationId: orgB._id,
      isActive: true,
    });

    // 3. Permissions & Roles
    const permView = await Permission.create({
      name: "coupons.view",
      module: "Coupons",
      action: "View",
      description: "View coupons",
    });

    const permConfigure = await Permission.create({
      name: "coupons.configure",
      module: "Coupons",
      action: "Configure",
      description: "Configure coupons",
    });

    const ownerRole = await Role.create({
      name: "owner",
      organizationId: orgA._id,
      isSystem: true,
      permissions: [permView._id, permConfigure._id],
    });

    const viewOnlyRole = await Role.create({
      name: "view_only",
      organizationId: orgA._id,
      isSystem: false,
      permissions: [permView._id],
    });

    const noPermRole = await Role.create({
      name: "no_perm",
      organizationId: orgA._id,
      isSystem: false,
      permissions: [],
    });

    // 4. Users
    ownerUserOrgA = await User.create({
      name: "Owner Org A",
      username: "ownerorga",
      email: "owner.orga@test.com",
      password: "password123!",
      phone: "+12125550201",
      role: ownerRole._id,
      organizationId: orgA._id,
      isVerified: true,
      status: "active",
      hasOrgWideAccess: true,
    });

    ownerUserOrgB = await User.create({
      name: "Owner Org B",
      username: "ownerorgb",
      email: "owner.orgb@test.com",
      password: "password123!",
      phone: "+12125550202",
      role: ownerRole._id,
      organizationId: orgB._id,
      isVerified: true,
      status: "active",
      hasOrgWideAccess: true,
    });

    const viewUser = await User.create({
      name: "View User",
      username: "viewuser",
      email: "view@test.com",
      password: "password123!",
      phone: "+12125550203",
      role: viewOnlyRole._id,
      organizationId: orgA._id,
      isVerified: true,
      status: "active",
      hasOrgWideAccess: true,
    });

    staffUser = await User.create({
      name: "Staff No Perm",
      username: "staffnoperm",
      email: "staff@test.com",
      password: "password123!",
      phone: "+12125550204",
      role: noPermRole._id,
      organizationId: orgA._id,
      isVerified: true,
      status: "active",
      hasOrgWideAccess: true,
    });

    // 5. Auth Tokens
    ownerTokenOrgA = jwt.sign(
      {
        id: ownerUserOrgA._id.toString(),
        sub: ownerUserOrgA._id.toString(),
        userId: ownerUserOrgA._id.toString(),
        organizationId: orgA._id.toString(),
        role: "owner",
        hasOrgWideAccess: true,
        branchAccess: [],
      },
      env.JWT_SECRET || "test-secret",
      { expiresIn: "1h" }
    );

    ownerTokenOrgB = jwt.sign(
      {
        id: ownerUserOrgB._id.toString(),
        sub: ownerUserOrgB._id.toString(),
        userId: ownerUserOrgB._id.toString(),
        organizationId: orgB._id.toString(),
        role: "owner",
        hasOrgWideAccess: true,
        branchAccess: [],
      },
      env.JWT_SECRET || "test-secret",
      { expiresIn: "1h" }
    );

    viewOnlyToken = jwt.sign(
      {
        id: viewUser._id.toString(),
        sub: viewUser._id.toString(),
        userId: viewUser._id.toString(),
        organizationId: orgA._id.toString(),
        role: "view_only",
        hasOrgWideAccess: true,
        branchAccess: [],
      },
      env.JWT_SECRET || "test-secret",
      { expiresIn: "1h" }
    );

    staffNoPermToken = jwt.sign(
      {
        id: staffUser._id.toString(),
        sub: staffUser._id.toString(),
        userId: staffUser._id.toString(),
        organizationId: orgA._id.toString(),
        role: "no_perm",
        hasOrgWideAccess: true,
        branchAccess: [],
      },
      env.JWT_SECRET || "test-secret",
      { expiresIn: "1h" }
    );
  });

  describe("1. Successful Coupon Creation & Validation", () => {
    it("should successfully create a percentage coupon with valid attributes", async () => {
      const payload = {
        code: "SAVE20",
        description: "20% off summer promo",
        discountType: "percentage",
        discountValue: 20,
        validFrom: "2026-06-01T00:00:00.000Z",
        validUntil: "2026-06-30T23:59:59.999Z",
        status: "active",
        totalUsageLimit: 100,
        perCustomerLimit: 1,
        excludedBranchIds: [branchA1._id.toString()],
      };

      const res = await request(app)
        .post("/api/v1/coupons")
        .set("Authorization", `Bearer ${ownerTokenOrgA}`)
        .send(payload);

      expect(res.status).toBe(201);
      expect(res.body.success).toBe(true);
      expect(res.body.data.code).toBe("SAVE20");
      expect(res.body.data.codeUpper).toBe("SAVE20");
      expect(res.body.data.usageCount).toBe(0);
      expect(res.body.data.isExpired).toBe(true); // Since 2026-06 is in past relative to local time (or depends on date)
    });

    it("should successfully create a fixed amount coupon with unlimited usage limits (null)", async () => {
      const payload = {
        code: "FLAT100",
        description: "Flat 100 off",
        discountType: "fixed",
        discountValue: 100,
        validFrom: new Date(Date.now() - 10000).toISOString(),
        validUntil: new Date(Date.now() + 86400000).toISOString(),
      };

      const res = await request(app)
        .post("/api/v1/coupons")
        .set("Authorization", `Bearer ${ownerTokenOrgA}`)
        .send(payload);

      expect(res.status).toBe(201);
      expect(res.body.success).toBe(true);
      expect(res.body.data.code).toBe("FLAT100");
      expect(res.body.data.codeUpper).toBe("FLAT100");
      expect(res.body.data.totalUsageLimit).toBeNull();
      expect(res.body.data.perCustomerLimit).toBeNull();
      expect(res.body.data.isExpired).toBe(false);
    });

    it("should reject percentage discount value greater than 100", async () => {
      const payload = {
        code: "INVALID150",
        discountType: "percentage",
        discountValue: 150,
        validFrom: "2026-01-01T00:00:00.000Z",
        validUntil: "2026-01-10T00:00:00.000Z",
      };

      const res = await request(app)
        .post("/api/v1/coupons")
        .set("Authorization", `Bearer ${ownerTokenOrgA}`)
        .send(payload);

      expect(res.status).toBe(400);
      expect(res.body.success).toBe(false);
      expect(res.body.message).toMatch(/cannot exceed 100/i);
    });

    it("should reject invalid date ranges where validUntil <= validFrom", async () => {
      const payload = {
        code: "BAD_DATES",
        discountType: "fixed",
        discountValue: 50,
        validFrom: "2026-05-10T00:00:00.000Z",
        validUntil: "2026-05-09T00:00:00.000Z",
      };

      const res = await request(app)
        .post("/api/v1/coupons")
        .set("Authorization", `Bearer ${ownerTokenOrgA}`)
        .send(payload);

      expect(res.status).toBe(400);
      expect(res.body.success).toBe(false);
      expect(res.body.message).toMatch(/validUntil must be strictly later than validFrom/i);
    });
  });

  describe("2. Case-Insensitive Uniqueness & Tenant Isolation", () => {
    it("should reject case-insensitive duplicate code within the same organization", async () => {
      await request(app)
        .post("/api/v1/coupons")
        .set("Authorization", `Bearer ${ownerTokenOrgA}`)
        .send({
          code: "welcome10",
          discountType: "percentage",
          discountValue: 10,
          validFrom: "2026-01-01T00:00:00.000Z",
          validUntil: "2026-12-31T00:00:00.000Z",
        });

      // Try creating uppercase version of the same code
      const res = await request(app)
        .post("/api/v1/coupons")
        .set("Authorization", `Bearer ${ownerTokenOrgA}`)
        .send({
          code: "WELCOME10",
          discountType: "fixed",
          discountValue: 50,
          validFrom: "2026-01-01T00:00:00.000Z",
          validUntil: "2026-12-31T00:00:00.000Z",
        });

      expect(res.status).toBe(409);
      expect(res.body.success).toBe(false);
      expect(res.body.message).toMatch(/already exists/i);
    });

    it("should allow identical coupon code in a different organization", async () => {
      await request(app)
        .post("/api/v1/coupons")
        .set("Authorization", `Bearer ${ownerTokenOrgA}`)
        .send({
          code: "SHAREDCODE",
          discountType: "fixed",
          discountValue: 50,
          validFrom: "2026-01-01T00:00:00.000Z",
          validUntil: "2026-12-31T00:00:00.000Z",
        });

      const resOrgB = await request(app)
        .post("/api/v1/coupons")
        .set("Authorization", `Bearer ${ownerTokenOrgB}`)
        .send({
          code: "sharedcode",
          discountType: "fixed",
          discountValue: 70,
          validFrom: "2026-01-01T00:00:00.000Z",
          validUntil: "2026-12-31T00:00:00.000Z",
        });

      expect(resOrgB.status).toBe(201);
      expect(resOrgB.body.success).toBe(true);
      expect(resOrgB.body.data.code).toBe("sharedcode");
      expect(resOrgB.body.data.codeUpper).toBe("SHAREDCODE");
    });

    it("should keep soft-deleted coupon code reserved and reject re-creation", async () => {
      const createRes = await request(app)
        .post("/api/v1/coupons")
        .set("Authorization", `Bearer ${ownerTokenOrgA}`)
        .send({
          code: "FOREVERRESERVED",
          discountType: "percentage",
          discountValue: 15,
          validFrom: "2026-01-01T00:00:00.000Z",
          validUntil: "2026-12-31T00:00:00.000Z",
        });
      const couponId = createRes.body.data.id;

      // Soft delete it
      const delRes = await request(app)
        .delete(`/api/v1/coupons/${couponId}`)
        .set("Authorization", `Bearer ${ownerTokenOrgA}`);
      expect(delRes.status).toBe(200);

      // Verify the record is marked isDeleted: true in DB
      const dbDoc = await Coupon.findById(couponId);
      expect(dbDoc.isDeleted).toBe(true);

      // Attempt creating a new coupon with the same code (case-variant)
      const recreateRes = await request(app)
        .post("/api/v1/coupons")
        .set("Authorization", `Bearer ${ownerTokenOrgA}`)
        .send({
          code: "foreverreserved",
          discountType: "percentage",
          discountValue: 20,
          validFrom: "2026-01-01T00:00:00.000Z",
          validUntil: "2026-12-31T00:00:00.000Z",
        });

      expect(recreateRes.status).toBe(409);
      expect(recreateRes.body.message).toMatch(/already exists/i);
    });

    it("should enforce tenant isolation for list, get, update, and delete", async () => {
      const createRes = await request(app)
        .post("/api/v1/coupons")
        .set("Authorization", `Bearer ${ownerTokenOrgA}`)
        .send({
          code: "ORGAONLY",
          discountType: "percentage",
          discountValue: 10,
          validFrom: "2026-01-01T00:00:00.000Z",
          validUntil: "2026-12-31T00:00:00.000Z",
        });
      const couponIdA = createRes.body.data.id;

      // Org B should not see Org A coupon in list
      const listResOrgB = await request(app)
        .get("/api/v1/coupons")
        .set("Authorization", `Bearer ${ownerTokenOrgB}`);
      expect(listResOrgB.body.data.coupons.length).toBe(0);

      // Org B cannot GET coupon of Org A
      const getResOrgB = await request(app)
        .get(`/api/v1/coupons/${couponIdA}`)
        .set("Authorization", `Bearer ${ownerTokenOrgB}`);
      expect(getResOrgB.status).toBe(404);

      // Org B cannot PATCH coupon of Org A
      const patchResOrgB = await request(app)
        .patch(`/api/v1/coupons/${couponIdA}`)
        .set("Authorization", `Bearer ${ownerTokenOrgB}`)
        .send({ description: "Hacked description" });
      expect(patchResOrgB.status).toBe(404);

      // Org B cannot DELETE coupon of Org A
      const delResOrgB = await request(app)
        .delete(`/api/v1/coupons/${couponIdA}`)
        .set("Authorization", `Bearer ${ownerTokenOrgB}`);
      expect(delResOrgB.status).toBe(404);
    });
  });

  describe("3. Excluded Branches Validation", () => {
    it("should reject excludedBranchIds belonging to another organization", async () => {
      const res = await request(app)
        .post("/api/v1/coupons")
        .set("Authorization", `Bearer ${ownerTokenOrgA}`)
        .send({
          code: "CROSSBRANCH",
          discountType: "fixed",
          discountValue: 25,
          validFrom: "2026-01-01T00:00:00.000Z",
          validUntil: "2026-12-31T00:00:00.000Z",
          excludedBranchIds: [branchB1._id.toString()],
        });

      expect(res.status).toBe(400);
      expect(res.body.message).toMatch(/do not exist, are inactive, or belong to another organization/i);
    });

    it("should reject excludedBranchIds that are inactive", async () => {
      const res = await request(app)
        .post("/api/v1/coupons")
        .set("Authorization", `Bearer ${ownerTokenOrgA}`)
        .send({
          code: "INACTIVEBRANCH",
          discountType: "fixed",
          discountValue: 25,
          validFrom: "2026-01-01T00:00:00.000Z",
          validUntil: "2026-12-31T00:00:00.000Z",
          excludedBranchIds: [branchA2._id.toString()],
        });

      expect(res.status).toBe(400);
      expect(res.body.message).toMatch(/do not exist, are inactive, or belong to another organization/i);
    });

    it("should reject malformed branch ObjectIds via validation schema", async () => {
      const res = await request(app)
        .post("/api/v1/coupons")
        .set("Authorization", `Bearer ${ownerTokenOrgA}`)
        .send({
          code: "MALFORMEDBRANCH",
          discountType: "fixed",
          discountValue: 25,
          validFrom: "2026-01-01T00:00:00.000Z",
          validUntil: "2026-12-31T00:00:00.000Z",
          excludedBranchIds: ["not-an-object-id"],
        });

      expect(res.status).toBe(400);
      expect(res.body.message).toMatch(/Invalid ObjectId format/i);
    });
  });

  describe("4. Authentication and RBAC Enforcement", () => {
    it("should deny unauthenticated requests with 401", async () => {
      const res = await request(app).get("/api/v1/coupons");
      expect(res.status).toBe(401);
    });

    it("should deny requests from users without coupons.view permission with 403", async () => {
      const res = await request(app)
        .get("/api/v1/coupons")
        .set("Authorization", `Bearer ${staffNoPermToken}`);
      expect(res.status).toBe(403);
      expect(res.body.message).toMatch(/Access denied/i);
    });

    it("should allow view_only user to GET coupons but reject POST with 403", async () => {
      const getRes = await request(app)
        .get("/api/v1/coupons")
        .set("Authorization", `Bearer ${viewOnlyToken}`);
      expect(getRes.status).toBe(200);

      const postRes = await request(app)
        .post("/api/v1/coupons")
        .set("Authorization", `Bearer ${viewOnlyToken}`)
        .send({
          code: "VIEWTRYINGTOPOST",
          discountType: "fixed",
          discountValue: 10,
          validFrom: "2026-01-01T00:00:00.000Z",
          validUntil: "2026-12-31T00:00:00.000Z",
        });
      expect(postRes.status).toBe(403);
    });

    it("should reject PATCH, PATCH /status, and DELETE from view_only user with 403", async () => {
      // First create a coupon as owner
      const createRes = await request(app)
        .post("/api/v1/coupons")
        .set("Authorization", `Bearer ${ownerTokenOrgA}`)
        .send({
          code: "RBACMUTATIONTEST",
          discountType: "fixed",
          discountValue: 10,
          validFrom: "2026-01-01T00:00:00.000Z",
          validUntil: "2026-12-31T00:00:00.000Z",
        });
      const couponId = createRes.body.data.id;

      // 1. PATCH /:id
      const patchRes = await request(app)
        .patch(`/api/v1/coupons/${couponId}`)
        .set("Authorization", `Bearer ${viewOnlyToken}`)
        .send({ description: "View user cannot patch" });
      expect(patchRes.status).toBe(403);

      // 2. PATCH /:id/status
      const statusRes = await request(app)
        .patch(`/api/v1/coupons/${couponId}/status`)
        .set("Authorization", `Bearer ${viewOnlyToken}`)
        .send({ status: "inactive" });
      expect(statusRes.status).toBe(403);

      // 3. DELETE /:id
      const delRes = await request(app)
        .delete(`/api/v1/coupons/${couponId}`)
        .set("Authorization", `Bearer ${viewOnlyToken}`);
      expect(delRes.status).toBe(403);
    });
  });

  describe("5. Client-Supplied Restricted Fields & Code Immutability", () => {
    it("should reject client-supplied organizationId, usageCount, codeUpper, and audit fields", async () => {
      const res = await request(app)
        .post("/api/v1/coupons")
        .set("Authorization", `Bearer ${ownerTokenOrgA}`)
        .send({
          code: "INJECTION",
          discountType: "fixed",
          discountValue: 50,
          validFrom: "2026-01-01T00:00:00.000Z",
          validUntil: "2026-12-31T00:00:00.000Z",
          organizationId: orgB._id.toString(), // Attempted spoof
          usageCount: 999,
          codeUpper: "SPOOFED_CODE",
        });

      expect(res.status).toBe(400);
      expect(res.body.message).toMatch(/Unrecognized keys|Validation failed/i);
    });

    it("should reject code changes on PATCH endpoint", async () => {
      const createRes = await request(app)
        .post("/api/v1/coupons")
        .set("Authorization", `Bearer ${ownerTokenOrgA}`)
        .send({
          code: "STATICCODE",
          discountType: "percentage",
          discountValue: 10,
          validFrom: "2026-01-01T00:00:00.000Z",
          validUntil: "2026-12-31T00:00:00.000Z",
        });

      const patchRes = await request(app)
        .patch(`/api/v1/coupons/${createRes.body.data.id}`)
        .set("Authorization", `Bearer ${ownerTokenOrgA}`)
        .send({ code: "NEWCODE" });

      expect(patchRes.status).toBe(400);
      expect(patchRes.body.message).toMatch(/Unrecognized key|Validation failed/i);
    });
  });

  describe("6. Update Business Rules & Usage Guards", () => {
    it("should block discountType or discountValue modification when usageCount > 0", async () => {
      const createRes = await request(app)
        .post("/api/v1/coupons")
        .set("Authorization", `Bearer ${ownerTokenOrgA}`)
        .send({
          code: "USEDCOUPON",
          discountType: "percentage",
          discountValue: 10,
          validFrom: "2026-01-01T00:00:00.000Z",
          validUntil: "2026-12-31T00:00:00.000Z",
        });
      const couponId = createRes.body.data.id;

      // Simulate a usage count recorded in DB
      await Coupon.findByIdAndUpdate(couponId, { usageCount: 5 });

      // Attempt modifying discountValue
      const patchRes = await request(app)
        .patch(`/api/v1/coupons/${couponId}`)
        .set("Authorization", `Bearer ${ownerTokenOrgA}`)
        .send({ discountValue: 20 });

      expect(patchRes.status).toBe(400);
      expect(patchRes.body.message).toMatch(/Cannot modify discountType or discountValue on a coupon that has already been used/i);
    });

    it("should block lowering totalUsageLimit below current usageCount", async () => {
      const createRes = await request(app)
        .post("/api/v1/coupons")
        .set("Authorization", `Bearer ${ownerTokenOrgA}`)
        .send({
          code: "LIMITCHECK",
          discountType: "percentage",
          discountValue: 10,
          totalUsageLimit: 100,
          validFrom: "2026-01-01T00:00:00.000Z",
          validUntil: "2026-12-31T00:00:00.000Z",
        });
      const couponId = createRes.body.data.id;

      // Simulate usageCount = 50
      await Coupon.findByIdAndUpdate(couponId, { usageCount: 50 });

      // Attempt setting totalUsageLimit = 30
      const patchRes = await request(app)
        .patch(`/api/v1/coupons/${couponId}`)
        .set("Authorization", `Bearer ${ownerTokenOrgA}`)
        .send({ totalUsageLimit: 30 });

      expect(patchRes.status).toBe(400);
      expect(patchRes.body.message).toMatch(/cannot be less than current usageCount/i);
    });

    it("should allow activating / deactivating coupon via dedicated status endpoint", async () => {
      const createRes = await request(app)
        .post("/api/v1/coupons")
        .set("Authorization", `Bearer ${ownerTokenOrgA}`)
        .send({
          code: "STATUSSWITCH",
          discountType: "percentage",
          discountValue: 10,
          status: "active",
          validFrom: "2026-01-01T00:00:00.000Z",
          validUntil: "2026-12-31T00:00:00.000Z",
        });
      const couponId = createRes.body.data.id;

      const deactivateRes = await request(app)
        .patch(`/api/v1/coupons/${couponId}/status`)
        .set("Authorization", `Bearer ${ownerTokenOrgA}`)
        .send({ status: "inactive" });

      expect(deactivateRes.status).toBe(200);
      expect(deactivateRes.body.data.status).toBe("inactive");
    });

    describe("Audit 1 & 3: Partial Date Range Consistency & Status Endpoint Security", () => {
      it("should reject updating only validFrom to a date after stored validUntil", async () => {
        const createRes = await request(app)
          .post("/api/v1/coupons")
          .set("Authorization", `Bearer ${ownerTokenOrgA}`)
          .send({
            code: "DATEBOUNDS1",
            discountType: "fixed",
            discountValue: 10,
            validFrom: "2026-05-01T00:00:00.000Z",
            validUntil: "2026-05-31T00:00:00.000Z",
          });
        const couponId = createRes.body.data.id;

        // Try setting validFrom past 2026-05-31
        const patchRes = await request(app)
          .patch(`/api/v1/coupons/${couponId}`)
          .set("Authorization", `Bearer ${ownerTokenOrgA}`)
          .send({ validFrom: "2026-06-01T00:00:00.000Z" });

        expect(patchRes.status).toBe(400);
        expect(patchRes.body.message).toMatch(/validUntil must be strictly later than validFrom/i);
      });

      it("should reject updating only validUntil to a date before stored validFrom", async () => {
        const createRes = await request(app)
          .post("/api/v1/coupons")
          .set("Authorization", `Bearer ${ownerTokenOrgA}`)
          .send({
            code: "DATEBOUNDS2",
            discountType: "fixed",
            discountValue: 10,
            validFrom: "2026-05-10T00:00:00.000Z",
            validUntil: "2026-05-31T00:00:00.000Z",
          });
        const couponId = createRes.body.data.id;

        // Try setting validUntil earlier than 2026-05-10
        const patchRes = await request(app)
          .patch(`/api/v1/coupons/${couponId}`)
          .set("Authorization", `Bearer ${ownerTokenOrgA}`)
          .send({ validUntil: "2026-05-05T00:00:00.000Z" });

        expect(patchRes.status).toBe(400);
        expect(patchRes.body.message).toMatch(/validUntil must be strictly later than validFrom/i);
      });

      it("should successfully update both validFrom and validUntil to a valid range", async () => {
        const createRes = await request(app)
          .post("/api/v1/coupons")
          .set("Authorization", `Bearer ${ownerTokenOrgA}`)
          .send({
            code: "DATEBOUNDS3",
            discountType: "fixed",
            discountValue: 10,
            validFrom: "2026-05-01T00:00:00.000Z",
            validUntil: "2026-05-31T00:00:00.000Z",
          });
        const couponId = createRes.body.data.id;

        const patchRes = await request(app)
          .patch(`/api/v1/coupons/${couponId}`)
          .set("Authorization", `Bearer ${ownerTokenOrgA}`)
          .send({
            validFrom: "2026-07-01T00:00:00.000Z",
            validUntil: "2026-07-31T00:00:00.000Z",
          });

        expect(patchRes.status).toBe(200);
        expect(new Date(patchRes.body.data.validFrom).toISOString()).toBe("2026-07-01T00:00:00.000Z");
        expect(new Date(patchRes.body.data.validUntil).toISOString()).toBe("2026-07-31T00:00:00.000Z");
      });

      it("should update unrelated fields without failing date validation", async () => {
        const createRes = await request(app)
          .post("/api/v1/coupons")
          .set("Authorization", `Bearer ${ownerTokenOrgA}`)
          .send({
            code: "UNRELATEDUPDATE",
            description: "Initial description",
            discountType: "fixed",
            discountValue: 10,
            validFrom: "2026-05-01T00:00:00.000Z",
            validUntil: "2026-05-31T00:00:00.000Z",
          });
        const couponId = createRes.body.data.id;

        const patchRes = await request(app)
          .patch(`/api/v1/coupons/${couponId}`)
          .set("Authorization", `Bearer ${ownerTokenOrgA}`)
          .send({ description: "Updated description only" });

        expect(patchRes.status).toBe(200);
        expect(patchRes.body.data.description).toBe("Updated description only");
      });

      it("should reject extraneous/injected fields on PATCH /status", async () => {
        const createRes = await request(app)
          .post("/api/v1/coupons")
          .set("Authorization", `Bearer ${ownerTokenOrgA}`)
          .send({
            code: "STATUSINJECTION",
            discountType: "fixed",
            discountValue: 10,
            validFrom: "2026-05-01T00:00:00.000Z",
            validUntil: "2026-05-31T00:00:00.000Z",
          });
        const couponId = createRes.body.data.id;

        const patchRes = await request(app)
          .patch(`/api/v1/coupons/${couponId}/status`)
          .set("Authorization", `Bearer ${ownerTokenOrgA}`)
          .send({
            status: "inactive",
            discountValue: 9999, // Injected forbidden field
          });

        expect(patchRes.status).toBe(400);
        expect(patchRes.body.message).toMatch(/Unrecognized key|Validation failed/i);
      });
    });
  });

  describe("7. Pagination and Filtering Contract", () => {
    it("should properly paginate and filter coupons by status and search", async () => {
      // Create 3 coupons in Org A
      await request(app)
        .post("/api/v1/coupons")
        .set("Authorization", `Bearer ${ownerTokenOrgA}`)
        .send({
          code: "SUMMER1",
          description: "Summer deal 1",
          discountType: "fixed",
          discountValue: 10,
          status: "active",
          validFrom: "2026-01-01T00:00:00.000Z",
          validUntil: "2026-12-31T00:00:00.000Z",
        });

      await request(app)
        .post("/api/v1/coupons")
        .set("Authorization", `Bearer ${ownerTokenOrgA}`)
        .send({
          code: "SUMMER2",
          description: "Summer deal 2",
          discountType: "fixed",
          discountValue: 20,
          status: "inactive",
          validFrom: "2026-01-01T00:00:00.000Z",
          validUntil: "2026-12-31T00:00:00.000Z",
        });

      await request(app)
        .post("/api/v1/coupons")
        .set("Authorization", `Bearer ${ownerTokenOrgA}`)
        .send({
          code: "WINTER1",
          description: "Winter special",
          discountType: "fixed",
          discountValue: 30,
          status: "active",
          validFrom: "2026-01-01T00:00:00.000Z",
          validUntil: "2026-12-31T00:00:00.000Z",
        });

      // Query with status=active
      const activeRes = await request(app)
        .get("/api/v1/coupons?status=active")
        .set("Authorization", `Bearer ${ownerTokenOrgA}`);

      expect(activeRes.status).toBe(200);
      expect(activeRes.body.data.coupons.length).toBe(2);
      expect(activeRes.body.meta.total).toBe(2);

      // Query with search=WINTER
      const searchRes = await request(app)
        .get("/api/v1/coupons?search=winter")
        .set("Authorization", `Bearer ${ownerTokenOrgA}`);

      expect(searchRes.status).toBe(200);
      expect(searchRes.body.data.coupons.length).toBe(1);
      expect(searchRes.body.data.coupons[0].code).toBe("WINTER1");

      // Query pagination limit=1
      const pageRes = await request(app)
        .get("/api/v1/coupons?page=1&limit=1")
        .set("Authorization", `Bearer ${ownerTokenOrgA}`);

      expect(pageRes.status).toBe(200);
      expect(pageRes.body.data.coupons.length).toBe(1);
      expect(pageRes.body.meta.totalPages).toBe(3);
    });
  });
});
