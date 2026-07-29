import { jest } from "@jest/globals";
import { CustomerService } from "../../services/customers/customer.service.js";
import { AppError } from "../../utils/errors.js";

describe("CustomerService Unit Tests", () => {
  let customerService;
  let mockCustomerRepo;

  beforeEach(() => {
    mockCustomerRepo = {
      findOne: jest.fn(),
      findById: jest.fn(),
      create: jest.fn(),
      updateById: jest.fn(),
      deleteById: jest.fn(),
      find: jest.fn(),
      addNote: jest.fn(),
      addActivity: jest.fn(),
    };

    customerService = new CustomerService(mockCustomerRepo);
  });

  describe("createCustomer", () => {
    it("should throw an error if homeBranchId is missing", async () => {
      await expect(
        customerService.createCustomer({ phone: "+919999988888", name: "Test" }, "org-789", "user-123")
      ).rejects.toThrow(new AppError("homeBranchId is required to create a customer.", 400));
    });

    it("should create customer and write CREATED timeline event", async () => {
      const mockCustomer = {
        _id: "new-customer-id",
        phone: "+919999988888",
        name: "Test",
        homeBranchId: "branch-123",
        organizationId: "org-789",
        isActive: true,
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
      expect(mockCustomerRepo.addActivity).toHaveBeenCalledWith(
        "new-customer-id",
        "CREATED",
        "Customer profile created successfully",
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
        isActive: true,
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
        isActive: true,
      };
      mockCustomerRepo.findById.mockResolvedValue(mockCustomer);

      await expect(
        customerService.getCustomerById(
          "customer-1",
          "org-789",
          { hasOrgWideAccess: false },
          "branch-3" // User branch context
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
        isActive: true,
      };
      mockCustomerRepo.findById.mockResolvedValue(mockCustomer);
      mockCustomerRepo.updateById.mockResolvedValue({ ...mockCustomer, name: "New Name" });

      const result = await customerService.updateCustomer(
        "customer-1",
        { name: "New Name", homeBranchId: "malicious-change-attempt", organizationId: "other-org" },
        "org-789",
        "user-123",
        { hasOrgWideAccess: true }
      );

      expect(result.name).toBe("New Name");
      expect(mockCustomerRepo.updateById).toHaveBeenCalledWith(
        "customer-1",
        { name: "New Name" },
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
        isActive: false,
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
        isActive: false,
      };
      mockCustomerRepo.findById.mockResolvedValue(mockCustomer);
      mockCustomerRepo.updateById.mockResolvedValue({ ...mockCustomer, isActive: true });

      const result = await customerService.updateCustomer(
        "customer-1",
        { isActive: true },
        "org-789",
        "user-123",
        { hasOrgWideAccess: true }
      );

      expect(result.isActive).toBe(true);
    });
  });

  describe("addNote", () => {
    it("should add a note if customer is active", async () => {
      const mockCustomer = {
        _id: "customer-1",
        homeBranchId: "branch-123",
        visitedBranchIds: [],
        organizationId: "org-789",
        isActive: true,
      };
      mockCustomerRepo.findById.mockResolvedValue(mockCustomer);
      mockCustomerRepo.addNote.mockResolvedValue({ ...mockCustomer, notes: [{ text: "New Note" }] });

      const result = await customerService.addNote(
        "customer-1",
        "New Note",
        "org-789",
        "user-123",
        { hasOrgWideAccess: true }
      );

      expect(result.notes).toBeDefined();
    });

    it("should block adding a note if customer is deactivated", async () => {
      const mockCustomer = {
        _id: "customer-1",
        homeBranchId: "branch-123",
        visitedBranchIds: [],
        organizationId: "org-789",
        isActive: false,
      };
      mockCustomerRepo.findById.mockResolvedValue(mockCustomer);

      await expect(
        customerService.addNote(
          "customer-1",
          "New Note",
          "org-789",
          "user-123",
          { hasOrgWideAccess: true }
        )
      ).rejects.toThrow(
        new AppError("Cannot perform operations on a deactivated customer profile.", 400)
      );
    });
  });
});
