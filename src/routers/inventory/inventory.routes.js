import { Router } from "express";
import { authenticate } from "../../middleware/auth.js";
import { requireBranchScope } from "../../middleware/branchScope.js";
import { authorize } from "../../middleware/rbac.js";
import { validate } from "../../middleware/validate.js";
import * as inventoryController from "../../controllers/inventory/inventory.controller.js";
import * as stocktakeController from "../../controllers/inventory/stocktake.controller.js";
import {
  createProductSchema,
  updateProductSchema,
  listProductsSchema,
  listBranchStockSchema,
  manualConsumptionSchema,
  stockAdjustmentSchema,
  stockTransferSchema,
  listStockMovementsSchema,
  allocateStockDomainSchema,
  objectIdSchema
} from "../../validation/inventory/inventory.validation.js";
import {
  createStocktakeSchema,
  recordStocktakeCountsSchema,
  listStocktakeQuerySchema,
  cancelStocktakeSchema
} from "../../validation/inventory/stocktake.validation.js";
import { z } from "zod";

const router = Router();

const withIdParam = (schema) =>
  schema.extend({
    params: z.object({
      id: objectIdSchema
    })
  });

/**
 * Product Catalogue Management
 */
router.post(
  "/products",
  authenticate,
  authorize("inventory.adjust"),
  validate(createProductSchema),
  inventoryController.createProduct
);

router.get(
  "/products",
  authenticate,
  authorize("inventory.view"),
  validate(listProductsSchema),
  inventoryController.listProducts
);

router.get(
  "/products/:id",
  authenticate,
  authorize("inventory.view"),
  validate(z.object({ params: z.object({ id: objectIdSchema }) })),
  inventoryController.getProduct
);

router.put(
  "/products/:id",
  authenticate,
  authorize("inventory.adjust"),
  validate(updateProductSchema),
  inventoryController.updateProduct
);

/**
 * Branch Stock Balances
 */
router.get(
  "/stock",
  authenticate,
  requireBranchScope,
  authorize("inventory.view"),
  validate(listBranchStockSchema),
  inventoryController.listBranchStock
);

/**
 * Manual Salon Consumption
 */
router.post(
  "/consume",
  authenticate,
  requireBranchScope,
  authorize("inventory.consume"),
  validate(manualConsumptionSchema),
  inventoryController.recordManualConsumption
);

/**
 * Stock Adjustments
 */
router.post(
  "/adjust",
  authenticate,
  requireBranchScope,
  authorize("inventory.adjust"),
  validate(stockAdjustmentSchema),
  inventoryController.recordAdjustment
);

/**
 * Inter-Branch Transfers
 */
router.post(
  "/transfer",
  authenticate,
  requireBranchScope,
  authorize("inventory.transfer"),
  validate(stockTransferSchema),
  inventoryController.recordTransfer
);

/**
 * Stock Movement Ledger History
 */
router.get(
  "/movements",
  authenticate,
  requireBranchScope,
  authorize("inventory.view"),
  validate(listStockMovementsSchema),
  inventoryController.listStockMovements
);

/**
 * Manager-Controlled Historical Domain Allocation (usageType: "both")
 */
router.post(
  "/allocate-domain",
  authenticate,
  requireBranchScope,
  authorize("inventory.adjust"),
  validate(allocateStockDomainSchema),
  inventoryController.recordDomainAllocation
);

/**
 * Stock Batches Listing (FIFO Lots)
 */
router.get(
  "/batches",
  authenticate,
  requireBranchScope,
  authorize("inventory.view"),
  inventoryController.listBatches
);

/**
 * Reversal of a Stock Movement
 */
router.post(
  "/movements/:id/reverse",
  authenticate,
  requireBranchScope,
  authorize("inventory.adjust"),
  inventoryController.reverseMovement
);

/**
 * Opening Stock Batch Valuation
 */
router.post(
  "/batches/:id/valuation",
  authenticate,
  requireBranchScope,
  authorize("inventory.adjust"),
  inventoryController.valueOpeningStockBatch
);

/**
 * =========================================================================
 * Stocktake Lifecycle Routes (Count -> Review -> Post)
 * =========================================================================
 */

// 1. Create stocktake session & snapshot inventory
router.post(
  "/stocktakes",
  authenticate,
  requireBranchScope,
  authorize("inventory.stocktake"),
  validate(createStocktakeSchema),
  stocktakeController.createStocktake
);

// 2. List stocktake sessions
router.get(
  "/stocktakes",
  authenticate,
  requireBranchScope,
  authorize("inventory.view"),
  validate(listStocktakeQuerySchema),
  stocktakeController.listStocktakes
);

// 3. Get single stocktake session with items
router.get(
  "/stocktakes/:id",
  authenticate,
  requireBranchScope,
  authorize("inventory.view"),
  stocktakeController.getStocktakeById
);

// 4. Record/update physical counts
router.put(
  "/stocktakes/:id/counts",
  authenticate,
  requireBranchScope,
  authorize("inventory.stocktake"),
  validate(recordStocktakeCountsSchema),
  stocktakeController.recordCounts
);

// 5. Read-only discrepancy preview
router.get(
  "/stocktakes/:id/discrepancies",
  authenticate,
  requireBranchScope,
  authorize("inventory.view"),
  stocktakeController.getDiscrepancies
);

// 6. Post stocktake (atomic reconciliation)
router.post(
  "/stocktakes/:id/post",
  authenticate,
  requireBranchScope,
  authorize("inventory.stocktake"),
  stocktakeController.postStocktake
);

// 7. Cancel unposted stocktake
router.post(
  "/stocktakes/:id/cancel",
  authenticate,
  requireBranchScope,
  authorize("inventory.stocktake"),
  validate(cancelStocktakeSchema),
  stocktakeController.cancelStocktake
);

export default router;
