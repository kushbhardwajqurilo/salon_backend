import { jest } from "@jest/globals";
import mongoose from "mongoose";
import { CustomerService } from "../../services/customers/customer.service.js";
import { CustomerNoteService } from "../../services/customers/customerNote.service.js";
import { AuditLogService } from "../../services/audit/auditLog.service.js";
import { AppError } from "../../utils/errors.js";

// Mock the models
import { Customer } from "../../models/customers/customer.model.js";
import { CustomerNote } from "../../models/customers/customerNote.model.js";
import { AuditLog } from "../../models/audit/auditLog.model.js";
import { Branch } from "../../models/branches/branch.model.js";

Branch.findOne = jest.fn();
Branch.find = jest.fn();
Customer.findOne = jest.fn();
Customer.findById = jest.fn();
Customer.findOneAndUpdate = jest.fn();
Customer.find = jest.fn().mockReturnValue({
  setOptions: jest.fn().mockResolvedValue([]),
});
Customer.syncIndexes = jest.fn();

AuditLog.create = jest.fn().mockResolvedValue({});
AuditLog.findOne = jest.fn();
AuditLog.find = jest.fn();
AuditLog.syncIndexes = jest.fn().mockResolvedValue(true);
AuditLog.prototype.save = jest.fn().mockImplementation(function () { return Promise.resolve(this); });

CustomerNote.create = jest.fn().mockResolvedValue({});
CustomerNote.findOne = jest.fn();
CustomerNote.find = jest.fn();
CustomerNote.syncIndexes = jest.fn().mockResolvedValue(true);
CustomerNote.prototype.save = jest.fn().mockImplementation(function () { return Promise.resolve(this); });

const createQueryMock = (resolvedValue) => {
  return {
    populate: jest.fn().mockReturnThis(),
    select: jest.fn().mockReturnThis(),
    sort: jest.fn().mockReturnThis(),
    skip: jest.fn().mockReturnThis(),
    limit: jest.fn().mockReturnThis(),
    setOptions: jest.fn().mockReturnThis(),
    exec: jest.fn().mockResolvedValue(resolvedValue),
  };
};

