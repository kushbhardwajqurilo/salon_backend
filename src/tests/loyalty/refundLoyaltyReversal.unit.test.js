import { jest } from "@jest/globals";
import mongoose from "mongoose";

const mockSession = { id: "mock-session" };
const orgId = new mongoose.Types.ObjectId();
const branchId = new mongoose.Types.ObjectId();
const customerId = new mongoose.Types.ObjectId();
const invoiceId = new mongoose.Types.ObjectId();
const earnTxId = new mongoose.Types.ObjectId();

const mockRefundCaseFindOne = jest.fn();
const mockRefundCaseFind = jest.fn();
const mockScopeLockFindOneAndUpdate = jest.fn();
const mockLoyaltyTxFindOne = jest.fn();
const mockLoyaltyTxFind = jest.fn();
const mockLoyaltyTxSave = jest.fn();
const mockCustomerFindOne = jest.fn();

jest.unstable_mockModule("../../models/billing/refundCase.model.js", () => ({
  RefundCase: {
    findOne: mockRefundCaseFindOne,
    find: mockRefundCaseFind,
  },
}));

jest.unstable_mockModule("../../models/incentives/scopeLock.model.js", () => ({
  ScopeLock: {
    findOneAndUpdate: mockScopeLockFindOneAndUpdate,
  },
}));

class MockLoyaltyTransaction {
  constructor(data) {
    Object.assign(this, data);
    this._id = data._id || new mongoose.Types.ObjectId();
  }
  async save(opts) {
    return mockLoyaltyTxSave(this, opts);
  }
  static findOne(query) {
    return {
      session: () => mockLoyaltyTxFindOne(query),
    };
  }
  static find(query) {
    return {
      session: () => mockLoyaltyTxFind(query),
    };
  }
}

jest.unstable_mockModule("../../models/loyalty/loyaltyTransaction.model.js", () => ({
  LoyaltyTransaction: MockLoyaltyTransaction,
  LOYALTY_TRANSACTION_TYPES: {
    EARNED: "EARNED",
    REDEEMED: "REDEEMED",
    EARNING_REVERSED: "EARNING_REVERSED",
    REDEMPTION_RESTORED: "REDEMPTION_RESTORED",
    ADJUSTED: "ADJUSTED",
    EXPIRED: "EXPIRED",
  },
}));

jest.unstable_mockModule("../../models/customers/customer.model.js", () => ({
  Customer: {
    findOne: mockCustomerFindOne,
  },
}));

const { loyaltyService } = await import("../../services/loyalty/loyalty.service.js");

function makeInvoice(overrides = {}) {
  return {
    _id: invoiceId,
    organizationId: orgId,
    branchId,
    customerId,
    loyaltyTransactionId: earnTxId,
    ...overrides,
  };
}

function makeRefundCase(overrides = {}) {
  const rc = {
    _id: new mongoose.Types.ObjectId(),
    organizationId: orgId,
    invoiceId,
    refundNumber: "RF-001",
    refundKind: "item_linked",
    allocations: [{ allocatedAmountPaise: 50000 }],
    domainReversals: { loyalty: { status: "pending", referenceIds: [] } },
    save: jest.fn().mockResolvedValue(true),
    ...overrides,
  };
  return rc;
}

