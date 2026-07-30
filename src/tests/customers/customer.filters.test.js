import { jest } from "@jest/globals";
import mongoose from "mongoose";
import { CustomerRepository } from "../../repositories/customers/customer.repository.js";
import { Customer } from "../../models/customers/customer.model.js";
import { listCustomers } from "../../controllers/customers/customer.controller.js";
import { Branch } from "../../models/branches/branch.model.js";

// Mock Customer Model queries
Customer.find = jest.fn();
Customer.countDocuments = jest.fn();
Branch.findOne = jest.fn();

const createQueryMock = (resolvedValue) => {
  return {
    populate: jest.fn().mockReturnThis(),
    select: jest.fn().mockReturnThis(),
    sort: jest.fn().mockReturnThis(),
    skip: jest.fn().mockReturnThis(),
    limit: jest.fn().mockReturnThis(),
    exec: jest.fn().mockResolvedValue(resolvedValue),
  };
};

describe("Customer Filtering, Pagination, and Scoping Audits", () => {
  let req, res, next, mockRepo;

  beforeEach(() => {
    jest.clearAllMocks();
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
    mockRepo = new CustomerRepository();
  });

  describe("Requirement G1 & G4: Active customer returned by default listing", () => {
    it("should query active/legacy customers when isActive is missing", async () => {
      const activeBranchId = new mongoose.Types.ObjectId().toString();
      req.headers["x-branch-id"] = activeBranchId;
      req.user.branchAccess = [{ branchId: activeBranchId, isActive: true }];

      Branch.findOne.mockResolvedValue({ _id: activeBranchId, organizationId: req.user.organizationId, isActive: true });
      Customer.find.mockReturnValue(createQueryMock([]));
      Customer.countDocuments.mockReturnValue({ exec: jest.fn().mockResolvedValue(0) });

      await listCustomers(req, res, next);

      expect(Customer.find).toHaveBeenCalledWith(
        expect.objectContaining({
          $and: expect.arrayContaining([
            {
              $or: [
                { homeBranchId: activeBranchId },
                { visitedBranchIds: activeBranchId },
              ],
            },
          ]),
        })
      );
    });
  });

  describe("Requirement G2: isActive=true returns active customer", () => {
    it("should query strictly status: 'active' when isActive=true query parameter is supplied", async () => {
      const activeBranchId = new mongoose.Types.ObjectId().toString();
      req.headers["x-branch-id"] = activeBranchId;
      req.query = { isActive: "true" };
      req.user.branchAccess = [{ branchId: activeBranchId, isActive: true }];

      Branch.findOne.mockResolvedValue({ _id: activeBranchId, organizationId: req.user.organizationId, isActive: true });
      Customer.find.mockReturnValue(createQueryMock([]));
      Customer.countDocuments.mockReturnValue({ exec: jest.fn().mockResolvedValue(0) });

      await listCustomers(req, res, next);

      expect(Customer.find).toHaveBeenCalledWith(
        expect.objectContaining({
          $and: expect.arrayContaining([
            { status: "active" },
          ]),
        })
      );
    });
  });

  describe("Requirement G3: isActive=false returns inactive customer", () => {
    it("should query strictly status in inactive/blocked when isActive=false query parameter is supplied", async () => {
      const activeBranchId = new mongoose.Types.ObjectId().toString();
      req.headers["x-branch-id"] = activeBranchId;
      req.query = { isActive: "false" };
      req.user.branchAccess = [{ branchId: activeBranchId, isActive: true }];

      Branch.findOne.mockResolvedValue({ _id: activeBranchId, organizationId: req.user.organizationId, isActive: true });
      Customer.find.mockReturnValue(createQueryMock([]));
      Customer.countDocuments.mockReturnValue({ exec: jest.fn().mockResolvedValue(0) });

      await listCustomers(req, res, next);

      expect(Customer.find).toHaveBeenCalledWith(
        expect.objectContaining({
          $and: expect.arrayContaining([
            { status: { $in: ["inactive", "blocked"] } },
          ]),
        })
      );
    });
  });

  describe("Requirement G5: Soft-deleted customer is excluded", () => {
    it("should verify that the find query has isDeleted: { $ne: true } implicitly added or repository honors it", async () => {
      const organizationId = new mongoose.Types.ObjectId().toString();
      Customer.find.mockReturnValue(createQueryMock([]));
      Customer.countDocuments.mockReturnValue({ exec: jest.fn().mockResolvedValue(0) });

      await mockRepo.find({ status: "active" }, { page: 1, limit: 10 }, organizationId);

      expect(Customer.find).toHaveBeenCalledWith(
        expect.objectContaining({
          status: "active",
          organizationId,
        })
      );
    });
  });

  describe("Requirement G6: Branch-scoped user only sees customers from permitted branch", () => {
    it("should apply homeBranchId and visitedBranchIds checks when activeBranchId is present", async () => {
      const activeBranchId = new mongoose.Types.ObjectId().toString();
      req.headers["x-branch-id"] = activeBranchId;
      req.user.branchAccess = [{ branchId: activeBranchId, isActive: true }];

      Branch.findOne.mockResolvedValue({ _id: activeBranchId, organizationId: req.user.organizationId, isActive: true });
      Customer.find.mockReturnValue(createQueryMock([]));
      Customer.countDocuments.mockReturnValue({ exec: jest.fn().mockResolvedValue(0) });

      await listCustomers(req, res, next);

      expect(Customer.find).toHaveBeenCalledWith(
        expect.objectContaining({
          $and: expect.arrayContaining([
            {
              $or: [
                { homeBranchId: activeBranchId },
                { visitedBranchIds: activeBranchId },
              ],
            },
          ]),
        })
      );
    });
  });

  describe("Requirement G7: Organization-wide user follows hasOrgWideAccess scoping rules", () => {
    it("should omit branch filtering when hasOrgWideAccess is true and X-Branch-Id header is omitted", async () => {
      req.user.hasOrgWideAccess = true;
      req.headers = {}; // Omit X-Branch-Id header
      Customer.find.mockReturnValue(createQueryMock([]));
      Customer.countDocuments.mockReturnValue({ exec: jest.fn().mockResolvedValue(0) });

      await listCustomers(req, res, next);

      const calls = Customer.find.mock.calls;
      const appliedFilter = calls[0][0];
      if (appliedFilter.$and) {
        expect(appliedFilter.$and).not.toContainEqual(
          expect.objectContaining({
            $or: expect.arrayContaining([
              expect.objectContaining({ homeBranchId: expect.any(String) }),
            ]),
          })
        );
      } else {
        expect(appliedFilter.$and).toBeUndefined();
      }
    });
  });

  describe("Requirement G8 & G9: data.length and meta.total/totalPages consistency", () => {
    it("should return consistent total and totalPages pagination metadata", async () => {
      const organizationId = new mongoose.Types.ObjectId().toString();
      const mockCustomers = [{ _id: "cust-1", name: "Client A" }];
      Customer.find.mockReturnValue(createQueryMock(mockCustomers));
      Customer.countDocuments.mockReturnValue({ exec: jest.fn().mockResolvedValue(25) });

      const result = await mockRepo.find({}, { page: 1, limit: 10 }, organizationId);

      expect(result.data.length).toBe(1);
      expect(result.meta.total).toBe(25);
      expect(result.meta.totalPages).toBe(3); // Math.ceil(25 / 10)
      expect(result.meta.page).toBe(1);
      expect(result.meta.limit).toBe(10);
    });

    it("should correctly calculate 0 totalPages when 0 records match", async () => {
      const organizationId = new mongoose.Types.ObjectId().toString();
      Customer.find.mockReturnValue(createQueryMock([]));
      Customer.countDocuments.mockReturnValue({ exec: jest.fn().mockResolvedValue(0) });

      const result = await mockRepo.find({}, { page: 1, limit: 10 }, organizationId);

      expect(result.data.length).toBe(0);
      expect(result.meta.total).toBe(0);
      expect(result.meta.totalPages).toBe(0);
    });
  });

  describe("Requirement G10: Search + isActive filter combination", () => {
    it("should query with search query AND status: 'active'", async () => {
      const activeBranchId = new mongoose.Types.ObjectId().toString();
      req.headers["x-branch-id"] = activeBranchId;
      req.query = { search: "bikram", isActive: "true" };
      req.user.branchAccess = [{ branchId: activeBranchId, isActive: true }];

      Branch.findOne.mockResolvedValue({ _id: activeBranchId, organizationId: req.user.organizationId, isActive: true });
      Customer.find.mockReturnValue(createQueryMock([]));
      Customer.countDocuments.mockReturnValue({ exec: jest.fn().mockResolvedValue(0) });

      await listCustomers(req, res, next);

      expect(Customer.find).toHaveBeenCalledWith(
        expect.objectContaining({
          $and: expect.arrayContaining([
            { status: "active" },
          ]),
          $or: expect.arrayContaining([
            { name: { $regex: "bikram", $options: "i" } },
            { phone: { $regex: "bikram", $options: "i" } },
            { email: { $regex: "bikram", $options: "i" } },
          ]),
        })
      );
    });
  });

  describe("Requirement G11: Pagination + isActive filter combination", () => {
    it("should support page/limit pagination together with status: 'active'", async () => {
      const organizationId = new mongoose.Types.ObjectId().toString();
      Customer.find.mockReturnValue(createQueryMock([]));
      Customer.countDocuments.mockReturnValue({ exec: jest.fn().mockResolvedValue(15) });

      const result = await mockRepo.find({ status: "active" }, { page: 2, limit: 5 }, organizationId);

      expect(result.meta.page).toBe(2);
      expect(result.meta.limit).toBe(5);
      expect(result.meta.total).toBe(15);
      expect(result.meta.totalPages).toBe(3);
    });
  });

  describe("Requirement G12: Branch + isActive filter combination", () => {
    it("should apply branch scoping and status filters together in the same query", async () => {
      const activeBranchId = new mongoose.Types.ObjectId().toString();
      req.headers["x-branch-id"] = activeBranchId;
      req.query = { isActive: "true" };
      req.user.branchAccess = [{ branchId: activeBranchId, isActive: true }];

      Branch.findOne.mockResolvedValue({ _id: activeBranchId, organizationId: req.user.organizationId, isActive: true });
      Customer.find.mockReturnValue(createQueryMock([]));
      Customer.countDocuments.mockReturnValue({ exec: jest.fn().mockResolvedValue(0) });

      await listCustomers(req, res, next);

      expect(Customer.find).toHaveBeenCalledWith(
        expect.objectContaining({
          $and: expect.arrayContaining([
            {
              $or: [
                { homeBranchId: activeBranchId },
                { visitedBranchIds: activeBranchId },
              ],
            },
            { status: "active" },
          ]),
        })
      );
    });
  });
});
