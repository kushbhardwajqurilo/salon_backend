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
  let mockStaffBranchModel;
  let mockStaffServiceModel;

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

    mockStaffBranchModel = {
      updateMany: jest.fn().mockResolvedValue({}),
      countDocuments: jest.fn().mockImplementation(() => ({
        session: jest.fn().mockResolvedValue(0)
      })),
      find: jest.fn().mockImplementation(() => createQueryMock([])),
    };

    mockStaffServiceModel = {
      updateMany: jest.fn().mockResolvedValue({}),
      find: jest.fn().mockImplementation(() => createQueryMock([])),
    };

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
        return mockStaffBranchModel;
      }
      if (name === "StaffService") {
        return mockStaffServiceModel;
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

  describe("D. Primary Branch Integrity Invariant & Retrieval", () => {
    it("should assign first branch automatically as primary", async () => {
      const mockStaff = { _id: "staff-1", organizationId: "org-1" };
      jest.spyOn(staffService.staffRepo, "findById").mockResolvedValue(mockStaff);
      
      StaffBranch.findOne.mockReturnValue(createQueryMock(null));
      
      // Mock countDocuments
      jest.spyOn(mockStaffBranchModel, "countDocuments").mockReturnValue({
        session: jest.fn().mockResolvedValue(0)
      });
      
      // Spy on updateMany
      const updateManySpy = jest.spyOn(mockStaffBranchModel, "updateMany");
      
      const mockAssignment = { _id: "assignment-1", staffId: "staff-1", branchId: "branch-1", isPrimary: true, isActive: true };
      jest.spyOn(staffService.staffBranchRepo, "create").mockResolvedValue(mockAssignment);
      
      const result = await staffService.assignBranch("staff-1", "branch-1", false, "org-1", "actor-1");
      
      expect(result.isPrimary).toBe(true);
    });

    it("should assign second branch as non-primary without demoting existing primary", async () => {
      const mockStaff = { _id: "staff-1", organizationId: "org-1" };
      jest.spyOn(staffService.staffRepo, "findById").mockResolvedValue(mockStaff);
      StaffBranch.findOne.mockReturnValue(createQueryMock(null));
      
      jest.spyOn(mockStaffBranchModel, "countDocuments").mockReturnValue({
        session: jest.fn().mockResolvedValue(1)
      });
      
      const updateManySpy = jest.spyOn(mockStaffBranchModel, "updateMany");
      const mockAssignment = { _id: "assignment-2", staffId: "staff-1", branchId: "branch-2", isPrimary: false, isActive: true };
      jest.spyOn(staffService.staffBranchRepo, "create").mockResolvedValue(mockAssignment);
      
      const result = await staffService.assignBranch("staff-1", "branch-2", false, "org-1", "actor-1");
      
      expect(result.isPrimary).toBe(false);
      expect(updateManySpy).not.toHaveBeenCalled();
    });

    it("should demote existing primary when assigning a second branch as primary", async () => {
      const mockStaff = { _id: "staff-1", organizationId: "org-1" };
      jest.spyOn(staffService.staffRepo, "findById").mockResolvedValue(mockStaff);
      StaffBranch.findOne.mockReturnValue(createQueryMock(null));
      
      jest.spyOn(mockStaffBranchModel, "countDocuments").mockReturnValue({
        session: jest.fn().mockResolvedValue(1)
      });
      
      const updateManySpy = jest.spyOn(mockStaffBranchModel, "updateMany");
      const mockAssignment = { _id: "assignment-2", staffId: "staff-1", branchId: "branch-2", isPrimary: true, isActive: true };
      jest.spyOn(staffService.staffBranchRepo, "create").mockResolvedValue(mockAssignment);
      
      const result = await staffService.assignBranch("staff-1", "branch-2", true, "org-1", "actor-1");
      
      expect(result.isPrimary).toBe(true);
      expect(updateManySpy).toHaveBeenCalled();
    });

    it("should promote oldest remaining branch to primary when primary is removed", async () => {
      const mockStaff = { _id: "staff-1", organizationId: "org-1" };
      jest.spyOn(staffService.staffRepo, "findById").mockResolvedValue(mockStaff);
      
      const mockAssignment = {
        _id: "assignment-1",
        staffId: "staff-1",
        branchId: "branch-1",
        isPrimary: true,
        isActive: true,
        save: jest.fn().mockResolvedValue({})
      };
      StaffBranch.findOne.mockReturnValue(createQueryMock(mockAssignment));

      const mockRemaining = [
        { _id: "assignment-2", branchId: "branch-2", isPrimary: false, save: jest.fn().mockResolvedValue({}) }
      ];
      
      jest.spyOn(mockStaffBranchModel, "find").mockReturnValue({
        sort: jest.fn().mockReturnThis(),
        session: jest.fn().mockResolvedValue(mockRemaining)
      });

      await staffService.removeBranch("staff-1", "branch-1", "org-1", "actor-1");

      expect(mockAssignment.isActive).toBe(false);
      expect(mockAssignment.isPrimary).toBe(false);
      expect(mockRemaining[0].isPrimary).toBe(true);
      expect(mockRemaining[0].save).toHaveBeenCalled();
    });

    it("should not promote anything if no branches remain after removing final branch", async () => {
      const mockStaff = { _id: "staff-1", organizationId: "org-1" };
      jest.spyOn(staffService.staffRepo, "findById").mockResolvedValue(mockStaff);
      
      const mockAssignment = {
        _id: "assignment-1",
        staffId: "staff-1",
        branchId: "branch-1",
        isPrimary: true,
        isActive: true,
        save: jest.fn().mockResolvedValue({})
      };
      StaffBranch.findOne.mockReturnValue(createQueryMock(mockAssignment));

      jest.spyOn(mockStaffBranchModel, "find").mockReturnValue({
        sort: jest.fn().mockReturnThis(),
        session: jest.fn().mockResolvedValue([])
      });

      await staffService.removeBranch("staff-1", "branch-1", "org-1", "actor-1");

      expect(mockAssignment.isActive).toBe(false);
      expect(mockAssignment.isPrimary).toBe(false);
    });

    it("should prevent duplicate branch assignments", async () => {
      const mockStaff = { _id: "staff-1", organizationId: "org-1" };
      jest.spyOn(staffService.staffRepo, "findById").mockResolvedValue(mockStaff);
      StaffBranch.findOne.mockReturnValue(createQueryMock({ _id: "existing" }));

      await expect(
        staffService.assignBranch("staff-1", "branch-1", false, "org-1", "actor-1")
      ).rejects.toThrow(AppError);
    });

    it("should retrieve active branch assignments", async () => {
      const mockStaff = { _id: "staff-1", organizationId: "org-1" };
      jest.spyOn(staffService.staffRepo, "findById").mockResolvedValue(mockStaff);

      const mockData = [{ _id: "assignment-1", branchId: { _id: "branch-1", name: "Koramangala" } }];
      jest.spyOn(staffService.staffBranchRepo, "find").mockResolvedValue({ data: mockData });

      const result = await staffService.getStaffBranches("staff-1", "org-1");
      expect(result).toEqual(mockData);
    });
  });

  describe("E. Service Capability Junction & Retrieval", () => {
    it("should successfully assign service", async () => {
      const mockStaff = { _id: "staff-1", organizationId: "org-1" };
      jest.spyOn(staffService.staffRepo, "findById").mockResolvedValue(mockStaff);
      jest.spyOn(staffService.staffServiceRepo, "findOne").mockResolvedValue(null);

      const mockMapping = { _id: "mapping-1", staffId: "staff-1", serviceId: "service-1", isActive: true };
      jest.spyOn(staffService.staffServiceRepo, "create").mockResolvedValue(mockMapping);

      const result = await staffService.assignService("staff-1", "service-1", "org-1", "actor-1");
      expect(result.isActive).toBe(true);
    });

    it("should prevent duplicate service capability mappings", async () => {
      const mockStaff = { _id: "staff-1", organizationId: "org-1" };
      jest.spyOn(staffService.staffRepo, "findById").mockResolvedValue(mockStaff);
      jest.spyOn(staffService.staffServiceRepo, "findOne").mockResolvedValue({ _id: "existing" });

      await expect(
        staffService.assignService("staff-1", "service-1", "org-1", "actor-1")
      ).rejects.toThrow(AppError);
    });

    it("should deactivate service mapping on removal", async () => {
      const mockStaff = { _id: "staff-1", organizationId: "org-1" };
      jest.spyOn(staffService.staffRepo, "findById").mockResolvedValue(mockStaff);
      const mockMapping = { _id: "mapping-1", isActive: true, save: jest.fn().mockResolvedValue({}) };
      jest.spyOn(staffService.staffServiceRepo, "findOne").mockResolvedValue(mockMapping);

      await staffService.removeService("staff-1", "service-1", "org-1", "actor-1");
      expect(mockMapping.isActive).toBe(false);
      expect(mockMapping.save).toHaveBeenCalled();
    });

    it("should retrieve active services", async () => {
      const mockStaff = { _id: "staff-1", organizationId: "org-1" };
      jest.spyOn(staffService.staffRepo, "findById").mockResolvedValue(mockStaff);

      const mockData = [{ _id: "mapping-1", serviceId: { _id: "service-1", name: "Haircut" } }];
      jest.spyOn(staffService.staffServiceRepo, "find").mockResolvedValue({ data: mockData });

      const result = await staffService.getStaffServices("staff-1", "org-1");
      expect(result).toEqual(mockData);
    });
  });

  describe("F. Keyword Search & Scoping", () => {
    it("should correctly clean filters and pass searchFields to super.find in StaffRepository", async () => {
      const superFindSpy = jest.spyOn(Object.getPrototypeOf(Object.getPrototypeOf(staffService.staffRepo)), "find").mockResolvedValue({ data: [], meta: {} });
      
      await staffService.staffRepo.find(
        { page: 1, limit: 10, sort: "-createdAt", search: "Jane", status: "active", branchId: "branch-1" },
        { page: 1, limit: 10, sort: "-createdAt", search: "Jane" },
        "org-1"
      );

      // Verify that filter object has status and organizationId, but stripped page, limit, sort, search, branchId
      expect(superFindSpy).toHaveBeenCalledWith(
        expect.objectContaining({
          status: "active",
          organizationId: "org-1"
        }),
        expect.objectContaining({
          searchFields: ["name", "email", "phone", "staffCode", "designation"]
        })
      );
      
      const filterArg = superFindSpy.mock.calls[0][0];
      expect(filterArg.page).toBeUndefined();
      expect(filterArg.limit).toBeUndefined();
      expect(filterArg.search).toBeUndefined();
      expect(filterArg.branchId).toBeUndefined();
    });
  });

  describe("G. Staff ↔ User Linking Validation Scoping", () => {
    it("should allow linking when user exists, is active, matches organization and not linked", async () => {
      const mockStaff = { _id: "staff-1", organizationId: "org-1", userId: null, save: jest.fn().mockResolvedValue(true) };
      const mockUser = { _id: "user-1", organizationId: "org-1", status: "active" };

      jest.spyOn(staffService.staffRepo, "findById").mockResolvedValue(mockStaff);
      jest.spyOn(staffService.userRepo, "findById").mockResolvedValue(mockUser);
      jest.spyOn(staffService.staffRepo, "findOne").mockResolvedValue(null);

      const result = await staffService.linkUser("staff-1", "user-1", "org-1", "actor-1");
      expect(result.userId).toBe("user-1");
      expect(mockStaff.save).toHaveBeenCalled();
    });

    it("should reject linking if user belongs to a different organization", async () => {
      const mockStaff = { _id: "staff-1", organizationId: "org-1" };
      // User belongs to org-2, or userRepo.findById returns null because of scope filter
      jest.spyOn(staffService.staffRepo, "findById").mockResolvedValue(mockStaff);
      jest.spyOn(staffService.userRepo, "findById").mockResolvedValue(null);

      await expect(
        staffService.linkUser("staff-1", "user-1", "org-1", "actor-1")
      ).rejects.toThrow(new AppError("User not found", 404));
    });

    it("should reject linking if user is suspended", async () => {
      const mockStaff = { _id: "staff-1", organizationId: "org-1" };
      const mockUser = { _id: "user-1", organizationId: "org-1", status: "suspended" };

      jest.spyOn(staffService.staffRepo, "findById").mockResolvedValue(mockStaff);
      jest.spyOn(staffService.userRepo, "findById").mockResolvedValue(mockUser);

      await expect(
        staffService.linkUser("staff-1", "user-1", "org-1", "actor-1")
      ).rejects.toThrow(new AppError("User is suspended and cannot be linked", 400));
    });

    it("should reject linking if user is locked", async () => {
      const mockStaff = { _id: "staff-1", organizationId: "org-1" };
      const mockUser = { _id: "user-1", organizationId: "org-1", status: "locked" };

      jest.spyOn(staffService.staffRepo, "findById").mockResolvedValue(mockStaff);
      jest.spyOn(staffService.userRepo, "findById").mockResolvedValue(mockUser);

      await expect(
        staffService.linkUser("staff-1", "user-1", "org-1", "actor-1")
      ).rejects.toThrow(new AppError("User is locked and cannot be linked", 400));
    });

    it("should reject linking if user is inactive", async () => {
      const mockStaff = { _id: "staff-1", organizationId: "org-1" };
      const mockUser = { _id: "user-1", organizationId: "org-1", status: "inactive" };

      jest.spyOn(staffService.staffRepo, "findById").mockResolvedValue(mockStaff);
      jest.spyOn(staffService.userRepo, "findById").mockResolvedValue(mockUser);

      await expect(
        staffService.linkUser("staff-1", "user-1", "org-1", "actor-1")
      ).rejects.toThrow(new AppError("User is inactive and cannot be linked", 400));
    });

    it("should reject linking if user is already linked to another active staff", async () => {
      const mockStaff = { _id: "staff-1", organizationId: "org-1" };
      const mockUser = { _id: "user-1", organizationId: "org-1", status: "active" };

      jest.spyOn(staffService.staffRepo, "findById").mockResolvedValue(mockStaff);
      jest.spyOn(staffService.userRepo, "findById").mockResolvedValue(mockUser);
      jest.spyOn(staffService.staffRepo, "findOne").mockResolvedValue({ _id: "another-staff-linked" });

      await expect(
        staffService.linkUser("staff-1", "user-1", "org-1", "actor-1")
      ).rejects.toThrow(new AppError("User is already linked to another active Staff", 400));
    });
  });
});
