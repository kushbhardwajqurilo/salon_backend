import { jest } from "@jest/globals";
import crypto from "crypto";
import mongoose from "mongoose";
import { SubscriptionService } from "../../services/subscriptions/subscription.service.js";
import { AppError } from "../../utils/errors.js";

describe("SubscriptionService Unit Tests - Redemption & Concurrency", () => {
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
  const branchAId = new mongoose.Types.ObjectId().toString();
  const branchBId = new mongoose.Types.ObjectId().toString();
  const serviceId = new mongoose.Types.ObjectId().toString();
  const subId = new mongoose.Types.ObjectId().toString();

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
    };

    mockBranchRepo = {
      findById: jest.fn(),
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
  });

  describe("sendRedemptionOTP", () => {
    it("should successfully generate and store hashed OTP on Customer and trigger SMS", async () => {
      mockSubscriptionRepo.findOne.mockResolvedValue({
        _id: subId,
        organizationId: orgId,
        customerId,
        status: "active",
        permittedBranchIds: [branchAId],
        endDate: new Date(Date.now() + 86400000), // tomorrow
        save: jest.fn(),
      });

      const mockCustomer = {
        _id: customerId,
        name: "Jane Doe",
        phone: "+919876543210",
        status: "active",
        isDeleted: false,
        save: jest.fn().mockResolvedValue(true),
      };
      mockCustomerRepo.findById.mockResolvedValue(mockCustomer);

      const result = await subscriptionService.sendRedemptionOTP(
        subId,
        branchAId,
        orgId,
        userId
      );

      expect(result.success).toBe(true);
      expect(mockCustomer.otp).toBeDefined();
      expect(mockCustomer.otp).toHaveLength(64); // SHA-256 hex string
      expect(mockCustomer.otpExpires).toBeInstanceOf(Date);
      expect(mockCustomer.save).toHaveBeenCalled();
      expect(mockAuditRepo.create).toHaveBeenCalled();
    });

    it("should reject OTP request if branch is not in permittedBranchIds", async () => {
      mockSubscriptionRepo.findOne.mockResolvedValue({
        _id: subId,
        organizationId: orgId,
        customerId,
        status: "active",
        permittedBranchIds: [branchAId], // only branchA permitted
        endDate: new Date(Date.now() + 86400000),
      });

      await expect(
        subscriptionService.sendRedemptionOTP(subId, branchBId, orgId, userId)
      ).rejects.toThrow("Subscription is not valid for redemption at this branch");
    });

    it("should enforce 60s cooldown if OTP was recently requested", async () => {
      mockSubscriptionRepo.findOne.mockResolvedValue({
        _id: subId,
        organizationId: orgId,
        customerId,
        status: "active",
        permittedBranchIds: [],
        endDate: new Date(Date.now() + 86400000),
      });

      mockCustomerRepo.findById.mockResolvedValue({
        _id: customerId,
        status: "active",
        phone: "+919876543210",
        otpResendUntil: new Date(Date.now() + 45000), // 45s remaining cooldown
      });

      await expect(
        subscriptionService.sendRedemptionOTP(subId, branchAId, orgId, userId)
      ).rejects.toThrow("Too many OTP requests");
    });
  });

  describe("redeemSubscription - Verification and Atomic Decrements", () => {
    it("should reject redemption when OTP is incorrect and track failed attempts", async () => {
      mockSubscriptionRepo.findOne.mockResolvedValue({
        _id: subId,
        organizationId: orgId,
        customerId,
        status: "active",
        permittedBranchIds: [],
        endDate: new Date(Date.now() + 86400000),
        entitlements: [
          { serviceId, serviceName: "Facial", remainingQuantity: 3 },
        ],
      });

      const hashedRealOtp = crypto.createHash("sha256").update("123456").digest("hex");
      const mockCustomer = {
        _id: customerId,
        otp: hashedRealOtp,
        otpExpires: new Date(Date.now() + 300000),
        otpAttempts: 0,
        save: jest.fn().mockResolvedValue(true),
      };
      mockCustomerRepo.findById.mockResolvedValue(mockCustomer);

      await expect(
        subscriptionService.redeemSubscription(
          subId,
          branchAId,
          "999999", // wrong OTP
          [{ serviceId, quantity: 1 }],
          null,
          orgId,
          userId
        )
      ).rejects.toThrow("Invalid OTP");

      expect(mockCustomer.otpAttempts).toBe(1);
      expect(mockCustomer.save).toHaveBeenCalled();
    });

    it("should atomically redeem service entitlement, clear OTP, create usage record, and transition to exhausted when 0 balance", async () => {
      const activeSub = {
        _id: subId,
        organizationId: orgId,
        customerId,
        subscriptionCode: "SUB-20261001-0001",
        status: "active",
        permittedBranchIds: [],
        endDate: new Date(Date.now() + 86400000),
        entitlements: [
          {
            serviceId,
            serviceName: "Full Hair Spa",
            totalQuantity: 2,
            usedQuantity: 1,
            remainingQuantity: 1,
          },
        ],
        save: jest.fn().mockResolvedValue(true),
      };

      mockSubscriptionRepo.findOne.mockResolvedValue(activeSub);

      const rawOtp = "654321";
      const hashedRealOtp = crypto.createHash("sha256").update(rawOtp).digest("hex");
      const mockCustomer = {
        _id: customerId,
        name: "Alice",
        phone: "+919876543210",
        otp: hashedRealOtp,
        otpExpires: new Date(Date.now() + 300000),
        otpAttempts: 0,
        save: jest.fn().mockResolvedValue(true),
      };
      mockCustomerRepo.findById.mockResolvedValue(mockCustomer);

      // Mock atomic update returning updated document with 0 remaining
      const updatedSubDoc = {
        _id: subId,
        organizationId: orgId,
        customerId,
        subscriptionCode: "SUB-20261001-0001",
        status: "active",
        entitlements: [
          {
            serviceId,
            serviceName: "Full Hair Spa",
            totalQuantity: 2,
            usedQuantity: 2,
            remainingQuantity: 0,
          },
        ],
        save: jest.fn().mockResolvedValue(true),
      };
      mockSubscriptionRepo.atomicDecrementEntitlement.mockResolvedValue(updatedSubDoc);

      mockSubscriptionUsageRepo.create.mockResolvedValue({
        _id: new mongoose.Types.ObjectId(),
        subscriptionId: subId,
        serviceName: "Full Hair Spa",
        quantity: 1,
        branchId: branchAId,
      });

      const result = await subscriptionService.redeemSubscription(
        subId,
        branchAId,
        rawOtp,
        [{ serviceId, quantity: 1 }],
        null,
        orgId,
        userId
      );

      // Verify OTP cleared
      expect(mockCustomer.otp).toBeNull();
      expect(mockCustomer.otpExpires).toBeNull();

      // Verify atomic decrement called with proper parameters
      expect(mockSubscriptionRepo.atomicDecrementEntitlement).toHaveBeenCalledWith(
        subId,
        orgId,
        serviceId,
        1,
        null
      );

      // Verify usage record created
      expect(mockSubscriptionUsageRepo.create).toHaveBeenCalledWith(
        expect.objectContaining({
          subscriptionId: subId,
          serviceId,
          quantity: 1,
          branchId: branchAId,
          verificationMethod: "otp",
        }),
        userId,
        null
      );

      // Verify status auto-transition to exhausted
      expect(result.subscription.status).toBe("exhausted");
      expect(updatedSubDoc.save).toHaveBeenCalled();
      expect(mockAuditRepo.create).toHaveBeenCalled();
    });

    it("should reject redemption if requested quantity exceeds entitlement balance (409 Conflict)", async () => {
      mockSubscriptionRepo.findOne.mockResolvedValue({
        _id: subId,
        organizationId: orgId,
        customerId,
        status: "active",
        permittedBranchIds: [],
        endDate: new Date(Date.now() + 86400000),
        entitlements: [
          {
            serviceId,
            serviceName: "Manicure",
            totalQuantity: 2,
            usedQuantity: 1,
            remainingQuantity: 1, // Only 1 left
          },
        ],
      });

      const rawOtp = "112233";
      const hashedOtp = crypto.createHash("sha256").update(rawOtp).digest("hex");
      mockCustomerRepo.findById.mockResolvedValue({
        _id: customerId,
        otp: hashedOtp,
        otpExpires: new Date(Date.now() + 300000),
        otpAttempts: 0,
        save: jest.fn(),
      });

      await expect(
        subscriptionService.redeemSubscription(
          subId,
          branchAId,
          rawOtp,
          [{ serviceId, quantity: 5 }], // Requesting 5
          null,
          orgId,
          userId
        )
      ).rejects.toThrow("Insufficient balance for service 'Manicure'");
    });

    it("should throw 409 Conflict if atomic decrement returns null due to race condition / concurrent decrement", async () => {
      mockSubscriptionRepo.findOne.mockResolvedValue({
        _id: subId,
        organizationId: orgId,
        customerId,
        status: "active",
        permittedBranchIds: [],
        endDate: new Date(Date.now() + 86400000),
        entitlements: [
          {
            serviceId,
            serviceName: "Pedicure",
            totalQuantity: 1,
            usedQuantity: 0,
            remainingQuantity: 1,
          },
        ],
      });

      const rawOtp = "445566";
      const hashedOtp = crypto.createHash("sha256").update(rawOtp).digest("hex");
      mockCustomerRepo.findById.mockResolvedValue({
        _id: customerId,
        otp: hashedOtp,
        otpExpires: new Date(Date.now() + 300000),
        otpAttempts: 0,
        save: jest.fn(),
      });

      // Simultaneous request already decremented balance in MongoDB
      mockSubscriptionRepo.atomicDecrementEntitlement.mockResolvedValue(null);

      await expect(
        subscriptionService.redeemSubscription(
          subId,
          branchAId,
          rawOtp,
          [{ serviceId, quantity: 1 }],
          null,
          orgId,
          userId
        )
      ).rejects.toThrow("Concurrent modification or insufficient balance");
    });
  });
});
