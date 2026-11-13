import { Router } from "express";
import { authenticate } from "../../middleware/auth.js";
import { requireBranchScope } from "../../middleware/branchScope.js";
import { authorize } from "../../middleware/rbac.js";
import { validate } from "../../middleware/validate.js";
import * as inventoryController from "../../controllers/inventory/inventory.controller.js";
import {
  createProductSchema,
  updateProductSchema,
  listProductsSchema,
  listBranchStockSchema,
  manualConsumptionSchema,
  stockAdjustmentSchema,
  stockTransferSchema,
  listStockMovementsSchema,
  objectIdSchema
} from "../../validation/inventory/inventory.validation.js";
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

export default router;
