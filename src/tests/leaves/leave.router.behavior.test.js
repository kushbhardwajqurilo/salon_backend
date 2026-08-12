import express from "express";
import request from "supertest";
import { beforeEach, describe, expect, it, jest } from "@jest/globals";
import { ZodError } from "zod";
import { AppError } from "../../utils/errors.js";

const authCalls = [];
const branchCalls = [];
const authorizeCalls = [];
const leaveScopeCalls = [];
const controllerCalls = [];

const authenticate = jest.fn((req, res, next) => {
  authCalls.push({ method: req.method, path: req.path });
  if (!req.headers.authorization) {
    return next(new AppError("Access denied. No token provided.", 401));
  }
  req.user = {
    id: "user-123",
    role: req.headers["x-role"] || "manager",
    organizationId: "org-123",
  };
  next();
});

const requireBranchScope = jest.fn((req, res, next) => {
  branchCalls.push({ method: req.method, path: req.path });
  if (!req.headers["x-branch-id"] && req.headers["x-org-wide"] !== "true") {
    return next(new AppError("X-Branch-Id header is required for this request.", 400));
  }
  req.organizationId = req.user.organizationId;
  req.branchId = req.headers["x-org-wide"] === "true" ? undefined : req.headers["x-branch-id"];
  next();
});

const authorize = jest.fn((permission) => (req, res, next) => {
  authorizeCalls.push(permission);
  if (req.headers["x-deny-permission"] === permission) {
    return next(new AppError("Access denied. You do not have the required permissions.", 403));
  }
  next();
});

const requireOnBehalfManage = jest.fn((req, res, next) => {
  leaveScopeCalls.push({ body: req.body, organizationId: req.organizationId });
  if (req.headers["x-on-behalf-denied"] === "true") {
    return next(new AppError("Access denied. You do not have the required permissions.", 403));
  }
  next();
});

const createLeave = jest.fn((req, res) => {
  controllerCalls.push({
    action: "create",
    branchId: req.branchId,
    organizationId: req.organizationId,
    body: req.body,
    query: req.query,
  });
  res.status(201).json({
    success: true,
    status: "success",
    message: "ok",
    data: { branchId: req.branchId ?? null, body: req.body, query: req.query },
    meta: null,
  });
});

const listLeaves = jest.fn((req, res) => {
  controllerCalls.push({
    action: "list",
    branchId: req.branchId,
    organizationId: req.organizationId,
    query: req.query,
  });
  res.status(200).json({
    success: true,
    status: "success",
    message: "ok",
    data: [{ branchId: req.branchId ?? null }],
    meta: { total: 1, page: 1, limit: 10, totalPages: 1 },
  });
});

const getLeaveById = jest.fn((req, res) => {
  controllerCalls.push({
    action: "get",
    branchId: req.branchId,
    organizationId: req.organizationId,
    params: req.params,
  });
  res.status(200).json({
    success: true,
    status: "success",
    message: "ok",
    data: { id: req.params.id, branchId: req.branchId ?? null },
    meta: null,
  });
});

const updateLeave = jest.fn((req, res) => {
  controllerCalls.push({ action: "update" });
  res.status(200).json({ success: true, status: "success", message: "ok", data: {}, meta: null });
});

const approveLeave = jest.fn((req, res) => {
  controllerCalls.push({ action: "approve" });
  res.status(200).json({ success: true, status: "success", message: "ok", data: {}, meta: null });
});

const rejectLeave = jest.fn((req, res) => {
  controllerCalls.push({ action: "reject" });
  res.status(200).json({ success: true, status: "success", message: "ok", data: {}, meta: null });
});

const cancelLeave = jest.fn((req, res) => {
  controllerCalls.push({ action: "cancel" });
  res.status(200).json({ success: true, status: "success", message: "ok", data: {}, meta: null });
});

jest.unstable_mockModule("../../middleware/auth.js", () => ({ authenticate }));
jest.unstable_mockModule("../../middleware/branchScope.js", () => ({ requireBranchScope }));
jest.unstable_mockModule("../../middleware/rbac.js", () => ({ authorize }));
jest.unstable_mockModule("../../middleware/leaveScope.js", () => ({ requireOnBehalfManage }));
jest.unstable_mockModule("../../controllers/leaves/leave.controller.js", () => ({
  createLeave,
  listLeaves,
  getLeaveById,
  updateLeave,
  approveLeave,
  rejectLeave,
  cancelLeave,
}));

const router = (await import("../../routers/leaves/leave.router.js")).default;

const app = express();
app.use(express.json());
app.use("/api/v1/leaves", router);
app.use((err, req, res, next) => {
  const statusCode =
    err?.statusCode ||
    (err instanceof ZodError || err?.name === "ZodError" || err?.issues ? 400 : 500);
  res.status(statusCode).json({
    success: false,
    status: statusCode >= 500 ? "error" : "fail",
    message: err?.message || "Unexpected error",
  });
});

