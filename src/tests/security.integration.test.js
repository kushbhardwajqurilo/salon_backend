import { jest } from "@jest/globals";
import { requireBranchScope, requireOrganizationScope } from "../middleware/branchScope.js";
import { validateUserUpdate } from "../utils/userValidation.js";
import { Branch } from "../models/branches/branch.model.js";
import { CustomerRepository } from "../repositories/customers/customer.repository.js";
import { AppError } from "../utils/errors.js";
import mongoose from "mongoose";

// Mock the Branch model's findOne method
Branch.findOne = jest.fn();

// Helper to run express middleware and capture next() outcomes
const runMiddleware = (middleware, req, res = {}) => {
  return new Promise((resolve, reject) => {
    middleware(req, res, (err) => {
      if (err) {
        reject(err);
      } else {
        resolve();
      }
    });
  });
};

describe("Security Scoping Middleware & Validation tests", () => {
  let req;
  let res;

  beforeEach(() => {
    jest.clearAllMocks();
    req = {
      headers: {},
      user: {
        id: "user-123",
        organizationId: new mongoose.Types.ObjectId().toString(),
        branchAccess: [],
        hasOrgWideAccess: false,
      },
    };
    res = {};
  });

  describe("requireOrganizationScope Middleware", () => {
    it("should set req.organizationId strictly from authenticated user context", async () => {
      await expect(runMiddleware(requireOrganizationScope, req, res)).resolves.toBeUndefined();
      expect(req.organizationId).toBe(req.user.organizationId);
    });

    it("should reject if user is not authenticated", async () => {
      req.user = null;
      await expect(runMiddleware(requireOrganizationScope, req, res)).rejects.toThrow(
        new AppError("User authentication required", 401)
      );
    });
  });

  describe("requireBranchScope Middleware", () => {
    it("should reject with 400 if X-Branch-Id header is missing", async () => {
      await expect(runMiddleware(requireBranchScope, req, res)).rejects.toThrow(
        new AppError("X-Branch-Id header is required for this request.", 400)
      );
    });

    it("should reject with 400 if X-Branch-Id format is invalid", async () => {
      req.headers["x-branch-id"] = "invalid-id-format";
      await expect(runMiddleware(requireBranchScope, req, res)).rejects.toThrow(
        new AppError("Invalid branch ID format.", 400)
      );
    });

    it("should return 404 if branch belongs to another organization or is inactive", async () => {
      const targetBranchId = new mongoose.Types.ObjectId().toString();
      req.headers["x-branch-id"] = targetBranchId;

      // Mock Branch.findOne to return null (not found under user's organizationId + active status query constraint)
      Branch.findOne.mockResolvedValue(null);

      await expect(runMiddleware(requireBranchScope, req, res)).rejects.toThrow(
        new AppError("Resource not found", 404)
      );
      
      expect(Branch.findOne).toHaveBeenCalledWith({
        _id: targetBranchId,
        organizationId: req.user.organizationId,
        isActive: true,
      });
    });

    it("should return 403 if branch is active in organization but user lacks access (hasOrgWideAccess=false, not in branchAccess)", async () => {
      const targetBranchId = new mongoose.Types.ObjectId().toString();
      req.headers["x-branch-id"] = targetBranchId;

      Branch.findOne.mockResolvedValue({
        _id: targetBranchId,
        organizationId: req.user.organizationId,
        isActive: true,
      });

      req.user.branchAccess = []; // empty access list
      req.user.hasOrgWideAccess = false;

      await expect(runMiddleware(requireBranchScope, req, res)).rejects.toThrow(
        new AppError("Access denied. You do not have access to this branch.", 403)
      );
    });

    it("should proceed (200) if branch belongs to organization and user has hasOrgWideAccess", async () => {
      const targetBranchId = new mongoose.Types.ObjectId().toString();
      req.headers["x-branch-id"] = targetBranchId;

      Branch.findOne.mockResolvedValue({
        _id: targetBranchId,
        organizationId: req.user.organizationId,
        isActive: true,
      });

      req.user.hasOrgWideAccess = true;

      await expect(runMiddleware(requireBranchScope, req, res)).resolves.toBeUndefined();
      expect(req.branchId).toBe(targetBranchId);
      expect(req.organizationId).toBe(req.user.organizationId);
    });

    it("should proceed (200) if branch belongs to organization and is present in user's branchAccess", async () => {
      const targetBranchId = new mongoose.Types.ObjectId().toString();
      req.headers["x-branch-id"] = targetBranchId;

      Branch.findOne.mockResolvedValue({
        _id: targetBranchId,
        organizationId: req.user.organizationId,
        isActive: true,
      });

      req.user.hasOrgWideAccess = false;
      req.user.branchAccess = [
        { branchId: targetBranchId, branchName: "Main Branch", isActive: true },
      ];

      await expect(runMiddleware(requireBranchScope, req, res)).resolves.toBeUndefined();
      expect(req.branchId).toBe(targetBranchId);
    });
  });

  describe("Privilege Escalation Protection (validateUserUpdate)", () => {
    it("should block self organization modification", async () => {
      const reqUser = { id: "user-123", hasOrgWideAccess: true };
      const targetUser = { _id: "user-123", organizationId: "org-1" };
      const updates = { organizationId: "org-2" };

      await expect(validateUserUpdate(reqUser, targetUser, updates)).rejects.toThrow(
        new AppError("You cannot change your own organization context.", 403)
      );
    });

    it("should block non-admin users from escalating hasOrgWideAccess to true", async () => {
      const reqUser = { id: "user-123", hasOrgWideAccess: false };
      const targetUser = { _id: "user-456", organizationId: "org-1", hasOrgWideAccess: false };
      const updates = { hasOrgWideAccess: true };

      await expect(validateUserUpdate(reqUser, targetUser, updates)).rejects.toThrow(
        new AppError("Access denied. You cannot grant organization-wide access.", 403)
      );
    });
  });

  describe("Repository Tenant Isolation", () => {
    it("should filter find query strictly using target organizationId", async () => {
      const repo = new CustomerRepository();
      repo.model.find = jest.fn().mockReturnValue({
        populate: jest.fn().mockReturnThis(),
        select: jest.fn().mockReturnThis(),
        sort: jest.fn().mockReturnThis(),
        skip: jest.fn().mockReturnThis(),
        limit: jest.fn().mockReturnThis(),
        exec: jest.fn().mockResolvedValue([]),
      });
      repo.count = jest.fn().mockResolvedValue(0);

      const organizationId = "org-123";
      await repo.find({}, { page: 1, limit: 10 }, organizationId);

      expect(repo.model.find).toHaveBeenCalledWith({ organizationId });
    });
  });
});
