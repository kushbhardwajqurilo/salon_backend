import { describe, expect, it, beforeEach, afterEach, beforeAll, afterAll, jest } from "@jest/globals";
import mongoose from "mongoose";
import dns from "dns";
import { getIsolatedTestMongoUri } from "../testSetup.js";

try {
  dns.setServers(["8.8.8.8", "1.1.1.1"]);
} catch (_) {}

import { StockBatch } from "../../models/inventory/stockBatch.model.js";
import { StockBalance } from "../../models/inventory/stockBalance.model.js";
import { StockMovement } from "../../models/inventory/stockMovement.model.js";
import { Product } from "../../models/inventory/product.model.js";
import { FifoDepletionService, toMilliUnits, calculateAllocatedCostPaise } from "../../services/inventory/fifoDepletion.service.js";
import { InventoryService } from "../../services/inventory/inventory.service.js";
import { ProcurementService } from "../../services/procurement/procurement.service.js";
import { FinanceService } from "../../services/finance/finance.service.js";
import { migrateInventoryLots } from "../../scripts/migrateInventoryLots.js";
import { runInTransaction } from "../../utils/transaction.js";

describe("Phase 2 — Inventory FIFO / COGS Subledger Test Suite", () => {
  jest.setTimeout(45000);

  let orgId;
  let branchId;
  let actorId;
  let product;
  const inventoryService = new InventoryService();
  const procurementService = new ProcurementService();

  beforeAll(async () => {
    process.env.NODE_ENV = "test";
    const testUri = getIsolatedTestMongoUri("inventory_test");
    await mongoose.connect(testUri);
  });

  afterAll(async () => {
    await mongoose.connection.close();
  });

  beforeEach(async () => {
    orgId = new mongoose.Types.ObjectId();
    branchId = new mongoose.Types.ObjectId();
    actorId = new mongoose.Types.ObjectId();

    // Create test product with usageType: 'both', unit: 'bottle'
    product = await Product.create({
      organizationId: orgId,
      name: "Keratin Serum Pro 100ml",
      sku: `KER-${Date.now()}-${Math.floor(Math.random() * 1000)}`,
      category: "Hair Treatment",
      usageType: "both",
      stockUnit: "bottle",
      costPrice: 500,
      sellingPrice: 1200,
    });
  });

  afterEach(async () => {
    await StockBatch.deleteMany({ organizationId: orgId });
    await StockBalance.deleteMany({ organizationId: orgId });
    await StockMovement.deleteMany({ organizationId: orgId });
    await Product.deleteMany({ organizationId: orgId });
  });

  describe("1. Precision and Tranche Cost Arithmetic", () => {
    it("should normalize quantities to integer milli-units without floating-point drift", () => {
      expect(toMilliUnits(0.333)).toBe(333);
      expect(toMilliUnits(1)).toBe(1000);
      expect(toMilliUnits(2.5)).toBe(2500);
      expect(toMilliUnits(0.001)).toBe(1);
    });

    it("should calculate integer paise accurately and preserve exact identity", () => {
      // 0.333 units of ₹120.50 (12050 paise)
      // Math.round((333 * 12050) / 1000) = Math.round(4012.65) = 4013 paise
      const paise = calculateAllocatedCostPaise(333, 12050);
      expect(paise).toBe(4013);
    });
  });

  describe("2. FIFO Depletion Across Valued & Unvalued Lots in Receipt Order", () => {
    it("should consume older unvalued lots first and NOT skip them for newer valued lots", async () => {
      // Create Batch 1: Unvalued opening lot received yesterday (10 units)
      const yesterday = new Date(Date.now() - 86400000);
      const batch1 = await StockBatch.create({
        organizationId: orgId,
        branchId,
        productId: product._id,
        stockDomain: "salon_consumables",
        batchNumber: "BAT-UNVALUED-01",
        sourceType: "opening_stock",
        sourceReference: { entityType: "Manual", identifier: "OPENING" },
        receivedDate: yesterday,
        initialQuantityMilli: 10000,
        remainingQuantityMilli: 10000,
        isValued: false,
        unitCostPaise: null,
        totalCostPaise: null,
        status: "active",
        createdBy: actorId,
      });

      // Create Batch 2: Valued procurement lot received today (10 units @ ₹500/unit = 50000 paise)
      const today = new Date();
      const batch2 = await StockBatch.create({
        organizationId: orgId,
        branchId,
        productId: product._id,
        stockDomain: "salon_consumables",
        batchNumber: "BAT-VALUED-02",
        sourceType: "procurement_grn",
        sourceReference: { entityType: "GoodsReceiptNote", identifier: "GRN-01" },
        receivedDate: today,
        initialQuantityMilli: 10000,
        remainingQuantityMilli: 10000,
        isValued: true,
        unitCostPaise: 50000,
        totalCostPaise: 500000,
        status: "active",
        createdBy: actorId,
      });

      // Initialize physical stock balance
      await StockBalance.create({
        organizationId: orgId,
        branchId,
        productId: product._id,
        onHand: 20,
        onHandConsumables: 20,
        onHandRetail: 0,
      });

      // Deplete 15 units: Must consume 10 from Batch 1 (unvalued) and 5 from Batch 2 (valued)
      const result = await runInTransaction(async (session) => {
        return await FifoDepletionService.depleteFifo({
          organizationId: orgId,
          branchId,
          productId: product._id,
          stockDomain: "salon_consumables",
          quantity: 15,
          movementType: "service_consumption",
          reference: { entityType: "Appointment", identifier: "APT-100" },
          actorId,
          accountingDate: new Date(),
          session,
        });
      });

      expect(result.allocations).toHaveLength(2);
      expect(result.allocations[0].batchNumber).toBe("BAT-UNVALUED-01");
      expect(result.allocations[0].quantityMilli).toBe(10000);
      expect(result.allocations[0].isValued).toBe(false);

      expect(result.allocations[1].batchNumber).toBe("BAT-VALUED-02");
      expect(result.allocations[1].quantityMilli).toBe(5000);
      expect(result.allocations[1].isValued).toBe(true);
      expect(result.allocations[1].allocatedCostPaise).toBe(250000); // 5 * 50000 paise

      // Verify movement properties: movement is partially unvalued
      expect(result.isFullyValued).toBe(false);
      expect(result.unvaluedQuantity).toBe(10);
      expect(result.valuedQuantity).toBe(5);
      expect(result.totalCostPaise).toBeNull(); // Cannot declare exact total cost when partially unvalued!

      // Verify batch remaining balances
      const b1 = await StockBatch.findById(batch1._id);
      expect(b1.remainingQuantityMilli).toBe(0);
      expect(b1.status).toBe("depleted");

      const b2 = await StockBatch.findById(batch2._id);
      expect(b2.remainingQuantityMilli).toBe(5000);
      expect(b2.status).toBe("active");

      // Verify physical stock balance
      const bal = await StockBalance.findOne({ organizationId: orgId, branchId, productId: product._id });
      expect(bal.onHand).toBe(5);
      expect(bal.onHandConsumables).toBe(5);
    });
  });

  describe("3. Multi-Lot FIFO Depletion with Valued Lots", () => {
    it("should allocate costs deterministically across sequential batches and sum to totalCostPaise", async () => {
      const d1 = new Date(Date.now() - 100000);
      const d2 = new Date(Date.now() - 50000);

      // Batch A: 2 units @ ₹400 = 40000 paise
      const batchA = await StockBatch.create({
        organizationId: orgId,
        branchId,
        productId: product._id,
        stockDomain: "salon_consumables",
        batchNumber: "BAT-A",
        sourceType: "procurement_grn",
        sourceReference: { entityType: "GRN", identifier: "GRN-A" },
        receivedDate: d1,
        initialQuantityMilli: 2000,
        remainingQuantityMilli: 2000,
        isValued: true,
        unitCostPaise: 40000,
        totalCostPaise: 80000,
        status: "active",
        createdBy: actorId,
      });

      // Batch B: 5 units @ ₹550 = 55000 paise
      const batchB = await StockBatch.create({
        organizationId: orgId,
        branchId,
        productId: product._id,
        stockDomain: "salon_consumables",
        batchNumber: "BAT-B",
        sourceType: "procurement_grn",
        sourceReference: { entityType: "GRN", identifier: "GRN-B" },
        receivedDate: d2,
        initialQuantityMilli: 5000,
        remainingQuantityMilli: 5000,
        isValued: true,
        unitCostPaise: 55000,
        totalCostPaise: 275000,
        status: "active",
        createdBy: actorId,
      });

      await StockBalance.create({
        organizationId: orgId,
        branchId,
        productId: product._id,
        onHand: 7,
        onHandConsumables: 7,
      });

      // Deplete 3 units: 2 from Batch A (2 * 40000 = 80000), 1 from Batch B (1 * 55000 = 55000)
      // Total cost = 135000 paise (₹1350)
      const res = await runInTransaction(async (session) => {
        return await FifoDepletionService.depleteFifo({
          organizationId: orgId,
          branchId,
          productId: product._id,
          stockDomain: "salon_consumables",
          quantity: 3,
          movementType: "service_consumption",
          reference: { entityType: "Service", identifier: "SRV-1" },
          actorId,
          session,
        });
      });

      expect(res.isFullyValued).toBe(true);
      expect(res.totalCostPaise).toBe(135000);
      expect(res.movement.totalCostPaise).toBe(135000);
      expect(res.allocations[0].allocatedCostPaise).toBe(80000);
      expect(res.allocations[1].allocatedCostPaise).toBe(55000);
      expect(res.allocations[0].allocatedCostPaise + res.allocations[1].allocatedCostPaise).toBe(res.totalCostPaise);
    });
  });

  describe("4. Compensating Reversals & Partial Returns", () => {
    it("should reverse movements idempotently and restore exact batch quantities and costs", async () => {
      // Setup batch and balance
      const batch = await StockBatch.create({
        organizationId: orgId,
        branchId,
        productId: product._id,
        stockDomain: "salon_consumables",
        batchNumber: "BAT-REV-01",
        sourceType: "procurement_grn",
        sourceReference: { entityType: "GRN", identifier: "GRN-REV" },
        receivedDate: new Date(),
        initialQuantityMilli: 5000,
        remainingQuantityMilli: 5000,
        isValued: true,
        unitCostPaise: 30000,
        totalCostPaise: 150000,
        status: "active",
        createdBy: actorId,
      });

      await StockBalance.create({
        organizationId: orgId,
        branchId,
        productId: product._id,
        onHand: 5,
        onHandConsumables: 5,
      });

      // Deplete 2 units
      const depletion = await runInTransaction(async (session) => {
        return await FifoDepletionService.depleteFifo({
          organizationId: orgId,
          branchId,
          productId: product._id,
          stockDomain: "salon_consumables",
          quantity: 2,
          movementType: "service_consumption",
          reference: { entityType: "Appointment", identifier: "APT-REV" },
          actorId,
          session,
        });
      });

      expect(depletion.totalCostPaise).toBe(60000); // 2 * 30000

      // Reverse the depletion movement
      const reversal = await runInTransaction(async (session) => {
        return await FifoDepletionService.reverseMovement({
          movementId: depletion.movement._id,
          organizationId: orgId,
          actorId,
          reason: "Appointment cancelled by client",
          session,
        });
      });

      expect(reversal.restoredQuantity).toBe(2);
      expect(reversal.restoredCostPaise).toBe(60000);
      expect(reversal.reversalMovement.movementType).toBe("movement_reversal");

      // Verify batch restored back to 5000 milli
      const restoredBatch = await StockBatch.findById(batch._id);
      expect(restoredBatch.remainingQuantityMilli).toBe(5000);

      // Verify balance restored back to 5
      const restoredBalance = await StockBalance.findOne({ organizationId: orgId, branchId, productId: product._id });
      expect(restoredBalance.onHand).toBe(5);

      // Attempt second reversal: Must fail duplicate reversal guard
      let duplicateError;
      try {
        await runInTransaction(async (session) => {
          return await FifoDepletionService.reverseMovement({
            movementId: depletion.movement._id,
            organizationId: orgId,
            actorId,
            reason: "Duplicate attempt",
            session,
          });
        });
      } catch (err) {
        duplicateError = err;
      }
      expect(duplicateError).toBeDefined();
      expect(duplicateError.message).toContain("already been reversed");
    });
  });

  describe("5. Migration Safety & Physical Reconciliation", () => {
    it("should dry-run by default and create unvalued batches matching physical stock upon execution", async () => {
      // Create stock balance without batches
      await StockBalance.create({
        organizationId: orgId,
        branchId,
        productId: product._id,
        onHand: 12.5,
        onHandConsumables: 12.5,
        onHandRetail: 0,
      });

      // 1. Dry run
      const dryResult = await migrateInventoryLots({ execute: false });
      expect(dryResult.isDryRun).toBe(true);
      const countAfterDry = await StockBatch.countDocuments({ organizationId: orgId });
      expect(countAfterDry).toBe(0);

      // 2. Execute
      const execResult = await migrateInventoryLots({ execute: true });
      expect(execResult.isDryRun).toBe(false);

      const createdBatches = await StockBatch.find({ organizationId: orgId });
      expect(createdBatches).toHaveLength(1);
      expect(createdBatches[0].remainingQuantityMilli).toBe(12500);
      expect(createdBatches[0].isValued).toBe(false);
      expect(createdBatches[0].unitCostPaise).toBeNull();

      // 3. Repeat execute: must skip already migrated
      const secondExec = await migrateInventoryLots({ execute: true });
      expect(secondExec.skippedCount).toBeGreaterThan(0);
    });
  });

  describe("6. Finance COGS Aggregation & Disclosure", () => {
    it("should aggregate valued COGS into operating result and disclose unvalued consumption", async () => {
      // Create stock batch @ ₹200 = 20000 paise
      await StockBatch.create({
        organizationId: orgId,
        branchId,
        productId: product._id,
        stockDomain: "salon_consumables",
        batchNumber: "BAT-FIN-01",
        sourceType: "procurement_grn",
        sourceReference: { entityType: "GRN", identifier: "GRN-FIN" },
        receivedDate: new Date(),
        initialQuantityMilli: 10000,
        remainingQuantityMilli: 10000,
        isValued: true,
        unitCostPaise: 20000,
        totalCostPaise: 200000,
        status: "active",
        createdBy: actorId,
      });

      await StockBalance.create({
        organizationId: orgId,
        branchId,
        productId: product._id,
        onHand: 10,
        onHandConsumables: 10,
      });

      // Deplete 2 units @ ₹200 = ₹400 (40000 paise) COGS
      await runInTransaction(async (session) => {
        return await FifoDepletionService.depleteFifo({
          organizationId: orgId,
          branchId,
          productId: product._id,
          stockDomain: "salon_consumables",
          quantity: 2,
          movementType: "service_consumption",
          reference: { entityType: "Appointment", identifier: "APT-FIN" },
          actorId,
          accountingDate: new Date(),
          session,
        });
      });

      const todayStr = new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Kolkata" }).format(new Date());
      const profitReport = await FinanceService.getOperatingProfit(
        orgId.toString(),
        branchId.toString(),
        todayStr,
        todayStr
      );

      expect(profitReport.inventoryCost.cogs).toBe(400); // ₹400
      expect(profitReport.inventoryCost.cogsPaise).toBe(40000);
      expect(profitReport.inventoryCost.isFullyValued).toBe(true);
      expect(profitReport.costCoverageNotice).toContain("FIFO Valued Stock Consumption (COGS)");
    });
  });

  describe("7. Opening Stock Valuation Workflow & Non-Retroactivity", () => {
    it("should value remaining unvalued stock without retroactively altering historical movements", async () => {
      // 1. Create an unvalued batch (5 units)
      const unvaluedBatch = await StockBatch.create({
        organizationId: orgId,
        branchId,
        productId: product._id,
        stockDomain: "salon_consumables",
        batchNumber: "BAT-UNVAL-VALUATE",
        sourceType: "opening_stock",
        sourceReference: { entityType: "Manual", identifier: "OPENING" },
        receivedDate: new Date(Date.now() - 100000),
        initialQuantityMilli: 5000,
        remainingQuantityMilli: 5000,
        isValued: false,
        unitCostPaise: null,
        totalCostPaise: null,
        status: "active",
        createdBy: actorId,
      });

      await StockBalance.create({
        organizationId: orgId,
        branchId,
        productId: product._id,
        onHand: 5,
        onHandConsumables: 5,
      });

      // 2. Consume 2 units while unvalued
      const histDepletion = await runInTransaction(async (session) => {
        return await FifoDepletionService.depleteFifo({
          organizationId: orgId,
          branchId,
          productId: product._id,
          stockDomain: "salon_consumables",
          quantity: 2,
          movementType: "service_consumption",
          reference: { entityType: "Appointment", identifier: "APT-HIST" },
          actorId,
          session,
        });
      });

      expect(histDepletion.movement.isValued).toBe(false);
      expect(histDepletion.movement.totalCostPaise).toBeNull();

      // 3. Manager values the remaining 3 units at ₹150 per unit (15000 paise)
      const valuedBatch = await inventoryService.valueOpeningStockBatch({
        batchId: unvaluedBatch._id,
        organizationId: orgId,
        branchId,
        unitCostPrice: 150,
        notes: "Verified against physical opening count and supplier catalogue",
        sourceDocumentRef: "VAL-DOC-001",
        actorId,
      });

      expect(valuedBatch.isValued).toBe(true);
      expect(valuedBatch.unitCostPaise).toBe(15000);
      expect(valuedBatch.totalCostPaise).toBe(45000); // 3 * 15000 paise
      expect(valuedBatch.openingValuationMetadata.notes).toBe("Verified against physical opening count and supplier catalogue");

      // 4. Verify historical movement remains UNCHANGED (non-retroactivity invariant)
      const checkedHistMovement = await StockMovement.findById(histDepletion.movement._id);
      expect(checkedHistMovement.isValued).toBe(false);
      expect(checkedHistMovement.totalCostPaise).toBeNull();

      // 5. Next consumption of 1 unit must now be VALUED using the newly set unit cost
      const nextDepletion = await runInTransaction(async (session) => {
        return await FifoDepletionService.depleteFifo({
          organizationId: orgId,
          branchId,
          productId: product._id,
          stockDomain: "salon_consumables",
          quantity: 1,
          movementType: "service_consumption",
          reference: { entityType: "Appointment", identifier: "APT-AFTER-VAL" },
          actorId,
          session,
        });
      });

      expect(nextDepletion.movement.isValued).toBe(true);
      expect(nextDepletion.movement.totalCostPaise).toBe(15000); // 1 * 15000 paise
    });
  });

  describe("8. High-Concurrency Stress Test (5 Concurrent Depletions)", () => {
    it("should prevent overselling and negative quantities under concurrent FIFO depletions", async () => {
      // Create batch with exactly 10 units
      await StockBatch.create({
        organizationId: orgId,
        branchId,
        productId: product._id,
        stockDomain: "salon_consumables",
        batchNumber: "BAT-CONCUR-01",
        sourceType: "procurement_grn",
        sourceReference: { entityType: "GRN", identifier: "GRN-CONCUR" },
        receivedDate: new Date(),
        initialQuantityMilli: 10000,
        remainingQuantityMilli: 10000,
        isValued: true,
        unitCostPaise: 10000,
        totalCostPaise: 100000,
        status: "active",
        createdBy: actorId,
      });

      await StockBalance.create({
        organizationId: orgId,
        branchId,
        productId: product._id,
        onHand: 10,
        onHandConsumables: 10,
      });

      // Launch 5 concurrent depletion attempts of 3 units each (Total requested = 15 units, only 10 available)
      const promises = [1, 2, 3, 4, 5].map((i) =>
        runInTransaction(async (session) => {
          return await FifoDepletionService.depleteFifo({
            organizationId: orgId,
            branchId,
            productId: product._id,
            stockDomain: "salon_consumables",
            quantity: 3,
            movementType: "service_consumption",
            reference: { entityType: "Appointment", identifier: `APT-CONCUR-${i}` },
            actorId,
            session,
          });
        }).catch((err) => ({ error: err.message }))
      );

      const results = await Promise.all(promises);
      const successes = results.filter((r) => !r.error);
      const failures = results.filter((r) => r.error);

      // Exactly 3 requests should succeed (3 * 3 = 9 units consumed), and 2 must fail safely with insufficient stock
      expect(successes).toHaveLength(3);
      expect(failures).toHaveLength(2);

      // Verify physical balance and batch remaining are strictly positive and reconciled
      const bal = await StockBalance.findOne({ organizationId: orgId, branchId, productId: product._id });
      expect(bal.onHand).toBe(1);
      expect(bal.onHandConsumables).toBe(1);

      const batch = await StockBatch.findOne({ organizationId: orgId, branchId, productId: product._id });
      expect(batch.remainingQuantityMilli).toBe(1000); // 1 unit remaining
      expect(batch.remainingQuantityMilli / 1000).toBe(bal.onHand);
    });
  });

  describe("9. Stock Adjustment FIFO Depletion & Positive Lot Creation", () => {
    it("should deplete FIFO batches on negative adjustment and record loss cost", async () => {
      // Create valued batch @ ₹300 = 30000 paise
      await StockBatch.create({
        organizationId: orgId,
        branchId,
        productId: product._id,
        stockDomain: "salon_consumables",
        batchNumber: "BAT-ADJ-TEST-01",
        sourceType: "procurement_grn",
        sourceReference: { entityType: "GRN", identifier: "GRN-ADJ-01" },
        receivedDate: new Date(),
        initialQuantityMilli: 5000,
        remainingQuantityMilli: 5000,
        isValued: true,
        unitCostPaise: 30000,
        totalCostPaise: 150000,
        status: "active",
        createdBy: actorId,
      });

      await StockBalance.create({
        organizationId: orgId,
        branchId,
        productId: product._id,
        onHand: 5,
        onHandConsumables: 5,
      });

      // Adjust negative by -2 units (Stock breakage/spillage)
      const res = await inventoryService.recordAdjustment(
        {
          branchId,
          productId: product._id,
          quantityDelta: -2,
          reason: "Damaged bottle spilled on floor",
        },
        orgId,
        actorId
      );

      const bal = await StockBalance.findOne({ organizationId: orgId, branchId, productId: product._id });
      expect(bal.onHand).toBe(3);

      const mvt = await StockMovement.findOne({ organizationId: orgId, branchId, productId: product._id, movementType: "adjustment" });
      expect(mvt.isValued).toBe(true);
      expect(mvt.totalCostPaise).toBe(60000); // 2 * 30000 paise
      expect(mvt.quantityDelta).toBe(-2);

      // Verify that Finance COGS reflects this stock loss
      const todayStr = new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Kolkata" }).format(new Date());
      const profitReport = await FinanceService.getOperatingProfit(orgId.toString(), branchId.toString(), todayStr, todayStr);
      expect(profitReport.inventoryCost.cogsPaise).toBe(60000); // ₹600
    });

    it("should create explicitly unvalued batch on positive adjustment without assuming zero cost", async () => {
      await StockBalance.create({
        organizationId: orgId,
        branchId,
        productId: product._id,
        onHand: 0,
        onHandConsumables: 0,
      });

      // Positive adjustment: +4 units found during physical count
      await inventoryService.recordAdjustment(
        {
          branchId,
          productId: product._id,
          quantityDelta: 4,
          reason: "Found in back storage cupboard",
        },
        orgId,
        actorId
      );

      const bal = await StockBalance.findOne({ organizationId: orgId, branchId, productId: product._id });
      expect(bal.onHand).toBe(4);

      const createdBatch = await StockBatch.findOne({ organizationId: orgId, branchId, productId: product._id, sourceType: "manual_adjustment" });
      expect(createdBatch).toBeDefined();
      expect(createdBatch.remainingQuantityMilli).toBe(4000);
      expect(createdBatch.isValued).toBe(false); // Unknown cost is NOT zero cost!
      expect(createdBatch.unitCostPaise).toBeNull();
    });
  });
});
