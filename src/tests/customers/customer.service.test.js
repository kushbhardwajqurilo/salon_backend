import { jest } from "@jest/globals";
import mongoose from "mongoose";
import { CustomerService } from "../../services/customers/customer.service.js";
import { CustomerNoteService } from "../../services/customers/customerNote.service.js";
import { AppError } from "../../utils/errors.js";

// Mock Mongoose model function
mongoose.model = jest.fn().mockImplementation((modelName) => {
  if (modelName === "Branch") {
    return {
      findOne: jest.fn().mockResolvedValue({ _id: "branch-123", organizationId: "org-789", isActive: true }),
      find: jest.fn().mockResolvedValue([{ _id: "branch-123", organizationId: "org-789", isActive: true }]),
    };
  }
  if (modelName === "User") {
    return {
      find: jest.fn().mockResolvedValue([]),
    };
  }
  if (modelName === "Customer") {
    return {
      findOne: jest.fn().mockResolvedValue({ _id: "customer-1", homeBranchId: "branch-123", organizationId: "org-789", status: "active" }),
    };
  }
  return {};
});

describe("CustomerService Unit Tests", () => {
  let customerService;
  let mockCustomerRepo;
  let mockAuditRepo;

  beforeEach(() => {
    jest.clearAllMocks();
    mockCustomerRepo = {
      findOne: jest.fn(),
      findById: jest.fn(),
      findByIdIncludeDeleted: jest.fn(),
      findByPhone: jest.fn(),
      create: jest.fn(),
      updateById: jest.fn(),
      deleteById: jest.fn(),
      find: jest.fn(),
      reactivateById: jest.fn(),
      statusUpdateById: jest.fn(),
    };
    mockAuditRepo = {
      create: jest.fn().mockResolvedValue({}),
      find: jest.fn().mockResolvedValue([]),
    };

    customerService = new CustomerService(mockCustomerRepo, mockAuditRepo);
  });

  describe("createCustomer", () => {
    it("should throw an error if homeBranchId is missing", async () => {
      await expect(
        customerService.createCustomer({ phone: "+919999988888", name: "Test" }, "org-789", "user-123")
      ).rejects.toThrow(new AppError("homeBranchId is required to create a customer.", 400));
    });

    it("should create customer and write customer_created timeline event", async () => {
      mockCustomerRepo.findByPhone.mockResolvedValue(null);
      const mockCustomer = {
        _id: "new-customer-id",
        phone: "+919999988888",
        name: "Test",
        homeBranchId: "branch-123",
        organizationId: "org-789",
        status: "active"
      };
      mockCustomerRepo.create.mockResolvedValue(mockCustomer);

      const result = await customerService.createCustomer(
        { phone: "+919999988888", name: "Test", homeBranchId: "branch-123" },
        "org-789",
        "user-123"
      );

      expect(result).toEqual(mockCustomer);
      expect(mockCustomerRepo.create).toHaveBeenCalledWith(
        expect.objectContaining({ phone: "+919999988888", name: "Test", homeBranchId: "branch-123" }),
        "org-789",
        "user-123"
      );
      expect(mockAuditRepo.create).toHaveBeenCalledWith(
        expect.objectContaining({
          action: "CUSTOMER_CREATED",
          entityType: "Customer",
          entityId: "new-customer-id",
        }),
        "org-789",
        "user-123"
      );
    });
  });

  describe("getCustomerById", () => {
    it("should allow reading if user is org-wide", async () => {
      const mockCustomer = {
        _id: "customer-1",
        homeBranchId: "branch-2",
        visitedBranchIds: [],
        organizationId: "org-789",
        status: "active",
      };
      mockCustomerRepo.findById.mockResolvedValue(mockCustomer);

      const result = await customerService.getCustomerById(
        "customer-1",
        "org-789",
        { hasOrgWideAccess: true }
      );

      expect(result).toEqual(mockCustomer);
    });

    it("should deny reading if user is branch-limited and customer did not visit user branch", async () => {
      const mockCustomer = {
        _id: "customer-1",
        homeBranchId: "branch-2",
        visitedBranchIds: [],
        organizationId: "org-789",
        status: "active",
      };
      mockCustomerRepo.findById.mockResolvedValue(mockCustomer);

      await expect(
        customerService.getCustomerById(
          "customer-1",
          "org-789",
          { hasOrgWideAccess: false },
          "branch-3"
        )
      ).rejects.toThrow(
        new AppError("Access denied. Customer is not visible within your active branch scope.", 403)
      );
    });
  });

  describe("updateCustomer", () => {
    it("should update properties but ignore immutable fields", async () => {
      const mockCustomer = {
        _id: "customer-1",
        homeBranchId: "branch-123",
        visitedBranchIds: [],
        organizationId: "org-789",
        status: "active",
      };
      mockCustomerRepo.findById.mockResolvedValue(mockCustomer);
      mockCustomerRepo.updateById.mockResolvedValue({ ...mockCustomer, name: "New Name" });

      const result = await customerService.updateCustomer(
        "customer-1",
        { name: "New Name", organizationId: "other-org" },
        "org-789",
        "user-123",
        { hasOrgWideAccess: true }
      );

      expect(result.name).toBe("New Name");
      expect(mockCustomerRepo.updateById).toHaveBeenCalledWith(
        "customer-1",
        expect.objectContaining({ name: "New Name" }),
        "org-789",
        "user-123"
      );
    });

    it("should block update if customer is deactivated and update does not reactivate them", async () => {
      const mockCustomer = {
        _id: "customer-1",
        homeBranchId: "branch-123",
        visitedBranchIds: [],
        organizationId: "org-789",
        status: "inactive",
      };
      mockCustomerRepo.findById.mockResolvedValue(mockCustomer);

      await expect(
        customerService.updateCustomer(
          "customer-1",
          { name: "New Name" },
          "org-789",
          "user-123",
          { hasOrgWideAccess: true }
        )
      ).rejects.toThrow(
        new AppError("Cannot perform operations on a deactivated customer profile.", 400)
      );
    });

    it("should allow update if customer is deactivated but update reactivates them", async () => {
      const mockCustomer = {
        _id: "customer-1",
        homeBranchId: "branch-123",
        visitedBranchIds: [],
        organizationId: "org-789",
        status: "inactive"
      };
      mockCustomerRepo.findById.mockResolvedValue(mockCustomer);
      mockCustomerRepo.updateById.mockResolvedValue({ ...mockCustomer, status: "active" });

      const result = await customerService.updateCustomer(
        "customer-1",
        { status: "active" },
        "org-789",
        "user-123",
        { hasOrgWideAccess: true }
      );

      expect(result.status).toBe("active");
    });
  });
});

