import { describe, expect, it, beforeEach, jest } from "@jest/globals";
import mongoose from "mongoose";
import { Invoice } from "../../../src/models/billing/invoice.model.js";
import { Payment } from "../../../src/models/billing/payment.model.js";
import { RefundCase } from "../../../src/models/billing/refundCase.model.js";
import { refundService } from "../../../src/services/billing/refund.service.js";
import { previewRefundSchema } from "../../../src/validation/billing/billing.validation.js";

const mockLeanChain = (value) => ({
  select: jest.fn().mockReturnThis(),
  sort: jest.fn().mockReturnThis(),
  session: jest.fn().mockReturnThis(),
  lean: jest.fn().mockResolvedValue(value),
});

describe("Refund Foundation (Isolated Unit Verification)", () => {
  const orgId = new mongoose.Types.ObjectId();
  const otherOrgId = new mongoose.Types.ObjectId();
  const branchId = new mongoose.Types.ObjectId();
  const otherBranchId = new mongoose.Types.ObjectId();
  const customerId = new mongoose.Types.ObjectId();
  const userId = new mongoose.Types.ObjectId();
  const line1Id = new mongoose.Types.ObjectId();
  const line2Id = new mongoose.Types.ObjectId();

  const makeInvoice = (overrides = {}) => ({
    _id: new mongoose.Types.ObjectId(),
    organizationId: orgId,
    branchId,
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
        customerPayable: 600,
      },
      {
        _id: line2Id,
        lineType: "service",
        name: "Haircut",
        quantity: 1,
        returnedQuantity: 0,
        customerPayable: 400,
      },
    ],
    ...overrides,
  });

  beforeEach(() => {
    jest.restoreAllMocks();
  });

  it("1. Finalized Paid invoice is eligible when refundable balance exists", async () => {
    const invoice = makeInvoice();
    jest.spyOn(Invoice, "findOne").mockReturnValue(mockLeanChain(invoice));
    jest.spyOn(Payment, "find").mockReturnValue(
      mockLeanChain([{ amount: 1000, type: "payment", status: "completed" }])
    );
    jest.spyOn(RefundCase, "find").mockReturnValue(mockLeanChain([]));

    const ctx = await refundService.getRefundContext(invoice._id, orgId, branchId);

    expect(ctx.eligibility.isEligible).toBe(true);
    expect(ctx.eligibility.reasonCode).toBe("ELIGIBLE");
    expect(ctx.summary.refundableBalancePaise).toBe(100000);
    expect(ctx.summary.derivedRefundStatus).toBe("none");
  });

  it("2. Draft, unpaid, partially paid, and cancelled invoices are rejected", async () => {
    for (const [overrides, expectedCode] of [
      [{ status: "draft", paymentStatus: "unpaid" }, "DRAFT_INVOICE"],
      [{ status: "cancelled", paymentStatus: "unpaid" }, "CANCELLED_INVOICE"],
      [{ status: "finalized", paymentStatus: "unpaid" }, "UNPAID_INVOICE"],
      [{ status: "finalized", paymentStatus: "partially_paid" }, "PARTIALLY_PAID_INVOICE"],
    ]) {
      const invoice = makeInvoice(overrides);
      jest.spyOn(Invoice, "findOne").mockReturnValue(mockLeanChain(invoice));
      jest.spyOn(Payment, "find").mockReturnValue(mockLeanChain([]));
      jest.spyOn(RefundCase, "find").mockReturnValue(mockLeanChain([]));

      const ctx = await refundService.getRefundContext(invoice._id, orgId, branchId);
      expect(ctx.eligibility.isEligible).toBe(false);
      expect(ctx.eligibility.reasonCode).toBe(expectedCode);

      await expect(
        refundService.previewRefund(
          invoice._id,
          { refundMode: "financial_only", requestedAmountPaise: 10000 },
          orgId,
          branchId
        )
      ).rejects.toThrow();
    }
  });

  it("3. Partially refunded invoice remains eligible; fully refunded invoice is ineligible", async () => {
    const invoice = makeInvoice();
    jest.spyOn(Invoice, "findOne").mockReturnValue(mockLeanChain(invoice));
    jest.spyOn(RefundCase, "find").mockReturnValue(mockLeanChain([]));

    jest.spyOn(Payment, "find").mockReturnValue(
      mockLeanChain([
        { amount: 1000, type: "payment", status: "completed" },
        { amount: -400, type: "refund", status: "completed" },
      ])
    );

    const partialCtx = await refundService.getRefundContext(invoice._id, orgId, branchId);
    expect(partialCtx.eligibility.isEligible).toBe(true);
    expect(partialCtx.summary.refundableBalancePaise).toBe(60000);
    expect(partialCtx.summary.derivedRefundStatus).toBe("partially_refunded");

    jest.spyOn(Payment, "find").mockReturnValue(
      mockLeanChain([
        { amount: 1000, type: "payment", status: "completed" },
        { amount: -1000, type: "refund", status: "completed" },
      ])
    );

    const fullCtx = await refundService.getRefundContext(invoice._id, orgId, branchId);
    expect(fullCtx.eligibility.isEligible).toBe(false);
    expect(fullCtx.eligibility.reasonCode).toBe("FULLY_REFUNDED");
    expect(fullCtx.summary.derivedRefundStatus).toBe("fully_refunded");
  });

  it("4. Pending RefundCase reservations reduce refundable balance and cannot cause over-refunding", async () => {
    const invoice = makeInvoice();
    jest.spyOn(Invoice, "findOne").mockReturnValue(mockLeanChain(invoice));
    jest.spyOn(Payment, "find").mockReturnValue(
      mockLeanChain([{ amount: 1000, type: "payment", status: "completed" }])
    );
    jest.spyOn(RefundCase, "find").mockReturnValue(
      mockLeanChain([
        {
          _id: new mongoose.Types.ObjectId(),
          refundNumber: "REF-1",
          refundMode: "financial_only",
          requestedAmountPaise: 70000,
          pendingAmountPaise: 70000,
          settledAmountPaise: 0,
          status: "pending",
        },
      ])
    );

    const ctx = await refundService.getRefundContext(invoice._id, orgId, branchId);
    expect(ctx.summary.pendingReservedPaise).toBe(70000);
    expect(ctx.summary.refundableBalancePaise).toBe(30000);
    expect(ctx.summary.derivedRefundStatus).toBe("pending_refund");

    await expect(
      refundService.previewRefund(
        invoice._id,
        { refundMode: "financial_only", requestedAmountPaise: 30001 },
        orgId,
        branchId
      )
    ).rejects.toThrow(/exceeds remaining refundable balance/i);
  });

  it("5. Financial-only and item-linked previews calculate deterministically in paise with loyalty allocation and no DB writes", async () => {
    const invoice = makeInvoice({ loyaltyDiscountAmount: 100, payableAmount: 900 });
    jest.spyOn(Invoice, "findOne").mockReturnValue(mockLeanChain(invoice));
    jest.spyOn(Payment, "find").mockReturnValue(
      mockLeanChain([{ amount: 900, type: "payment", status: "completed" }])
    );
    jest.spyOn(RefundCase, "find").mockReturnValue(mockLeanChain([]));
    const createSpy = jest.spyOn(RefundCase, "create");
    const payCreateSpy = jest.spyOn(Payment, "create");

    const finPreview1 = await refundService.previewRefund(
      invoice._id,
      { refundMode: "financial_only", requestedAmountPaise: 25000 },
      orgId,
      branchId
    );
    const finPreview2 = await refundService.previewRefund(
      invoice._id,
      { refundMode: "financial_only", requestedAmountPaise: 25000 },
      orgId,
      branchId
    );
    expect(finPreview1).toEqual(finPreview2);
    expect(finPreview1.allocations).toEqual([]);
    expect(finPreview1.remainingRefundableBalancePaise).toBe(65000);

    // Loyalty 10000 paise allocated 6000 to line1 (600) and 4000 to line2 (400).
    // Line1 net = 60000 - 6000 = 54000 paise for qty 2 -> 27000 paise for qty 1.
    const itemPreview = await refundService.previewRefund(
      invoice._id,
      {
        refundMode: "item_linked",
        items: [{ lineId: line1Id.toString(), quantity: 1, acceptPhysicalRestock: true }],
      },
      orgId,
      branchId
    );
    expect(itemPreview.totalRefundAmountPaise).toBe(27000);
    expect(itemPreview.allocations[0].loyaltyAllocatedPaise).toBe(6000);
    expect(createSpy).not.toHaveBeenCalled();
    expect(payCreateSpy).not.toHaveBeenCalled();
  });

  it("6. Completed service lines are blocked with COMPLETED_SERVICE_POLICY_PENDING", async () => {
    const invoice = makeInvoice();
    jest.spyOn(Invoice, "findOne").mockReturnValue(mockLeanChain(invoice));
    jest.spyOn(Payment, "find").mockReturnValue(
      mockLeanChain([{ amount: 1000, type: "payment", status: "completed" }])
    );
    jest.spyOn(RefundCase, "find").mockReturnValue(mockLeanChain([]));

    await expect(
      refundService.previewRefund(
        invoice._id,
        {
          refundMode: "item_linked",
          items: [{ lineId: line2Id.toString(), quantity: 1 }],
        },
        orgId,
        branchId
      )
    ).rejects.toThrow(/COMPLETED_SERVICE_POLICY_PENDING/);
  });

  it("7. Cross-organization and unauthorized branch access are rejected", async () => {
    jest.spyOn(Invoice, "findOne").mockReturnValue(mockLeanChain(null));
    await expect(
      refundService.getRefundContext(new mongoose.Types.ObjectId(), otherOrgId, branchId)
    ).rejects.toThrow(/Invoice not found/);

    const invoice = makeInvoice();
    jest.spyOn(Invoice, "findOne").mockReturnValue(mockLeanChain(invoice));
    await expect(
      refundService.getRefundContext(invoice._id, orgId, otherBranchId)
    ).rejects.toThrow(/belongs to another branch/);
  });

  it("8. Validation schema and RefundCase idempotency uniqueness index are properly configured", () => {
    const validFin = previewRefundSchema.safeParse({
      params: { id: new mongoose.Types.ObjectId().toString() },
      body: { refundMode: "financial_only", requestedAmountPaise: 5000 },
    });
    expect(validFin.success).toBe(true);

    const invalidFin = previewRefundSchema.safeParse({
      params: { id: new mongoose.Types.ObjectId().toString() },
      body: { refundMode: "financial_only", requestedAmountPaise: -10 },
    });
    expect(invalidFin.success).toBe(false);

    const indexes = RefundCase.schema.indexes();
    const idempIdx = indexes.find(([keys]) => keys.organizationId === 1 && keys.idempotencyKey === 1);
    expect(idempIdx).toBeDefined();
    expect(idempIdx[1].unique).toBe(true);
  });
});
