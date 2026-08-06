import { jest } from "@jest/globals";
import mongoose from "mongoose";
import { AppError } from "../../utils/errors.js";
import { UserRepository } from "../../repositories/users/user.repository.js";
import { SessionRepository } from "../../repositories/auth/session.repository.js";
import { UserService } from "../../services/users/user.service.js";
import { updateUserStatus } from "../../controllers/users/user.controller.js";

// Mock the repositories
UserRepository.prototype.findById = jest.fn();
SessionRepository.prototype.invalidateAllUserSessions = jest.fn();

describe("User Lifecycle Management & Session Invalidation (Phase 4)", () => {
  let req;
  let res;
  let next;
  let orgAId;
  let orgBId;
  let userId;
  let userService;

  beforeEach(() => {
    jest.clearAllMocks();

    orgAId = new mongoose.Types.ObjectId().toString();
    orgBId = new mongoose.Types.ObjectId().toString();
    userId = new mongoose.Types.ObjectId().toString();

    userService = new UserService();

    // Mock runTransaction to execute callback directly without database transactions
    userService.runTransaction = jest.fn().mockImplementation((op) => op(null));

    req = {
      organizationId: orgAId,
      user: {
        id: "actor-123",
        role: "admin",
      },
      params: { id: userId },
      body: {},
    };

    res = {
      status: jest.fn().mockReturnThis(),
      json: jest.fn().mockReturnThis(),
    };

    next = jest.fn();
  });

  describe("Tenant Isolation on status change", () => {
    it("should prevent Org A from modifying Org B User status", async () => {
      UserRepository.prototype.findById.mockResolvedValue(null); // User not found under Org A

      await expect(
        userService.updateUserStatus(userId, "suspended", orgAId, "actor-123")
      ).rejects.toThrow(new AppError("User not found", 404));
    });
  });

  describe("Session Invalidation & Lifecycle transitions", () => {
    it("should invalidate all sessions on transition to suspended", async () => {
      const mockUser = {
        _id: userId,
        status: "active",
        save: jest.fn().mockResolvedValue(true),
      };
      UserRepository.prototype.findById.mockResolvedValue(mockUser);

      // Mock updateMany on Session collection
      const mockUpdateMany = jest.fn().mockReturnValue({
        session: jest.fn().mockReturnThis(),
        exec: jest.fn().mockResolvedValue({ modifiedCount: 1 }),
      });
      userService.sessionRepo.model = {
        updateMany: mockUpdateMany,
      };

      const result = await userService.updateUserStatus(userId, "suspended", orgAId, "actor-123");

      expect(result.status).toBe("suspended");
      expect(mockUser.save).toHaveBeenCalled();
      expect(mockUpdateMany).toHaveBeenCalledWith(
        { user: userId, isValid: true },
        { $set: { isValid: false } }
      );
    });

    it("should invalidate all sessions on transition to inactive", async () => {
      const mockUser = {
        _id: userId,
        status: "active",
        save: jest.fn().mockResolvedValue(true),
      };
      UserRepository.prototype.findById.mockResolvedValue(mockUser);

      const mockUpdateMany = jest.fn().mockReturnValue({
        session: jest.fn().mockReturnThis(),
        exec: jest.fn().mockResolvedValue({ modifiedCount: 1 }),
      });
      userService.sessionRepo.model = {
        updateMany: mockUpdateMany,
      };

      const result = await userService.updateUserStatus(userId, "inactive", orgAId, "actor-123");

      expect(result.status).toBe("inactive");
      expect(mockUpdateMany).toHaveBeenCalledWith(
        { user: userId, isValid: true },
        { $set: { isValid: false } }
      );
    });
  });

  describe("Administrative Unlock", () => {
    it("locked -> active resets login attempts and lock times", async () => {
      const mockUser = {
        _id: userId,
        status: "locked",
        failedLoginAttempts: 5,
        lockUntil: new Date(Date.now() + 3600000),
        save: jest.fn().mockResolvedValue(true),
      };
      UserRepository.prototype.findById.mockResolvedValue(mockUser);

      // Session invalidation doesn't trigger when transitioning to active,
      // but updateMany mock is needed since Mongoose model is accessed
      userService.sessionRepo.model = {
        updateMany: jest.fn().mockReturnValue({
          session: jest.fn().mockReturnThis(),
          exec: jest.fn().mockResolvedValue({}),
        }),
      };

      const result = await userService.updateUserStatus(userId, "active", orgAId, "actor-123");

      expect(result.status).toBe("active");
      expect(result.failedLoginAttempts).toBe(0);
      expect(result.lockUntil).toBeNull();
      expect(mockUser.save).toHaveBeenCalled();
    });
  });
});