describe("CustomerNoteService Unit Tests", () => {
  let noteService;
  let mockNoteRepo;
  let mockAuditRepo;

  beforeEach(() => {
    jest.clearAllMocks();
    mockNoteRepo = {
      create: jest.fn(),
      findByCustomer: jest.fn(),
    };
    mockAuditRepo = {
      create: jest.fn(),
    };
    noteService = new CustomerNoteService(mockNoteRepo, mockAuditRepo);
  });

  describe("createNote", () => {
    it("should create a note if customer is active", async () => {
      mockNoteRepo.create.mockResolvedValue({ _id: "note-1", text: "Test Note" });
      mockAuditRepo.create.mockResolvedValue({});

      const result = await noteService.createNote(
        "customer-1",
        "Test Note",
        "org-789",
        "branch-123",
        "user-123"
      );

      expect(result.text).toBe("Test Note");
      expect(mockNoteRepo.create).toHaveBeenCalled();
      expect(mockAuditRepo.create).toHaveBeenCalled();
    });

    it("should reject note if text exceeds 2000 characters", async () => {
      const longText = "a".repeat(2001);
      await expect(
        noteService.createNote("customer-1", longText, "org-789", "branch-123", "user-123")
      ).rejects.toThrow(new AppError("Note text exceeds maximum length of 2000 characters", 400));
    });
  });
});