describe("loyaltyService.reverseForRefund (unit)", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockScopeLockFindOneAndUpdate.mockResolvedValue({});
    mockLoyaltyTxSave.mockImplementation(async (doc) => doc);
  });

  test("1. throws 400 when session is missing", async () => {
    await expect(
      loyaltyService.reverseForRefund({
        invoice: makeInvoice(),
        refundCase: makeRefundCase(),
        allocations: [],
      })
    ).rejects.toMatchObject({ statusCode: 400 });
  });

  test("2. skips financial_only refundCase and marks domainReversals.loyalty as skipped", async () => {
    const rc = makeRefundCase({ refundKind: "financial_only" });
    mockRefundCaseFindOne.mockReturnValue({ session: () => Promise.resolve(rc) });

    const res = await loyaltyService.reverseForRefund({
      invoice: makeInvoice(),
      refundCase: rc,
      allocations: [],
      session: mockSession,
    });

    expect(res.status).toBe("skipped");
    expect(res.pointsReversed).toBe(0);
    expect(rc.domainReversals.loyalty.status).toBe("skipped");
    expect(rc.save).toHaveBeenCalledWith({ session: mockSession });
    expect(mockScopeLockFindOneAndUpdate).not.toHaveBeenCalled();
  });

  test("3. returns idempotently if domainReversals.loyalty.status is already completed", async () => {
    const existingRef = new mongoose.Types.ObjectId();
    const rc = makeRefundCase({
      domainReversals: { loyalty: { status: "completed", referenceIds: [existingRef] } },
    });
    mockRefundCaseFindOne.mockReturnValue({ session: () => Promise.resolve(rc) });

    const res = await loyaltyService.reverseForRefund({
      invoice: makeInvoice(),
      refundCase: rc,
      allocations: rc.allocations,
      session: mockSession,
    });

    expect(res).toEqual({
      status: "completed",
      alreadyReversed: true,
      pointsReversed: 0,
      referenceIds: [existingRef],
    });
    expect(mockScopeLockFindOneAndUpdate).not.toHaveBeenCalled();
  });

  test("4. completes with 0 pointsReversed when no original earning transaction exists", async () => {
    const rc = makeRefundCase();
    mockRefundCaseFindOne.mockReturnValue({ session: () => Promise.resolve(rc) });
    mockLoyaltyTxFindOne.mockResolvedValue(null);

    const res = await loyaltyService.reverseForRefund({
      invoice: makeInvoice({ loyaltyTransactionId: null }),
      refundCase: rc,
      allocations: rc.allocations,
      session: mockSession,
    });

    expect(res.status).toBe("completed");
    expect(res.pointsReversed).toBe(0);
    expect(rc.domainReversals.loyalty.status).toBe("completed");
    expect(rc.save).toHaveBeenCalledWith({ session: mockSession });
  });

  test("5. reverses proportional earned points using cumulative floor rounding", async () => {
    const rc = makeRefundCase({ allocations: [{ allocatedAmountPaise: 50000 }] });
    mockRefundCaseFindOne.mockReturnValue({ session: () => Promise.resolve(rc) });
    mockRefundCaseFind.mockReturnValue({ session: () => Promise.resolve([]) });

    mockLoyaltyTxFindOne
      .mockResolvedValueOnce(null) // existingReverse
      .mockResolvedValueOnce({
        _id: earnTxId,
        pointsDelta: 100,
        rateSnapshot: { eligibleSpendAmount: 100000, earnThresholdAmount: 1000, earnPointsPerUnit: 1 },
      });
    mockLoyaltyTxFind.mockResolvedValue([]);

    const customer = {
      _id: customerId,
      loyaltyPoints: 150,
      loyaltyPointsDebt: 0,
      save: jest.fn().mockResolvedValue(true),
    };
    mockCustomerFindOne.mockReturnValue({ session: () => Promise.resolve(customer) });

    const res = await loyaltyService.reverseForRefund({
      invoice: makeInvoice(),
      refundCase: rc,
      allocations: rc.allocations,
      session: mockSession,
    });

    expect(res.status).toBe("completed");
    expect(res.pointsReversed).toBe(50);
    expect(customer.loyaltyPoints).toBe(100);
    expect(customer.loyaltyPointsDebt).toBe(0);
    expect(customer.save).toHaveBeenCalledWith({ session: mockSession });
    expect(mockLoyaltyTxSave).toHaveBeenCalledTimes(1);
    const savedTx = mockLoyaltyTxSave.mock.calls[0][0];
    expect(savedTx.pointsDelta).toBe(-50);
    expect(savedTx.sourceEventKey).toBe(`REFUND_REV:LOYALTY:${rc._id.toString()}`);
    expect(rc.domainReversals.loyalty.status).toBe("completed");
    expect(rc.domainReversals.loyalty.referenceIds).toEqual([savedTx._id]);
  });

  test("6. second partial refund uses cumulative rounding across prior completed cases", async () => {
    const rc2 = makeRefundCase({ allocations: [{ allocatedAmountPaise: 30000 }] });
    mockRefundCaseFindOne.mockReturnValue({ session: () => Promise.resolve(rc2) });
    // Prior completed case refunded 30000 out of 100000, where 100 points were earned -> floor(100*30000/100000) = 30
    // Cumulative = 60000 -> targetCumulativeReversed = 60 -> pointsToReverse = 60 - 30 = 30
    mockRefundCaseFind.mockReturnValue({
      session: () => Promise.resolve([{ allocations: [{ allocatedAmountPaise: 30000 }] }]),
    });

    mockLoyaltyTxFindOne
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce({
        _id: earnTxId,
        pointsDelta: 100,
        rateSnapshot: { eligibleSpendAmount: 100000 },
      });
    mockLoyaltyTxFind.mockResolvedValue([{ pointsDelta: -30 }]);

    const customer = {
      _id: customerId,
      loyaltyPoints: 80,
      loyaltyPointsDebt: 0,
      save: jest.fn().mockResolvedValue(true),
    };
    mockCustomerFindOne.mockReturnValue({ session: () => Promise.resolve(customer) });

    const res = await loyaltyService.reverseForRefund({
      invoice: makeInvoice(),
      refundCase: rc2,
      allocations: rc2.allocations,
      session: mockSession,
    });

    expect(res.pointsReversed).toBe(30);
    expect(customer.loyaltyPoints).toBe(50);
  });

  test("7. records uncovered remainder in customer.loyaltyPointsDebt when balance is insufficient", async () => {
    const rc = makeRefundCase({ allocations: [{ allocatedAmountPaise: 100000 }] });
    mockRefundCaseFindOne.mockReturnValue({ session: () => Promise.resolve(rc) });
    mockRefundCaseFind.mockReturnValue({ session: () => Promise.resolve([]) });

    mockLoyaltyTxFindOne
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce({
        _id: earnTxId,
        pointsDelta: 100,
        rateSnapshot: { eligibleSpendAmount: 100000 },
      });
    mockLoyaltyTxFind.mockResolvedValue([]);

    const customer = {
      _id: customerId,
      loyaltyPoints: 40,
      loyaltyPointsDebt: 5,
      save: jest.fn().mockResolvedValue(true),
    };
    mockCustomerFindOne.mockReturnValue({ session: () => Promise.resolve(customer) });

    const res = await loyaltyService.reverseForRefund({
      invoice: makeInvoice(),
      refundCase: rc,
      allocations: rc.allocations,
      session: mockSession,
    });

    expect(res.pointsReversed).toBe(100);
    expect(customer.loyaltyPoints).toBe(0);
    expect(customer.loyaltyPointsDebt).toBe(65);
  });

  test("8. propagates ScopeLock E11000 duplicate key error", async () => {
    const rc = makeRefundCase();
    mockRefundCaseFindOne.mockReturnValue({ session: () => Promise.resolve(rc) });
    const dupErr = new Error("E11000 duplicate key error");
    dupErr.code = 11000;
    mockScopeLockFindOneAndUpdate.mockRejectedValue(dupErr);

    await expect(
      loyaltyService.reverseForRefund({
        invoice: makeInvoice(),
        refundCase: rc,
        allocations: rc.allocations,
        session: mockSession,
      })
    ).rejects.toThrow("E11000 duplicate key error");
  });

  test("10. two distinct partial RefundCases for the same invoice reuse the same ScopeLock key and session", async () => {
    const rc1 = makeRefundCase({ allocations: [{ allocatedAmountPaise: 30000 }] });
    const rc2 = makeRefundCase({ allocations: [{ allocatedAmountPaise: 30000 }] });
    const customer = {
      _id: customerId,
      loyaltyPoints: 100,
      loyaltyPointsDebt: 0,
      save: jest.fn().mockResolvedValue(true),
    };

    mockRefundCaseFindOne
      .mockReturnValueOnce({ session: () => Promise.resolve(rc1) })
      .mockReturnValueOnce({ session: () => Promise.resolve(rc2) });
    mockRefundCaseFind
      .mockReturnValueOnce({ session: () => Promise.resolve([]) })
      .mockReturnValueOnce({ session: () => Promise.resolve([rc1]) });
    mockLoyaltyTxFindOne
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce({
        _id: earnTxId,
        pointsDelta: 100,
        rateSnapshot: { eligibleSpendAmount: 100000 },
      })
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce({
        _id: earnTxId,
        pointsDelta: 100,
        rateSnapshot: { eligibleSpendAmount: 100000 },
      });
    mockLoyaltyTxFind
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([{ pointsDelta: -30 }]);
    mockCustomerFindOne.mockReturnValue({ session: () => Promise.resolve(customer) });

    const res1 = await loyaltyService.reverseForRefund({
      invoice: makeInvoice(),
      refundCase: rc1,
      allocations: rc1.allocations,
      session: mockSession,
    });
    const res2 = await loyaltyService.reverseForRefund({
      invoice: makeInvoice(),
      refundCase: rc2,
      allocations: rc2.allocations,
      session: mockSession,
    });

    expect(res1.pointsReversed).toBe(30);
    expect(res2.pointsReversed).toBe(30);
    expect(customer.loyaltyPoints).toBe(40);
    expect(mockScopeLockFindOneAndUpdate).toHaveBeenCalledTimes(2);
    const expectedKey = `REFUND_REV:LOYALTY:INV:${invoiceId.toString()}`;
    expect(mockScopeLockFindOneAndUpdate.mock.calls[0][0].scopeKey).toBe(expectedKey);
    expect(mockScopeLockFindOneAndUpdate.mock.calls[0][2]).toMatchObject({
      upsert: true,
      session: mockSession,
    });
    expect(mockScopeLockFindOneAndUpdate.mock.calls[1][0].scopeKey).toBe(expectedKey);
    expect(mockScopeLockFindOneAndUpdate.mock.calls[1][2]).toMatchObject({
      upsert: true,
      session: mockSession,
    });
  });

  test("9. handles existing LoyaltyTransaction for sourceEventKey without double-deducting", async () => {
    const rc = makeRefundCase();
    const existingTxId = new mongoose.Types.ObjectId();
    mockRefundCaseFindOne.mockReturnValue({ session: () => Promise.resolve(rc) });
    mockLoyaltyTxFindOne.mockResolvedValueOnce({
      _id: existingTxId,
      pointsDelta: -50,
    });

    const res = await loyaltyService.reverseForRefund({
      invoice: makeInvoice(),
      refundCase: rc,
      allocations: rc.allocations,
      session: mockSession,
    });

    expect(res).toEqual({
      status: "completed",
      alreadyReversed: true,
      pointsReversed: 50,
      referenceIds: [existingTxId],
    });
    expect(rc.domainReversals.loyalty.status).toBe("completed");
    expect(rc.save).toHaveBeenCalledWith({ session: mockSession });
    expect(mockCustomerFindOne).not.toHaveBeenCalled();
  });
});
