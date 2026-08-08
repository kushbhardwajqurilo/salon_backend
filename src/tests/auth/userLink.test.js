import { jest } from "@jest/globals";
import mongoose from "mongoose";
import { AppError } from "../../utils/errors.js";
import { StaffService } from "../../services/staff/staff.service.js";

describe("Staff-User Linking & Transactions (Phase 6)", () => {
  let staffService;
  let orgAId;
  let orgBId;
  let staffId;
  let userId;
  let mockSession;

  beforeEach(() => {
    jest.clearAllMocks();

    orgAId = new mongoose.Types.ObjectId().toString();
    orgBId = new mongoose.Types.ObjectId().toString();
    staffId = new mongoose.Types.ObjectId().toString();
    userId = new mongoose.Types.ObjectId().toString();

    staffService = new StaffService();

    // Mock transaction helpers
    mockSession = {
      startTransaction: jest.fn(),
      commitTransaction: jest.fn(),
      abortTransaction: jest.fn(),
      endSession: jest.fn(),
    };
    Object.defineProperty(mongoose.connection, "db", {
      get: () => ({}),
      configurable: true,
    });
    jest.spyOn(mongoose.connection, "startSession").mockResolvedValue(mockSession);

    // Mock Repositories
    staffService.staffRepo = {
      findById: jest.fn(),
      findOne: jest.fn(),
    };
    staffService.userRepo = {
      findById: jest.fn(),
      findOne: jest.fn(),
    };
    staffService.auditLogService = {
      createAuditLog: jest.fn().mockResolvedValue({}),
    };
  });

  describe("Staff-User linking validations", () => {
    it("should link an active User to Staff successfully", async () => {
      const mockStaff = {
        _id: staffId,
        organizationId: orgAId,
        userId: null,
        save: jest.fn().mockResolvedValue(true),
      };
      const mockUser = {
        _id: userId,
        organizationId: orgAId,
        status: "active",
        branchAccess: [{ branchId: "b-1", isActive: true }],
      };

      staffService.staffRepo.findById.mockResolvedValue(mockStaff);
      staffService.userRepo.findById.mockResolvedValue(mockUser);
      staffService.staffRepo.findOne.mockResolvedValue(null);

      const result = await staffService.linkUser(staffId, userId, orgAId, "actor-1");

      expect(result.userId).toBe(userId);
      expect(mockStaff.save).toHaveBeenCalledWith({ session: mockSession });
      expect(mockSession.commitTransaction).toHaveBeenCalled();
      // Branch check: remains separate
      expect(mockUser.branchAccess).toEqual([{ branchId: "b-1", isActive: true }]);
    });

    it("should reject linking if the User is suspended", async () => {
      const mockStaff = { _id: staffId, organizationId: orgAId, userId: null };
      const mockUser = { _id: userId, organizationId: orgAId, status: "suspended" };

      staffService.staffRepo.findById.mockResolvedValue(mockStaff);
      staffService.userRepo.findById.mockResolvedValue(mockUser);

      await expect(
        staffService.linkUser(staffId, userId, orgAId, "actor-1")
      ).rejects.toThrow(new AppError("User is suspended and cannot be linked", 400));

      expect(mockSession.abortTransaction).toHaveBeenCalled();
    });

    it("should link a staff profile by username when an ObjectId is not supplied", async () => {
      const mockStaff = {
        _id: staffId,
        organizationId: orgAId,
        userId: null,
        save: jest.fn().mockResolvedValue(true),
      };
      const mockUser = {
        _id: userId,
        organizationId: orgAId,
        status: "active",
        username: "rahul.sharma",
      };

      staffService.staffRepo.findById.mockResolvedValue(mockStaff);
      staffService.userRepo.findOne.mockResolvedValue(mockUser);
      staffService.staffRepo.findOne.mockResolvedValue(null);

      const result = await staffService.linkUser(staffId, "rahul.sharma", orgAId, "actor-1");

      expect(result.userId).toBe(userId);
      expect(staffService.userRepo.findOne).toHaveBeenCalledWith(
        { username: "rahul.sharma" },
        orgAId,
        [],
        null,
        mockSession,
      );
    });

    it("should reject linking if Staff is already linked to another User", async () => {
      const mockStaff = { _id: staffId, organizationId: orgAId, userId: "another-user" };
      const mockUser = { _id: userId, organizationId: orgAId, status: "active" };

      staffService.staffRepo.findById.mockResolvedValue(mockStaff);
      staffService.userRepo.findById.mockResolvedValue(mockUser);

      await expect(
        staffService.linkUser(staffId, userId, orgAId, "actor-1")
      ).rejects.toThrow(new AppError("Staff is already linked to another User", 400));
    });

    it("should reject linking if User is already linked to another Staff", async () => {
      const mockStaff = { _id: staffId, organizationId: orgAId, userId: null };
      const mockUser = { _id: userId, organizationId: orgAId, status: "active" };
      const anotherStaff = { _id: "another-staff", userId };

      staffService.staffRepo.findById.mockResolvedValue(mockStaff);
      staffService.userRepo.findById.mockResolvedValue(mockUser);
      staffService.staffRepo.findOne.mockResolvedValue(anotherStaff);

      await expect(
        staffService.linkUser(staffId, userId, orgAId, "actor-1")
      ).rejects.toThrow(new AppError("User is already linked to another active Staff", 400));
    });

    it("should prevent cross-organization linking", async () => {
      const mockStaff = { _id: staffId, organizationId: orgAId, userId: null };
      const mockUser = { _id: userId, organizationId: orgBId, status: "active" };

      staffService.staffRepo.findById.mockResolvedValue(mockStaff);
      staffService.userRepo.findById.mockResolvedValue(mockUser);

      await expect(
        staffService.linkUser(staffId, userId, orgAId, "actor-1")
      ).rejects.toThrow(new AppError("Cross-organization linkage is prohibited", 400));
    });

    it("should rollback transaction and abort if staff save fails", async () => {
      const mockStaff = {
        _id: staffId,
        organizationId: orgAId,
        userId: null,
        save: jest.fn().mockRejectedValue(new Error("Database write error")),
      };
      const mockUser = { _id: userId, organizationId: orgAId, status: "active" };

      staffService.staffRepo.findById.mockResolvedValue(mockStaff);
      staffService.userRepo.findById.mockResolvedValue(mockUser);
      staffService.staffRepo.findOne.mockResolvedValue(null);

      await expect(
        staffService.linkUser(staffId, userId, orgAId, "actor-1")
      ).rejects.toThrow("Database write error");

      expect(mockSession.abortTransaction).toHaveBeenCalled();
    });
  });
});
