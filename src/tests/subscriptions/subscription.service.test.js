import { jest } from "@jest/globals";
import mongoose from "mongoose";
import { SubscriptionService } from "../../services/subscriptions/subscription.service.js";
import { Sequence } from "../../models/sequence/sequence.model.js";
import { AppError } from "../../utils/errors.js";

describe("SubscriptionService Unit Tests - Core Operations", () => {
  let subscriptionService;
  let mockSubscriptionRepo;
  let mockSubscriptionUsageRepo;
  let mockCustomerRepo;
  let mockServiceRepo;
  let mockBranchRepo;
  let mockAuditRepo;

  const orgId = new mongoose.Types.ObjectId().toString();
  const userId = new mongoose.Types.ObjectId().toString();
  const customerId = new mongoose.Types.ObjectId().toString();
  const branchId = new mongoose.Types.ObjectId().toString();
  const serviceId1 = new mongoose.Types.ObjectId().toString();
  const serviceId2 = new mongoose.Types.ObjectId().toString();

  beforeEach(() => {
    jest.clearAllMocks();

    mockSubscriptionRepo = {
      create: jest.fn(),
      findOne: jest.fn(),
      find: jest.fn(),
      updateById: jest.fn(),
      atomicDecrementEntitlement: jest.fn(),
    };

    mockSubscriptionUsageRepo = {
      create: jest.fn(),
      findBySubscriptionId: jest.fn(),
      findByCustomerId: jest.fn(),
    };

    mockCustomerRepo = {
      findById: jest.fn(),
      findOne: jest.fn(),
    };

    mockServiceRepo = {
      findById: jest.fn(),
      findOne: jest.fn(),
    };

    mockBranchRepo = {
      findById: jest.fn(),
      findOne: jest.fn(),
    };

    mockAuditRepo = {
      create: jest.fn().mockResolvedValue({}),
    };

    subscriptionService = new SubscriptionService(
      mockSubscriptionRepo,
      mockSubscriptionUsageRepo,
      mockCustomerRepo,
      mockServiceRepo,
      mockBranchRepo,
      mockAuditRepo
    );

    // Mock Sequence counter
    Sequence.findOneAndUpdate = jest.fn().mockResolvedValue({ seq: 1 });
  });

  describe("createSubscription", () => {
    it("should successfully create a customer-specific subscription with entitlements", async () => {
      mockCustomerRepo.findById.mockResolvedValue({
        _id: customerId,
        name: "Alice Smith",
        phone: "+919876543210",
        organizationId: orgId,
        status: "active",
        isDeleted: false,
      });

      mockBranchRepo.findById.mockResolvedValue({
        _id: branchId,
        organizationId: orgId,
        isActive: true,
        isDeleted: false,
      });

      mockServiceRepo.findById
        .mockResolvedValueOnce({
          _id: serviceId1,
          name: "Hair Cut",
          organizationId: orgId,
          status: "active",
          isDeleted: false,
        })
        .mockResolvedValueOnce({
          _id: serviceId2,
          name: "Hair Color",
          organizationId: orgId,
          status: "active",
          isDeleted: false,
        });

      mockSubscriptionRepo.create.mockImplementation((data) => ({
        _id: new mongoose.Types.ObjectId(),
        ...data,
      }));

      const payload = {
        customerId,
        price: 4999,
        permittedBranchIds: [branchId],
        startDate: "2026-10-01T00:00:00.000Z",
        endDate: "2026-12-31T23:59:59.000Z",
        entitlements: [
          { serviceId: serviceId1, quantity: 5 },
          { serviceId: serviceId2, quantity: 2 },
        ],
        notes: "VIP Subscription package",
      };

      const result = await subscriptionService.createSubscription(
        payload,
        orgId,
        userId
      );

      expect(result).toBeDefined();
      expect(result.subscriptionCode).toMatch(/^SUB-\d{8}-0001$/);
      expect(result.price).toBe(4999);
      expect(result.entitlements).toHaveLength(2);
      expect(result.entitlements[0].remainingQuantity).toBe(5);
      expect(result.entitlements[0].serviceName).toBe("Hair Cut");
      expect(result.permittedBranchIds).toEqual([branchId]);
      expect(mockAuditRepo.create).toHaveBeenCalled();
    });

    it("should throw error if customer belongs to another organization", async () => {
      mockCustomerRepo.findById.mockResolvedValue({
        _id: customerId,
        organizationId: new mongoose.Types.ObjectId().toString(), // Different org
        status: "active",
      });

      const payload = {
        customerId,
        price: 2000,
        startDate: "2026-10-01",
        endDate: "2026-12-31",
        entitlements: [{ serviceId: serviceId1, quantity: 2 }],
      };

      await expect(
        subscriptionService.createSubscription(payload, orgId, userId)
      ).rejects.toThrow("Customer not found or invalid for organization");
    });

    it("should throw error if customer is inactive", async () => {
      mockCustomerRepo.findById.mockResolvedValue({
        _id: customerId,
        organizationId: orgId,
        status: "inactive",
      });

      const payload = {
        customerId,
        price: 2000,
        startDate: "2026-10-01",
        endDate: "2026-12-31",
        entitlements: [{ serviceId: serviceId1, quantity: 2 }],
      };

      await expect(
        subscriptionService.createSubscription(payload, orgId, userId)
      ).rejects.toThrow("Cannot create subscription for customer with status 'inactive'");
    });

    it("should throw error if endDate is before or equal to startDate", async () => {
      mockCustomerRepo.findById.mockResolvedValue({
        _id: customerId,
        organizationId: orgId,
        status: "active",
      });

      const payload = {
        customerId,
        price: 2000,
        startDate: "2026-12-31",
        endDate: "2026-10-01", // earlier than start
        entitlements: [{ serviceId: serviceId1, quantity: 2 }],
      };

      await expect(
        subscriptionService.createSubscription(payload, orgId, userId)
      ).rejects.toThrow("End date must be strictly after start date");
    });

    it("should throw error if duplicate serviceId is present in entitlements", async () => {
      mockCustomerRepo.findById.mockResolvedValue({
        _id: customerId,
        organizationId: orgId,
        status: "active",
      });

      mockServiceRepo.findById.mockResolvedValue({
        _id: serviceId1,
        name: "Hair Cut",
        organizationId: orgId,
        status: "active",
      });

      const payload = {
        customerId,
        price: 2000,
        startDate: "2026-10-01",
        endDate: "2026-12-31",
        entitlements: [
          { serviceId: serviceId1, quantity: 2 },
          { serviceId: serviceId1, quantity: 3 }, // duplicate
        ],
      };

      await expect(
        subscriptionService.createSubscription(payload, orgId, userId)
      ).rejects.toThrow("Duplicate serviceId in entitlements");
    });

    it("should throw error if entitlement service is inactive", async () => {
      mockCustomerRepo.findById.mockResolvedValue({
        _id: customerId,
        organizationId: orgId,
        status: "active",
      });

      mockServiceRepo.findById.mockResolvedValue({
        _id: serviceId1,
        name: "Delisted Facial",
        organizationId: orgId,
        status: "inactive",
      });

      const payload = {
        customerId,
        price: 2000,
        startDate: "2026-10-01",
        endDate: "2026-12-31",
        entitlements: [{ serviceId: serviceId1, quantity: 1 }],
      };

      await expect(
        subscriptionService.createSubscription(payload, orgId, userId)
      ).rejects.toThrow("Service 'Delisted Facial' is inactive and cannot be added to a subscription");
    });
  });

  describe("updateSubscription and cancelSubscription", () => {
    it("should cancel active subscription and log audit event", async () => {
      const subId = new mongoose.Types.ObjectId().toString();
      mockSubscriptionRepo.findOne.mockResolvedValue({
        _id: subId,
        organizationId: orgId,
        subscriptionCode: "SUB-20261001-0001",
        status: "active",
        notes: "Initial note",
      });

      mockSubscriptionRepo.updateById.mockResolvedValue({
        _id: subId,
        status: "cancelled",
      });

      const result = await subscriptionService.cancelSubscription(
        subId,
        orgId,
        userId,
        "Customer moved out of city"
      );

      expect(result.status).toBe("cancelled");
      expect(mockSubscriptionRepo.updateById).toHaveBeenCalledWith(
        subId,
        expect.objectContaining({
          status: "cancelled",
        }),
        userId,
        null
      );
      expect(mockAuditRepo.create).toHaveBeenCalled();
    });

    it("should reject cancel if already cancelled", async () => {
      const subId = new mongoose.Types.ObjectId().toString();
      mockSubscriptionRepo.findOne.mockResolvedValue({
        _id: subId,
        organizationId: orgId,
        status: "cancelled",
      });

      await expect(
        subscriptionService.cancelSubscription(subId, orgId, userId, "Test")
      ).rejects.toThrow("Subscription is already cancelled");
    });
  });
});
