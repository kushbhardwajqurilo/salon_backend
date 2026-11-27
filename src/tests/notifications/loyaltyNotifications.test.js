import { jest } from "@jest/globals";
import mongoose from "mongoose";

const mockCreateOutboxEvent = jest.fn();
const mockLoyaltyTxFindOne = jest.fn();
const mockLoyaltyTxSave = jest.fn();
const mockCustomerFindOne = jest.fn();
const mockCustomerFindOneAndUpdate = jest.fn();
const mockConfigFindOne = jest.fn();

jest.unstable_mockModule("../../services/notifications/outbox.service.js", () => ({
  createOutboxEvent: mockCreateOutboxEvent,
}));

jest.unstable_mockModule("../../models/loyalty/loyaltyTransaction.model.js", () => {
  const LoyaltyTransactionMock = jest.fn().mockImplementation((doc) => ({
    ...doc,
    _id: new mongoose.Types.ObjectId(),
    save: mockLoyaltyTxSave,
  }));
  LoyaltyTransactionMock.findOne = mockLoyaltyTxFindOne;
  return {
    LoyaltyTransaction: LoyaltyTransactionMock,
    LOYALTY_TRANSACTION_TYPES: {
      EARNED: "earned",
      REDEEMED: "redeemed",
    },
  };
});

jest.unstable_mockModule("../../models/customers/customer.model.js", () => ({
  Customer: {
    findOne: mockCustomerFindOne,
    findOneAndUpdate: mockCustomerFindOneAndUpdate,
  },
}));

jest.unstable_mockModule("../../repositories/loyalty/loyaltyProgramConfig.repository.js", () => ({
  loyaltyProgramConfigRepository: {
    findByOrganizationId: mockConfigFindOne,
  },
}));

const { LoyaltyService } = await import(
  "../../services/loyalty/loyalty.service.js"
);
const loyaltyService = new LoyaltyService();

