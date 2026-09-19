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
    let testUri = process.env.MONGO_URI || "mongodb://127.0.0.1:27017/saloon_erp_test";
    if (testUri.includes("?")) {
      const parts = testUri.split("?");
      testUri = parts[0].replace(/\/([^\/]+)$/, "/saloon_erp_srv_test") + "?" + parts[1];
    } else {
      testUri = testUri.replace(/\/([^\/]+)$/, "/saloon_erp_srv_test");
    }
    dbConnection = await mongoose.connect(testUri);
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
      branchId: branch1A._id,
      status: "active",
    });

    category2 = await ServiceCategory.create({
      name: "Skincare",
      organizationId: org2._id,
      branchId: new mongoose.Types.ObjectId(),
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
    expect(res.body.data.branchId).toBeNull();
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
});
