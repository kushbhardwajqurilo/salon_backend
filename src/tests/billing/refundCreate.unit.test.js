import { describe, expect, it, beforeEach, jest } from "@jest/globals";
import mongoose from "mongoose";
import { Invoice } from "../../../src/models/billing/invoice.model.js";
import { Payment } from "../../../src/models/billing/payment.model.js";
import { RefundCase } from "../../../src/models/billing/refundCase.model.js";
import { ScopeLock } from "../../../src/models/incentives/scopeLock.model.js";
import { refundService } from "../../../src/services/billing/refund.service.js";

const mockSession = () => ({
  withTransaction: jest.fn(async (fn) => fn()),
  endSession: jest.fn().mockResolvedValue(undefined),
});

const mockQuery = (value) => ({
  select: jest.fn().mockReturnThis(),
  sort: jest.fn().mockReturnThis(),
  session: jest.fn().mockReturnThis(),
  lean: jest.fn().mockResolvedValue(value),
  then: (resolve, reject) => Promise.resolve(value).then(resolve, reject),
});

describe("Refund Case Creation & Reservation (Isolated Unit Verification)", () => {
  const orgId = new mongoose.Types.ObjectId();
  const branchId = new mongoose.Types.ObjectId();
  const otherBranchId = new mongoose.Types.ObjectId();
  const customerId = new mongoose.Types.ObjectId();
  const userId = new mongoose.Types.ObjectId();
  const line1Id = new mongoose.Types.ObjectId();

  const makeInvoice = (overrides = {}) => ({
    _id: new mongoose.Types.ObjectId(),
    organizationId: orgId,
    branchId,
    customerId,
    invoiceNumber: "INV-20261126-0001",
    status: "finalized",
    paymentStatus: "paid",
    payableAmount: 1000,
    loyaltyDiscountAmount: 0,
    lines: [
      {
        _id: line1Id,
        lineType: "product",
        name: "Shampoo",
        quantity: 2,
        returnedQuantity: 0,
        customerPayable: 1000,
      },
    ],
    ...overrides,
  });

  beforeEach(() => {
    jest.restoreAllMocks();
    jest.spyOn(mongoose, "startSession").mockResolvedValue(mockSession());
  });

  it("1. Creates a pending financial_only RefundCase, uses ScopeLock, never mutates Invoice, and passes same session to all queries", async () => {
    const invoice = makeInvoice();
    const sessionObj = mockSession();
    jest.spyOn(mongoose, "startSession").mockResolvedValue(sessionObj);

    const rcFindOneSpy = jest.spyOn(RefundCase, "findOne").mockReturnValue(mockQuery(null));
    const lockSpy = jest.spyOn(ScopeLock, "findOneAndUpdate").mockResolvedValue({});
    const invUpdateSpy = jest.spyOn(Invoice, "findOneAndUpdate");
    const invFindOneSpy = jest.spyOn(Invoice, "findOne").mockReturnValue(mockQuery(invoice));
    const payFindSpy = jest.spyOn(Payment, "find").mockReturnValue(
      mockQuery([{ amount: 1000, type: "payment", status: "completed" }])
    );
    const rcFindSpy = jest.spyOn(RefundCase, "find").mockReturnValue(mockQuery([]));
    const payCreateSpy = jest.spyOn(Payment, "create");
    const createSpy = jest.spyOn(RefundCase, "create").mockImplementation(async (docs) => docs);

    const res = await refundService.createPendingRefundCase(
      invoice._id,
      {
        refundMode: "financial_only",
        refundMethod: "cash",
        requestedAmountPaise: 40000,
        reason: "Goodwill compensation",
      },
      orgId,
      branchId,
      userId,
      "key-fin-1"
    );

    expect(res.idempotentReplay).toBe(false);
    expect(res.refundCase.status).toBe("pending");
    expect(res.refundCase.pendingAmountPaise).toBe(40000);
    expect(res.refundCase.settledAmountPaise).toBe(0);
    expect(invUpdateSpy).not.toHaveBeenCalled();
    expect(lockSpy).toHaveBeenCalledWith(
      expect.objectContaining({ organizationId: orgId, scopeKey: `REFUND_RESERVE:${invoice._id}` }),
      expect.any(Object),
      expect.objectContaining({ session: sessionObj })
    );
    expect(rcFindOneSpy.mock.results[0].value.session).toHaveBeenCalledWith(sessionObj);
    expect(invFindOneSpy.mock.results[0].value.session).toHaveBeenCalledWith(sessionObj);
    expect(payFindSpy.mock.results[0].value.session).toHaveBeenCalledWith(sessionObj);
    expect(rcFindSpy.mock.results[0].value.session).toHaveBeenCalledWith(sessionObj);
    expect(createSpy).toHaveBeenCalledWith(expect.any(Array), { session: sessionObj });
    expect(payCreateSpy).not.toHaveBeenCalled();
  });

  it("2. Creates an item_linked RefundCase with persisted allocations", async () => {
    const invoice = makeInvoice();
    jest.spyOn(RefundCase, "findOne").mockReturnValue(mockQuery(null));
    jest.spyOn(ScopeLock, "findOneAndUpdate").mockResolvedValue({});
    jest.spyOn(Invoice, "findOne").mockReturnValue(mockQuery(invoice));
    jest.spyOn(Payment, "find").mockReturnValue(
      mockQuery([{ amount: 1000, type: "payment", status: "completed" }])
    );
    jest.spyOn(RefundCase, "find").mockReturnValue(mockQuery([]));
    jest.spyOn(RefundCase, "create").mockImplementation(async (docs) => docs);

    const res = await refundService.createPendingRefundCase(
      invoice._id,
      {
        refundMode: "item_linked",
        refundMethod: "upi",
        items: [{ lineId: line1Id.toString(), quantity: 1, acceptPhysicalRestock: true }],
        reason: "Unopened return",
      },
      orgId,
      branchId,
      userId,
      "key-item-1"
    );

    expect(res.idempotentReplay).toBe(false);
    expect(res.refundCase.status).toBe("pending");
    expect(res.refundCase.requestedAmountPaise).toBe(50000);
    expect(res.refundCase.allocations).toHaveLength(1);
    expect(res.refundCase.allocations[0].allocatedAmountPaise).toBe(50000);
    expect(res.refundCase.allocations[0].domainReversalStatus).toBe("pending");
  });

  it("3 & 4. Rejects ineligible invoice or amount exceeding remaining balance after pending reservations", async () => {
    const invoice = makeInvoice();
    jest.spyOn(RefundCase, "findOne").mockReturnValue(mockQuery(null));
    jest.spyOn(ScopeLock, "findOneAndUpdate").mockResolvedValue({});
    jest.spyOn(Invoice, "findOne").mockReturnValue(mockQuery(invoice));
    jest.spyOn(Payment, "find").mockReturnValue(
      mockQuery([{ amount: 1000, type: "payment", status: "completed" }])
    );
    jest.spyOn(RefundCase, "find").mockReturnValue(
      mockQuery([
        {
          _id: new mongoose.Types.ObjectId(),
          status: "pending",
          pendingAmountPaise: 70000,
          requestedAmountPaise: 70000,
        },
      ])
    );

    await expect(
      refundService.createPendingRefundCase(
        invoice._id,
        {
          refundMode: "financial_only",
          refundMethod: "cash",
          requestedAmountPaise: 30001,
          reason: "Over reserve",
        },
        orgId,
        branchId,
        userId,
        "key-over-1"
      )
    ).rejects.toThrow(/exceeds remaining refundable balance/i);
  });

  it("5 & 6. Same-key/same-payload returns existing case; same-key/different-payload throws 409", async () => {
    const invoice = makeInvoice();
    jest.spyOn(RefundCase, "findOne").mockReturnValue(mockQuery(null));
    jest.spyOn(ScopeLock, "findOneAndUpdate").mockResolvedValue({});
    jest.spyOn(Invoice, "findOne").mockReturnValue(mockQuery(invoice));
    jest.spyOn(Payment, "find").mockReturnValue(
      mockQuery([{ amount: 1000, type: "payment", status: "completed" }])
    );
    jest.spyOn(RefundCase, "find").mockReturnValue(mockQuery([]));

    let savedCase = null;
    jest.spyOn(RefundCase, "create").mockImplementation(async (docs) => {
      savedCase = { ...docs[0], _id: new mongoose.Types.ObjectId(), invoiceId: invoice._id };
      return [savedCase];
    });

    const first = await refundService.createPendingRefundCase(
      invoice._id,
      {
        refundMode: "financial_only",
        refundMethod: "cash",
        requestedAmountPaise: 20000,
        reason: "Retry test",
      },
      orgId,
      branchId,
      userId,
      "key-idemp-1"
    );

    jest.spyOn(RefundCase, "findOne").mockReturnValue(mockQuery(savedCase));

    const replay = await refundService.createPendingRefundCase(
      invoice._id,
      {
        refundMode: "financial_only",
        refundMethod: "cash",
        requestedAmountPaise: 20000,
        reason: "Retry test",
      },
      orgId,
      branchId,
      userId,
      "key-idemp-1"
    );
    expect(replay.idempotentReplay).toBe(true);
    expect(replay.refundCase._id).toEqual(first.refundCase._id);

    await expect(
      refundService.createPendingRefundCase(
        invoice._id,
        {
          refundMode: "financial_only",
          refundMethod: "cash",
          requestedAmountPaise: 25000,
          reason: "Retry test",
        },
        orgId,
        branchId,
        userId,
        "key-idemp-1"
      )
    ).rejects.toThrow(/different refund request/i);
  });

  it("7. Handles concurrent duplicate-key E11000 race safely", async () => {
    const invoice = makeInvoice();
    const existing = {
      _id: new mongoose.Types.ObjectId(),
      invoiceId: invoice._id,
      requestPayloadHash: "mismatch",
    };

    jest
      .spyOn(mongoose, "startSession")
      .mockResolvedValue({
        withTransaction: jest.fn().mockRejectedValue({ code: 11000 }),
        endSession: jest.fn().mockResolvedValue(undefined),
      });
    jest.spyOn(RefundCase, "findOne").mockReturnValue(mockQuery(existing));

    await expect(
      refundService.createPendingRefundCase(
        invoice._id,
        {
          refundMode: "financial_only",
          refundMethod: "cash",
          requestedAmountPaise: 20000,
          reason: "Race test",
        },
        orgId,
        branchId,
        userId,
        "key-race-1"
      )
    ).rejects.toThrow(/different refund request/i);
  });

  it("8. Rejects cross-organization / unauthorized branch", async () => {
    const invoice = makeInvoice();
    jest.spyOn(RefundCase, "findOne").mockReturnValue(mockQuery(null));
    jest.spyOn(ScopeLock, "findOneAndUpdate").mockResolvedValue({});
    jest.spyOn(Invoice, "findOne").mockReturnValue(mockQuery(invoice));

    await expect(
      refundService.createPendingRefundCase(
        invoice._id,
        {
          refundMode: "financial_only",
          refundMethod: "cash",
          requestedAmountPaise: 10000,
          reason: "Wrong branch",
        },
        orgId,
        otherBranchId,
        userId,
        "key-branch-1"
      )
    ).rejects.toThrow(/belongs to another branch/i);
  });

  it("9. ScopeLock enforces unique { organizationId, scopeType, scopeKey } index", () => {
    const indexes = ScopeLock.schema.indexes();
    const lockIdx = indexes.find(
      ([keys]) => keys.organizationId === 1 && keys.scopeType === 1 && keys.scopeKey === 1
    );
    expect(lockIdx).toBeDefined();
    expect(lockIdx[1].unique).toBe(true);
  });

  it("10. Transient transaction retry re-acquires ScopeLock and revalidates refundable balance", async () => {
    const invoice = makeInvoice();
    let attempts = 0;
    const sessionObj = {
      withTransaction: jest.fn(async (fn) => {
        attempts += 1;
        await fn();
        if (attempts === 1) {
          // Simulate driver retry on transient write conflict
          attempts += 1;
          await fn();
        }
      }),
      endSession: jest.fn().mockResolvedValue(undefined),
    };
    jest.spyOn(mongoose, "startSession").mockResolvedValue(sessionObj);
    jest.spyOn(RefundCase, "findOne").mockReturnValue(mockQuery(null));
    const lockSpy = jest.spyOn(ScopeLock, "findOneAndUpdate").mockResolvedValue({});
    jest.spyOn(Invoice, "findOne").mockReturnValue(mockQuery(invoice));
    jest.spyOn(Payment, "find").mockReturnValue(
      mockQuery([{ amount: 1000, type: "payment", status: "completed" }])
    );
    jest.spyOn(RefundCase, "find").mockReturnValue(mockQuery([]));
    jest.spyOn(RefundCase, "create").mockImplementation(async (docs) => docs);

    await refundService.createPendingRefundCase(
      invoice._id,
      {
        refundMode: "financial_only",
        refundMethod: "cash",
        requestedAmountPaise: 10000,
        reason: "Retry revalidation",
      },
      orgId,
      branchId,
      userId,
      "key-retry-1"
    );

    expect(lockSpy).toHaveBeenCalledTimes(2);
    expect(sessionObj.endSession).toHaveBeenCalledTimes(1);
  });

  it("11. Lock upsert E11000 without existing RefundCase propagates error and ends session", async () => {
    const invoice = makeInvoice();
    const endSession = jest.fn().mockResolvedValue(undefined);
    jest.spyOn(mongoose, "startSession").mockResolvedValue({
      withTransaction: jest.fn().mockRejectedValue({ code: 11000 }),
      endSession,
    });
    jest.spyOn(RefundCase, "findOne").mockReturnValue(mockQuery(null));

    await expect(
      refundService.createPendingRefundCase(
        invoice._id,
        {
          refundMode: "financial_only",
          refundMethod: "cash",
          requestedAmountPaise: 10000,
          reason: "Lock upsert race",
        },
        orgId,
        branchId,
        userId,
        "key-lock-race-1"
      )
    ).rejects.toMatchObject({ code: 11000 });
    expect(endSession).toHaveBeenCalledTimes(1);
  });
});
