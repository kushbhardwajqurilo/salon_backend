import { jest } from "@jest/globals";
import mongoose from "mongoose";
import { AppError } from "../../utils/errors.js";
import { StaffService } from "../../services/staff/staff.service.js";
import { AuthService } from "../../services/auth/auth.service.js";

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

  describe("AuthService Staff Linkage Authentication Enforcement", () => {
    let authService;
    let mockUserRepo;
    let mockRoleRepo;
    let mockSessionRepo;
    let mockStaffRepo;
    let mockUser;

    beforeEach(() => {
      mockUser = {
        _id: userId,
        email: "staffuser@parlour.com",
        password: "hashedpassword",
        organizationId: orgAId,
        status: "active",
        role: { name: "manager" },
        comparePassword: jest.fn().mockResolvedValue(true),
        save: jest.fn().mockResolvedValue(true),
      };

      mockUserRepo = {
        findByEmailOrUsername: jest.fn().mockResolvedValue(mockUser),
        findByEmail: jest.fn().mockResolvedValue(mockUser),
      };

      mockRoleRepo = {
        findByName: jest.fn(),
      };

      mockSessionRepo = {
        create: jest.fn().mockResolvedValue(true),
        invalidateAllUserSessions: jest.fn(),
      };

      mockStaffRepo = {
        findOne: jest.fn(),
      };

      authService = new AuthService(
        mockUserRepo,
        mockRoleRepo,
        mockSessionRepo,
        null,
        mockStaffRepo
      );
    });

    it("should reject login for unlinked staff User (staff link absent)", async () => {
      mockStaffRepo.findOne.mockResolvedValue(null);

      await expect(
        authService.login("staffuser@parlour.com", "Password123!", "127.0.0.1", "agent")
      ).rejects.toThrow(new AppError("This account is not linked to an active staff profile. Please contact an administrator.", 403));

      expect(mockSessionRepo.create).not.toHaveBeenCalled();
    });

    it("should allow login for linked active Staff", async () => {
      mockStaffRepo.findOne.mockResolvedValue({
        _id: staffId,
        userId,
        organizationId: orgAId,
        status: "active",
        isDeleted: false,
      });

      const result = await authService.login("staffuser@parlour.com", "Password123!", "127.0.0.1", "agent");
      expect(result.accessToken).toBeDefined();
      expect(result.refreshToken).toBeDefined();
      expect(mockSessionRepo.create).toHaveBeenCalled();
    });

    it("should reject login for inactive Staff", async () => {
      mockStaffRepo.findOne.mockResolvedValue({
        _id: staffId,
        userId,
        organizationId: orgAId,
        status: "inactive",
        isDeleted: false,
      });

      await expect(
        authService.login("staffuser@parlour.com", "Password123!", "127.0.0.1", "agent")
      ).rejects.toThrow(new AppError("This account is not linked to an active staff profile. Please contact an administrator.", 403));
    });

    it("should reject login for suspended Staff", async () => {
      mockStaffRepo.findOne.mockResolvedValue({
        _id: staffId,
        userId,
        organizationId: orgAId,
        status: "suspended",
        isDeleted: false,
      });

      await expect(
        authService.login("staffuser@parlour.com", "Password123!", "127.0.0.1", "agent")
      ).rejects.toThrow(new AppError("This account is not linked to an active staff profile. Please contact an administrator.", 403));
    });

    it("should reject login for deleted Staff", async () => {
      mockStaffRepo.findOne.mockResolvedValue(null); // findOne with isDeleted: false returns null

      await expect(
        authService.login("staffuser@parlour.com", "Password123!", "127.0.0.1", "agent")
      ).rejects.toThrow(new AppError("This account is not linked to an active staff profile. Please contact an administrator.", 403));
    });

    it("should reject login for cross-organization staff linkage", async () => {
      // If staff belongs to orgBId while user belongs to orgAId, staffRepo.findOne returns null because organizationId does not match
      mockStaffRepo.findOne.mockImplementation((filter, orgId) => {
        if (orgId !== orgAId) return null;
        return null;
      });

      await expect(
        authService.login("staffuser@parlour.com", "Password123!", "127.0.0.1", "agent")
      ).rejects.toThrow(new AppError("This account is not linked to an active staff profile. Please contact an administrator.", 403));
    });

    it("should allow login for Admin User without Staff record", async () => {
      mockUser.role = { name: "owner" };
      mockStaffRepo.findOne.mockResolvedValue(null);

      const result = await authService.login("staffuser@parlour.com", "Password123!", "127.0.0.1", "agent");
      expect(result.accessToken).toBeDefined();
      expect(result.refreshToken).toBeDefined();
    });
  });
});