describe("Leave router behavior", () => {
  beforeEach(() => {
    authCalls.length = 0;
    branchCalls.length = 0;
    authorizeCalls.length = 0;
    leaveScopeCalls.length = 0;
    controllerCalls.length = 0;
    jest.clearAllMocks();
  });

  it("requires authentication", async () => {
    const response = await request(app).get("/api/v1/leaves").set("x-branch-id", "64b000000000000000000001");

    expect(response.status).toBe(401);
    expect(response.body.message).toBe("Access denied. No token provided.");
  });

  it("requires branch scope when org-wide access is not established", async () => {
    const response = await request(app)
      .get("/api/v1/leaves")
      .set("authorization", "Bearer test-token");

    expect(response.status).toBe(400);
    expect(response.body.message).toBe("X-Branch-Id header is required for this request.");
  });

  it("requires view permission for list and create", async () => {
    const listResponse = await request(app)
      .get("/api/v1/leaves")
      .set("authorization", "Bearer test-token")
      .set("x-branch-id", "64b000000000000000000001")
      .set("x-deny-permission", "employees.leaves.view");

    expect(listResponse.status).toBe(403);

    const createResponse = await request(app)
      .post("/api/v1/leaves")
      .set("authorization", "Bearer test-token")
      .set("x-branch-id", "64b000000000000000000001")
      .set("x-deny-permission", "employees.leaves.view")
      .send({
        leaveType: "Casual",
        startDate: "2026-09-01",
        endDate: "2026-09-01",
        reason: "Test",
      });

    expect(createResponse.status).toBe(403);
  });

  it("uses view permission for update/cancel and manage permission for approve/reject", async () => {
    const updateResponse = await request(app)
      .put("/api/v1/leaves/64b000000000000000000001")
      .set("authorization", "Bearer test-token")
      .set("x-branch-id", "64b000000000000000000001")
      .set("x-deny-permission", "employees.leaves.view")
      .send({ reason: "Updated reason" });

    expect(updateResponse.status).toBe(403);

    const cancelResponse = await request(app)
      .post("/api/v1/leaves/64b000000000000000000001/cancel")
      .set("authorization", "Bearer test-token")
      .set("x-branch-id", "64b000000000000000000001")
      .set("x-deny-permission", "employees.leaves.view")
      .send({ cancelReason: "Cancelled" });

    expect(cancelResponse.status).toBe(403);

    for (const [method, path, body] of [
      ["post", "/api/v1/leaves/64b000000000000000000001/approve", { reviewNote: "Approved" }],
      ["post", "/api/v1/leaves/64b000000000000000000001/reject", { reviewNote: "Rejected" }],
    ]) {
      const response = await request(app)
        [method](path)
        .set("authorization", "Bearer test-token")
        .set("x-branch-id", "64b000000000000000000001")
        .set("x-deny-permission", "employees.leaves.manage")
        .send(body);

      expect(response.status).toBe(403);
    }
  });

  it("rejects branchId supplied through query from bypassing scope", async () => {
    const response = await request(app)
      .get("/api/v1/leaves?branchId=64b000000000000000000099")
      .set("authorization", "Bearer test-token")
      .set("x-branch-id", "64b000000000000000000001");

    expect(response.status).toBe(400);
    expect(controllerCalls).toHaveLength(0);
  });

  it("rejects branchId supplied through body from bypassing scope", async () => {
    const response = await request(app)
      .post("/api/v1/leaves")
      .set("authorization", "Bearer test-token")
      .set("x-branch-id", "64b000000000000000000001")
      .send({
        branchId: "64b000000000000000000099",
        leaveType: "Casual",
        startDate: "2026-09-01",
        endDate: "2026-09-01",
        reason: "Test",
      });

    expect(response.status).toBe(400);
    expect(controllerCalls).toHaveLength(0);
  });

  it("rejects malformed :id according to validation conventions", async () => {
    const response = await request(app)
      .get("/api/v1/leaves/not-an-objectid")
      .set("authorization", "Bearer test-token")
      .set("x-branch-id", "64b000000000000000000001");

    expect(response.status).toBe(400);
    expect(controllerCalls).toHaveLength(0);
  });

  it("preserves org-wide behavior from requireBranchScope", async () => {
    const response = await request(app)
      .get("/api/v1/leaves")
      .set("authorization", "Bearer test-token")
      .set("x-org-wide", "true");

    expect(response.status).toBe(200);
    expect(controllerCalls[0].branchId).toBeUndefined();
    expect(response.body.data[0].branchId).toBeNull();
  });

  it("does not duplicate RBAC logic in routes and leaves on-behalf checks to requireOnBehalfManage", async () => {
    const response = await request(app)
      .post("/api/v1/leaves")
      .set("authorization", "Bearer test-token")
      .set("x-branch-id", "64b000000000000000000001")
      .set("x-on-behalf-denied", "true")
      .send({
        staffId: "64b000000000000000000777",
        leaveType: "Casual",
        startDate: "2026-09-01",
        endDate: "2026-09-01",
        reason: "Test",
      });

    expect(response.status).toBe(403);
    expect(requireOnBehalfManage).toHaveBeenCalled();
  });
});
