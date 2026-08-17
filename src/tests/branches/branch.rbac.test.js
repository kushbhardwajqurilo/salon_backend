import { jest } from "@jest/globals";
import mongoose from "mongoose";
import express from "express";
import request from "supertest";

// Mock middleware & dependencies before importing router
jest.unstable_mockModule("../../middleware/auth.js", () => ({
  authenticate: (req, res, next) => {
    if (!req.user) {
      return res.status(401).json({ success: false, message: "Unauthorized" });
    }
    next();
  },
}));

jest.unstable_mockModule("../../repositories/roles/role.repository.js", () => {
  return {
    RoleRepository: class MockRoleRepository {
      async findOne(query) {
        if (global.__TEST_USER_PERMISSIONS__) {
          return {
            name: query.name,
            permissions: global.__TEST_USER_PERMISSIONS__.map((p) => ({ name: p })),
          };
        }
        return null;
      }
    },
  };
});

jest.unstable_mockModule("../../utils/redis.js", () => ({
  redis: {
    get: jest.fn().mockResolvedValue(null),
    setex: jest.fn().mockResolvedValue("OK"),
    del: jest.fn().mockResolvedValue(1),
  },
}));

jest.unstable_mockModule("../../models/branches/branch.model.js", () => ({
  Branch: {
    find: jest.fn(),
    findOne: jest.fn(),
    create: jest.fn(),
    countDocuments: jest.fn(),
  },
}));

jest.unstable_mockModule("../../models/organizations/organization.model.js", () => ({
  Organization: {
    findOne: jest.fn(),
  },
}));

const { Branch } = await import("../../models/branches/branch.model.js");
const { Organization } = await import("../../models/organizations/organization.model.js");
const branchRouter = (await import("../../routers/branches/branch.routes.js")).default;

const app = express();
app.use(express.json());

const testOrgId = new mongoose.Types.ObjectId().toString();
const testBranchId = new mongoose.Types.ObjectId().toString();

app.use((req, res, next) => {
  req.user = global.__TEST_USER__ || {
    id: "user-123",
    role: "custom_role",
    organizationId: testOrgId,
    hasOrgWideAccess: true,
    branchAccess: [{ branchId: testBranchId, isActive: true }],
  };
  next();
});

app.use("/api/v1/branches", branchRouter);

app.use((err, req, res, next) => {
  const statusCode = err.statusCode || 500;
  res.status(statusCode).json({
    success: false,
    message: err.message,
  });
});

