import { jest } from "@jest/globals";
import mongoose from "mongoose";

const mockCreateOutboxEvent = jest.fn();
const mockRunInTransaction = jest.fn();
const mockFindByIdempotencyKey = jest.fn();
const mockGrnCreate = jest.fn();
const mockGrnCountDocuments = jest.fn();
const mockPoFindOne = jest.fn();
const mockCreateGrnBatch = jest.fn();
const mockAuditSave = jest.fn();
const mockStockBalanceFindOneAndUpdate = jest.fn();
const mockStockMovementCreate = jest.fn();

jest.unstable_mockModule("../../services/notifications/outbox.service.js", () => ({
  createOutboxEvent: mockCreateOutboxEvent,
}));

jest.unstable_mockModule("../../utils/transaction.js", () => ({
  runInTransaction: mockRunInTransaction,
}));

jest.unstable_mockModule("../../repositories/procurement/goodsReceipt.repository.js", () => ({
  goodsReceiptRepository: {
    findByIdempotencyKey: mockFindByIdempotencyKey,
    countByOrganization: jest.fn().mockResolvedValue(0),
    create: mockGrnCreate,
  },
}));

jest.unstable_mockModule("../../models/procurement/goodsReceiptNote.model.js", () => ({
  GoodsReceiptNote: {
    countDocuments: mockGrnCountDocuments,
  },
}));

jest.unstable_mockModule("../../models/procurement/purchaseOrder.model.js", () => ({
  PurchaseOrder: {
    findOne: mockPoFindOne,
  },
}));

jest.unstable_mockModule("../../services/inventory/fifoDepletion.service.js", () => ({
  FifoDepletionService: {
    createGrnBatch: mockCreateGrnBatch,
  },
  toMilliUnits: jest.fn((v) => Math.round(v * 1000)),
}));

jest.unstable_mockModule("../../models/audit/auditLog.model.js", () => ({
  AuditLog: jest.fn().mockImplementation((doc) => ({
    ...doc,
    save: mockAuditSave,
  })),
  AUDIT_ACTIONS: { PROCUREMENT_GOODS_RECEIVED: "PROCUREMENT_GOODS_RECEIVED" },
}));

jest.unstable_mockModule("../../models/inventory/stockBalance.model.js", () => ({
  StockBalance: {
    findOneAndUpdate: mockStockBalanceFindOneAndUpdate,
  },
}));

jest.unstable_mockModule("../../repositories/inventory/stockMovement.repository.js", () => ({
  stockMovementRepository: {
    create: mockStockMovementCreate,
  },
}));

jest.unstable_mockModule("../../repositories/inventory/product.repository.js", () => ({
  productRepository: {
    findById: jest.fn().mockImplementation(async (id) => ({
      _id: id,
      name: "Test Product",
      productType: "retail",
      stockUnit: "unit",
    })),
  },
}));

const { ProcurementService } = await import(
  "../../services/procurement/procurement.service.js"
);
const procurementService = new ProcurementService();

