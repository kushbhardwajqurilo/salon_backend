import { jest } from "@jest/globals";
import mongoose from "mongoose";
import { AppError } from "../../utils/errors.js";
import { Role } from "../../models/roles/role.model.js";
import { User } from "../../models/users/user.model.js";
import { Staff } from "../../models/staff/staff.model.js";
import { UserRepository } from "../../repositories/users/user.repository.js";
import { createUser, updateUser } from "../../controllers/users/user.controller.js";

// Mock the UserRepository
UserRepository.prototype.create = jest.fn();
UserRepository.prototype.findById = jest.fn();
UserRepository.prototype.updateById = jest.fn();
UserRepository.prototype.findByEmailOrPhone = jest.fn();
UserRepository.prototype.findByUsername = jest.fn();
Staff.findOne = jest.fn();

describe("User Management RBAC & Delegation Protection (Phase 5)", () => {
  let req;
  let res;
  let next;
  let orgAId;
  let roleId;
  let adminRoleId;

  beforeEach(() => {
    jest.clearAllMocks();

    orgAId = new mongoose.Types.ObjectId().toString();
    roleId = new mongoose.Types.ObjectId().toString();
    adminRoleId = new mongoose.Types.ObjectId().toString();

    req = {
      organizationId: orgAId,
      user: {
        id: new mongoose.Types.ObjectId().toString(),
        role: "admin",
      },
      params: {},
      body: {},
    };

    res = {
      status: jest.fn().mockReturnThis(),
      json: jest.fn().mockReturnThis(),
    };

    next = jest.fn();

    // Mock global models
    Role.findById = jest.fn();
    Role.findOne = jest.fn();
    Staff.findOne.mockResolvedValue(null);
  });

  describe("Role Delegation Checks", () => {
    it("should allow admin to assign a Role whose permissions are a subset of their own", async () => {
      req.body = {
        name: "New User",
        email: "subset@example.com",
        phone: "+919999988888",
        roleId,
      };

      UserRepository.prototype.findByEmailOrPhone.mockResolvedValue(null);

      // Target Role has reports.view
      Role.findById.mockReturnValue({
        populate: jest.fn().mockReturnValue({
          permissions: [{ name: "reports.view" }],
        }),
      });

      // Admin has reports.view and users.create
      Role.findOne.mockReturnValue({
        populate: jest.fn().mockReturnValue({
          permissions: [{ name: "reports.view" }, { name: "users.create" }],
        }),
      });

      const mockSavedUser = {
        _id: new mongoose.Types.ObjectId(),
        name: "New User",
        email: "subset@example.com",
        phone: "+919999988888",
        role: roleId,
        organizationId: orgAId,
      };
      UserRepository.prototype.create.mockResolvedValue(mockSavedUser);

      await createUser(req, res, next);

      expect(res.status).toHaveBeenCalledWith(201);
    });

    it("should reject assignment if target Role contains any permission admin does not possess", async () => {
      req.body = {
        name: "New User",
        email: "superset@example.com",
        phone: "+919999988888",
        roleId,
      };

      UserRepository.prototype.findByEmailOrPhone.mockResolvedValue(null);

      // Target Role has reports.view and dashboard.view
      Role.findById.mockReturnValue({
        populate: jest.fn().mockReturnValue({
          permissions: [{ name: "reports.view" }, { name: "dashboard.view" }],
        }),
      });

      // Admin only has reports.view
      Role.findOne.mockReturnValue({
        populate: jest.fn().mockReturnValue({
          permissions: [{ name: "reports.view" }],
        }),
      });

      await createUser(req, res, next);

      expect(next).toHaveBeenCalledWith(expect.any(AppError));
      expect(next.mock.calls[0][0].statusCode).toBe(403);
      expect(next.mock.calls[0][0].message).toBe("Access denied. You cannot assign a role with permissions you do not possess.");
    });
  });

  describe("hasOrgWideAccess Modification Protection", () => {
    it("should allow modifying another User's hasOrgWideAccess", async () => {
      req.user.hasOrgWideAccess = true;
      const targetUserId = new mongoose.Types.ObjectId().toString();
      req.params.id = targetUserId;
      req.body = { hasOrgWideAccess: true };

      UserRepository.prototype.findById.mockResolvedValue({
        _id: targetUserId,
        organizationId: orgAId,
      });

      const mockUpdatedUser = {
        _id: targetUserId,
        hasOrgWideAccess: true,
      };
      UserRepository.prototype.updateById.mockResolvedValue(mockUpdatedUser);

      await updateUser(req, res, next);

      expect(res.status).toHaveBeenCalledWith(200);
    });

    it("should reject modifying admin's own hasOrgWideAccess", async () => {
      req.user.hasOrgWideAccess = true;
      const adminId = req.user.id;
      req.params.id = adminId; // Target is the requesting admin themselves
      req.body = { hasOrgWideAccess: true };

      UserRepository.prototype.findById.mockResolvedValue({
        _id: adminId,
        organizationId: orgAId,
      });

      await updateUser(req, res, next);

      expect(next).toHaveBeenCalledWith(expect.any(AppError));
      expect(next.mock.calls[0][0].statusCode).toBe(403);
      expect(next.mock.calls[0][0].message).toBe("Self-modification of hasOrgWideAccess is prohibited.");
    });
  });
});