describe("Branch RBAC Granular Permissions Contract Tests", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    global.__TEST_USER_PERMISSIONS__ = [];
    global.__TEST_USER__ = {
      id: "user-123",
      role: "custom_role",
      organizationId: testOrgId,
      hasOrgWideAccess: true,
      branchAccess: [{ branchId: testBranchId, isActive: true }],
    };

    Organization.findOne.mockResolvedValue({
      _id: testOrgId,
      name: "Test Org",
      logo: null,
      isActive: true,
    });

    Branch.find.mockResolvedValue([
      {
        _id: testBranchId,
        name: "Main Branch",
        organizationId: testOrgId,
        address: "123 Main St",
        phone: "+12345",
        isActive: true,
        createdAt: new Date(),
        updatedAt: new Date(),
      },
    ]);

    Branch.findOne.mockImplementation((query) => {
      if (query._id && query._id.$ne) {
        return Promise.resolve(null);
      }
      if (query._id === testBranchId) {
        return Promise.resolve({
          _id: testBranchId,
          name: "Main Branch",
          organizationId: testOrgId,
          address: "123 Main St",
          phone: "+12345",
          isActive: true,
          createdAt: new Date(),
          updatedAt: new Date(),
          save: jest.fn().mockResolvedValue(true),
        });
      }
      return Promise.resolve(null);
    });

    Branch.create.mockResolvedValue({
      _id: testBranchId,
      name: "New Branch",
      organizationId: testOrgId,
      address: "456 St",
      phone: "+67890",
      isActive: true,
      createdAt: new Date(),
      updatedAt: new Date(),
    });

    Branch.countDocuments.mockResolvedValue(2);
  });

  it("1. GET /branches with branches.view → allowed (200)", async () => {
    global.__TEST_USER_PERMISSIONS__ = ["branches.view"];
    const res = await request(app).get("/api/v1/branches");
    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
  });

  it("2. GET /branches without branches.view → denied (403)", async () => {
    global.__TEST_USER_PERMISSIONS__ = ["customers.view"];
    const res = await request(app).get("/api/v1/branches");
    expect(res.status).toBe(403);
    expect(res.body.message).toContain("Access denied");
  });

  it("3. GET /branches/:id with branches.view → allowed (200)", async () => {
    global.__TEST_USER_PERMISSIONS__ = ["branches.view"];
    const res = await request(app).get(`/api/v1/branches/${testBranchId}`);
    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
  });

  it("4. GET /branches/:id without branches.view → denied (403)", async () => {
    global.__TEST_USER_PERMISSIONS__ = ["customers.view"];
    const res = await request(app).get(`/api/v1/branches/${testBranchId}`);
    expect(res.status).toBe(403);
  });

  it("5. POST /branches with branches.create → allowed (201)", async () => {
    global.__TEST_USER_PERMISSIONS__ = ["branches.create"];
    const res = await request(app)
      .post("/api/v1/branches")
      .send({ name: "New Branch" });
    expect(res.status).toBe(201);
    expect(res.body.success).toBe(true);
  });

  it("6. POST /branches without branches.create → denied (403)", async () => {
    global.__TEST_USER_PERMISSIONS__ = ["branches.view"];
    const res = await request(app)
      .post("/api/v1/branches")
      .send({ name: "New Branch" });
    expect(res.status).toBe(403);
  });

  it("7. PATCH /branches/:id with branches.update → allowed (200)", async () => {
    global.__TEST_USER_PERMISSIONS__ = ["branches.update"];
    const res = await request(app)
      .patch(`/api/v1/branches/${testBranchId}`)
      .send({ name: "Updated Name" });
    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
  });

  it("8. PATCH /branches/:id without branches.update → denied (403)", async () => {
    global.__TEST_USER_PERMISSIONS__ = ["branches.view"];
    const res = await request(app)
      .patch(`/api/v1/branches/${testBranchId}`)
      .send({ name: "Updated Name" });
    expect(res.status).toBe(403);
  });

  it("9. DELETE /branches/:id with branches.delete → allowed (200)", async () => {
    global.__TEST_USER_PERMISSIONS__ = ["branches.delete"];
    const res = await request(app).delete(`/api/v1/branches/${testBranchId}`);
    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
  });

  it("10. DELETE /branches/:id without branches.delete → denied (403)", async () => {
    global.__TEST_USER_PERMISSIONS__ = ["branches.view"];
    const res = await request(app).delete(`/api/v1/branches/${testBranchId}`);
    expect(res.status).toBe(403);
  });

  it("11. User with branches.view only: can GET, cannot POST/PATCH/DELETE", async () => {
    global.__TEST_USER_PERMISSIONS__ = ["branches.view"];
    const getRes = await request(app).get("/api/v1/branches");
    expect(getRes.status).toBe(200);

    const postRes = await request(app).post("/api/v1/branches").send({ name: "X" });
    expect(postRes.status).toBe(403);

    const patchRes = await request(app).patch(`/api/v1/branches/${testBranchId}`).send({ name: "Y" });
    expect(patchRes.status).toBe(403);

    const delRes = await request(app).delete(`/api/v1/branches/${testBranchId}`);
    expect(delRes.status).toBe(403);
  });

  it("12. User with branches.create only: can POST, cannot PATCH/DELETE", async () => {
    global.__TEST_USER_PERMISSIONS__ = ["branches.create"];
    const postRes = await request(app).post("/api/v1/branches").send({ name: "Created" });
    expect(postRes.status).toBe(201);

    const patchRes = await request(app).patch(`/api/v1/branches/${testBranchId}`).send({ name: "Y" });
    expect(patchRes.status).toBe(403);

    const delRes = await request(app).delete(`/api/v1/branches/${testBranchId}`);
    expect(delRes.status).toBe(403);
  });

  it("13. User with branches.update only: can PATCH, cannot POST/DELETE", async () => {
    global.__TEST_USER_PERMISSIONS__ = ["branches.update"];
    const patchRes = await request(app).patch(`/api/v1/branches/${testBranchId}`).send({ name: "Updated" });
    expect(patchRes.status).toBe(200);

    const postRes = await request(app).post("/api/v1/branches").send({ name: "X" });
    expect(postRes.status).toBe(403);

    const delRes = await request(app).delete(`/api/v1/branches/${testBranchId}`);
    expect(delRes.status).toBe(403);
  });

  it("14. User with branches.delete only: can DELETE, cannot POST/PATCH", async () => {
    global.__TEST_USER_PERMISSIONS__ = ["branches.delete"];
    const delRes = await request(app).delete(`/api/v1/branches/${testBranchId}`);
    expect(delRes.status).toBe(200);

    const postRes = await request(app).post("/api/v1/branches").send({ name: "X" });
    expect(postRes.status).toBe(403);

    const patchRes = await request(app).patch(`/api/v1/branches/${testBranchId}`).send({ name: "Y" });
    expect(patchRes.status).toBe(403);
  });

  it("15. User possessing granular permissions without branches.manage can perform branch CRUD", async () => {
    global.__TEST_USER_PERMISSIONS__ = ["branches.view", "branches.create", "branches.update", "branches.delete"];

    expect((await request(app).get("/api/v1/branches")).status).toBe(200);
    expect((await request(app).post("/api/v1/branches").send({ name: "Valid" })).status).toBe(201);
    expect((await request(app).patch(`/api/v1/branches/${testBranchId}`).send({ name: "Valid" })).status).toBe(200);
    expect((await request(app).delete(`/api/v1/branches/${testBranchId}`)).status).toBe(200);
  });

  it("16. Organization isolation is enforced on Branch lookup", async () => {
    global.__TEST_USER_PERMISSIONS__ = ["branches.view"];
    Branch.findOne.mockImplementationOnce(() => Promise.resolve(null));
    const res = await request(app).get(`/api/v1/branches/${new mongoose.Types.ObjectId().toString()}`);
    expect(res.status).toBe(404);
    expect(res.body.message).toContain("Branch not found");
  });

  it("17. Branch Management operates without X-Branch-Id header", async () => {
    global.__TEST_USER_PERMISSIONS__ = ["branches.view"];
    const res = await request(app).get("/api/v1/branches");
    expect(res.status).toBe(200);
  });

  it("18. Passing X-Branch-Id: all does not break Branch Management", async () => {
    global.__TEST_USER_PERMISSIONS__ = ["branches.view"];
    const res = await request(app)
      .get("/api/v1/branches")
      .set("X-Branch-Id", "all");
    expect(res.status).toBe(200);
  });
});
