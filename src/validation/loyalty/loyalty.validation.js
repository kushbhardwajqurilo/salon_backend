import { z } from "zod";

const objectIdRegex = /^[0-9a-fA-F]{24}$/;
const objectIdSchema = z.string().refine((val) => objectIdRegex.test(val), {
  message: "Invalid ObjectId format",
});

export const updateLoyaltyProgramSchema = z.object({
  body: z.object({
    isEnabled: z.boolean().optional(),
    earnPointsPerUnit: z.coerce.number().min(0, "earnPointsPerUnit must be >= 0").optional(),
    earnThresholdAmount: z.coerce.number().min(1, "earnThresholdAmount must be >= 1").optional(),
    redemptionRate: z.coerce.number().positive("redemptionRate must be > 0").optional(),
    minRedemptionPoints: z.coerce.number().int().min(1, "minRedemptionPoints must be an integer >= 1").optional(),
    maxRedemptionPercentage: z.coerce.number().min(1).max(100, "maxRedemptionPercentage must be between 1 and 100").optional(),
  }),
});

export const adjustCustomerPointsSchema = z.object({
  params: z.object({
    customerId: objectIdSchema,
  }),
  body: z.object({
    points: z.coerce.number().int().positive("Points must be a positive integer"),
    operation: z.enum(["CREDIT", "DEBIT"], {
      errorMap: () => ({ message: "Operation must be either CREDIT or DEBIT" }),
    }),
    reason: z.string().trim().min(3, "Reason must be at least 3 characters").max(500),
    idempotencyKey: z.string().trim().min(1).max(255).optional(),
    branchId: objectIdSchema.optional(),
  }),
});

export const listCustomerLedgerSchema = z.object({
  params: z.object({
    customerId: objectIdSchema,
  }),
  query: z.object({
    page: z.coerce.number().int().min(1).optional().default(1),
    limit: z.coerce.number().int().min(1).max(100).optional().default(20),
    type: z.enum(["EARNED", "REDEEMED", "ADJUSTED", "EARNING_REVERSED", "REDEMPTION_RESTORED"]).optional(),
    startDate: z.string().optional(),
    endDate: z.string().optional(),
    sortBy: z.string().optional().default("createdAt"),
    sortOrder: z.enum(["asc", "desc"]).optional().default("desc"),
  }),
});

export const previewRedemptionSchema = z.object({
  query: z.object({
    customerId: objectIdSchema,
    billAmount: z.coerce.number().min(0, "Bill amount must be >= 0").optional(),
    pointsRequested: z.coerce.number().int().min(0).optional(),
    invoiceId: objectIdSchema.optional(),
  }),
});
