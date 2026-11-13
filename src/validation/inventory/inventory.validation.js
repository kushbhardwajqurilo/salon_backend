import { z } from "zod";
import { PRODUCT_USAGE_TYPES, STOCK_UNITS, DISCRETE_STOCK_UNITS } from "../../models/inventory/product.model.js";
import { MOVEMENT_TYPES } from "../../models/inventory/stockMovement.model.js";

const objectIdRegex = /^[0-9a-fA-F]{24}$/;
export const objectIdSchema = z.string().regex(objectIdRegex, "Invalid ObjectId format");

/**
 * Validates that quantity has at most 3 decimal places and is strictly positive
 */
export const validateDecimalPrecision = (val) => {
  if (typeof val !== "number" || isNaN(val)) return false;
  const str = val.toString();
  if (str.includes(".")) {
    const decimals = str.split(".")[1];
    return decimals.length <= 3;
  }
  return true;
};

/**
 * Validates quantity against product unit:
 * Discrete units (piece, bottle, box, pack, kit) require whole integers.
 */
export const validateQuantityForUnit = (quantity, unit) => {
  if (quantity <= 0) return { valid: false, message: "Quantity must be greater than zero" };
  if (!validateDecimalPrecision(quantity)) {
    return { valid: false, message: "Quantity cannot exceed 3 decimal places" };
  }
  if (DISCRETE_STOCK_UNITS.includes(unit?.toLowerCase())) {
    if (!Number.isInteger(quantity)) {
      return { valid: false, message: `Discrete unit '${unit}' requires integer quantity` };
    }
  }
  return { valid: true };
};

// 1. Product creation schema
export const createProductSchema = z.object({
  body: z.object({
    name: z.string().min(1, "Product name is required").max(200).trim(),
    sku: z.string().min(1, "SKU is required").max(100).trim().toUpperCase(),
    category: z.string().min(1, "Category is required").max(100).trim(),
    usageType: z.enum(PRODUCT_USAGE_TYPES, {
      errorMap: () => ({ message: `usageType must be one of: ${PRODUCT_USAGE_TYPES.join(", ")}` })
    }),
    stockUnit: z.enum(STOCK_UNITS, {
      errorMap: () => ({ message: `stockUnit must be one of: ${STOCK_UNITS.join(", ")}` })
    }),
    costPrice: z.coerce.number().min(0, "costPrice must be non-negative").default(0),
    sellingPrice: z.coerce.number().min(0, "sellingPrice must be non-negative").default(0),
    reorderLevel: z.coerce.number().min(0, "reorderLevel must be non-negative").default(0),
    status: z.enum(["active", "inactive"]).optional().default("active")
  }).strict()
});

// 2. Product update schema
export const updateProductSchema = z.object({
  params: z.object({
    id: objectIdSchema
  }),
  body: z.object({
    name: z.string().min(1).max(200).trim().optional(),
    sku: z.string().min(1).max(100).trim().toUpperCase().optional(),
    category: z.string().min(1).max(100).trim().optional(),
    usageType: z.enum(PRODUCT_USAGE_TYPES).optional(),
    stockUnit: z.enum(STOCK_UNITS).optional(),
    costPrice: z.coerce.number().min(0).optional(),
    sellingPrice: z.coerce.number().min(0).optional(),
    reorderLevel: z.coerce.number().min(0).optional(),
    status: z.enum(["active", "inactive"]).optional()
  }).strict()
});

// 3. List products schema
export const listProductsSchema = z.object({
  query: z.object({
    page: z.coerce.number().int().min(1).optional().default(1),
    limit: z.coerce.number().int().min(1).max(100).optional().default(20),
    category: z.string().trim().optional(),
    usageType: z.enum(PRODUCT_USAGE_TYPES).optional(),
    status: z.enum(["active", "inactive"]).optional(),
    search: z.string().trim().optional()
  })
});

// 4. Branch stock query schema
export const listBranchStockSchema = z.object({
  query: z.object({
    branchId: objectIdSchema.optional(),
    page: z.coerce.number().int().min(1).optional().default(1),
    limit: z.coerce.number().int().min(1).max(100).optional().default(20),
    lowStock: z.enum(["true", "false"]).optional(),
    search: z.string().trim().optional()
  })
});

// 5. Manual salon consumption schema
export const manualConsumptionSchema = z.object({
  body: z.object({
    branchId: objectIdSchema,
    productId: objectIdSchema,
    quantity: z.coerce.number().positive("Quantity must be positive"),
    serviceId: objectIdSchema.optional(),
    appointmentId: objectIdSchema.optional(),
    notes: z.string().max(1000).trim().optional().default(""),
    idempotencyKey: z.string().min(1).max(200).trim().optional()
  }).strict()
});

// 6. Stock adjustment schema
export const stockAdjustmentSchema = z.object({
  body: z.object({
    branchId: objectIdSchema,
    productId: objectIdSchema,
    quantityDelta: z.coerce.number().refine((val) => val !== 0, "quantityDelta cannot be zero"),
    reason: z.string().min(1, "Adjustment reason is required").max(1000).trim(),
    notes: z.string().max(1000).trim().optional().default(""),
    idempotencyKey: z.string().min(1).max(200).trim().optional()
  }).strict()
});

// 7. Inter-branch transfer schema
export const stockTransferSchema = z.object({
  body: z.object({
    fromBranchId: objectIdSchema,
    toBranchId: objectIdSchema,
    productId: objectIdSchema,
    quantity: z.coerce.number().positive("Transfer quantity must be positive"),
    notes: z.string().max(1000).trim().optional().default(""),
    idempotencyKey: z.string().min(1).max(200).trim().optional()
  }).refine((data) => data.fromBranchId !== data.toBranchId, {
    message: "Source and destination branch cannot be the same",
    path: ["toBranchId"]
  })
});

// 8. Stock movements history schema
export const listStockMovementsSchema = z.object({
  query: z.object({
    branchId: objectIdSchema.optional(),
    productId: objectIdSchema.optional(),
    movementType: z.enum(MOVEMENT_TYPES).optional(),
    startDate: z.string().datetime().optional(),
    endDate: z.string().datetime().optional(),
    page: z.coerce.number().int().min(1).optional().default(1),
    limit: z.coerce.number().int().min(1).max(100).optional().default(20)
  })
});
