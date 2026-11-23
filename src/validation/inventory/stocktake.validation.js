import { z } from "zod";
import { validateQuantityForUnit } from "./inventory.validation.js";

// Helper for MongoDB ObjectId
const objectIdRegex = /^[0-9a-fA-F]{24}$/;
const objectIdSchema = z.string().regex(objectIdRegex, "Invalid ObjectId format");

// 1. Create Stocktake Session Schema
export const createStocktakeSchema = z.object({
  body: z.object({
    title: z.string().max(200).trim().optional().default("Physical Stocktake"),
    targetDomain: z
      .enum(["all", "salon_consumables", "retail_products"])
      .optional()
      .default("all"),
    notes: z.string().max(1000).trim().optional().default(""),
  }),
});

// 2. Count Entry Schema
const countItemSchema = z.object({
  productId: objectIdSchema,
  stockDomain: z.enum(["salon_consumables", "retail_products"]),
  countedQuantity: z.coerce.number().min(0, "Counted quantity must be non-negative"),
  notes: z.string().max(500).trim().optional().default(""),
});

export const recordStocktakeCountsSchema = z.object({
  params: z.object({
    id: objectIdSchema,
  }),
  body: z.object({
    items: z.array(countItemSchema).min(1, "At least one count entry is required"),
  }),
});

// 3. Stocktake Query Schema
export const listStocktakeQuerySchema = z.object({
  query: z.object({
    status: z.enum(["draft", "in_progress", "posting", "completed", "cancelled"]).optional(),
    targetDomain: z.enum(["all", "salon_consumables", "retail_products"]).optional(),
    page: z.coerce.number().int().min(1).default(1),
    limit: z.coerce.number().int().min(1).max(100).default(20),
  }),
});

// 4. Cancel Stocktake Schema
export const cancelStocktakeSchema = z.object({
  params: z.object({
    id: objectIdSchema,
  }),
  body: z.object({
    reason: z.string().max(500).trim().optional().default("Cancelled by manager"),
  }),
});
