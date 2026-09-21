import { describe, expect, it, beforeEach, afterEach, jest } from "@jest/globals";
import request from "supertest";
import mongoose from "mongoose";
import app from "../../../app.mjs";
import { Organization } from "../../models/organizations/organization.model.js";
import { Branch } from "../../models/branches/branch.model.js";
import { Role } from "../../models/roles/role.model.js";
import { Permission } from "../../models/permissions/permission.model.js";
import { User } from "../../models/users/user.model.js";
import { AuditLog, AUDIT_ACTIONS } from "../../models/audit/auditLog.model.js";
import jwt from "jsonwebtoken";
import { env } from "../../config/env.js";
import { redis } from "../../utils/redis.js";

jest.spyOn(redis, "get").mockResolvedValue(null);
jest.spyOn(redis, "setex").mockResolvedValue("OK");

describe("Audit Logs Module Integration Test Suite", () => {
  jest.setTimeout(30000);

  let orgA, orgB;
  let branchA1, branchA2, branchB1;
  let ownerUserA, staffUserA, ownerUserB;
  let ownerTokenA, staffTokenA, ownerTokenB;
  let log1, log2, log3, logOrgB;

  beforeAll(async () => {
    let testUri = process.env.MONGO_URI || "mongodb://127.0.0.1:27017/saloon_erp_test";
    if (testUri.includes("?")) {
      const parts = testUri.split("?");
      testUri = parts[0].replace(/\/([^\/]+)$/, "/saloon_erp_audit_test") + "?" + parts[1];
    } else {
      testUri = testUri.replace(/\/([^\/]+)$/, "/saloon_erp_audit_test");
    }
    await mongoose.connect(testUri);
  });

  afterAll(async () => {
    await AuditLog.deleteMany({});
    await User.deleteMany({});
    await Role.deleteMany({});
    await Permission.deleteMany({});
    await Branch.deleteMany({});
    await Organization.deleteMany({});
    await mongoose.connection.close();
  });

  beforeEach(async () => {
    await AuditLog.deleteMany({});
    await User.deleteMany({});
    await Role.deleteMany({});
    await Permission.deleteMany({});
    await Branch.deleteMany({});
    await Organization.deleteMany({});

    // 1. Create Organizations & Branches
    orgA = await Organization.create({
      name: "Org Alpha",
      slug: `org-alpha-${Date.now()}`,
      status: "active",
    });
    orgB = await Organization.create({
      name: "Org Beta",
      slug: `org-beta-${Date.now()}`,
      status: "active",
    });

    branchA1 = await Branch.create({
      name: "Branch Alpha 1",
      organizationId: orgA._id,
      status: "active",
      isActive: true,
    });
    branchA2 = await Branch.create({
      name: "Branch Alpha 2",
      organizationId: orgA._id,
      status: "active",
      isActive: true,
    });
    branchB1 = await Branch.create({
      name: "Branch Beta 1",
      organizationId: orgB._id,
      status: "active",
      isActive: true,
    });

    // 2. Setup Permissions & Roles
    const pLogsView = await Permission.findOneAndUpdate(
      { name: "logs.view" },
      { name: "logs.view", module: "Settings", action: "View Logs", description: "View Logs" },
      { upsert: true, returnDocument: "after" }
    );
    const pCustView = await Permission.findOneAndUpdate(
      { name: "customers.view" },
      { name: "customers.view", module: "Customers", action: "View", description: "View Customers" },
      { upsert: true, returnDocument: "after" }
    );

    const ownerRoleA = await Role.create({
      name: "owner",
      description: "Owner Role",
      permissions: [pLogsView._id, pCustView._id],
    });

    const staffRoleA = await Role.create({
      name: "stylist",
      description: "Staff without logs.view",
      permissions: [pCustView._id],
    });

    // 3. Create Users
    ownerUserA = await User.create({
      name: "Owner Alpha",
      email: `owner_alpha_${Date.now()}@test.com`,
      phone: "+919111111111",
      password: "Password@123",
      role: ownerRoleA._id,
      organizationId: orgA._id,
      status: "active",
      hasOrgWideAccess: true,
      branchAccess: [{ branchId: branchA1._id, branchName: branchA1.name, isActive: true }],
    });

    staffUserA = await User.create({
      name: "Staff Alpha",
      email: `staff_alpha_${Date.now()}@test.com`,
      phone: "+919222222222",
      password: "Password@123",
      role: staffRoleA._id,
      organizationId: orgA._id,
      status: "active",
      hasOrgWideAccess: false,
      branchAccess: [{ branchId: branchA1._id, branchName: branchA1.name, isActive: true }],
    });

    ownerUserB = await User.create({
      name: "Owner Beta",
      email: `owner_beta_${Date.now()}@test.com`,
      phone: "+919333333333",
      password: "Password@123",
      role: ownerRoleA._id,
      organizationId: orgB._id,
      status: "active",
      hasOrgWideAccess: true,
      branchAccess: [{ branchId: branchB1._id, branchName: branchB1.name, isActive: true }],
    });

    // 4. Tokens
    ownerTokenA = jwt.sign(
      { id: ownerUserA._id, role: "owner" },
      env.JWT_SECRET || "default_jwt_secret",
      { expiresIn: "1h" }
    );
    staffTokenA = jwt.sign(
      { id: staffUserA._id, role: "stylist" },
      env.JWT_SECRET || "default_jwt_secret",
      { expiresIn: "1h" }
    );
    ownerTokenB = jwt.sign(
      { id: ownerUserB._id, role: "owner" },
      env.JWT_SECRET || "default_jwt_secret",
      { expiresIn: "1h" }
    );

    // 5. Seed Audit Logs
    log1 = await AuditLog.create({
      organizationId: orgA._id,
      branchId: branchA1._id,
      actorId: ownerUserA._id,
      action: AUDIT_ACTIONS.CUSTOMER_CREATED,
      entityType: "Customer",
      entityId: new mongoose.Types.ObjectId(),
      description: "Customer John created",
      metadata: { phone: "+919876543210" },
      createdAt: new Date("2026-09-10T10:00:00.000Z"),
    });

    log2 = await AuditLog.create({
      organizationId: orgA._id,
      branchId: branchA2._id,
      actorId: ownerUserA._id,
      action: AUDIT_ACTIONS.SERVICE_CREATED,
      entityType: "Service",
      entityId: new mongoose.Types.ObjectId(),
      description: "Service Haircut created",
      metadata: { basePrice: 200 },
      createdAt: new Date("2026-09-15T12:00:00.000Z"),
    });

    log3 = await AuditLog.create({
      organizationId: orgA._id,
      branchId: branchA1._id,
      actorId: staffUserA._id,
      action: AUDIT_ACTIONS.NOTE_ADDED,
      entityType: "CustomerNote",
      entityId: new mongoose.Types.ObjectId(),
      description: "Note added to customer",
      metadata: { noteId: "note-1" },
      createdAt: new Date("2026-09-20T14:00:00.000Z"),
    });

    logOrgB = await AuditLog.create({
      organizationId: orgB._id,
      branchId: branchB1._id,
      actorId: ownerUserB._id,
      action: AUDIT_ACTIONS.CUSTOMER_CREATED,
      entityType: "Customer",
      entityId: new mongoose.Types.ObjectId(),
      description: "Org B customer created",
      metadata: {},
      createdAt: new Date("2026-09-20T15:00:00.000Z"),
    });
  });

  // Requirement 1: authenticated user with logs.view can retrieve audit logs
  it("allows authenticated user with logs.view to retrieve audit logs", async () => {
    const res = await request(app)
      .get("/api/v1/audit-logs")
      .set("Authorization", `Bearer ${ownerTokenA}`);

    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
    expect(res.body.status).toBe("success");
    expect(res.body.message).toBe("Audit logs retrieved successfully");
    expect(Array.isArray(res.body.data)).toBe(true);
    expect(res.body.data.length).toBe(3);
    expect(res.body.meta).toEqual(
      expect.objectContaining({
        total: 3,
        page: 1,
        limit: 10,
        totalPages: 1,
      })
    );
  });

  // Requirement 2: unauthenticated request is rejected
  it("rejects unauthenticated requests with 401", async () => {
    const res = await request(app).get("/api/v1/audit-logs");
    expect(res.status).toBe(401);
  });

  // Requirement 3: authenticated user without logs.view is rejected
  it("rejects authenticated user without logs.view with 403", async () => {
    const res = await request(app)
      .get("/api/v1/audit-logs")
      .set("Authorization", `Bearer ${staffTokenA}`)
      .set("X-Branch-Id", branchA1._id.toString());

    expect(res.status).toBe(403);
  });

  // Requirement 4: organization isolation is enforced
  it("enforces strict organization isolation (tenant boundary)", async () => {
    const resA = await request(app)
      .get("/api/v1/audit-logs")
      .set("Authorization", `Bearer ${ownerTokenA}`);

    expect(resA.status).toBe(200);
    const orgAIds = resA.body.data.map((l) => l.organizationId.toString());
    expect(orgAIds.every((id) => id === orgA._id.toString())).toBe(true);
    expect(resA.body.data.some((l) => l._id.toString() === logOrgB._id.toString())).toBe(false);

    const resB = await request(app)
      .get("/api/v1/audit-logs")
      .set("Authorization", `Bearer ${ownerTokenB}`);

    expect(resB.status).toBe(200);
    expect(resB.body.data.length).toBe(1);
    expect(resB.body.data[0]._id.toString()).toBe(logOrgB._id.toString());
  });

  // Requirement 5: valid pagination works
  it("handles valid pagination parameters correctly", async () => {
    const res = await request(app)
      .get("/api/v1/audit-logs?page=1&limit=2")
      .set("Authorization", `Bearer ${ownerTokenA}`);

    expect(res.status).toBe(200);
    expect(res.body.data.length).toBe(2);
    expect(res.body.meta.total).toBe(3);
    expect(res.body.meta.page).toBe(1);
    expect(res.body.meta.limit).toBe(2);
    expect(res.body.meta.totalPages).toBe(2);

    const resPage2 = await request(app)
      .get("/api/v1/audit-logs?page=2&limit=2")
      .set("Authorization", `Bearer ${ownerTokenA}`);

    expect(resPage2.status).toBe(200);
    expect(resPage2.body.data.length).toBe(1);
    expect(resPage2.body.meta.page).toBe(2);
  });

  // Requirement 6: supported filters work (branchId, entityType, action, actorId, date range)
  it("filters audit logs by action, entityType, actorId, branchId, and date range", async () => {
    // Filter by action
    const resAction = await request(app)
      .get(`/api/v1/audit-logs?action=${AUDIT_ACTIONS.CUSTOMER_CREATED}`)
      .set("Authorization", `Bearer ${ownerTokenA}`);
    expect(resAction.status).toBe(200);
    expect(resAction.body.data.length).toBe(1);
    expect(resAction.body.data[0].action).toBe(AUDIT_ACTIONS.CUSTOMER_CREATED);

    // Filter by entityType
    const resEntity = await request(app)
      .get("/api/v1/audit-logs?entityType=Service")
      .set("Authorization", `Bearer ${ownerTokenA}`);
    expect(resEntity.status).toBe(200);
    expect(resEntity.body.data.length).toBe(1);
    expect(resEntity.body.data[0].entityType).toBe("Service");

    // Filter by actorId
    const resActor = await request(app)
      .get(`/api/v1/audit-logs?actorId=${staffUserA._id}`)
      .set("Authorization", `Bearer ${ownerTokenA}`);
    expect(resActor.status).toBe(200);
    expect(resActor.body.data.length).toBe(1);
    expect(resActor.body.data[0]._id.toString()).toBe(log3._id.toString());

    // Filter by branchId via query (org-wide user)
    const resBranch = await request(app)
      .get(`/api/v1/audit-logs?branchId=${branchA2._id}`)
      .set("Authorization", `Bearer ${ownerTokenA}`);
    expect(resBranch.status).toBe(200);
    expect(resBranch.body.data.length).toBe(1);
    expect(resBranch.body.data[0]._id.toString()).toBe(log2._id.toString());

    // Filter by date range
    const resDate = await request(app)
      .get("/api/v1/audit-logs?startDate=2026-09-12&endDate=2026-09-18")
      .set("Authorization", `Bearer ${ownerTokenA}`);
    expect(resDate.status).toBe(200);
    expect(resDate.body.data.length).toBe(1);
    expect(resDate.body.data[0]._id.toString()).toBe(log2._id.toString());
  });

  // Requirement 7 & 8: invalid query parameters and invalid ObjectId filters are rejected
  it("rejects invalid query parameters and invalid ObjectIds with 400", async () => {
    // Invalid action
    const resBadAction = await request(app)
      .get("/api/v1/audit-logs?action=NOT_A_REAL_ACTION")
      .set("Authorization", `Bearer ${ownerTokenA}`);
    expect(resBadAction.status).toBe(400);

    // Invalid ObjectId format for actorId
    const resBadActorId = await request(app)
      .get("/api/v1/audit-logs?actorId=invalid-object-id")
      .set("Authorization", `Bearer ${ownerTokenA}`);
    expect(resBadActorId.status).toBe(400);

    // Invalid date format
    const resBadDate = await request(app)
      .get("/api/v1/audit-logs?startDate=2026/09/01")
      .set("Authorization", `Bearer ${ownerTokenA}`);
    expect(resBadDate.status).toBe(400);

    // Invalid date range (startDate > endDate)
    const resInvertedDate = await request(app)
      .get("/api/v1/audit-logs?startDate=2026-09-20&endDate=2026-09-10")
      .set("Authorization", `Bearer ${ownerTokenA}`);
    expect(resInvertedDate.status).toBe(400);

    // Invalid sort field
    const resBadSort = await request(app)
      .get("/api/v1/audit-logs?sort=invalidField")
      .set("Authorization", `Bearer ${ownerTokenA}`);
    expect(resBadSort.status).toBe(400);
  });

  // Requirement 9: branch filtering cannot bypass branch authorization
  it("enforces active branch context when X-Branch-Id is provided", async () => {
    const res = await request(app)
      .get("/api/v1/audit-logs")
      .set("Authorization", `Bearer ${ownerTokenA}`)
      .set("X-Branch-Id", branchA1._id.toString());

    expect(res.status).toBe(200);
    expect(res.body.data.length).toBe(2); // log1 and log3 belong to branchA1
    expect(res.body.data.every((l) => l.branchId.toString() === branchA1._id.toString())).toBe(true);

    // If non-authorized branch header is supplied for Org B branch
    const resCrossOrgBranch = await request(app)
      .get("/api/v1/audit-logs")
      .set("Authorization", `Bearer ${ownerTokenA}`)
      .set("X-Branch-Id", branchB1._id.toString());

    expect(resCrossOrgBranch.status).toBe(404);
  });

  // Requirement 10: audit records are read-only — no mutation route exists
  it("verifies audit records are strictly read-only and no mutation routes exist", async () => {
    const postRes = await request(app)
      .post("/api/v1/audit-logs")
      .set("Authorization", `Bearer ${ownerTokenA}`)
      .send({ action: AUDIT_ACTIONS.CUSTOMER_CREATED });
    expect(postRes.status).toBe(404);

    const putRes = await request(app)
      .put(`/api/v1/audit-logs/${log1._id}`)
      .set("Authorization", `Bearer ${ownerTokenA}`)
      .send({ description: "Modified" });
    expect(putRes.status).toBe(404);

    const deleteRes = await request(app)
      .delete(`/api/v1/audit-logs/${log1._id}`)
      .set("Authorization", `Bearer ${ownerTokenA}`);
    expect(deleteRes.status).toBe(404);
  });

  // Requirement 11: response follows standard API / pagination contract and populates actorId
  it("populates actorId name and email according to the response contract", async () => {
    const res = await request(app)
      .get("/api/v1/audit-logs?limit=1")
      .set("Authorization", `Bearer ${ownerTokenA}`);

    expect(res.status).toBe(200);
    expect(res.body.data.length).toBe(1);
    const item = res.body.data[0];
    expect(item).toHaveProperty("_id");
    expect(item).toHaveProperty("organizationId");
    expect(item).toHaveProperty("action");
    expect(item).toHaveProperty("entityType");
    expect(item).toHaveProperty("entityId");
    expect(item).toHaveProperty("actorId");
    expect(item.actorId).toHaveProperty("name");
    expect(item.actorId).toHaveProperty("email");
  });
});
