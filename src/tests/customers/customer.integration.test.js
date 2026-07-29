import { jest } from "@jest/globals";
import mongoose from "mongoose";
import { AppError } from "../../utils/errors.js";
import { Branch } from "../../models/branches/branch.model.js";
import { Customer } from "../../models/customers/customer.model.js";
import { CustomerService } from "../../services/customers/customer.service.js";
import {
  createCustomer,
  listCustomers,
  getCustomerById,
  updateCustomer,
  deleteCustomer,
  addNote,
} from "../../controllers/customers/customer.controller.js";

// Mock the models and DB queries
Branch.findOne = jest.fn();
Customer.findOne = jest.fn();
Customer.findById = jest.fn();
Customer.findOneAndUpdate = jest.fn();

// Robust mongoose query mock creator
const createQueryMock = (resolvedValue) => {
  return {
    populate: jest.fn().mockReturnThis(),
    select: jest.fn().mockReturnThis(),
    session: jest.fn().mockReturnThis(),
    exec: jest.fn().mockResolvedValue(resolvedValue),
    then: function (onResolve, onReject) {
      return Promise.resolve(resolvedValue).then(onResolve, onReject);
    },
  };
};

describe("Customer Core Integration & Scoping Tests", () => {
  let req;
  let res;
  let next;

  beforeEach(() => {
    jest.clearAllMocks();
    Customer.findOneAndUpdate.mockResolvedValue({});
    req = {
      headers: {},
      query: {},
      params: {},
      body: {},
      organizationId: new mongoose.Types.ObjectId().toString(),
      user: {
        id: "user-123",
        organizationId: new mongoose.Types.ObjectId().toString(),
        branchAccess: [],
        hasOrgWideAccess: false,
      },
    };
    res = {
      status: jest.fn().mockReturnThis(),
      json: jest.fn(),
    };
    next = jest.fn();
  });

  describe("Organization Isolation", () => {
    it("should throw 403 or 404 if a user from Org A tries to access a customer in Org B", async () => {
      req.user.organizationId = "org-A";
      req.organizationId = "org-A";
      req.params.id = new mongoose.Types.ObjectId().toString();
      req.headers["x-branch-id"] = new mongoose.Types.ObjectId().toString();

      // Mock Branch check success
      Branch.findOne.mockResolvedValue({ _id: req.headers["x-branch-id"], organizationId: "org-A", isActive: true });
      req.user.branchAccess = [{ branchId: req.headers["x-branch-id"], isActive: true }];

      // Customer is in Org B
      Customer.findOne.mockReturnValue(createQueryMock(null)); 

      await getCustomerById(req, res, next);

      expect(next).toHaveBeenCalledWith(expect.any(AppError));
      expect(next.mock.calls[0][0].statusCode).toBe(404);
      expect(next.mock.calls[0][0].message).toBe("Resource not found");
    });
  });

  describe("Branch-Limited Visibility", () => {
    it("should allow access if X-Branch-Id matches customer's homeBranchId", async () => {
      const activeBranchId = new mongoose.Types.ObjectId().toString();
      req.headers["x-branch-id"] = activeBranchId;
      req.params.id = new mongoose.Types.ObjectId().toString();
      req.user.branchAccess = [{ branchId: activeBranchId, isActive: true }];

      Branch.findOne.mockResolvedValue({ _id: activeBranchId, organizationId: req.user.organizationId, isActive: true });

      const mockCustomer = {
        _id: req.params.id,
        organizationId: req.user.organizationId,
        homeBranchId: activeBranchId,
        visitedBranchIds: [],
      };
      Customer.findOne.mockReturnValue(createQueryMock(mockCustomer));

      await getCustomerById(req, res, next);

      expect(next).not.toHaveBeenCalled();
      expect(res.status).toHaveBeenCalledWith(200);
      expect(res.json).toHaveBeenCalledWith(
        expect.objectContaining({
          success: true,
          message: "Customer retrieved successfully",
        })
      );
    });

    it("should allow access if activeBranchId is in visitedBranchIds", async () => {
      const activeBranchId = new mongoose.Types.ObjectId().toString();
      const otherBranchId = new mongoose.Types.ObjectId().toString();
      req.headers["x-branch-id"] = activeBranchId;
      req.params.id = new mongoose.Types.ObjectId().toString();
      req.user.branchAccess = [{ branchId: activeBranchId, isActive: true }];

      Branch.findOne.mockResolvedValue({ _id: activeBranchId, organizationId: req.user.organizationId, isActive: true });

      const mockCustomer = {
        _id: req.params.id,
        organizationId: req.user.organizationId,
        homeBranchId: otherBranchId,
        visitedBranchIds: [activeBranchId],
      };
      Customer.findOne.mockReturnValue(createQueryMock(mockCustomer));

      await getCustomerById(req, res, next);

      expect(next).not.toHaveBeenCalled();
      expect(res.status).toHaveBeenCalledWith(200);
    });

    it("should deny access (403) if activeBranchId is neither homeBranchId nor in visitedBranchIds", async () => {
      const activeBranchId = new mongoose.Types.ObjectId().toString();
      const otherBranchId = new mongoose.Types.ObjectId().toString();
      req.headers["x-branch-id"] = activeBranchId;
      req.params.id = new mongoose.Types.ObjectId().toString();
      req.user.branchAccess = [{ branchId: activeBranchId, isActive: true }];

      Branch.findOne.mockResolvedValue({ _id: activeBranchId, organizationId: req.user.organizationId, isActive: true });

      const mockCustomer = {
        _id: req.params.id,
        organizationId: req.user.organizationId,
        homeBranchId: otherBranchId,
        visitedBranchIds: [],
      };
      Customer.findOne.mockReturnValue(createQueryMock(mockCustomer));

      await getCustomerById(req, res, next);

      expect(next).toHaveBeenCalledWith(expect.any(AppError));
      expect(next.mock.calls[0][0].statusCode).toBe(403);
      expect(next.mock.calls[0][0].message).toContain("Customer is not visible within your active branch scope");
    });
  });

  describe("Org-Wide Scope", () => {
    it("should permit org-wide access when hasOrgWideAccess is true and X-Branch-Id is omitted", async () => {
      req.user.hasOrgWideAccess = true;
      req.params.id = new mongoose.Types.ObjectId().toString();

      const mockCustomer = {
        _id: req.params.id,
        organizationId: req.user.organizationId,
        homeBranchId: new mongoose.Types.ObjectId().toString(),
        visitedBranchIds: [],
      };
      Customer.findOne.mockReturnValue(createQueryMock(mockCustomer));

      await getCustomerById(req, res, next);

      expect(next).not.toHaveBeenCalled();
      expect(res.status).toHaveBeenCalledWith(200);
    });

    it("should restrict to active branch when hasOrgWideAccess is true but X-Branch-Id is explicitly passed", async () => {
      req.user.hasOrgWideAccess = true;
      const activeBranchId = new mongoose.Types.ObjectId().toString();
      const otherBranchId = new mongoose.Types.ObjectId().toString();
      req.headers["x-branch-id"] = activeBranchId;
      req.params.id = new mongoose.Types.ObjectId().toString();

      Branch.findOne.mockResolvedValue({ _id: activeBranchId, organizationId: req.user.organizationId, isActive: true });

      // Customer belongs strictly to otherBranch
      const mockCustomer = {
        _id: req.params.id,
        organizationId: req.user.organizationId,
        homeBranchId: otherBranchId,
        visitedBranchIds: [],
      };
      Customer.findOne.mockReturnValue(createQueryMock(mockCustomer));

      await getCustomerById(req, res, next);

      expect(next).toHaveBeenCalledWith(expect.any(AppError));
      expect(next.mock.calls[0][0].statusCode).toBe(403);
    });

    it("should reject X-Branch-Id belonging to another organization", async () => {
      req.user.hasOrgWideAccess = true;
      const foreignBranchId = new mongoose.Types.ObjectId().toString();
      req.headers["x-branch-id"] = foreignBranchId;

      Branch.findOne.mockResolvedValue(null); // Not found under user's org

      await getCustomerById(req, res, next);

      expect(next).toHaveBeenCalledWith(expect.any(AppError));
      expect(next.mock.calls[0][0].statusCode).toBe(404);
    });
  });

  describe("all Sentinel Rejection", () => {
    it("should fail validation with 400 when X-Branch-Id is 'all'", async () => {
      req.headers["x-branch-id"] = "all";

      await getCustomerById(req, res, next);

      expect(next).toHaveBeenCalledWith(expect.any(AppError));
      expect(next.mock.calls[0][0].statusCode).toBe(400);
      expect(next.mock.calls[0][0].message).toBe("Invalid branch ID format.");
    });
  });

  describe("Customer Creation", () => {
    it("should reject creation if X-Branch-Id is omitted for org-wide user", async () => {
      req.user.hasOrgWideAccess = true;
      req.body = { name: "New Client", phone: "+919999988888" };

      await createCustomer(req, res, next);

      expect(next).toHaveBeenCalledWith(expect.any(AppError));
      expect(next.mock.calls[0][0].statusCode).toBe(400);
      expect(next.mock.calls[0][0].message).toBe("X-Branch-Id header is required to create a customer.");
    });

    it("should ignore homeBranchId passed manually in body", async () => {
      const activeBranchId = new mongoose.Types.ObjectId().toString();
      const userSuppliedHomeBranch = new mongoose.Types.ObjectId().toString();
      req.headers["x-branch-id"] = activeBranchId;
      req.body = { name: "New Client", phone: "+919999988888", homeBranchId: userSuppliedHomeBranch };
      req.user.branchAccess = [{ branchId: activeBranchId, isActive: true }];

      Branch.findOne.mockResolvedValue({ _id: activeBranchId, organizationId: req.user.organizationId, isActive: true });

      const saveMock = jest.fn().mockImplementation(function () {
        return Promise.resolve(this);
      });
      // Mock Customer constructor behavior
      jest.spyOn(Customer.prototype, "save").mockImplementation(saveMock);

      await createCustomer(req, res, next);

      // Verify it was saved with header branch ID and not body-supplied branch ID
      const savedInstance = saveMock.mock.instances[0];
      expect(savedInstance.homeBranchId.toString()).toBe(activeBranchId);
      expect(savedInstance.homeBranchId.toString()).not.toBe(userSuppliedHomeBranch);
    });
  });

  describe("homeBranchId Immutability and Hardening", () => {
    let activeBranchId;
    let mockCustomer;

    beforeEach(() => {
      activeBranchId = new mongoose.Types.ObjectId().toString();
      req.headers["x-branch-id"] = activeBranchId;
      req.params.id = new mongoose.Types.ObjectId().toString();
      req.user.branchAccess = [{ branchId: activeBranchId, isActive: true }];

      Branch.findOne.mockResolvedValue({ _id: activeBranchId, organizationId: req.user.organizationId, isActive: true });

      mockCustomer = {
        _id: req.params.id,
        organizationId: req.user.organizationId,
        homeBranchId: activeBranchId,
        visitedBranchIds: [],
        name: "Old Name",
        phone: "+919999999999",
        isActive: true,
        save: jest.fn().mockImplementation(function () {
          return Promise.resolve(this);
        }),
      };

      Customer.findOne.mockReturnValue(createQueryMock(mockCustomer));
    });

    it("Test 1 — should reject explicit attempt to update homeBranchId", async () => {
      req.body = {
        homeBranchId: new mongoose.Types.ObjectId().toString(),
      };

      await updateCustomer(req, res, next);

      expect(next).toHaveBeenCalledWith(expect.any(AppError));
      const err = next.mock.calls[0][0];
      expect(err.statusCode).toBe(400);
      expect(err.message).toBe("Immutable customer fields cannot be modified");
      expect(err.errors).toEqual([
        {
          field: "homeBranchId",
          message: "homeBranchId cannot be modified after customer creation",
        },
      ]);
      expect(mockCustomer.homeBranchId.toString()).toBe(activeBranchId);
    });

    it("Test 2 — should reject explicit attempt to update organizationId", async () => {
      req.body = {
        organizationId: "some-new-org",
      };

      await updateCustomer(req, res, next);

      expect(next).toHaveBeenCalledWith(expect.any(AppError));
      const err = next.mock.calls[0][0];
      expect(err.statusCode).toBe(400);
      expect(err.message).toBe("Immutable customer fields cannot be modified");
      expect(err.errors).toEqual([
        {
          field: "organizationId",
          message: "organizationId cannot be modified after customer creation",
        },
      ]);
      expect(mockCustomer.organizationId).toBe(req.user.organizationId);
    });

    it("Test 3 — should reject explicit attempt to update visitedBranchIds", async () => {
      req.body = {
        visitedBranchIds: [new mongoose.Types.ObjectId().toString()],
      };

      await updateCustomer(req, res, next);

      expect(next).toHaveBeenCalledWith(expect.any(AppError));
      const err = next.mock.calls[0][0];
      expect(err.statusCode).toBe(400);
      expect(err.message).toBe("Immutable customer fields cannot be modified");
      expect(err.errors).toEqual([
        {
          field: "visitedBranchIds",
          message: "visitedBranchIds cannot be modified after customer creation",
        },
      ]);
      expect(mockCustomer.visitedBranchIds).toEqual([]);
    });

    it("Test 4 — Mixed valid and immutable fields (should reject entire update)", async () => {
      req.body = {
        name: "Updated Name",
        homeBranchId: new mongoose.Types.ObjectId().toString(),
      };

      await updateCustomer(req, res, next);

      expect(next).toHaveBeenCalledWith(expect.any(AppError));
      const err = next.mock.calls[0][0];
      expect(err.statusCode).toBe(400);
      expect(mockCustomer.name).toBe("Old Name"); // Remains unchanged
      expect(mockCustomer.homeBranchId.toString()).toBe(activeBranchId);
    });

    it("Test 5 — Valid update without immutable fields", async () => {
      req.body = {
        name: "Updated Name",
        phone: "+918888888888",
      };

      await updateCustomer(req, res, next);

      expect(next).not.toHaveBeenCalled();
      expect(res.status).toHaveBeenCalledWith(200);
      expect(mockCustomer.name).toBe("Updated Name");
      expect(mockCustomer.phone).toBe("+918888888888");
    });

    it("Test 6 — should reject updates if customer is deactivated and body does not reactivate them", async () => {
      mockCustomer.isActive = false;
      req.body = {
        name: "Updated Name",
      };

      await updateCustomer(req, res, next);

      expect(next).toHaveBeenCalledWith(expect.any(AppError));
      expect(next.mock.calls[0][0].statusCode).toBe(400);
      expect(next.mock.calls[0][0].message).toBe("Cannot perform operations on a deactivated customer profile.");
    });
  });

  describe("Customer List Filtering and Sorting", () => {
    it("should query customers defaulting to active-only (true or missing isActive) and using safe sorting options", async () => {
      const activeBranchId = new mongoose.Types.ObjectId().toString();
      req.headers["x-branch-id"] = activeBranchId;
      req.query = { page: 1, limit: 10, sort: "name" };
      req.user.branchAccess = [{ branchId: activeBranchId, isActive: true }];

      Branch.findOne.mockResolvedValue({ _id: activeBranchId, organizationId: req.user.organizationId, isActive: true });
      CustomerService.prototype.listCustomers = jest.fn().mockResolvedValue({ data: [], meta: {} });

      await listCustomers(req, res, next);

      expect(CustomerService.prototype.listCustomers).toHaveBeenCalledWith(
        expect.objectContaining({
          $and: expect.arrayContaining([
            {
              $or: [
                { homeBranchId: activeBranchId },
                { visitedBranchIds: activeBranchId }
              ]
            },
            {
              $or: [
                { isActive: true },
                { isActive: { $exists: false } }
              ]
            }
          ])
        }),
        expect.objectContaining({ sort: { name: 1, _id: 1 } }),
        req.organizationId
      );
    });

    it("should query customers matching explicitly inactive when queried", async () => {
      const activeBranchId = new mongoose.Types.ObjectId().toString();
      req.headers["x-branch-id"] = activeBranchId;
      req.query = { page: 1, limit: 10, sort: "name", isActive: "false" };
      req.user.branchAccess = [{ branchId: activeBranchId, isActive: true }];

      Branch.findOne.mockResolvedValue({ _id: activeBranchId, organizationId: req.user.organizationId, isActive: true });
      CustomerService.prototype.listCustomers = jest.fn().mockResolvedValue({ data: [], meta: {} });

      await listCustomers(req, res, next);

      expect(CustomerService.prototype.listCustomers).toHaveBeenCalledWith(
        expect.objectContaining({
          $and: expect.arrayContaining([
            { isActive: false }
          ])
        }),
        expect.any(Object),
        req.organizationId
      );
    });

    it("should update legacy customers and exclude soft-deleted ones (migration logic)", async () => {
      Customer.updateMany = jest.fn().mockResolvedValue({ matchedCount: 1, modifiedCount: 1 });
      const { migrateCustomersLogic } = await import("../../scripts/migrateCustomers.js");
      const result = await migrateCustomersLogic();
      expect(Customer.updateMany).toHaveBeenCalledWith(
        { isActive: { $exists: false }, isDeleted: { $ne: true } },
        { $set: { isActive: true } }
      );
      expect(result.matchedCount).toBe(1);
      expect(result.modifiedCount).toBe(1);
    });
  });
});
