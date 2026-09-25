import { z } from "zod";

const objectIdRegex = /^[0-9a-fA-F]{24}$/;
const objectIdSchema = z.string().regex(objectIdRegex, "Invalid ObjectId format");

const planEntitlementInputSchema = z.object({
  serviceId: objectIdSchema,
  quantity: z.number().int().min(1, "Quantity must be an integer and at least 1"),
});

export const createSubscriptionPlanSchema = z.object({
  body: z.object({
    name: z.string().trim().min(2, "Plan name must be at least 2 characters").max(100),
    code: z.string().trim().max(50).optional().nullable(),
    description: z.string().trim().max(1000).optional().default(""),
    suggestedPrice: z.number().min(0, "Suggested price must be non-negative"),
    validityMonths: z
      .number()
      .int("validityMonths must be an integer")
      .min(1, "Validity in months must be at least 1"),
    entitlements: z
      .array(planEntitlementInputSchema)
      .min(1, "At least one service entitlement is required"),
    permittedBranchIds: z.array(objectIdSchema).optional().default([]),
  }),
});

export const updateSubscriptionPlanSchema = z.object({
  body: z.object({
    name: z.string().trim().min(2).max(100).optional(),
    code: z.string().trim().max(50).optional().nullable(),
    description: z.string().trim().max(1000).optional(),
    suggestedPrice: z.number().min(0).optional(),
    validityMonths: z.number().int().min(1).optional(),
    entitlements: z.array(planEntitlementInputSchema).min(1).optional(),
    permittedBranchIds: z.array(objectIdSchema).optional(),
    isActive: z.boolean().optional(),
  }),
});

export const querySubscriptionPlanSchema = z.object({
  query: z.object({
    page: z.string().regex(/^\d+$/).transform(Number).optional().default("1"),
    limit: z.string().regex(/^\d+$/).transform(Number).optional().default("20"),
    search: z.string().trim().optional(),
    status: z.enum(["active", "inactive", "all"]).optional().default("all"),
  }),
});
