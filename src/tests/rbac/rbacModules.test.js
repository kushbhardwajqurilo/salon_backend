import { jest } from "@jest/globals";
import request from "supertest";
import app from "../../../app.mjs";
import { PermissionRepository } from "../../repositories/permissions/permission.repository.js";
import { PermissionService } from "../../services/permissions/permission.service.js";
import { redis } from "../../utils/redis.js";

describe("GET /api/v1/rbac/modules Unit & Contract Tests", () => {
  let permissionRepo;
  let permissionService;

  beforeEach(() => {
    jest.clearAllMocks();
    permissionRepo = new PermissionRepository();
    permissionService = new PermissionService();
  });

  describe("PermissionRepository.getDistinctModules", () => {
    it("should return distinct, non-empty, trimmed, alphabetically sorted modules", async () => {
      const raw = ["Services", "  Appointments ", null, "", undefined, "Appointments", "Billing & POS", "  Services "];
      jest.spyOn(permissionRepo.model, "distinct").mockResolvedValue(raw);

      const modules = await permissionRepo.getDistinctModules();
      expect(modules).toEqual(["Appointments", "Billing & POS", "Services"]);
    });

    it("should return empty array if no permission modules exist", async () => {
      jest.spyOn(permissionRepo.model, "distinct").mockResolvedValue([]);

      const modules = await permissionRepo.getDistinctModules();
      expect(modules).toEqual([]);
    });

    it("should return empty array if distinct returns non-array result", async () => {
      jest.spyOn(permissionRepo.model, "distinct").mockResolvedValue(null);

      const modules = await permissionRepo.getDistinctModules();
      expect(modules).toEqual([]);
    });
  });

  describe("PermissionService.listModules", () => {
    it("should return modules from Redis cache on cache hit", async () => {
      jest.spyOn(redis, "get").mockResolvedValue(JSON.stringify(["Appointments", "Customers"]));
      const spyRepo = jest.spyOn(permissionService.permissionRepo, "getDistinctModules");

      const result = await permissionService.listModules();
      expect(result).toEqual(["Appointments", "Customers"]);
      expect(spyRepo).not.toHaveBeenCalled();
    });

    it("should query repository and populate Redis cache on cache miss", async () => {
      jest.spyOn(redis, "get").mockResolvedValue(null);
      jest.spyOn(redis, "setex").mockResolvedValue("OK");
      jest.spyOn(permissionService.permissionRepo, "getDistinctModules").mockResolvedValue(["Appointments", "Customers"]);

      const result = await permissionService.listModules();
      expect(result).toEqual(["Appointments", "Customers"]);
      expect(redis.setex).toHaveBeenCalledWith("rbac:modules", 86400, JSON.stringify(["Appointments", "Customers"]));
    });

    it("should gracefully fallback to repository if Redis throws an error", async () => {
      jest.spyOn(redis, "get").mockRejectedValue(new Error("Redis connection error"));
      jest.spyOn(permissionService.permissionRepo, "getDistinctModules").mockResolvedValue(["Appointments"]);

      const result = await permissionService.listModules();
      expect(result).toEqual(["Appointments"]);
    });
  });

  describe("GET /api/v1/rbac/modules HTTP Endpoint Contract", () => {
    it("should reject unauthenticated request with 401", async () => {
      const res = await request(app).get("/api/v1/rbac/modules");
      expect(res.status).toBe(401);
      expect(res.body.success).toBe(false);
    });
  });
});
