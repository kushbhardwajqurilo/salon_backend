import { jest } from "@jest/globals";
import { requireBranchScope, requireOrganizationScope } from "../middleware/branchScope.js";
import { validateUserUpdate } from "../utils/userValidation.js";
import { Branch } from "../models/branches/branch.model.js";
import { CustomerRepository } from "../repositories/customers/customer.repository.js";
import { AppError } from "../utils/errors.js";
import mongoose from "mongoose";
import { createCustomer, listCustomers } from "../controllers/customers/customer.controller.js";
import { CustomerService } from "../services/customers/customer.service.js";
import { getBranchById } from "../controllers/branches/branch.controller.js";
import { authorize } from "../middleware/rbac.js";
import { RoleRepository } from "../repositories/roles/role.repository.js";
import { me } from "../controllers/auth/auth.controller.js";


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

  describe("Customer Scoping and Validation Hardening", () => {
    describe("requireBranchScope Omitted X-Branch-Id Fallback", () => {
      it("should proceed (200) if X-Branch-Id is omitted and user has hasOrgWideAccess", async () => {
        const req = {
          headers: {},
          user: {
            organizationId: new mongoose.Types.ObjectId().toString(),
            hasOrgWideAccess: true,
            branchAccess: []
          }
        };
        const res = {};
        await expect(runMiddleware(requireBranchScope, req, res)).resolves.toBeUndefined();
        expect(req.branchId).toBeUndefined();
        expect(req.organizationId).toBe(req.user.organizationId);
      });
    });

    describe("createCustomer branchId Verification", () => {
      it("should reject with 400 if X-Branch-Id context is missing", async () => {
        const req = {
          organizationId: "org-123",
          branchId: undefined, // missing header context
          body: { name: "Test Customer" },
          user: { id: "user-123", hasOrgWideAccess: false, branchAccess: [] }
        };
        const res = {};
        const next = jest.fn();
        
        await createCustomer(req, res, next);
        
        expect(next).toHaveBeenCalledWith(expect.any(AppError));
        expect(next.mock.calls[0][0].message).toBe("X-Branch-Id header is required for this request.");
        expect(next.mock.calls[0][0].statusCode).toBe(400);
      });

      it("should derive homeBranchId server-side from header context", async () => {
        const headerBranchId = new mongoose.Types.ObjectId().toString();
        const req = {
          organizationId: "org-123",
          headers: { "x-branch-id": headerBranchId },
          body: { name: "Test Customer", phone: "+919999988888" },
          user: { id: "user-123", hasOrgWideAccess: false, branchAccess: [{ branchId: headerBranchId, isActive: true }] }
        };
        const res = {
          status: jest.fn().mockReturnThis(),
          json: jest.fn()
        };
        const next = jest.fn();
        
        Branch.findOne.mockResolvedValue({ _id: headerBranchId, organizationId: "org-123", isActive: true });
        CustomerService.prototype.createCustomer = jest.fn().mockResolvedValue({ _id: "cust-123", homeBranchId: headerBranchId });

        await createCustomer(req, res, next);
        expect(CustomerService.prototype.createCustomer).toHaveBeenCalledWith(
          expect.objectContaining({ homeBranchId: headerBranchId }),
          "org-123",
          "user-123"
        );
      });
    });

    describe("listCustomers branchId Scoping & Validation", () => {
      it("should reject with 400 if X-Branch-Id is missing and user is branch-limited", async () => {
        const req = {
          organizationId: "org-123",
          headers: {},
          query: {},
          user: { hasOrgWideAccess: false, branchAccess: [] }
        };
        const res = {};
        const next = jest.fn();

        await listCustomers(req, res, next);

        expect(next).toHaveBeenCalledWith(expect.any(AppError));
        expect(next.mock.calls[0][0].message).toBe("X-Branch-Id header is required for this request.");
        expect(next.mock.calls[0][0].statusCode).toBe(400);
      });
    });

    describe("Customer Update Immutability Verification", () => {
      it("should ignore organizationId, homeBranchId, and visitedBranchIds in updateCustomer payload", async () => {
        const customerService = new CustomerService();
        const organizationId = new mongoose.Types.ObjectId().toString();
        const homeBranchId = new mongoose.Types.ObjectId().toString();
        const customerId = new mongoose.Types.ObjectId().toString();
        const userId = new mongoose.Types.ObjectId().toString();
        
        customerService.customerRepo.findById = jest.fn().mockResolvedValue({
          _id: customerId,
          organizationId,
          homeBranchId,
          visitedBranchIds: [],
          status: "active",
        });

        customerService.customerRepo.updateById = jest.fn().mockImplementation((id, data) => {
          return Promise.resolve({ _id: id, ...data });
        });

        customerService.auditRepo = {
          create: jest.fn().mockResolvedValue({}),
        };

        const updates = {
          name: "Updated Name",
          homeBranchId: "malicious-change-attempt",
          organizationId: "other-org",
          visitedBranchIds: ["some-other-branch"]
        };

        const result = await customerService.updateCustomer(
          customerId,
          updates,
          organizationId,
          userId,
          { hasOrgWideAccess: true }
        );

        expect(result.name).toBe("Updated Name");
        expect(customerService.customerRepo.updateById).toHaveBeenCalledWith(
          customerId,
          { name: "Updated Name" }, // strictly updates only mutable properties
          organizationId,
          userId
        );
      });
    });

    describe("Branch Resource Role-Agnostic Scoping & Middleware Tests", () => {
      let branchReq;
      let branchRes;

      beforeEach(() => {
        branchReq = {
          params: {},
          user: {
            id: "user-123",
            organizationId: new mongoose.Types.ObjectId().toString(),
            branchAccess: [],
            hasOrgWideAccess: false,
            role: "stylist",
          },
        };
        branchRes = {
          status: jest.fn().mockReturnThis(),
          json: jest.fn(),
        };
        RoleRepository.prototype.findOne = jest.fn();
      });

      it("should allow getBranchById for a user with hasOrgWideAccess: true", async () => {
        const branchId = new mongoose.Types.ObjectId().toString();
        branchReq.params.id = branchId;
        branchReq.user.hasOrgWideAccess = true;

        Branch.findOne.mockResolvedValue({
          _id: branchId,
          organizationId: branchReq.user.organizationId,
          isActive: true,
        });

        const next = jest.fn();
        await getBranchById(branchReq, branchRes, next);
        expect(next).not.toHaveBeenCalled();
        expect(branchRes.status).toHaveBeenCalledWith(200);
        expect(branchRes.json).toHaveBeenCalledWith(
          expect.objectContaining({
            message: "Branch retrieved successfully",
          })
        );
      });

      it("should allow getBranchById for a non-org-wide user with the branch in branchAccess", async () => {
        const branchId = new mongoose.Types.ObjectId().toString();
        branchReq.params.id = branchId;
        branchReq.user.hasOrgWideAccess = false;
        branchReq.user.branchAccess = [
          { branchId: branchId, branchName: "Active Branch", isActive: true },
        ];

        Branch.findOne.mockResolvedValue({
          _id: branchId,
          organizationId: branchReq.user.organizationId,
          isActive: true,
        });

        const next = jest.fn();
        await getBranchById(branchReq, branchRes, next);
        expect(next).not.toHaveBeenCalled();
        expect(branchRes.status).toHaveBeenCalledWith(200);
      });

      it("should deny getBranchById for a user whose role is 'owner' but hasOrgWideAccess is false and branch is not in branchAccess", async () => {
        const branchId = new mongoose.Types.ObjectId().toString();
        branchReq.params.id = branchId;
        branchReq.user.role = "owner";
        branchReq.user.hasOrgWideAccess = false;
        branchReq.user.branchAccess = [];

        Branch.findOne.mockResolvedValue({
          _id: branchId,
          organizationId: branchReq.user.organizationId,
          isActive: true,
        });

        const next = jest.fn();
        getBranchById(branchReq, branchRes, next);
        await new Promise((resolve) => setImmediate(resolve));
        expect(next).toHaveBeenCalledWith(expect.any(AppError));
        expect(next.mock.calls[0][0].message).toBe("Access denied. You do not have access to this branch.");
        expect(next.mock.calls[0][0].statusCode).toBe(403);
      });

      it("should deny access for 'admin' or 'superadmin' in authorize middleware if they lack the required permission (no role-name bypass)", async () => {
        const middleware = authorize("branches.create");
        branchReq.user.role = "admin";
        branchReq.user.hasOrgWideAccess = true;

        RoleRepository.prototype.findOne.mockResolvedValue({
          name: "admin",
          permissions: [{ name: "customer:view" }],
        });

        await expect(runMiddleware(middleware, branchReq, branchRes)).rejects.toThrow(
          new AppError("Access denied. You do not have the required permissions.", 403)
        );
      });

      it("should allow access for 'admin' or 'superadmin' if they are assigned the required permission", async () => {
        const middleware = authorize("branches.create");
        branchReq.user.role = "admin";
        branchReq.user.hasOrgWideAccess = true;

        RoleRepository.prototype.findOne.mockResolvedValue({
          name: "admin",
          permissions: [{ name: "branches.create" }],
        });

        await expect(runMiddleware(middleware, branchReq, branchRes)).resolves.toBeUndefined();
      });

      it("should deny access for Owner if they lack the required permission (no role-name bypass)", async () => {
        const middleware = authorize("branches.create");
        branchReq.user.role = "owner";
        branchReq.user.hasOrgWideAccess = false;

        RoleRepository.prototype.findOne.mockResolvedValue({
          name: "owner",
          permissions: [{ name: "customer:view" }],
        });

        await expect(runMiddleware(middleware, branchReq, branchRes)).rejects.toThrow(
          new AppError("Access denied. You do not have the required permissions.", 403)
        );
      });

      it("should allow access for Owner if they have the required permission", async () => {
        const middleware = authorize("branches.create");
        branchReq.user.role = "owner";
        branchReq.user.hasOrgWideAccess = false;

        RoleRepository.prototype.findOne.mockResolvedValue({
          name: "owner",
          permissions: [{ name: "branches.create" }],
        });

        await expect(runMiddleware(middleware, branchReq, branchRes)).resolves.toBeUndefined();
      });

      it("should allow access for a non-owner with the same permission if scope permits", async () => {
        const middleware = authorize("branches.create");
        branchReq.user.role = "manager";
        branchReq.user.hasOrgWideAccess = false;

        RoleRepository.prototype.findOne.mockResolvedValue({
          name: "manager",
          permissions: [{ name: "branches.create" }],
        });

        await expect(runMiddleware(middleware, branchReq, branchRes)).resolves.toBeUndefined();
      });

      it("should allow Owner with hasOrgWideAccess: true to operate organization-wide (e.g., skip branch access checks)", async () => {
        // Here we test that hasOrgWideAccess operates independently of functional permissions
        // We run requireBranchScope middleware to verify it accepts organization wide access
        const targetBranchId = new mongoose.Types.ObjectId().toString();
        const testReq = {
          headers: { "x-branch-id": targetBranchId },
          user: {
            id: "owner-123",
            role: "owner",
            hasOrgWideAccess: true,
            branchAccess: []
          }
        };
        const testRes = {};

        Branch.findOne.mockResolvedValue({
          _id: targetBranchId,
          organizationId: new mongoose.Types.ObjectId().toString(),
          isActive: true,
        });

        await expect(runMiddleware(requireBranchScope, testReq, testRes)).resolves.toBeUndefined();
        expect(testReq.branchId).toBe(targetBranchId);
      });

      describe("/api/v1/auth/me response structure", () => {
        let originalModel;
        let mockUserFindById;
        let mockRoleFindById;
        let mockBranchFind;

        beforeAll(() => {
          originalModel = mongoose.model;
        });

        afterAll(() => {
          mongoose.model = originalModel;
        });

        it("should return the expected resolved permissions and role for Owner in me response", async () => {
          mockUserFindById = jest.fn().mockReturnValue({
            populate: jest.fn().mockResolvedValue({
              _id: "owner-user-id",
              name: "John Owner",
              email: "owner@example.com",
              phone: "+12345",
              role: { _id: "role-owner-id", name: "owner" },
              organizationId: "org-id",
              hasOrgWideAccess: true,
              branchAccess: []
            })
          });

          mockRoleFindById = jest.fn().mockReturnValue({
            populate: jest.fn().mockResolvedValue({
              _id: "role-owner-id",
              name: "owner",
              permissions: [
                { name: "branches.create" },
                { name: "customer:view" }
              ]
            })
          });

          mockBranchFind = jest.fn().mockResolvedValue([]);

          mongoose.model = jest.fn().mockImplementation((modelName) => {
            if (modelName === "User") return { findById: mockUserFindById };
            if (modelName === "Role") return { findById: mockRoleFindById };
            if (modelName === "Branch") return { find: mockBranchFind };
            return originalModel(modelName);
          });

          const testReq = {
            user: { id: "owner-user-id" }
          };
          const testRes = {
            status: jest.fn().mockReturnThis(),
            json: jest.fn()
          };

          await new Promise((resolve, reject) => {
            const next = (err) => {
              if (err) reject(err);
              else resolve();
            };
            testRes.json = jest.fn().mockImplementation((data) => {
              testRes._json = data;
              resolve();
            });
            me(testReq, testRes, next);
          });

          expect(testRes.status).toHaveBeenCalledWith(200);
          expect(testRes.json).toHaveBeenCalledWith(expect.objectContaining({
            success: true,
            data: expect.objectContaining({
              role: "Owner",
              permissions: expect.arrayContaining(["branches.create", "customer:view"]),
              hasOrgWideAccess: true
            })
          }));
        });
      });
    });
  });
});
