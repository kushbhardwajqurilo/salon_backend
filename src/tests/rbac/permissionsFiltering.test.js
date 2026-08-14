import { jest } from "@jest/globals";
import request from "supertest";
import app from "../../../app.mjs";
import { PermissionRepository } from "../../repositories/permissions/permission.repository.js";

describe("GET /api/v1/rbac/permissions Filtering & Pagination Tests", () => {
  let permissionRepo;

  beforeEach(() => {
    jest.clearAllMocks();
    permissionRepo = new PermissionRepository();
  });

  describe("PermissionRepository.listPermissions", () => {
    it("should filter by search across name, description, module, and action", async () => {
      const mockChain = {
        sort: jest.fn().mockReturnThis(),
        skip: jest.fn().mockReturnThis(),
        limit: jest.fn().mockReturnThis(),
        exec: jest.fn().mockResolvedValue([
          { name: "customers.view", module: "Customers", description: "View customer profiles" },
        ]),
      };

      jest.spyOn(permissionRepo.model, "countDocuments").mockResolvedValue(1);
      jest.spyOn(permissionRepo.model, "find").mockReturnValue(mockChain);

      const result = await permissionRepo.listPermissions({ search: "view" });

      expect(permissionRepo.model.countDocuments).toHaveBeenCalledWith({
        $or: [
          { name: expect.any(RegExp) },
          { description: expect.any(RegExp) },
          { module: expect.any(RegExp) },
          { action: expect.any(RegExp) },
        ],
      });
      expect(result.data.length).toBe(1);
      expect(result.meta.total).toBe(1);
    });

    it("should filter by exact module", async () => {
      const mockChain = {
        sort: jest.fn().mockReturnThis(),
        skip: jest.fn().mockReturnThis(),
        limit: jest.fn().mockReturnThis(),
        exec: jest.fn().mockResolvedValue([
          { name: "appointments.view", module: "Appointments" },
          { name: "appointments.create", module: "Appointments" },
        ]),
      };

      jest.spyOn(permissionRepo.model, "countDocuments").mockResolvedValue(2);
      jest.spyOn(permissionRepo.model, "find").mockReturnValue(mockChain);

      const result = await permissionRepo.listPermissions({ module: "Appointments" });

      expect(permissionRepo.model.countDocuments).toHaveBeenCalledWith({ module: "Appointments" });
      expect(result.meta.total).toBe(2);
      expect(result.data.length).toBe(2);
    });

    it("should combine search and exact module filter", async () => {
      const mockChain = {
        sort: jest.fn().mockReturnThis(),
        skip: jest.fn().mockReturnThis(),
        limit: jest.fn().mockReturnThis(),
        exec: jest.fn().mockResolvedValue([{ name: "appointments.cancel", module: "Appointments" }]),
      };

      jest.spyOn(permissionRepo.model, "countDocuments").mockResolvedValue(1);
      jest.spyOn(permissionRepo.model, "find").mockReturnValue(mockChain);

      const result = await permissionRepo.listPermissions({ module: "Appointments", search: "cancel" });

      expect(permissionRepo.model.countDocuments).toHaveBeenCalledWith({
        module: "Appointments",
        $or: expect.any(Array),
      });
      expect(result.meta.total).toBe(1);
    });

    it("should calculate total BEFORE pagination and compute totalPages correctly", async () => {
      const mockChain = {
        sort: jest.fn().mockReturnThis(),
        skip: jest.fn().mockReturnThis(),
        limit: jest.fn().mockReturnThis(),
        exec: jest.fn().mockResolvedValue(new Array(5).fill({ name: "perm" })),
      };

      // 15 matching items in DB before pagination
      jest.spyOn(permissionRepo.model, "countDocuments").mockResolvedValue(15);
      jest.spyOn(permissionRepo.model, "find").mockReturnValue(mockChain);

      const result = await permissionRepo.listPermissions({ page: 2, limit: 5 });

      expect(mockChain.skip).toHaveBeenCalledWith(5);
      expect(mockChain.limit).toHaveBeenCalledWith(5);
      expect(result.meta).toEqual({
        total: 15,
        page: 2,
        limit: 5,
        totalPages: 3,
      });
    });

    it("should apply deterministic sorting by module and name", async () => {
      const mockChain = {
        sort: jest.fn().mockReturnThis(),
        skip: jest.fn().mockReturnThis(),
        limit: jest.fn().mockReturnThis(),
        exec: jest.fn().mockResolvedValue([]),
      };

      jest.spyOn(permissionRepo.model, "countDocuments").mockResolvedValue(0);
      jest.spyOn(permissionRepo.model, "find").mockReturnValue(mockChain);

      await permissionRepo.listPermissions();

      expect(mockChain.sort).toHaveBeenCalledWith({ module: 1, name: 1 });
    });

    it("should return empty data array [] and totalPages 0 for non-matching unknown module", async () => {
      const mockChain = {
        sort: jest.fn().mockReturnThis(),
        skip: jest.fn().mockReturnThis(),
        limit: jest.fn().mockReturnThis(),
        exec: jest.fn().mockResolvedValue([]),
      };

      jest.spyOn(permissionRepo.model, "countDocuments").mockResolvedValue(0);
      jest.spyOn(permissionRepo.model, "find").mockReturnValue(mockChain);

      const result = await permissionRepo.listPermissions({ module: "UnknownModule" });

      expect(result.data).toEqual([]);
      expect(result.meta).toEqual({
        total: 0,
        page: 1,
        limit: 10,
        totalPages: 0,
      });
    });

    it("should handle invalid page and limit inputs gracefully", async () => {
      const mockChain = {
        sort: jest.fn().mockReturnThis(),
        skip: jest.fn().mockReturnThis(),
        limit: jest.fn().mockReturnThis(),
        exec: jest.fn().mockResolvedValue([]),
      };

      jest.spyOn(permissionRepo.model, "countDocuments").mockResolvedValue(0);
      jest.spyOn(permissionRepo.model, "find").mockReturnValue(mockChain);

      const result = await permissionRepo.listPermissions({ page: -5, limit: 150 });

      expect(result.meta.page).toBe(1);
      expect(result.meta.limit).toBe(100);
    });
  });

  describe("GET /api/v1/rbac/permissions HTTP Endpoint Contract", () => {
    it("should reject unauthenticated request with 401", async () => {
      const res = await request(app).get("/api/v1/rbac/permissions?module=Appointments&page=1&limit=10");
      expect(res.status).toBe(401);
      expect(res.body.success).toBe(false);
    });
  });
});
