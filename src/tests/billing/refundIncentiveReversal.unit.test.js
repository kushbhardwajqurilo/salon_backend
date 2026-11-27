import { jest } from "@jest/globals";
import mongoose from "mongoose";

const mockSession = { id: "mock-session" };
const orgId = new mongoose.Types.ObjectId();
const branchId = new mongoose.Types.ObjectId();
const userId = new mongoose.Types.ObjectId();
const invoiceId = new mongoose.Types.ObjectId();

const mockRefundCaseFindOne = jest.fn();
const mockHandlePurchaseRefundProcessed = jest.fn();
const mockHandleProductReturnProcessed = jest.fn();

jest.unstable_mockModule("../../models/billing/refundCase.model.js", () => ({
  RefundCase: {
    findOne: mockRefundCaseFindOne,
  },
}));

jest.unstable_mockModule("../../services/incentives/settlementFulfillmentEvent.service.js", () => ({
  SettlementFulfillmentEventService: class {},
  settlementFulfillmentEventService: {
    handlePurchaseRefundProcessed: mockHandlePurchaseRefundProcessed,
    handleProductReturnProcessed: mockHandleProductReturnProcessed,
  },
}));

const { refundService } = await import("../../services/billing/refund.service.js");

function makeInvoice() {
  return {
    _id: invoiceId,
    organizationId: orgId,
    branchId,
  };
}

function makeRefundPayment(overrides = {}) {
  return {
    _id: new mongoose.Types.ObjectId(),
    type: "refund",
    amount: -500,
    ...overrides,
  };
}

function makeRefundCase(overrides = {}) {
  return {
    _id: new mongoose.Types.ObjectId(),
    organizationId: orgId,
    invoiceId,
    refundNumber: "RF-100",
    refundMode: "item_linked",
    refundKind: "item_linked",
    paymentSettlementStatus: "settled",
    reason: "Customer requested refund",
    allocations: [],
    domainReversals: { incentives: { status: "pending", referenceIds: [] } },
    save: jest.fn().mockResolvedValue(true),
    ...overrides,
  };
}

