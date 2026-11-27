import { describe, expect, it, beforeEach, jest } from "@jest/globals";
import mongoose from "mongoose";
import { StockBalance } from "../../../src/models/inventory/stockBalance.model.js";
import { Invoice } from "../../../src/models/billing/invoice.model.js";
import { RefundCase } from "../../../src/models/billing/refundCase.model.js";
import { stockMovementRepository } from "../../../src/repositories/inventory/stockMovement.repository.js";
import { inventoryService } from "../../../src/services/inventory/inventory.service.js";
import { Payment } from "../../../src/models/billing/payment.model.js";

describe("Inventory Reversal for Refunds (Isolated Unit Verification)", () => {
  const orgId = new mongoose.Types.ObjectId();
  const otherOrgId = new mongoose.Types.ObjectId();
  const branchId = new mongoose.Types.ObjectId();
  const productId = new mongoose.Types.ObjectId();
  const productLineId = new mongoose.Types.ObjectId();
  const serviceLineId = new mongoose.Types.ObjectId();
  const userId = new mongoose.Types.ObjectId();
  const session = { id: "mock-session" };

  const makeInvoice = () => ({
    _id: new mongoose.Types.ObjectId(),
    organizationId: orgId,
    branchId,
    lines: [
      {
        _id: productLineId,
        lineType: "product",
        productId,
        name: "Shampoo",
        quantity: 3,
        returnedQuantity: 1,
      },
      {
        _id: serviceLineId,
        lineType: "service",
        name: "Haircut",
        quantity: 1,
        returnedQuantity: 0,
      },
    ],
  });

  const makeRefundCase = (overrides = {}) => ({
    _id: new mongoose.Types.ObjectId(),
    organizationId: orgId,
    branchId,
    refundNumber: "REF-1",
    initiatedBy: userId,
    ...overrides,
  });

  beforeEach(() => {
    jest.restoreAllMocks();
  });

  it("1. Valid product allocation without restock does not update StockBalance or create StockMovement", async () => {
    const invoice = makeInvoice();
    const rc = makeRefundCase();
    jest.spyOn(stockMovementRepository, "findByIdempotencyKey").mockResolvedValue(null);
    const balSpy = jest.spyOn(StockBalance, "findOneAndUpdate");
    const movSpy = jest.spyOn(stockMovementRepository, "create");
    const invSpy = jest.spyOn(Invoice, "findOneAndUpdate").mockResolvedValue({ _id: invoice._id });
    const rcSpy = jest.spyOn(RefundCase, "findOneAndUpdate").mockResolvedValue(rc);
    const paySpy = jest.spyOn(Payment, "create");

    const res = await inventoryService.reverseSaleForRefund({
      invoice,
      refundCase: rc,
      allocations: [{ lineId: productLineId, quantity: 2, acceptPhysicalRestock: false }],
      session,
    });

    expect(res.status).toBe("completed");
    expect(res.restockedMovementIds).toEqual([]);
    expect(res.items[0].restocked).toBe(false);
    expect(balSpy).not.toHaveBeenCalled();
    expect(movSpy).not.toHaveBeenCalled();
    expect(invSpy).toHaveBeenCalledWith(
      expect.objectContaining({ _id: invoice._id, organizationId: orgId }),
      { $inc: { "lines.$.returnedQuantity": 2 } },
      expect.objectContaining({ session })
    );
    expect(rcSpy).toHaveBeenCalledWith(
      expect.objectContaining({ _id: rc._id, organizationId: orgId }),
      expect.objectContaining({
        $set: expect.objectContaining({ "domainReversals.inventory.status": "completed" }),
      }),
      expect.objectContaining({ session })
    );
    expect(paySpy).not.toHaveBeenCalled();
  });

  it("2 & 8. Valid product allocation with restock updates StockBalance and creates one StockMovement using caller session", async () => {
    const invoice = makeInvoice();
    const rc = makeRefundCase();
    const movId = new mongoose.Types.ObjectId();
    jest.spyOn(stockMovementRepository, "findByIdempotencyKey").mockResolvedValue(null);
    const balSpy = jest.spyOn(StockBalance, "findOneAndUpdate").mockResolvedValue({ onHand: 12 });
    const movSpy = jest.spyOn(stockMovementRepository, "create").mockResolvedValue({ _id: movId });
    jest.spyOn(Invoice, "findOneAndUpdate").mockResolvedValue({ _id: invoice._id });
    jest.spyOn(RefundCase, "findOneAndUpdate").mockResolvedValue(rc);

    const res = await inventoryService.reverseSaleForRefund({
      invoice,
      refundCase: rc,
      allocations: [{ lineId: productLineId, quantity: 2, acceptPhysicalRestock: true }],
      session,
    });

    expect(res.status).toBe("completed");
    expect(res.restockedMovementIds).toEqual([movId]);
    expect(balSpy).toHaveBeenCalledWith(
      { organizationId: orgId, branchId, productId },
      expect.objectContaining({ $inc: { onHand: 2 } }),
      expect.objectContaining({ session })
    );
    expect(movSpy).toHaveBeenCalledWith(
      expect.objectContaining({
        organizationId: orgId,
        branchId,
        productId,
        quantityDelta: 2,
        idempotencyKey: `REFUND_REV:INVENTORY:${rc._id}:${productLineId}`,
      }),
      session
    );
  });

  it("3. Rejects non-product invoice lines", async () => {
    const invoice = makeInvoice();
    const rc = makeRefundCase();

    await expect(
      inventoryService.reverseSaleForRefund({
        invoice,
        refundCase: rc,
        allocations: [{ lineId: serviceLineId, quantity: 1 }],
        session,
      })
    ).rejects.toThrow(/not a product invoice line/i);
  });

  it("4. Rejects when requested quantity exceeds remaining returnable quantity", async () => {
    const invoice = makeInvoice();
    const rc = makeRefundCase();

    await expect(
      inventoryService.reverseSaleForRefund({
        invoice,
        refundCase: rc,
        allocations: [{ lineId: productLineId, quantity: 3 }],
        session,
      })
    ).rejects.toThrow(/exceeds remaining returnable quantity/i);
  });

  it("5. Rejects organization or branch mismatch", async () => {
    const invoice = makeInvoice();
    const rc = makeRefundCase({ organizationId: otherOrgId });

    await expect(
      inventoryService.reverseSaleForRefund({
        invoice,
        refundCase: rc,
        allocations: [{ lineId: productLineId, quantity: 1 }],
        session,
      })
    ).rejects.toThrow(/Organization or branch mismatch/i);
  });

  it("6 & 7. Same RefundCase retry returns existing StockMovement without duplicating StockBalance or StockMovement", async () => {
    const invoice = makeInvoice();
    const rc = makeRefundCase();
    const existingMovId = new mongoose.Types.ObjectId();
    jest
      .spyOn(stockMovementRepository, "findByIdempotencyKey")
      .mockResolvedValue({ _id: existingMovId });
    jest.spyOn(Invoice, "findOneAndUpdate").mockResolvedValue({ _id: invoice._id });
    jest.spyOn(RefundCase, "findOneAndUpdate").mockResolvedValue(rc);
    const balSpy = jest.spyOn(StockBalance, "findOneAndUpdate");
    const movSpy = jest.spyOn(stockMovementRepository, "create");

    const res = await inventoryService.reverseSaleForRefund({
      invoice,
      refundCase: rc,
      allocations: [{ lineId: productLineId, quantity: 1, acceptPhysicalRestock: true }],
      session,
    });

    expect(res.restockedMovementIds).toEqual([existingMovId]);
    expect(res.items[0].idempotentReplay).toBe(true);
    expect(balSpy).not.toHaveBeenCalled();
    expect(movSpy).not.toHaveBeenCalled();
  });

  it("7. Replayed non-restocked RefundCase (domainReversals.inventory.status === 'completed') is idempotent", async () => {
    const invoice = makeInvoice();
    const rc = makeRefundCase({
      domainReversals: { inventory: { status: "completed", referenceIds: [] } },
    });
    const invSpy = jest.spyOn(Invoice, "findOneAndUpdate");
    const balSpy = jest.spyOn(StockBalance, "findOneAndUpdate");

    const res = await inventoryService.reverseSaleForRefund({
      invoice,
      refundCase: rc,
      allocations: [{ lineId: productLineId, quantity: 1, acceptPhysicalRestock: false }],
      session,
    });

    expect(res.idempotentReplay).toBe(true);
    expect(invSpy).not.toHaveBeenCalled();
    expect(balSpy).not.toHaveBeenCalled();
  });

  it("8. Duplicate-key E11000 on StockMovement.create propagates to abort caller transaction", async () => {
    const invoice = makeInvoice();
    const rc = makeRefundCase();
    jest.spyOn(stockMovementRepository, "findByIdempotencyKey").mockResolvedValue(null);
    jest.spyOn(StockBalance, "findOneAndUpdate").mockResolvedValue({ onHand: 12 });
    jest.spyOn(stockMovementRepository, "create").mockRejectedValue({ code: 11000 });

    await expect(
      inventoryService.reverseSaleForRefund({
        invoice,
        refundCase: rc,
        allocations: [{ lineId: productLineId, quantity: 1, acceptPhysicalRestock: true }],
        session,
      })
    ).rejects.toMatchObject({ code: 11000 });
  });

  it("9. Rejects duplicate lineId allocations and conditional over-return at DB level", async () => {
    const invoice = makeInvoice();
    const rc = makeRefundCase();

    await expect(
      inventoryService.reverseSaleForRefund({
        invoice,
        refundCase: rc,
        allocations: [
          { lineId: productLineId, quantity: 1 },
          { lineId: productLineId, quantity: 1 },
        ],
        session,
      })
    ).rejects.toThrow(/Duplicate invoice line allocations/i);

    jest.spyOn(stockMovementRepository, "findByIdempotencyKey").mockResolvedValue(null);
    jest.spyOn(Invoice, "findOneAndUpdate").mockResolvedValue(null);

    await expect(
      inventoryService.reverseSaleForRefund({
        invoice,
        refundCase: rc,
        allocations: [{ lineId: productLineId, quantity: 2, acceptPhysicalRestock: false }],
        session,
      })
    ).rejects.toThrow(/exceeds remaining returnable quantity/i);
  });

  it("10. Conditional Invoice update query contains no $expr inside $elemMatch and handles missing/null/numeric returnedQuantity", async () => {
    const invoice = makeInvoice();
    const rc = makeRefundCase();
    jest.spyOn(stockMovementRepository, "findByIdempotencyKey").mockResolvedValue(null);
    const invSpy = jest.spyOn(Invoice, "findOneAndUpdate").mockResolvedValue({ _id: invoice._id });
    jest.spyOn(RefundCase, "findOneAndUpdate").mockResolvedValue(rc);

    await inventoryService.reverseSaleForRefund({
      invoice,
      refundCase: rc,
      allocations: [{ lineId: productLineId, quantity: 2, acceptPhysicalRestock: false }],
      session,
    });

    const filter = invSpy.mock.calls[0][0];
    expect(filter.lines.$elemMatch.$expr).toBeUndefined();
    expect(filter.lines.$elemMatch.$or).toEqual([
      { returnedQuantity: { $exists: false } },
      { returnedQuantity: null },
      { returnedQuantity: { $lte: 1 } },
    ]);
  });
});