describe("Loyalty Notification Producers", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockLoyaltyTxSave.mockResolvedValue(true);
    mockCreateOutboxEvent.mockResolvedValue({ _id: new mongoose.Types.ObjectId() });
  });

  it("awardPointsForSettledInvoice emits loyalty.points_earned with session", async () => {
    const orgId = new mongoose.Types.ObjectId();
    const branchId = new mongoose.Types.ObjectId();
    const customerId = new mongoose.Types.ObjectId();
    const invoiceId = new mongoose.Types.ObjectId();
    const actorId = new mongoose.Types.ObjectId();
    const session = { id: "earn-session" };

    mockLoyaltyTxFindOne.mockReturnValue({ session: jest.fn().mockResolvedValue(null) });
    mockConfigFindOne.mockResolvedValue({
      isEnabled: true,
      earnThresholdAmount: 100,
      earnPointsPerUnit: 1,
    });
    mockCustomerFindOne.mockReturnValue({
      session: jest.fn().mockResolvedValue({
        _id: customerId,
        loyaltyPoints: 10,
        loyaltyPointsDebt: 0,
        save: jest.fn().mockResolvedValue(true),
      }),
    });

    const invoice = {
      _id: invoiceId,
      organizationId: orgId,
      branchId,
      customerId,
      invoiceNumber: "INV-2026-01",
      lines: [{ customerPayable: 500, isCoveredBySubscription: false }],
      save: jest.fn().mockResolvedValue(true),
    };

    const tx = await loyaltyService.awardPointsForSettledInvoice({
      invoice,
      payment: { _id: new mongoose.Types.ObjectId() },
      actorId,
      session,
    });

    expect(mockCreateOutboxEvent).toHaveBeenCalledTimes(1);
    expect(mockCreateOutboxEvent).toHaveBeenCalledWith(
      expect.objectContaining({
        organizationId: orgId,
        branchId,
        eventType: "loyalty.points_earned",
        idempotencyKey: `loyalty-earn:${tx._id}`,
        payload: expect.objectContaining({
          customerId: String(customerId),
          invoiceId: String(invoiceId),
          invoiceNumber: "INV-2026-01",
          points: 5,
          balanceAfter: 15,
        }),
        session,
      }),
    );
  });

  it("commitRedemption emits loyalty.points_redeemed with session", async () => {
    const orgId = new mongoose.Types.ObjectId();
    const branchId = new mongoose.Types.ObjectId();
    const customerId = new mongoose.Types.ObjectId();
    const invoiceId = new mongoose.Types.ObjectId();
    const actorId = new mongoose.Types.ObjectId();
    const session = { id: "redeem-session" };

    mockLoyaltyTxFindOne.mockReturnValue({ session: jest.fn().mockResolvedValue(null) });
    mockCustomerFindOneAndUpdate.mockResolvedValue({
      _id: customerId,
      loyaltyPoints: 40,
    });

    const tx = await loyaltyService.commitRedemption({
      organizationId: orgId,
      customerId,
      branchId,
      invoiceId,
      points: 10,
      discountAmount: 10,
      actorId,
      session,
    });

    expect(mockCreateOutboxEvent).toHaveBeenCalledTimes(1);
    expect(mockCreateOutboxEvent).toHaveBeenCalledWith(
      expect.objectContaining({
        organizationId: orgId,
        branchId,
        eventType: "loyalty.points_redeemed",
        idempotencyKey: `loyalty-redeem:${tx._id}`,
        payload: expect.objectContaining({
          customerId: String(customerId),
          invoiceId: String(invoiceId),
          points: 10,
          balanceAfter: 40,
        }),
        session,
      }),
    );
  });

  it("skips outbox emission on duplicate/retried loyalty transaction", async () => {
    const orgId = new mongoose.Types.ObjectId();
    const existingTx = { _id: new mongoose.Types.ObjectId(), pointsDelta: 5 };
    mockLoyaltyTxFindOne.mockReturnValue({ session: jest.fn().mockResolvedValue(existingTx) });

    const res = await loyaltyService.awardPointsForSettledInvoice({
      invoice: { _id: new mongoose.Types.ObjectId(), organizationId: orgId, lines: [] },
      payment: null,
      actorId: new mongoose.Types.ObjectId(),
      session: { id: "s1" },
    });

    expect(res).toBe(existingTx);
    expect(mockCreateOutboxEvent).not.toHaveBeenCalled();
  });

  it("does not fail awardPointsForSettledInvoice when outbox creation throws", async () => {
    const orgId = new mongoose.Types.ObjectId();
    const branchId = new mongoose.Types.ObjectId();
    const customerId = new mongoose.Types.ObjectId();
    const invoiceId = new mongoose.Types.ObjectId();
    const session = { id: "earn-err-session" };

    mockLoyaltyTxFindOne.mockReturnValue({ session: jest.fn().mockResolvedValue(null) });
    mockConfigFindOne.mockResolvedValue({
      isEnabled: true,
      earnThresholdAmount: 100,
      earnPointsPerUnit: 1,
    });
    mockCustomerFindOne.mockReturnValue({
      session: jest.fn().mockResolvedValue({
        _id: customerId,
        loyaltyPoints: 0,
        loyaltyPointsDebt: 0,
        save: jest.fn().mockResolvedValue(true),
      }),
    });
    mockCreateOutboxEvent.mockRejectedValue(new Error("Outbox down"));

    const tx = await loyaltyService.awardPointsForSettledInvoice({
      invoice: {
        _id: invoiceId,
        organizationId: orgId,
        branchId,
        customerId,
        invoiceNumber: "INV-2026-02",
        lines: [{ customerPayable: 200, isCoveredBySubscription: false }],
        save: jest.fn().mockResolvedValue(true),
      },
      payment: null,
      actorId: new mongoose.Types.ObjectId(),
      session,
    });

    expect(tx).toBeDefined();
    expect(mockCreateOutboxEvent).toHaveBeenCalledTimes(1);
  });
});