describe("refundService.reverseIncentivesForRefundCase (unit)", () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  test("1. throws 400 when session is missing or payment is unsettled", async () => {
    await expect(
      refundService.reverseIncentivesForRefundCase({
        invoice: makeInvoice(),
        refundCase: makeRefundCase(),
        refundPayment: makeRefundPayment(),
        userId,
      })
    ).rejects.toMatchObject({ statusCode: 400 });

    const unsettledRc = makeRefundCase({ paymentSettlementStatus: "pending" });
    mockRefundCaseFindOne.mockReturnValue({ session: () => Promise.resolve(unsettledRc) });
    await expect(
      refundService.reverseIncentivesForRefundCase({
        invoice: makeInvoice(),
        refundCase: unsettledRc,
        refundPayment: makeRefundPayment(),
        userId,
        session: mockSession,
      })
    ).rejects.toMatchObject({ statusCode: 400 });
  });

  test("2. skips financial_only refundCase without calling incentive service", async () => {
    const rc = makeRefundCase({ refundMode: "financial_only", refundKind: "financial_only" });
    mockRefundCaseFindOne.mockReturnValue({ session: () => Promise.resolve(rc) });

    const res = await refundService.reverseIncentivesForRefundCase({
      invoice: makeInvoice(),
      refundCase: rc,
      refundPayment: makeRefundPayment(),
      userId,
      session: mockSession,
    });

    expect(res.status).toBe("skipped");
    expect(rc.domainReversals.incentives.status).toBe("skipped");
    expect(rc.save).toHaveBeenCalledWith({ session: mockSession });
    expect(mockHandlePurchaseRefundProcessed).not.toHaveBeenCalled();
    expect(mockHandleProductReturnProcessed).not.toHaveBeenCalled();
  });

  test("3. routes partial/full membership & subscription allocations to handlePurchaseRefundProcessed", async () => {
    const memLineId = new mongoose.Types.ObjectId();
    const subLineId = new mongoose.Types.ObjectId();
    const clawbackId = new mongoose.Types.ObjectId();
    const rc = makeRefundCase({
      allocations: [
        { lineId: memLineId, lineType: "membership", allocatedAmountPaise: 30000 },
        { lineId: subLineId, lineType: "subscription", allocatedAmountPaise: 20000 },
      ],
    });
    const payment = makeRefundPayment({ amount: -500 });
    mockRefundCaseFindOne.mockReturnValue({ session: () => Promise.resolve(rc) });
    mockHandlePurchaseRefundProcessed.mockResolvedValue({
      refundEvent: { _id: new mongoose.Types.ObjectId() },
      clawbacks: [{ _id: clawbackId }],
    });

    const res = await refundService.reverseIncentivesForRefundCase({
      invoice: makeInvoice(),
      refundCase: rc,
      refundPayment: payment,
      userId,
      session: mockSession,
    });

    expect(mockHandlePurchaseRefundProcessed).toHaveBeenCalledWith({
      invoice: makeInvoice(),
      refundPayment: payment,
      refundAllocations: [
        { lineItemId: memLineId, refundAmountInPaise: 30000 },
        { lineItemId: subLineId, refundAmountInPaise: 20000 },
      ],
      reason: "Customer requested refund",
      session: mockSession,
      userId,
    });
    expect(res.status).toBe("completed");
    expect(res.referenceIds).toEqual([clawbackId]);
    expect(rc.domainReversals.incentives.status).toBe("completed");
    expect(rc.domainReversals.incentives.referenceIds).toEqual([clawbackId]);
  });

  test("4. routes product allocations to handleProductReturnProcessed with refundCase._id as returnOperationId", async () => {
    const prodLineId = new mongoose.Types.ObjectId();
    const clawbackId = new mongoose.Types.ObjectId();
    const rc = makeRefundCase({
      allocations: [
        { lineId: prodLineId, lineType: "product", quantity: 2, allocatedAmountPaise: 40000 },
      ],
    });
    mockRefundCaseFindOne.mockReturnValue({ session: () => Promise.resolve(rc) });
    mockHandleProductReturnProcessed.mockResolvedValue([{ _id: clawbackId }]);

    const res = await refundService.reverseIncentivesForRefundCase({
      invoice: makeInvoice(),
      refundCase: rc,
      refundPayment: makeRefundPayment(),
      userId,
      session: mockSession,
    });

    expect(mockHandleProductReturnProcessed).toHaveBeenCalledWith({
      invoice: makeInvoice(),
      returnedItems: [{ lineItemId: prodLineId, returnQty: 2, refundPaise: 40000 }],
      returnOperationId: rc._id.toString(),
      session: mockSession,
      userId,
    });
    expect(res.referenceIds).toEqual([clawbackId]);
  });

  test("5. safely identifies unsupported-only service accruals as pending without inventing clawbacks", async () => {
    const srvLineId = new mongoose.Types.ObjectId();
    const rc = makeRefundCase({
      allocations: [
        { lineId: srvLineId, lineType: "service", quantity: 1, allocatedAmountPaise: 25000 },
      ],
    });
    mockRefundCaseFindOne.mockReturnValue({ session: () => Promise.resolve(rc) });

    const res = await refundService.reverseIncentivesForRefundCase({
      invoice: makeInvoice(),
      refundCase: rc,
      refundPayment: makeRefundPayment(),
      userId,
      session: mockSession,
    });

    expect(mockHandlePurchaseRefundProcessed).not.toHaveBeenCalled();
    expect(mockHandleProductReturnProcessed).not.toHaveBeenCalled();
    expect(res.status).toBe("pending");
    expect(rc.domainReversals.incentives.status).toBe("pending");
    expect(res.unsupportedLineIds).toEqual([srvLineId]);
    expect(res.referenceIds).toEqual([]);
  });

  test("5b. marks mixed supported and unsupported allocations as partially_completed and retries idempotently", async () => {
    const memLineId = new mongoose.Types.ObjectId();
    const srvLineId = new mongoose.Types.ObjectId();
    const clawbackId = new mongoose.Types.ObjectId();
    const rc = makeRefundCase({
      allocations: [
        { lineId: memLineId, lineType: "membership", allocatedAmountPaise: 30000 },
        { lineId: srvLineId, lineType: "service", quantity: 1, allocatedAmountPaise: 20000 },
      ],
    });
    mockRefundCaseFindOne.mockReturnValue({ session: () => Promise.resolve(rc) });
    mockHandlePurchaseRefundProcessed.mockResolvedValue({
      clawbacks: [{ _id: clawbackId }],
    });

    const firstRes = await refundService.reverseIncentivesForRefundCase({
      invoice: makeInvoice(),
      refundCase: rc,
      refundPayment: makeRefundPayment(),
      userId,
      session: mockSession,
    });

    expect(firstRes.status).toBe("partially_completed");
    expect(rc.domainReversals.incentives.status).toBe("partially_completed");
    expect(firstRes.referenceIds).toEqual([clawbackId]);
    expect(firstRes.unsupportedLineIds).toEqual([srvLineId]);

    // Retry on partially_completed revisits without duplicating clawbacks
    const retryRes = await refundService.reverseIncentivesForRefundCase({
      invoice: makeInvoice(),
      refundCase: rc,
      refundPayment: makeRefundPayment(),
      userId,
      session: mockSession,
    });

    expect(retryRes.status).toBe("partially_completed");
    expect(retryRes.referenceIds).toEqual([clawbackId]);
    expect(mockHandlePurchaseRefundProcessed).toHaveBeenCalledTimes(2);
  });

  test("6. returns idempotently on retry after completed reversal and recovers from failed status", async () => {
    const existingRef = new mongoose.Types.ObjectId();
    const completedRc = makeRefundCase({
      domainReversals: { incentives: { status: "completed", referenceIds: [existingRef] } },
    });
    mockRefundCaseFindOne.mockReturnValueOnce({ session: () => Promise.resolve(completedRc) });

    const replayRes = await refundService.reverseIncentivesForRefundCase({
      invoice: makeInvoice(),
      refundCase: completedRc,
      refundPayment: makeRefundPayment(),
      userId,
      session: mockSession,
    });

    expect(replayRes.alreadyReversed).toBe(true);
    expect(replayRes.referenceIds).toEqual([existingRef]);
    expect(mockHandlePurchaseRefundProcessed).not.toHaveBeenCalled();

    const memLineId = new mongoose.Types.ObjectId();
    const newClawbackId = new mongoose.Types.ObjectId();
    const failedRc = makeRefundCase({
      allocations: [{ lineId: memLineId, lineType: "membership", allocatedAmountPaise: 15000 }],
      domainReversals: { incentives: { status: "failed", errorMessage: "transient error", referenceIds: [] } },
    });
    mockRefundCaseFindOne.mockReturnValueOnce({ session: () => Promise.resolve(failedRc) });
    mockHandlePurchaseRefundProcessed.mockResolvedValue({ clawbacks: [{ _id: newClawbackId }] });

    const retryRes = await refundService.reverseIncentivesForRefundCase({
      invoice: makeInvoice(),
      refundCase: failedRc,
      refundPayment: makeRefundPayment(),
      userId,
      session: mockSession,
    });

    expect(retryRes.status).toBe("completed");
    expect(retryRes.referenceIds).toEqual([newClawbackId]);
  });

  test("7. supports multiple partial RefundCases against the same invoice", async () => {
    const memLineId = new mongoose.Types.ObjectId();
    const rc1 = makeRefundCase({
      allocations: [{ lineId: memLineId, lineType: "membership", allocatedAmountPaise: 20000 }],
    });
    const rc2 = makeRefundCase({
      allocations: [{ lineId: memLineId, lineType: "membership", allocatedAmountPaise: 30000 }],
    });
    const cb1 = new mongoose.Types.ObjectId();
    const cb2 = new mongoose.Types.ObjectId();

    mockRefundCaseFindOne
      .mockReturnValueOnce({ session: () => Promise.resolve(rc1) })
      .mockReturnValueOnce({ session: () => Promise.resolve(rc2) });
    mockHandlePurchaseRefundProcessed
      .mockResolvedValueOnce({ clawbacks: [{ _id: cb1 }] })
      .mockResolvedValueOnce({ clawbacks: [{ _id: cb2 }] });

    const r1 = await refundService.reverseIncentivesForRefundCase({
      invoice: makeInvoice(),
      refundCase: rc1,
      refundPayment: makeRefundPayment({ amount: -200 }),
      userId,
      session: mockSession,
    });
    const r2 = await refundService.reverseIncentivesForRefundCase({
      invoice: makeInvoice(),
      refundCase: rc2,
      refundPayment: makeRefundPayment({ amount: -300 }),
      userId,
      session: mockSession,
    });

    expect(r1.referenceIds).toEqual([cb1]);
    expect(r2.referenceIds).toEqual([cb2]);
    expect(mockHandlePurchaseRefundProcessed).toHaveBeenCalledTimes(2);
  });
});
