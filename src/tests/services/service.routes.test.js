import { describe, expect, it, jest } from "@jest/globals";
import express from "express";
import request from "supertest";

// Mock auth & scoping middleware for isolated pipeline test
jest.unstable_mockModule("../../middleware/auth.js", () => ({
  authenticate: (req, res, next) => {
    req.user = { id: "test-user-id" };
    next();
  },
}));

jest.unstable_mockModule("../../middleware/branchScope.js", () => ({
  requireBranchScope: (req, res, next) => next(),
  requireOrganizationScope: (req, res, next) => {
    req.organizationId = "60c72b2f9b1d8b2bad123456";
    next();
  },
}));

jest.unstable_mockModule("../../middleware/rbac.js", () => ({
  authorize: () => (req, res, next) => next(),
}));

const serviceRouter = (await import("../../routers/services/service.routes.js")).default;
const { ServiceService } = await import("../../services/services/service.service.js");
const { globalErrorHandler } = await import("../../utils/errors.js");

describe("Service Router & Pipeline Integration Tests", () => {
  const app = express();
  app.use(express.json());
  app.use("/api/v1/services", serviceRouter);
  app.use(globalErrorHandler);

  it("should export service router instance", () => {
    expect(serviceRouter).toBeDefined();
  });

  it("pipeline: rejects invalid customerGender through validation middleware", async () => {
    const res = await request(app)
      .get("/api/v1/services")
      .query({ customerGender: "invalid_value" });

    expect(res.status).toBe(400);
    expect(res.body.status).toBe("fail");
  });

  it("pipeline: rejects when both gender and customerGender are supplied together", async () => {
    const res = await request(app)
      .get("/api/v1/services")
      .query({ customerGender: "male", gender: "male" });

    expect(res.status).toBe(400);
    expect(res.body.status).toBe("fail");
    expect(JSON.stringify(res.body)).toContain("Cannot specify both 'gender' and 'customerGender' query parameters");
  });

  it("pipeline: passes customerGender=male to controller and service layer as ['male', 'unisex']", async () => {
    const listSpy = jest.spyOn(ServiceService.prototype, "listServices").mockResolvedValue({
      data: [{ _id: "s1", name: "Men Haircut", gender: "male" }],
      meta: { total: 1, page: 1, limit: 10 },
    });

    const res = await request(app)
      .get("/api/v1/services")
      .query({ customerGender: "male" });

    expect(res.status).toBe(200);
    expect(res.body.status).toBe("success");
    expect(listSpy).toHaveBeenCalledWith(
      {
        isDeleted: false,
        $and: [{ gender: { $in: ["male", "unisex"] } }],
      },
      expect.anything(),
      "60c72b2f9b1d8b2bad123456"
    );
    listSpy.mockRestore();
  });

  it("pipeline: passes customerGender=other without gender restriction", async () => {
    const listSpy = jest.spyOn(ServiceService.prototype, "listServices").mockResolvedValue({
      data: [],
      meta: { total: 0, page: 1, limit: 10 },
    });

    const res = await request(app)
      .get("/api/v1/services")
      .query({ customerGender: "other" });

    expect(res.status).toBe(200);
    expect(listSpy).toHaveBeenCalledWith(
      { isDeleted: false },
      expect.anything(),
      "60c72b2f9b1d8b2bad123456"
    );
    listSpy.mockRestore();
  });

  it("pipeline: preserves exact gender filter when customerGender is omitted", async () => {
    const listSpy = jest.spyOn(ServiceService.prototype, "listServices").mockResolvedValue({
      data: [],
      meta: { total: 0, page: 1, limit: 10 },
    });

    const res = await request(app)
      .get("/api/v1/services")
      .query({ gender: "female" });

    expect(res.status).toBe(200);
    expect(listSpy).toHaveBeenCalledWith(
      {
        isDeleted: false,
        $and: [{ gender: "female" }],
      },
      expect.anything(),
      "60c72b2f9b1d8b2bad123456"
    );
    listSpy.mockRestore();
  });
});
