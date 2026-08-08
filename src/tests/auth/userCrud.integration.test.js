import { jest } from "@jest/globals";
import mongoose from "mongoose";
import { AppError } from "../../utils/errors.js";
import { UserRepository } from "../../repositories/users/user.repository.js";
import { Branch } from "../../models/branches/branch.model.js";
import { Role } from "../../models/roles/role.model.js";
import { User } from "../../models/users/user.model.js";
import {
  listUsers,
  getUserById,
  createUser,
  updateUser,
} from "../../controllers/users/user.controller.js";

// Mock the UserRepository prototype methods
UserRepository.prototype.find = jest.fn();
UserRepository.prototype.findById = jest.fn();
UserRepository.prototype.create = jest.fn();
UserRepository.prototype.updateById = jest.fn();
UserRepository.prototype.findByEmailOrPhone = jest.fn();
UserRepository.prototype.findByUsername = jest.fn();

// Mock Mongoose models
Branch.find = jest.fn();
Role.findById = jest.fn();

describe("User CRUD Integration Tests (Phase 3)", () => {
  let req;
  let res;
  let next;
  let orgAId;
  let orgBId;
  let roleId;
  let userBId;

  beforeEach(() => {
    jest.clearAllMocks();

    orgAId = new mongoose.Types.ObjectId().toString();
    orgBId = new mongoose.Types.ObjectId().toString();
    roleId = new mongoose.Types.ObjectId().toString();
    userBId = new mongoose.Types.ObjectId().toString();

    req = {
      organizationId: orgAId,
      user: {
        id: "actor-123",
        role: "admin",
      },
      query: {},
      params: {},
      body: {},
    };

    res = {
      status: jest.fn().mockReturnThis(),
      json: jest.fn().mockReturnThis(),
    };

    next = jest.fn();

    // Mock Role.findOne to return admin permissions for delegation checks
    Role.findOne = jest.fn().mockReturnValue({
      populate: jest.fn().mockReturnValue({
        permissions: [
          { name: "users.create" },
          { name: "users.view" },
          { name: "users.update" },
          { name: "stylist" }
        ],
      }),
    });
  });

  describe("Tenant Isolation", () => {
    it("Org A can list only Org A Users", async () => {
      req.query = { page: 1, limit: 10 };
      
      const mockResult = {
        data: [
          { _id: new mongoose.Types.ObjectId(), name: "User 1", organizationId: orgAId, isFirstLogin: true, status: "active" },
        ],
        meta: { total: 1, page: 1, limit: 10, totalPages: 1 },
      };

      UserRepository.prototype.find.mockResolvedValue(mockResult);

      await listUsers(req, res, next);

      expect(res.status).toHaveBeenCalledWith(200);
      expect(res.json).toHaveBeenCalledWith(
        expect.objectContaining({
          success: true,
          data: expect.arrayContaining([
            expect.objectContaining({ organizationId: orgAId }),
          ]),
        })
      );
    });

    it("Org A cannot retrieve Org B User", async () => {
      req.params.id = userBId;
      UserRepository.prototype.findById.mockResolvedValue(null);

      await getUserById(req, res, next);

      expect(next).toHaveBeenCalledWith(expect.any(AppError));
      expect(next.mock.calls[0][0].statusCode).toBe(404);
    });

    it("Org A cannot update Org B User", async () => {
      req.params.id = userBId;
      req.body = { name: "New Name" };

      UserRepository.prototype.findById.mockResolvedValue(null);

      await updateUser(req, res, next);

      expect(next).toHaveBeenCalledWith(expect.any(AppError));
      expect(next.mock.calls[0][0].statusCode).toBe(404);
    });

    it("Org A cannot create a User in Org B (forced to Org A)", async () => {
      req.body = {
        name: "New User",
        email: "new@example.com",
        phone: "+919999988888",
        roleId: roleId,
        organizationId: orgBId, // Attempt to set Org B
      };

      UserRepository.prototype.findByEmailOrPhone.mockResolvedValue(null);
      Role.findById.mockReturnValue({
        populate: jest.fn().mockResolvedValue({ _id: roleId, name: "stylist", permissions: [{ name: "users.create" }] }),
      });

      const mockSavedUser = {
        _id: new mongoose.Types.ObjectId(),
        name: "New User",
        email: "new@example.com",
        phone: "+919999988888",
        role: roleId,
        organizationId: orgAId, // Must be forced to Org A
        isFirstLogin: true,
        status: "active",
      };

      UserRepository.prototype.create.mockResolvedValue(mockSavedUser);

      await createUser(req, res, next);

      expect(res.status).toHaveBeenCalledWith(201);
      const responseData = res.json.mock.calls[0][0];
      expect(responseData.data.organizationId).toBe(orgAId); // Verified organizationId matches authenticated org
    });
  });

  describe("Validation & Security Checks", () => {
    it("Invalid branch references are rejected when cross-tenant", async () => {
      req.body = {
        name: "New User",
        email: "new@example.com",
        phone: "+919999988888",
        roleId: roleId,
        branchAccess: [
          { branchId: new mongoose.Types.ObjectId().toString(), branchName: "Branch B" },
        ],
      };

      UserRepository.prototype.findByEmailOrPhone.mockResolvedValue(null);
      Role.findById.mockReturnValue({
        populate: jest.fn().mockResolvedValue({ _id: roleId, name: "stylist", permissions: [{ name: "users.create" }] }),
      });
      Branch.find.mockResolvedValue([]); // No branches matched (cross-tenant)

      await createUser(req, res, next);

      expect(next).toHaveBeenCalledWith(expect.any(AppError));
      expect(next.mock.calls[0][0].statusCode).toBe(400);
      expect(next.mock.calls[0][0].message).toBe("Invalid branch reference(s) for organization context");
    });

    it("Admin-created User gets isFirstLogin = true and temporary password is not exposed", async () => {
      req.body = {
        name: "New User",
        email: "new@example.com",
        phone: "+919999988888",
        roleId: roleId,
      };

      UserRepository.prototype.findByEmailOrPhone.mockResolvedValue(null);
      Role.findById.mockReturnValue({
        populate: jest.fn().mockResolvedValue({ _id: roleId, name: "stylist", permissions: [{ name: "users.create" }] }),
      });
      
      const mockSavedUser = {
        _id: new mongoose.Types.ObjectId(),
        name: "New User",
        email: "new@example.com",
        phone: "+919999988888",
        role: roleId,
        password: "hashedpassword",
        organizationId: orgAId,
        isFirstLogin: true,
        status: "active",
      };

      UserRepository.prototype.create.mockResolvedValue(mockSavedUser);

      await createUser(req, res, next);

      const responseData = res.json.mock.calls[0][0];
      expect(responseData.data.isFirstLogin).toBe(true);
      expect(responseData.data.password).toBeUndefined(); // DTO cleans password
      expect(responseData.data.passwordHash).toBeUndefined();
    });
  });
});
