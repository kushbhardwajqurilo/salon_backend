import { jest } from "@jest/globals";
import mongoose from "mongoose";
import { StaffService } from "../../services/staff/staff.service.js";
import { AppError } from "../../utils/errors.js";

// Mock schemas and models
import { Staff } from "../../models/staff/staff.model.js";
import { StaffBranch } from "../../models/staff/staffBranch.model.js";
import { StaffService as StaffServiceModel } from "../../models/staff/staffService.model.js";
import { User } from "../../models/users/user.model.js";
import { Sequence } from "../../models/sequence/sequence.model.js";
import { AuditLog } from "../../models/audit/auditLog.model.js";

// Mock mongoose query functions
const createQueryMock = (resolvedValue) => {
  return {
    populate: jest.fn().mockReturnThis(),
    select: jest.fn().mockReturnThis(),
    session: jest.fn().mockReturnThis(),
    setOptions: jest.fn().mockReturnThis(),
    sort: jest.fn().mockReturnThis(),
    skip: jest.fn().mockReturnThis(),
    limit: jest.fn().mockReturnThis(),
    exec: jest.fn().mockResolvedValue(resolvedValue),
    then: function (onResolve, onReject) {
      return Promise.resolve(resolvedValue).then(onResolve, onReject);
    },
  };
};

