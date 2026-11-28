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

describe("Refund Case Payment Settlement (Isolated Unit Verification)", () => {
  const orgId = new mongoose.Types.ObjectId();
  const branchId = new mongoose.Types.ObjectId();
  const otherBranchId = new mongoose.Types.ObjectId();
  const invoiceId = new mongoose.Types.ObjectId();
  const customerId = new mongoose.Types.ObjectId();
  const userId = new mongoose.Types.ObjectId();

  const makeRefundCase = (overrides = {}) => ({
    _id: new mongoose.Types.ObjectId(),
    organizationId: orgId,
    branchId,
    invoiceId,
    customerId,
    refundNumber: "REF-20261126-0001",
    refundMode: "financial_only",
    requestedAmountPaise: 50000,
    pendingAmountPaise: 50000,
    settledAmountPaise: 0,
    refundMethod: "cash",
    settlementType: "manual_record",
    status: "pending",
    paymentSettlementStatus: "pending",
    paymentId: null,
    domainReversals: {
      inventory: { status: "not_applicable", referenceIds: [] },
      membership: { status: "not_applicable", referenceIds: [] },
      subscription: { status: "not_applicable", referenceIds: [] },
      loyalty: { status: "not_applicable", referenceIds: [] },
      incentives: { status: "not_applicable", referenceIds: [] },
      appointment: { status: "not_applicable", referenceIds: [] },
    },
    save: jest.fn().mockResolvedValue(true),
    ...overrides,
  });

  beforeEach(() => {
    jest.restoreAllMocks();
    jest.spyOn(mongoose, "startSession").mockResolvedValue(mockSession());
    jest.spyOn(ScopeLock, "findOneAndUpdate").mockResolvedValue({});
  });

  it("1 & 2 & 3. Settles pending RefundCase with one negative Payment linked to org, branch, invoice, and RefundCase without mutating Invoice", async () => {
    const rc = makeRefundCase();
    const invUpdateSpy = jest.spyOn(Invoice, "findOneAndUpdate");
    jest.spyOn(RefundCase, "findOne").mockReturnValue(mockQuery(rc));
    jest.spyOn(Payment, "find").mockReturnValue(
      mockQuery([{ type: "payment", amount: 500 }]),
    );
    jest.spyOn(Invoice, "updateOne").mockResolvedValue({ modifiedCount: 1 });
    const payCreateSpy = jest
      .spyOn(Payment, "create")
      .mockImplementation(async (docs) => [
        { ...docs[0], _id: new mongoose.Types.ObjectId() },
      ]);

    const res = await refundService.settleRefundCase(
      invoiceId,
      rc._id,
      { refundMethod: "upi" },
      orgId,
      branchId,
      userId,
      "settle-key-1",
    );

    expect(res.idempotentReplay).toBe(false);
    expect(payCreateSpy).toHaveBeenCalledTimes(1);
    const createdPay = payCreateSpy.mock.calls[0][0][0];
    expect(createdPay.amount).toBe(-500);
    expect(createdPay.type).toBe("refund");
    expect(createdPay.status).toBe("completed");
    expect(createdPay.isManualRefundRecord).toBe(true);
    expect(createdPay.refundCaseId).toEqual(rc._id);
    expect(createdPay.invoiceId).toEqual(invoiceId);
    expect(createdPay.organizationId).toEqual(orgId);
    expect(createdPay.branchId).toEqual(branchId);

    expect(rc.paymentSettlementStatus).toBe("settled");
    expect(rc.settledAmountPaise).toBe(50000);
    expect(rc.pendingAmountPaise).toBe(0);
    expect(rc.status).toBe("completed");
    expect(rc.save).toHaveBeenCalledTimes(1);
    expect(invUpdateSpy).not.toHaveBeenCalled();
  });

  it("4. Repeating settlement on an already-settled RefundCase returns existing Payment without creating another", async () => {
    const existingPayId = new mongoose.Types.ObjectId();
    const rc = makeRefundCase({
      status: "completed",
      paymentSettlementStatus: "settled",
      paymentId: existingPayId,
      pendingAmountPaise: 0,
      settledAmountPaise: 50000,
    });
    const existingPay = {
      _id: existingPayId,
      amount: -500,
      type: "refund",
      status: "completed",
    };

    jest.spyOn(RefundCase, "findOne").mockReturnValue(mockQuery(rc));
    jest.spyOn(Payment, "find").mockReturnValue(
      mockQuery([{ type: "payment", amount: 500 }]),
    );
    jest.spyOn(Invoice, "updateOne").mockResolvedValue({ modifiedCount: 1 });
    jest.spyOn(Payment, "findOne").mockReturnValue(mockQuery(existingPay));
    const payCreateSpy = jest.spyOn(Payment, "create");

    const res = await refundService.settleRefundCase(
      invoiceId,
      rc._id,
      {},
      orgId,
      branchId,
      userId,
      "settle-key-1",
    );

    expect(res.idempotentReplay).toBe(true);
    expect(res.refundPayment._id).toEqual(existingPayId);
    expect(payCreateSpy).not.toHaveBeenCalled();
  });

  it("5 & 7. Concurrent E11000 duplicate-key race recovers existing Payment and RefundCase", async () => {
    const existingPay = {
      _id: new mongoose.Types.ObjectId(),
      refundCaseId: new mongoose.Types.ObjectId(),
      amount: -500,
    };
    const rc = makeRefundCase({
      _id: existingPay.refundCaseId,
      paymentSettlementStatus: "settled",
      paymentId: existingPay._id,
    });

    jest.spyOn(mongoose, "startSession").mockResolvedValue({
      withTransaction: jest.fn().mockRejectedValue({ code: 11000 }),
      endSession: jest.fn().mockResolvedValue(undefined),
    });
    jest.spyOn(Payment, "findOne").mockReturnValue(mockQuery(existingPay));
    jest.spyOn(RefundCase, "findOne").mockReturnValue(mockQuery(rc));
    jest.spyOn(Payment, "find").mockReturnValue(
      mockQuery([{ type: "payment", amount: 500 }]),
    );
    jest.spyOn(Invoice, "updateOne").mockResolvedValue({ modifiedCount: 1 });

    const res = await refundService.settleRefundCase(
      invoiceId,
      rc._id,
      {},
      orgId,
      branchId,
      userId,
      "settle-race-1",
    );

    expect(res.idempotentReplay).toBe(true);
    expect(res.refundPayment._id).toEqual(existingPay._id);
  });

  it("6 & 8 & 9. Rejects amount exceeding pendingAmountPaise and rejects cancelled/rejected cases", async () => {
    const rc = makeRefundCase({ pendingAmountPaise: 30000 });
    jest.spyOn(RefundCase, "findOne").mockReturnValue(mockQuery(rc));
    jest.spyOn(Payment, "find").mockReturnValue(
      mockQuery([{ type: "payment", amount: 500 }]),
    );
    jest.spyOn(Invoice, "updateOne").mockResolvedValue({ modifiedCount: 1 });

    await expect(
      refundService.settleRefundCase(
        invoiceId,
        rc._id,
        { amountPaise: 30001 },
        orgId,
        branchId,
        userId,
        "settle-over-1",
      ),
    ).rejects.toThrow(/must match the authorized pending RefundCase amount/i);

    const cancelledRc = makeRefundCase({ status: "cancelled" });
    jest.spyOn(RefundCase, "findOne").mockReturnValue(mockQuery(cancelledRc));

    await expect(
      refundService.settleRefundCase(
        invoiceId,
        cancelledRc._id,
        {},
        orgId,
        branchId,
        userId,
        "settle-cancel-1",
      ),
    ).rejects.toThrow(/cannot be settled/i);
  });

  it("10. Rejects cross-organization / unauthorized branch", async () => {
    const rc = makeRefundCase();
    jest.spyOn(RefundCase, "findOne").mockReturnValue(mockQuery(rc));
    jest.spyOn(Payment, "find").mockReturnValue(
      mockQuery([{ type: "payment", amount: 500 }]),
    );
    jest.spyOn(Invoice, "updateOne").mockResolvedValue({ modifiedCount: 1 });

    await expect(
      refundService.settleRefundCase(
        invoiceId,
        rc._id,
        {},
        orgId,
        otherBranchId,
        userId,
        "settle-branch-1",
      ),
    ).rejects.toThrow(/belongs to another branch/i);
  });

  it("11. Payment model enforces unique { organizationId, refundCaseId } partial index", () => {
    const indexes = Payment.schema.indexes();
    const rcIdx = indexes.find(
      ([keys]) => keys.organizationId === 1 && keys.refundCaseId === 1,
    );
    expect(rcIdx).toBeDefined();
    expect(rcIdx[1].unique).toBe(true);
  });
});