describe("Customer Upgraded Architecture Tests", () => {
  let customerService;
  let noteService;
  let auditService;
  let mockCustomerRepo;
  let mockNoteRepo;
  let mockAuditRepo;

  beforeEach(() => {
    jest.clearAllMocks();

    mockCustomerRepo = {
      create: jest.fn(),
      findById: jest.fn(),
      updateById: jest.fn(),
      deleteById: jest.fn(),
      findByPhone: jest.fn(),
      findByIdIncludeDeleted: jest.fn(),
      reactivateById: jest.fn(),
      statusUpdateById: jest.fn(),
    };

    mockNoteRepo = {
      create: jest.fn(),
      findByCustomer: jest.fn(),
    };

    mockAuditRepo = {
      create: jest.fn(),
      find: jest.fn(),
    };

    customerService = new CustomerService(mockCustomerRepo, mockAuditRepo);
    noteService = new CustomerNoteService(mockNoteRepo, mockAuditRepo);
    auditService = new AuditLogService(mockAuditRepo);
  });

  describe("A. Customer Model & Lifecycle", () => {
    it("should normalize phone numbers on update operations", async () => {
      const mockCustomer = {
        _id: "customer-1",
        phone: "+15555555555",
        status: "active",
        homeBranchId: "branch-1",
        visitedBranchIds: [],
        organizationId: "org-1",
      };
      mockCustomerRepo.findById.mockResolvedValue(mockCustomer);
      mockCustomerRepo.updateById.mockResolvedValue({ ...mockCustomer, phone: "9999999999" });

      await customerService.updateCustomer(
        "customer-1",
        { phone: " (999) 999-9999 " },
        "org-1",
        "user-1",
        { hasOrgWideAccess: true }
      );

      expect(mockCustomerRepo.updateById).toHaveBeenCalledWith(
        "customer-1",
        expect.objectContaining({ phone: "9999999999" }),
        "org-1",
        "user-1"
      );
    });

    it("should reject update if referredByCustomerId references self", async () => {
      const mockCustomer = {
        _id: "customer-1",
        phone: "+15555555555",
        status: "active",
        homeBranchId: "branch-1",
        visitedBranchIds: [],
        organizationId: "org-1",
      };
      mockCustomerRepo.findById.mockResolvedValue(mockCustomer);

      await expect(
        customerService.updateCustomer(
          "customer-1",
          { referredByCustomerId: "customer-1" },
          "org-1",
          "user-1",
          { hasOrgWideAccess: true }
        )
      ).rejects.toThrow("A customer cannot refer themselves.");
    });
  });

  describe("B. CustomerNote Creation & Scoping", () => {
    it("should successfully create a note and audit log event", async () => {
      const mockCustomer = {
        _id: "customer-1",
        status: "active",
        homeBranchId: "branch-1",
        visitedBranchIds: [],
        organizationId: "org-1",
      };
      jest.spyOn(mongoose, "model").mockImplementation((name) => {
        if (name === "Customer") {
          return {
            findOne: jest.fn().mockResolvedValue(mockCustomer),
          };
        }
        if (name === "Branch") {
          return {
            findOne: jest.fn().mockResolvedValue({ _id: "branch-1", organizationId: "org-1", isActive: true }),
          };
        }
        return {};
      });

      mockNoteRepo.create.mockResolvedValue({ _id: "note-1", text: "New Note Content" });
      mockAuditRepo.create.mockResolvedValue({});

      const result = await noteService.createNote(
        "customer-1",
        " New Note Content ",
        "org-1",
        "branch-1",
        "user-1"
      );

      expect(result.text).toBe("New Note Content");
      expect(mockNoteRepo.create).toHaveBeenCalledWith(
        expect.objectContaining({ text: "New Note Content", branchId: "branch-1" }),
        "org-1",
        "user-1"
      );
      expect(mockAuditRepo.create).toHaveBeenCalledWith(
        expect.objectContaining({
          action: "NOTE_ADDED",
          entityType: "Customer",
          description: 'Added note: "New Note Content"',
        }),
        "org-1",
        "user-1"
      );
    });

    it("should enforce branch isolation for note viewing", async () => {
      const mockCustomer = {
        _id: "customer-1",
        status: "active",
        homeBranchId: "branch-1",
        visitedBranchIds: ["branch-2"],
        organizationId: "org-1",
      };
      jest.spyOn(mongoose, "model").mockImplementation((name) => {
        if (name === "Customer") {
          return {
            findOne: jest.fn().mockResolvedValue(mockCustomer),
          };
        }
        return {};
      });

      await expect(
        noteService.getNotes("customer-1", "org-1", "branch-3", {})
      ).rejects.toThrow("Access denied. Customer is not visible within your active branch scope.");
    });
  });

  describe("C. AuditLog Administrative Logging", () => {
    it("should list audit logs newest-first", async () => {
      mockAuditRepo.find.mockResolvedValue({
        data: [{ action: "CUSTOMER_UPDATED", createdAt: new Date() }],
        meta: {},
      });

      await auditService.getAuditLogs({ entityId: "customer-1" }, {}, "org-1");

      expect(mockAuditRepo.find).toHaveBeenCalledWith(
        { entityId: "customer-1", organizationId: "org-1" },
        expect.objectContaining({ sort: { createdAt: -1, _id: -1 } }),
        expect.anything()
      );
    });
  });

  describe("H. Migration Idempotency", () => {
    it("should map legacy notes to CustomerNote with idempotency checks", async () => {
      const { migrateCustomersLogic } = await import("../../scripts/migrateCustomers.js");

      // Setup raw database mock array
      const rawCustomer = {
        _id: new mongoose.Types.ObjectId(),
        organizationId: "org-1",
        homeBranchId: "branch-1",
        notes: [
          { text: "Legacy Note 1", createdBy: "user-1", createdAt: new Date() },
        ],
      };

      Object.defineProperty(mongoose.connection, "db", {
        get: () => ({
          collection: () => ({
            find: () => ({
              toArray: async () => [rawCustomer],
            }),
          }),
        }),
        configurable: true,
      });

      // Simulate Note already exists
      CustomerNote.findOne = jest.fn().mockResolvedValue({ _id: "existing-note" });

      const result = await migrateCustomersLogic();
      expect(result.notesMigrated).toBe(0);
      expect(result.notesSkipped).toBe(1);
    });
  });
});