describe("Procurement Goods Receipt Notification Producer", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    const fakeSession = { id: "grn-session" };
    mockRunInTransaction.mockImplementation(async (fn) => fn(fakeSession));
    mockFindByIdempotencyKey.mockResolvedValue(null);
    mockGrnCountDocuments.mockReturnValue({
      session: jest.fn().mockResolvedValue(0),
    });
    mockStockBalanceFindOneAndUpdate.mockResolvedValue({ onHand: 10 });
    mockStockMovementCreate.mockResolvedValue({ _id: new mongoose.Types.ObjectId() });
    mockCreateGrnBatch.mockResolvedValue({});
    mockAuditSave.mockResolvedValue({});
    mockCreateOutboxEvent.mockResolvedValue({ _id: new mongoose.Types.ObjectId() });
  });

  function makePo({ ordered = 10, received = 0 } = {}) {
    const orgId = new mongoose.Types.ObjectId();
    const branchId = new mongoose.Types.ObjectId();
    const supplierId = new mongoose.Types.ObjectId();
    const productId = new mongoose.Types.ObjectId();
    const poId = new mongoose.Types.ObjectId();

    const po = {
      _id: poId,
      organizationId: orgId,
      branchId,
      supplierId,
      poNumber: "PO-2026-001",
      status: "approved",
      items: [
        {
          productId,
          orderedQuantity: ordered,
          receivedQuantity: received,
          unitCostPrice: 100,
          targetDomain: "retail_products",
        },
      ],
      save: jest.fn().mockResolvedValue(true),
    };
    return { orgId, branchId, supplierId, productId, poId, po };
  }

  it("emits procurement.goods_received with isPartial=false on full receipt", async () => {
    const { orgId, branchId, supplierId, productId, poId, po } = makePo({ ordered: 5, received: 0 });
    const userId = new mongoose.Types.ObjectId();
    const grnId = new mongoose.Types.ObjectId();

    mockPoFindOne.mockReturnValue({ session: jest.fn().mockResolvedValue(po) });
    mockGrnCreate.mockResolvedValue({
      _id: grnId,
      grnNumber: "GRN-001",
      receivedAt: new Date(),
      totalAmount: 500,
    });

    await procurementService.receiveGoods(
      poId,
      { items: [{ productId, receivedQuantity: 5 }], idempotencyKey: "grn-full-1" },
      orgId,
      userId,
    );

    expect(mockCreateOutboxEvent).toHaveBeenCalledTimes(1);
    expect(mockCreateOutboxEvent).toHaveBeenCalledWith(
      expect.objectContaining({
        organizationId: orgId,
        branchId,
        eventType: "procurement.goods_received",
        idempotencyKey: `po-grn:${grnId}`,
        payload: expect.objectContaining({
          grnId: String(grnId),
          poId: String(poId),
          poNumber: "PO-2026-001",
          supplierId: String(supplierId),
          poStatus: "received",
          isPartial: false,
          itemsCount: 1,
        }),
        session: { id: "grn-session" },
      }),
    );
  });

  it("emits procurement.goods_received with isPartial=true on partial receipt", async () => {
    const { orgId, branchId, productId, poId, po } = makePo({ ordered: 10, received: 0 });
    const userId = new mongoose.Types.ObjectId();
    const grnId = new mongoose.Types.ObjectId();

    mockPoFindOne.mockReturnValue({ session: jest.fn().mockResolvedValue(po) });
    mockGrnCreate.mockResolvedValue({
      _id: grnId,
      grnNumber: "GRN-002",
      receivedAt: new Date(),
      totalAmount: 400,
    });

    await procurementService.receiveGoods(
      poId,
      { items: [{ productId, receivedQuantity: 4 }], idempotencyKey: "grn-part-1" },
      orgId,
      userId,
    );

    expect(mockCreateOutboxEvent).toHaveBeenCalledWith(
      expect.objectContaining({
        organizationId: orgId,
        branchId,
        eventType: "procurement.goods_received",
        payload: expect.objectContaining({
          poStatus: "partially_received",
          isPartial: true,
        }),
      }),
    );
  });

  it("skips outbox emission on idempotent replay of duplicate receipt", async () => {
    const orgId = new mongoose.Types.ObjectId();
    const poId = new mongoose.Types.ObjectId();
    const userId = new mongoose.Types.ObjectId();

    mockFindByIdempotencyKey.mockResolvedValue({ _id: new mongoose.Types.ObjectId(), grnNumber: "GRN-001" });

    const res = await procurementService.receiveGoods(
      poId,
      { items: [], idempotencyKey: "dup-key" },
      orgId,
      userId,
    );

    expect(res.idempotentReplay).toBe(true);
    expect(mockCreateOutboxEvent).not.toHaveBeenCalled();
  });
});
