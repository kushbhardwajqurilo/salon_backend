import { jest } from "@jest/globals";
import mongoose from "mongoose";
import { billingService } from "../../services/billing/billing.service.js";
import { refundService } from "../../services/billing/refund.service.js";
import { Invoice } from "../../models/billing/invoice.model.js";
import { StockMovement } from "../../models/inventory/stockMovement.model.js";

describe("BillingService.processInvoiceReturn (line-type-aware delegation to RefundService)", () => {
  const orgId = new mongoose.Types.ObjectId();
  const branchId = new mongoose.Types.ObjectId();
  const userId = new mongoose.Types.ObjectId();
  const invoiceId = new mongoose.Types.ObjectId();
  const subLineId = new mongoose.Types.ObjectId();
  const prodLineId = new mongoose.Types.ObjectId();
  const refundCaseId = new mongoose.Types.ObjectId();
  const movementId = new mongoose.Types.ObjectId();

  afterEach(() => {
    jest.restoreAllMocks();
  });

  it("processes a subscription line return without failing physical-product validation", async () => {
    const mockRefundCase = {
      _id: refundCaseId,
      settledAmountPaise: 150000,
      status: "settled",
    };
    const mockPayment = { _id: new mongoose.Types.ObjectId(), amount: -1500, type: "refund", method: "cash" };
    const mockInvoice = {
      _id: invoiceId,
      organizationId: orgId,
      branchId,
      payableAmount: 1500,
      amountPaid: 1500,
      lines: [{ _id: subLineId, lineType: "subscription", name: "Subscription: SUB-20261127-0008" }],
    };

    const createSpy = jest.spyOn(refundService, "createPendingRefundCase").mockResolvedValue({
      refundCase: mockRefundCase,
      isIdempotentReplay: false,
    });
    const settleSpy = jest.spyOn(refundService, "settleRefundCase").mockResolvedValue({
      refundCase: mockRefundCase,
      refundPayment: mockPayment,
      domainReversals: { subscription: { status: "completed", referenceIds: [] } },
      isIdempotentReplay: false,
    });
    jest.spyOn(Invoice, "findOne").mockResolvedValue(mockInvoice);

    const result = await billingService.processInvoiceReturn(
      invoiceId.toString(),
      {
        branchId: branchId.toString(),
        items: [
          {
            lineId: subLineId.toString(),
            quantity: 1,
            condition: "unopened",
            acceptPhysicalRestock: false,
          },
        ],
        refundPaymentMethod: "cash",
        reason: "test refund",
      },
      orgId,
      branchId,
      userId,
      "sub-return-key-1",
    );

    expect(createSpy).toHaveBeenCalledWith(
      invoiceId.toString(),
      expect.objectContaining({
        branchId,
        refundMode: "item_linked",
        refundMethod: "cash",
        items: [{ lineId: subLineId.toString(), quantity: 1, acceptPhysicalRestock: false }],
        reason: "test refund",
      }),
      orgId,
      branchId,
      userId,
      "sub-return-key-1",
    );
    expect(settleSpy).toHaveBeenCalledWith(
      invoiceId.toString(),
      refundCaseId,
      expect.objectContaining({
        branchId,
        settlementType: "refund",
        refundMethod: "cash",
        reason: "test refund",
      }),
      orgId,
      branchId,
      userId,
      "SETTLE:sub-return-key-1",
    );
    expect(result.totalRefundAmount).toBe(1500);
    expect(result.refundPayment).toEqual(mockPayment);
    expect(result.restockedMovements).toEqual([]);
    expect(result.isIdempotentReplay).toBe(false);
    expect(result.domainReversals.subscription.status).toBe("completed");
  });

  it("returns restockedMovements when product return has acceptPhysicalRestock=true", async () => {
    const mockRefundCase = { _id: refundCaseId, settledAmountPaise: 85000, status: "settled" };
    const mockMovement = { _id: movementId, quantityDelta: 1 };

    jest.spyOn(refundService, "createPendingRefundCase").mockResolvedValue({
      refundCase: mockRefundCase,
      isIdempotentReplay: false,
    });
    jest.spyOn(refundService, "settleRefundCase").mockResolvedValue({
      refundCase: mockRefundCase,
      refundPayment: { _id: new mongoose.Types.ObjectId(), amount: -850 },
      domainReversals: { inventory: { status: "completed", movementIds: [movementId] } },
      isIdempotentReplay: false,
    });
    jest.spyOn(Invoice, "findOne").mockResolvedValue({ _id: invoiceId });
    jest.spyOn(StockMovement, "find").mockResolvedValue([mockMovement]);

    const result = await billingService.processInvoiceReturn(
      invoiceId.toString(),
      {
        branchId: branchId.toString(),
        items: [{ lineId: prodLineId.toString(), quantity: 1, acceptPhysicalRestock: true }],
        refundPaymentMethod: "cash",
        reason: "Duplicate purchase",
      },
      orgId,
      branchId,
      userId,
      "prod-return-key-1",
    );

    expect(result.totalRefundAmount).toBe(850);
    expect(result.restockedMovements).toEqual([mockMovement]);
  });

  it("propagates isIdempotentReplay=true on idempotent replay", async () => {
    const mockRefundCase = { _id: refundCaseId, settledAmountPaise: 150000, status: "settled" };

    jest.spyOn(refundService, "createPendingRefundCase").mockResolvedValue({
      refundCase: mockRefundCase,
      isIdempotentReplay: true,
    });
    jest.spyOn(refundService, "settleRefundCase").mockResolvedValue({
      refundCase: mockRefundCase,
      refundPayment: { _id: new mongoose.Types.ObjectId(), amount: -1500 },
      domainReversals: {},
      isIdempotentReplay: true,
    });
    jest.spyOn(Invoice, "findOne").mockResolvedValue({ _id: invoiceId });

    const result = await billingService.processInvoiceReturn(
      invoiceId.toString(),
      {
        branchId: branchId.toString(),
        items: [{ lineId: subLineId.toString(), quantity: 1, acceptPhysicalRestock: false }],
        refundPaymentMethod: "cash",
        reason: "test refund",
      },
      orgId,
      branchId,
      userId,
      "sub-return-key-1",
    );

    expect(result.isIdempotentReplay).toBe(true);
  });
});
