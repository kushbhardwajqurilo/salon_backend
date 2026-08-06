import { jest } from "@jest/globals";
import mongoose from "mongoose";
import { UserRepository } from "../../repositories/users/user.repository.js";
import { User } from "../../models/users/user.model.js";
import { StaffService } from "../../services/staff/staff.service.js";
import { AppError } from "../../utils/errors.js";

describe("UserRepository Tenant Isolation (Phase 2)", () => {
  let userRepo;
  let staffService;
  let orgAId;
  let orgBId;
  let userA;
  let userB;

  let userAId;
  let userBId;

  beforeAll(async () => {
    userRepo = new UserRepository();
    staffService = new StaffService();
    orgAId = new mongoose.Types.ObjectId();
    orgBId = new mongoose.Types.ObjectId();
    userAId = new mongoose.Types.ObjectId().toString();
    userBId = new mongoose.Types.ObjectId().toString();

    // Mock runTransaction to execute callback directly without database transactions
    staffService.runTransaction = jest.fn().mockImplementation((op) => op(null));
    staffService.staffRepo = {
      findById: jest.fn(),
      findOne: jest.fn(),
    };
    staffService.userRepo = userRepo;
  });

  describe("Tenant Isolation on UserRepository queries", () => {
    beforeEach(() => {
      jest.restoreAllMocks();
    });

    it("should allow Organization A to retrieve its own User", async () => {
      const mockUser = { _id: userAId, name: "User A", organizationId: orgAId };
      jest.spyOn(User, "findOne").mockReturnValue({
        populate: jest.fn().mockReturnThis(),
        select: jest.fn().mockReturnThis(),
        exec: jest.fn().mockResolvedValue(mockUser),
      });

      const result = await userRepo.findById(userAId, orgAId);
      expect(result).toBeDefined();
      expect(result.organizationId).toBe(orgAId);
      expect(User.findOne).toHaveBeenCalledWith({ _id: userAId, organizationId: orgAId });
    });

    it("should prevent Organization A from retrieving Organization B's User by ID", async () => {
      // Mock findOne to return null because organizationId doesn't match
      jest.spyOn(User, "findOne").mockReturnValue({
        populate: jest.fn().mockReturnThis(),
        select: jest.fn().mockReturnThis(),
        exec: jest.fn().mockResolvedValue(null),
      });

      const result = await userRepo.findById(userBId, orgAId);
      expect(result).toBeNull();
      expect(User.findOne).toHaveBeenCalledWith({ _id: userBId, organizationId: orgAId });
    });

    it("should prevent Organization A from updating Organization B's User", async () => {
      const mockFindOne = jest.fn().mockImplementation(() => ({
        session: jest.fn().mockReturnThis(),
        exec: jest.fn().mockResolvedValue(null), // User not found under Org A
      }));
      jest.spyOn(User, "findOne").mockImplementation(mockFindOne);

      const result = await userRepo.updateById(userBId, { name: "Hacked Name" }, orgAId);
      expect(result).toBeNull();
      expect(User.findOne).toHaveBeenCalledWith({ _id: userBId, organizationId: orgAId });
    });

    it("should prevent Organization A from modifying Organization B's User status", async () => {
      const mockFindOne = jest.fn().mockImplementation(() => ({
        session: jest.fn().mockReturnThis(),
        exec: jest.fn().mockResolvedValue(null),
      }));
      jest.spyOn(User, "findOne").mockImplementation(mockFindOne);

      const result = await userRepo.updateById(userBId, { status: "inactive" }, orgAId);
      expect(result).toBeNull();
    });

    it("should prevent Organization A from linking a User belonging to Organization B to a Staff", async () => {
      const mockStaff = { _id: "staff-1", organizationId: orgAId };
      
      // Mock UserRepository.findById to return null because orgId differs
      jest.spyOn(staffService.staffRepo, "findById").mockResolvedValue(mockStaff);
      jest.spyOn(userRepo, "findById").mockResolvedValue(null);

      await expect(
        staffService.linkUser("staff-1", userBId, orgAId, "actor-1")
      ).rejects.toThrow(new AppError("User not found", 404));
    });

    it("should allow existing global authentication lookups to continue working without organization context", async () => {
      const mockUser = { _id: "user-id", email: "login@example.com" };
      jest.spyOn(User, "findOne").mockReturnValue({
        populate: jest.fn().mockReturnThis(),
        select: jest.fn().mockReturnThis(),
        exec: jest.fn().mockResolvedValue(mockUser),
      });

      const result = await userRepo.findByEmail("login@example.com"); // No organizationId passed
      expect(result).toBeDefined();
      expect(User.findOne).toHaveBeenCalledWith({ email: "login@example.com" });
    });

    it("should ensure no client-provided organizationId parameter can override the authenticated tenant scope", async () => {
      // In the API handler / controller layer, the organizationId is strictly read from req.organizationId (set by the authenticate/branchScope middlewares from token context) and passed directly. If a client attempts to pass a custom filter inside query/body payloads, UserRepository overrides it or filters it strictly.
      const superFindSpy = jest.spyOn(Object.getPrototypeOf(UserRepository.prototype), "find").mockResolvedValue({ data: [], meta: {} });

      const clientFilters = { organizationId: orgBId.toString() }; // Client tries to override filter to Org B
      await userRepo.find(clientFilters, {}, orgAId); // Authenticated org scope is Org A

      // Verify that the query filter passed to Mongoose is overridden or forced to authenticated orgAId
      expect(superFindSpy).toHaveBeenCalledWith(
        expect.objectContaining({
          organizationId: orgAId,
        }),
        expect.any(Object)
      );
    });
  });
});