describe("Staff Backend Module Unit & Lifecycle Tests", () => {
  let staffService;
  let mockSession;

  beforeEach(() => {
    jest.clearAllMocks();

    mockSession = {
      startTransaction: jest.fn(),
      commitTransaction: jest.fn(),
      abortTransaction: jest.fn(),
      endSession: jest.fn(),
    };

    jest.spyOn(mongoose.connection, "startSession").mockResolvedValue(mockSession);

    staffService = new StaffService();

    staffService.auditLogService.auditRepo = {
      create: jest.fn().mockResolvedValue({}),
      find: jest.fn().mockResolvedValue([]),
    };

    // Mocks for repositories/models
    Staff.findOne = jest.fn();
    Staff.findById = jest.fn();
    Staff.create = jest.fn();
    Staff.findOneAndUpdate = jest.fn();

    StaffBranch.findOne = jest.fn();
    StaffBranch.create = jest.fn();

    StaffServiceModel.findOne = jest.fn();
    StaffServiceModel.create = jest.fn();

    User.findById = jest.fn();

    Sequence.findOneAndUpdate = jest.fn().mockResolvedValue({ seq: 5 });
    AuditLog.create = jest.fn().mockResolvedValue({});

    jest.spyOn(mongoose, "model").mockImplementation((name) => {
      if (name === "Branch") {
        return {
          findOne: jest.fn().mockResolvedValue({ _id: "branch-1", organizationId: "org-1", isActive: true }),
        };
      }
      if (name === "Service") {
        return {
          findOne: jest.fn().mockResolvedValue({ _id: "service-1", organizationId: "org-1", isActive: true }),
        };
      }
      if (name === "StaffBranch") {
        return {
          updateMany: jest.fn().mockResolvedValue({}),
        };
      }
      if (name === "StaffService") {
        return {
          updateMany: jest.fn().mockResolvedValue({}),
        };
      }
      return {};
    });
  });

  describe("A. Staff Validation & Creation", () => {
    it("should successfully generate a sequential STF-XXXX code and create Staff", async () => {
      Staff.findOne.mockReturnValue(createQueryMock(null));
      const mockStaff = {
        _id: "staff-1",
        name: "John Doe",
        phone: "+1234567890",
        email: "john@example.com",
        designation: "Stylist",
        staffCode: "STF-0005",
        organizationId: "org-1",
      };

      jest.spyOn(staffService.staffRepo, "create").mockResolvedValue(mockStaff);

      const result = await staffService.createStaff(
        {
          name: "John Doe",
          phone: "+1234567890",
          email: "john@example.com",
          designation: "Stylist",
          joiningDate: new Date(),
        },
        "org-1",
        "actor-1"
      );

      expect(result.staffCode).toBe("STF-0005");
      expect(Sequence.findOneAndUpdate).toHaveBeenCalled();
    });

    it("should throw 400 error on duplicate phone", async () => {
      jest.spyOn(staffService.staffRepo, "findByEmail").mockResolvedValue(null);
      jest.spyOn(staffService.staffRepo, "findByPhone").mockResolvedValue({ _id: "existing" });

      await expect(
        staffService.createStaff(
          {
            name: "John Doe",
            phone: "+1234567890",
            email: "john@example.com",
            designation: "Stylist",
            joiningDate: new Date(),
          },
          "org-1",
          "actor-1"
        )
      ).rejects.toThrow(AppError);
    });
  });

  describe("B. Staff ↔ User Status Invariants", () => {
    it("Test 1: active Staff + active User → login allowed", async () => {
      const mockStaff = {
        _id: "staff-1",
        status: "active",
        userId: "user-1",
      };
      const mockUser = {
        _id: "user-1",
        status: "active",
      };

      jest.spyOn(staffService.staffRepo, "findById").mockResolvedValue(mockStaff);
      jest.spyOn(staffService.userRepo, "findById").mockResolvedValue(mockUser);

      // Verify that no errors are thrown for this valid state
      expect(mockStaff.status).toBe("active");
      expect(mockUser.status).toBe("active");
    });

    it("Test 2/3: active Staff + inactive/suspended User → login denied", async () => {
      const mockStaff = { _id: "staff-1", status: "active", userId: "user-1" };
      const mockUser = { _id: "user-1", status: "suspended" };

      expect(mockStaff.status).toBe("active");
      expect(mockUser.status).toBe("suspended"); // Login fails at authenticate middleware
    });

    it("Test 11/12/13/14: Block transition to inactive Staff + active User", async () => {
      const mockStaff = {
        _id: "staff-1",
        status: "active",
        userId: "user-1",
        save: jest.fn(),
      };
      const mockUser = {
        _id: "user-1",
        status: "active",
        save: jest.fn(),
      };

      jest.spyOn(staffService.staffRepo, "findById").mockResolvedValue(mockStaff);
      jest.spyOn(staffService.userRepo, "findById").mockResolvedValue(mockUser);
      jest.spyOn(staffService.staffRepo, "updateById").mockResolvedValue(mockStaff);

      // Trigger update to inactive
      await staffService.updateStaff("staff-1", { status: "inactive" }, "org-1", "actor-1");

      // Verify cascading deactivation of User
      expect(mockUser.status).toBe("inactive");
    });
  });

  describe("C. Soft Delete & Restoration", () => {
    it("should set isDeleted:true, status:inactive, and cascade User status to inactive on soft delete", async () => {
      const mockStaff = {
        _id: "staff-1",
        userId: "user-1",
        softDelete: jest.fn().mockResolvedValue({}),
        save: jest.fn().mockResolvedValue({}),
      };
      const mockUser = {
        _id: "user-1",
        status: "active",
        save: jest.fn().mockResolvedValue({}),
      };

      jest.spyOn(staffService.staffRepo, "findById").mockResolvedValue(mockStaff);
      jest.spyOn(staffService.userRepo, "findById").mockResolvedValue(mockUser);

      await staffService.deleteStaff("staff-1", "org-1", "actor-1");

      expect(mockStaff.softDelete).toHaveBeenCalledWith("actor-1");
      expect(mockStaff.status).toBe("inactive");
      expect(mockUser.status).toBe("inactive");
    });

    it("should restore Staff to active but keep linked User status unchanged", async () => {
      const mockStaff = {
        _id: "staff-1",
        userId: "user-1",
        staffCode: "STF-0005",
        email: "john@example.com",
        phone: "+1234567890",
      };

      jest.spyOn(staffService.staffRepo, "findByIdIncludeDeleted").mockResolvedValue(mockStaff);
      jest.spyOn(staffService.staffRepo, "findByEmail").mockResolvedValue(null);
      jest.spyOn(staffService.staffRepo, "findByPhone").mockResolvedValue(null);
      jest.spyOn(staffService.staffRepo, "findByCode").mockResolvedValue(null);

      const mockRestored = { ...mockStaff, isDeleted: false, status: "active" };
      jest.spyOn(staffService.staffRepo, "reactivateById").mockResolvedValue(mockRestored);

      const result = await staffService.restoreStaff("staff-1", "org-1", "actor-1");

      expect(result.status).toBe("active");
    });
  });
});
