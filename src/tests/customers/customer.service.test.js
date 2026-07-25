import { jest } from "@jest/globals";
import { CustomerService } from "../../services/customers/customer.service.js";
import { AppError } from "../../utils/errors.js";

describe("CustomerService", () => {
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
      updatePreferences: jest.fn(),
      addActivity: jest.fn(),
      addVisit: jest.fn(),
      addServiceHistory: jest.fn(),
      addMembershipHistory: jest.fn(),
      adjustLoyaltyPoints: jest.fn(),
    };

    customerService = new CustomerService(mockCustomerRepo);
  });

  describe("createCustomer", () => {
    it("should throw an error if customer with same phone exists", async () => {
      mockCustomerRepo.findOne.mockResolvedValue({ _id: "existing-customer" });

      await expect(
        customerService.createCustomer({ phone: "+1234567890", name: "Test" }, "org-789", "user-123")
      ).rejects.toThrow(new AppError("Customer with this phone number already exists", 400));
    });

    it("should create customer and write CREATED timeline event", async () => {
      const mockCustomer = { _id: "new-customer-id", phone: "+1234567890", name: "Test", organizationId: "org-789" };
      mockCustomerRepo.findOne.mockResolvedValue(null);
      mockCustomerRepo.create.mockResolvedValue(mockCustomer);

      const result = await customerService.createCustomer(
        { phone: "+1234567890", name: "Test" },
        "org-789",
        "user-123"
      );

      expect(result).toEqual(mockCustomer);
      expect(mockCustomerRepo.create).toHaveBeenCalledWith({ phone: "+1234567890", name: "Test" }, "org-789", "user-123");
      expect(mockCustomerRepo.addActivity).toHaveBeenCalledWith(
        "new-customer-id",
        "CREATED",
        "Customer profile created successfully",
        "org-789",
        "user-123"
      );
    });
  });

  describe("adjustLoyaltyPoints", () => {
    it("should adjust points and log updates to timeline", async () => {
      const mockCustomer = { _id: "customer-1", branchId: "branch-a", loyaltyPoints: 10, organizationId: "org-789" };
      mockCustomerRepo.findById.mockResolvedValue(mockCustomer);
      mockCustomerRepo.adjustLoyaltyPoints.mockResolvedValue({
        _id: "customer-1",
        loyaltyPoints: 15,
      });

      const result = await customerService.adjustLoyaltyPoints(
        "customer-1",
        5,
        "org-789",
        "user-123"
      );

      expect(result.loyaltyPoints).toBe(15);
      expect(mockCustomerRepo.adjustLoyaltyPoints).toHaveBeenCalledWith("customer-1", 5, "org-789");
      expect(mockCustomerRepo.addActivity).toHaveBeenCalledWith(
        "customer-1",
        "LOYALTY_ADJUSTED",
        "Adjusted loyalty points by +5 (Current: 15)",
        "org-789",
        "user-123"
      );
    });
  });
});
