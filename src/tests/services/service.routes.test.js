import { describe, expect, it, beforeEach, afterEach, jest } from "@jest/globals";
import request from "supertest";
import mongoose from "mongoose";
import app from "../../../app.mjs";
import { Organization } from "../../models/organizations/organization.model.js";
import { Branch } from "../../models/branches/branch.model.js";
import { Service } from "../../models/services/service.model.js";
import { ServiceCategory } from "../../models/services/serviceCategory.model.js";
import { Role } from "../../models/roles/role.model.js";
import { Permission } from "../../models/permissions/permission.model.js";
import { User } from "../../models/users/user.model.js";
import jwt from "jsonwebtoken";
import { env } from "../../config/env.js";
import { redis } from "../../utils/redis.js";

import dns from "dns";

try {
  dns.setServers(["8.8.8.8", "1.1.1.1"]);
} catch (_) {}

jest.spyOn(redis, "get").mockResolvedValue(null);
jest.spyOn(redis, "setex").mockResolvedValue("OK");

describe("Service Router Organization-Global Scope Test Suite", () => {
  jest.setTimeout(30000);
  let dbConnection;
  let org1, org2;
  let branch1A, branch1B;
  let ownerToken1, ownerToken2;
  let category1, category2;

  beforeAll(async () => {
    let testUri = "mongodb://127.0.0.1:27017/saloon_erp_srv_test";
    dbConnection = await mongoose.connect(testUri);
    await ServiceCategory.syncIndexes();
    await Service.syncIndexes();
  });

  afterAll(async () => {
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
    // Organizations
    org1 = await Organization.create({ name: "Org 1", slug: `org-1-${Date.now()}`, status: "active" });
    org2 = await Organization.create({ name: "Org 2", slug: `org-2-${Date.now()}`, status: "active" });

    branch1A = await Branch.create({ name: "Branch 1A", organizationId: org1._id, status: "active", isActive: true });
    branch1B = await Branch.create({ name: "Branch 1B", organizationId: org1._id, status: "active", isActive: true });

    // Permissions & Roles
    const pCreate = await Permission.findOneAndUpdate(
      { name: "services.create" },
      { name: "services.create", module: "services", action: "create" },
      { upsert: true, returnDocument: "after" }
    );
    const pView = await Permission.findOneAndUpdate(
      { name: "services.view" },
      { name: "services.view", module: "services", action: "view" },
      { upsert: true, returnDocument: "after" }
    );
    const pUpdate = await Permission.findOneAndUpdate(
      { name: "services.update" },
      { name: "services.update", module: "services", action: "update" },
      { upsert: true, returnDocument: "after" }
    );
    const pDelete = await Permission.findOneAndUpdate(
      { name: "services.delete" },
      { name: "services.delete", module: "services", action: "delete" },
      { upsert: true, returnDocument: "after" }
    );

    const ownerRole1 = await Role.create({
      name: "owner",
      description: "Owner Role 1",
      organizationId: org1._id,
      permissions: [pCreate._id, pView._id, pUpdate._id, pDelete._id],
    });
    const ownerRole2 = await Role.create({
      name: "owner",
      description: "Owner Role 2",
      organizationId: org2._id,
      permissions: [pCreate._id, pView._id, pUpdate._id, pDelete._id],
    });

    const user1 = await User.create({
      name: "Owner 1",
      username: `user1_${Date.now()}`,
      phone: "+919800000001",
      email: `owner1_${Date.now()}@test.com`,
      password: "Password@123",
      organizationId: org1._id,
      role: ownerRole1._id,
      hasOrgWideAccess: true,
      branchAccess: [],
      status: "active",
      userType: "owner",
    });

    const user2 = await User.create({
      name: "Owner 2",
      username: `user2_${Date.now()}`,
      phone: "+919800000002",
      email: `owner2_${Date.now()}@test.com`,
      password: "Password@123",
      organizationId: org2._id,
      role: ownerRole2._id,
      hasOrgWideAccess: true,
      branchAccess: [],
      status: "active",
      userType: "owner",
    });

    ownerToken1 = jwt.sign({ id: user1._id, role: "owner" }, env.JWT_SECRET, { expiresIn: "1h" });
    ownerToken2 = jwt.sign({ id: user2._id, role: "owner" }, env.JWT_SECRET, { expiresIn: "1h" });

    category1 = await ServiceCategory.create({
      name: "Haircare",
      organizationId: org1._id,
      status: "active",
    });

    category2 = await ServiceCategory.create({
      name: "Skincare",
      organizationId: org2._id,
      status: "active",
    });
  });

  afterEach(async () => {
    await Service.deleteMany({});
    await ServiceCategory.deleteMany({});
    await User.deleteMany({});
    await Role.deleteMany({});
    await Branch.deleteMany({});
    await Organization.deleteMany({});
  });

  it("creates a service without requiring X-Branch-Id header or body.branchId", async () => {
    const res = await request(app)
      .post("/api/v1/services")
      .set("Authorization", `Bearer ${ownerToken1}`)
      .send({
        name: "Classic Haircut",
        categoryId: category1._id.toString(),
        duration: 30,
        basePrice: 450,
      });

    expect(res.status).toBe(201);
    expect(res.body.data.name).toBe("Classic Haircut");
    expect(res.body.data.pricing.basePrice).toBe(450);
    expect(res.body.data.organizationId).toBe(org1._id.toString());
    expect(res.body.data.branchId).toBeUndefined();
  });

  it("lists services without requiring X-Branch-Id header, returning all organization services", async () => {
    await Service.create({
      name: "Service A",
      categoryId: category1._id,
      duration: 30,
      pricing: { basePrice: 300 },
      organizationId: org1._id,
      status: "active",
    });

    const res = await request(app)
      .get("/api/v1/services")
      .set("Authorization", `Bearer ${ownerToken1}`);

    expect(res.status).toBe(200);
    expect(res.body.data).toHaveLength(1);
    expect(res.body.data[0].name).toBe("Service A");
  });

  it("fetches all services without pagination limit when query='all' or all=true or limit='all'", async () => {
    // Create multiple services
    const servicesData = [];
    for (let i = 1; i <= 15; i++) {
      servicesData.push({
        name: `Service Bulk ${i}`,
        categoryId: category1._id,
        duration: 30,
        pricing: { basePrice: 100 + i },
        organizationId: org1._id,
        status: "active",
      });
    }
    await Service.insertMany(servicesData);

    // Default list has limit 10
    const defaultRes = await request(app)
      .get("/api/v1/services")
      .set("Authorization", `Bearer ${ownerToken1}`);
    expect(defaultRes.status).toBe(200);
    expect(defaultRes.body.data).toHaveLength(10);
    expect(defaultRes.body.meta.total).toBe(15);
    expect(defaultRes.body.meta.totalPages).toBe(2);

    // query="all"
    const queryAllRes = await request(app)
      .get("/api/v1/services?query=all")
      .set("Authorization", `Bearer ${ownerToken1}`);
    expect(queryAllRes.status).toBe(200);
    expect(queryAllRes.body.data).toHaveLength(15);
    expect(queryAllRes.body.meta.limit).toBe("all");
    expect(queryAllRes.body.meta.totalPages).toBe(1);

    // all=true
    const allTrueRes = await request(app)
      .get("/api/v1/services?all=true")
      .set("Authorization", `Bearer ${ownerToken1}`);
    expect(allTrueRes.status).toBe(200);
    expect(allTrueRes.body.data).toHaveLength(15);

    // limit=all
    const limitAllRes = await request(app)
      .get("/api/v1/services?limit=all")
      .set("Authorization", `Bearer ${ownerToken1}`);
    expect(limitAllRes.status).toBe(200);
    expect(limitAllRes.body.data).toHaveLength(15);
  });

  it("prevents accessing or updating another organization's service", async () => {
    const serviceOrg1 = await Service.create({
      name: "Exclusive Treatment",
      categoryId: category1._id,
      duration: 60,
      pricing: { basePrice: 1200 },
      organizationId: org1._id,
      status: "active",
    });

    // Org 2 user tries to GET Org 1's service
    const getRes = await request(app)
      .get(`/api/v1/services/${serviceOrg1._id}`)
      .set("Authorization", `Bearer ${ownerToken2}`);
    expect(getRes.status).toBe(404);

    // Org 2 user tries to UPDATE Org 1's service
    const updateRes = await request(app)
      .put(`/api/v1/services/${serviceOrg1._id}`)
      .set("Authorization", `Bearer ${ownerToken2}`)
      .send({ name: "Hacked Service" });
    expect(updateRes.status).toBe(404);
  });

  it("rejects creating a service with a category belonging to another organization", async () => {
    const res = await request(app)
      .post("/api/v1/services")
      .set("Authorization", `Bearer ${ownerToken1}`)
      .send({
        name: "Cross Org Service",
        categoryId: category2._id.toString(), // belongs to org2
        duration: 30,
        basePrice: 500,
      });

    expect(res.status).toBe(400);
    expect(res.body.message).toMatch(/Category not found/i);
  });

  describe("ServiceCategory Organization-Global Tests", () => {
    it("creates a category without requiring X-Branch-Id header or body.branchId", async () => {
      const res = await request(app)
        .post("/api/v1/services/categories")
        .set("Authorization", `Bearer ${ownerToken1}`)
        .send({
          name: "Massage Therapy",
          description: "Full body and head massage",
        });

      expect(res.status).toBe(201);
      expect(res.body.data.name).toBe("Massage Therapy");
      expect(res.body.data.organizationId).toBe(org1._id.toString());
      expect(res.body.data.branchId).toBeUndefined();
    });

    it("creates a category even when user provides an arbitrary or specific X-Branch-Id header", async () => {
      const res = await request(app)
        .post("/api/v1/services/categories")
        .set("Authorization", `Bearer ${ownerToken1}`)
        .set("X-Branch-Id", branch1A._id.toString())
        .send({
          name: "Nail Care",
          description: "Manicure and pedicure",
        });

      expect(res.status).toBe(201);
      expect(res.body.data.name).toBe("Nail Care");
      expect(res.body.data.organizationId).toBe(org1._id.toString());
      expect(res.body.data.branchId).toBeUndefined();
    });

    it("lists all organization categories regardless of which branch header is sent", async () => {
      // Create another category in org1
      await ServiceCategory.create({
        name: "Spa Treatments",
        organizationId: org1._id,
        status: "active",
      });

      // Request without X-Branch-Id
      const resNoBranch = await request(app)
        .get("/api/v1/services/categories")
        .set("Authorization", `Bearer ${ownerToken1}`);

      expect(resNoBranch.status).toBe(200);
      expect(resNoBranch.body.data.length).toBeGreaterThanOrEqual(2);
      const names = resNoBranch.body.data.map((c) => c.name);
      expect(names).toContain("Haircare");
      expect(names).toContain("Spa Treatments");

      // Request with Branch 1A header - still returns all org categories
      const resBranch1A = await request(app)
        .get("/api/v1/services/categories")
        .set("Authorization", `Bearer ${ownerToken1}`)
        .set("X-Branch-Id", branch1A._id.toString());

      expect(resBranch1A.status).toBe(200);
      expect(resBranch1A.body.data.length).toBe(resNoBranch.body.data.length);

      // Request with Branch 1B header - returns same org categories
      const resBranch1B = await request(app)
        .get("/api/v1/services/categories")
        .set("Authorization", `Bearer ${ownerToken1}`)
        .set("X-Branch-Id", branch1B._id.toString());

      expect(resBranch1B.status).toBe(200);
      expect(resBranch1B.body.data.length).toBe(resNoBranch.body.data.length);
    });

    it("fetches all service categories without pagination limit when query='all' or all=true or limit='all'", async () => {
      // Create additional categories
      const categoriesData = [];
      for (let i = 1; i <= 15; i++) {
        categoriesData.push({
          name: `Category Bulk ${i}`,
          organizationId: org1._id,
          status: "active",
        });
      }
      await ServiceCategory.insertMany(categoriesData);

      // Default pagination limit 10
      const defaultRes = await request(app)
        .get("/api/v1/services/categories")
        .set("Authorization", `Bearer ${ownerToken1}`);
      expect(defaultRes.status).toBe(200);
      expect(defaultRes.body.data).toHaveLength(10);
      expect(defaultRes.body.meta.total).toBe(16); // 1 from beforeEach + 15
      expect(defaultRes.body.meta.totalPages).toBe(2);

      // query="all"
      const queryAllRes = await request(app)
        .get("/api/v1/services/categories?query=all")
        .set("Authorization", `Bearer ${ownerToken1}`);
      expect(queryAllRes.status).toBe(200);
      expect(queryAllRes.body.data).toHaveLength(16);
      expect(queryAllRes.body.meta.limit).toBe("all");
      expect(queryAllRes.body.meta.totalPages).toBe(1);

      // all=true
      const allTrueRes = await request(app)
        .get("/api/v1/services/categories?all=true")
        .set("Authorization", `Bearer ${ownerToken1}`);
      expect(allTrueRes.status).toBe(200);
      expect(allTrueRes.body.data).toHaveLength(16);

      // limit=all
      const limitAllRes = await request(app)
        .get("/api/v1/services/categories?limit=all")
        .set("Authorization", `Bearer ${ownerToken1}`);
      expect(limitAllRes.status).toBe(200);
      expect(limitAllRes.body.data).toHaveLength(16);
    });

    it("rejects duplicate category name within the same organization", async () => {
      const res = await request(app)
        .post("/api/v1/services/categories")
        .set("Authorization", `Bearer ${ownerToken1}`)
        .send({
          name: "Haircare", // already created in beforeEach
        });

      expect(res.status).toBe(400);
      expect(res.body.message).toMatch(/already exists in this organization/i);
    });

    it("allows same category name in a different organization", async () => {
      const res = await request(app)
        .post("/api/v1/services/categories")
        .set("Authorization", `Bearer ${ownerToken2}`)
        .send({
          name: "Haircare", // already in org1, but allowed in org2
        });

      expect(res.status).toBe(201);
      expect(res.body.data.name).toBe("Haircare");
      expect(res.body.data.organizationId).toBe(org2._id.toString());
    });

    it("denies cross-organization category access, update, and deletion", async () => {
      // Org 2 user tries to GET Org 1 category
      const getRes = await request(app)
        .get(`/api/v1/services/categories/${category1._id}`)
        .set("Authorization", `Bearer ${ownerToken2}`);
      expect(getRes.status).toBe(404);

      // Org 2 user tries to UPDATE Org 1 category
      const updateRes = await request(app)
        .put(`/api/v1/services/categories/${category1._id}`)
        .set("Authorization", `Bearer ${ownerToken2}`)
        .send({ name: "Hacked Category" });
      expect(updateRes.status).toBe(404);

      // Org 2 user tries to DELETE Org 1 category
      const deleteRes = await request(app)
        .delete(`/api/v1/services/categories/${category1._id}`)
        .set("Authorization", `Bearer ${ownerToken2}`);
      expect(deleteRes.status).toBe(404);
    });
  });
});
