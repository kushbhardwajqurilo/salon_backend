import { jest } from "@jest/globals";
import mongoose from "mongoose";

const mockCreateOutboxEvent = jest.fn();
const mockRunInTransaction = jest.fn();
const mockProductFindById = jest.fn();
const mockReservationFindActive = jest.fn();
const mockReservationUpdateStatus = jest.fn();
const mockStockMovementCreate = jest.fn();
const mockStockMovementFindOne = jest.fn();
const mockStockBalanceFindOneAndUpdate = jest.fn();
const mockStockBatchCountDocuments = jest.fn();
const mockAuditSave = jest.fn();
const mockFifoDeplete = jest.fn();

jest.unstable_mockModule("../../services/notifications/outbox.service.js", () => ({
  createOutboxEvent: mockCreateOutboxEvent,
}));

jest.unstable_mockModule("../../utils/transaction.js", () => ({
  runInTransaction: mockRunInTransaction,
}));

jest.unstable_mockModule("../../repositories/inventory/product.repository.js", () => ({
  productRepository: {
    findById: mockProductFindById,
  },
}));

jest.unstable_mockModule("../../repositories/inventory/stockReservation.repository.js", () => ({
  stockReservationRepository: {
    findActiveByInvoice: mockReservationFindActive,
    updateStatusByInvoice: mockReservationUpdateStatus,
  },
}));

jest.unstable_mockModule("../../repositories/inventory/stockMovement.repository.js", () => ({
  stockMovementRepository: {
    create: mockStockMovementCreate,
    findOne: mockStockMovementFindOne,
    findByIdempotencyKey: jest.fn().mockResolvedValue(null),
  },
}));

jest.unstable_mockModule("../../models/inventory/stockBalance.model.js", () => ({
  StockBalance: {
    findOneAndUpdate: mockStockBalanceFindOneAndUpdate,
    findOne: jest.fn(),
  },
}));

jest.unstable_mockModule("../../models/inventory/stockBatch.model.js", () => ({
  StockBatch: {
    countDocuments: mockStockBatchCountDocuments,
  },
}));

jest.unstable_mockModule("../../models/audit/auditLog.model.js", () => ({
  AuditLog: jest.fn().mockImplementation((doc) => ({
    ...doc,
    save: mockAuditSave,
  })),
  AUDIT_ACTIONS: { STOCK_ADJUSTED: "STOCK_ADJUSTED" },
}));

jest.unstable_mockModule("../../services/inventory/fifoDepletion.service.js", () => ({
  FifoDepletionService: {
    depleteFifo: mockFifoDeplete,
  },
  toMilliUnits: jest.fn((v) => Math.round(v * 1000)),
}));

const { InventoryService } = await import(
  "../../services/inventory/inventory.service.js"
);
const inventoryService = new InventoryService();

describe("Inventory Notification Producers", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    const fakeSession = { id: "session-1" };
    mockRunInTransaction.mockImplementation(async (fn) => fn(fakeSession));
    mockCreateOutboxEvent.mockResolvedValue({ _id: new mongoose.Types.ObjectId() });
    mockAuditSave.mockResolvedValue({});
  });

  it("recordManualConsumption emits inventory.stock_adjusted and inventory.low_stock for Salon Consumables", async () => {
    const orgId = new mongoose.Types.ObjectId();
    const branchId = new mongoose.Types.ObjectId();
    const productId = new mongoose.Types.ObjectId();
    const userId = new mongoose.Types.ObjectId();
    const movementId = new mongoose.Types.ObjectId();

    mockStockMovementFindOne.mockResolvedValue(null);
    mockProductFindById.mockResolvedValue({
      _id: productId,
      name: "Hair Serum",
      productType: "consumable",
      usageType: "salon_consumption",
      status: "active",
      reorderPoint: 5,
    });
    mockStockBalanceFindOneAndUpdate.mockResolvedValue({
      onHand: 3,
      allocated: 0,
    });
    mockStockBatchCountDocuments.mockReturnValue({
      session: jest.fn().mockResolvedValue(0),
    });
    mockStockMovementCreate.mockResolvedValue({
      _id: movementId,
      balanceAfter: 3,
    });

    await inventoryService.recordManualConsumption(
      {
        branchId,
        productId,
        quantity: 2,
        notes: "Service usage",
        idempotencyKey: "cons-key-1",
      },
      orgId,
      userId,
    );

    expect(mockCreateOutboxEvent).toHaveBeenCalledTimes(2);
    expect(mockCreateOutboxEvent).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({
        organizationId: orgId,
        branchId,
        eventType: "inventory.stock_adjusted",
        idempotencyKey: `inv-adj:${movementId}`,
        payload: expect.objectContaining({
          stockDomain: "Salon Consumables",
          quantity: 3,
          quantityDelta: -2,
        }),
        session: { id: "session-1" },
      }),
    );
    expect(mockCreateOutboxEvent).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({
        organizationId: orgId,
        branchId,
        eventType: "inventory.low_stock",
        idempotencyKey: `inv-low:${branchId}:${productId}:${movementId}`,
        payload: expect.objectContaining({
          stockDomain: "Salon Consumables",
          quantity: 3,
          reorderPoint: 5,
        }),
        session: { id: "session-1" },
      }),
    );
  });

  it("commitReservationsForInvoice emits inventory.out_of_stock for Retail Products when balance hits 0", async () => {
    const orgId = new mongoose.Types.ObjectId();
    const branchId = new mongoose.Types.ObjectId();
    const productId = new mongoose.Types.ObjectId();
    const invoiceId = new mongoose.Types.ObjectId();
    const actorId = new mongoose.Types.ObjectId();
    const movementId = new mongoose.Types.ObjectId();
    const session = { id: "pos-session" };

    mockReservationFindActive.mockResolvedValue([
      { branchId, productId, quantity: 2 },
    ]);
    mockProductFindById.mockResolvedValue({
      _id: productId,
      name: "Retail Shampoo",
      productType: "retail",
      reorderPoint: 3,
    });
    mockStockBatchCountDocuments.mockReturnValue({
      session: jest.fn().mockResolvedValue(0),
    });
    mockStockBalanceFindOneAndUpdate.mockResolvedValue({
      onHand: 0,
      allocated: 0,
    });
    mockStockMovementCreate.mockResolvedValue({
      _id: movementId,
      balanceAfter: 0,
    });
    mockReservationUpdateStatus.mockResolvedValue({});

    await inventoryService.commitReservationsForInvoice({
      invoice: {
        _id: invoiceId,
        organizationId: orgId,
        invoiceNumber: "INV-1001",
      },
      actorId,
      session,
    });

    expect(mockCreateOutboxEvent).toHaveBeenCalledTimes(1);
    expect(mockCreateOutboxEvent).toHaveBeenCalledWith(
      expect.objectContaining({
        organizationId: orgId,
        branchId,
        eventType: "inventory.out_of_stock",
        idempotencyKey: `inv-oos:${branchId}:${productId}:${movementId}`,
        payload: expect.objectContaining({
          stockDomain: "Retail Products",
          quantity: 0,
        }),
        session,
      }),
    );
  });
});
