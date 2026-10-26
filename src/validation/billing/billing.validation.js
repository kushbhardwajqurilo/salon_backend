import { z } from "zod";

const objectIdRegex = /^[0-9a-fA-F]{24}$/;
const objectIdSchema = z.string().refine((val) => objectIdRegex.test(val), {
  message: "Invalid ObjectId format",
});

export const createInvoiceSchema = z.object({
  body: z
    .object({
      branchId: objectIdSchema,
      appointmentId: objectIdSchema.optional(),
      subscriptionId: objectIdSchema.optional(),
      discount: z.coerce.number().min(0, "Discount must be non-negative").optional(),
      discountTotal: z.coerce.number().min(0, "Discount must be non-negative").optional(),
      redeemLoyaltyPoints: z.coerce.number().int().min(0, "redeemLoyaltyPoints must be non-negative").optional(),
      notes: z.string().max(1000, "Notes cannot exceed 1000 characters").optional().default(""),
    })
    .refine((data) => data.appointmentId || data.subscriptionId, {
      message: "Either appointmentId or subscriptionId must be provided to create an invoice",
      path: ["appointmentId"],
    }),
});

export const createSubscriptionInvoiceSchema = z.object({
  body: z.object({
    branchId: objectIdSchema,
    subscriptionId: objectIdSchema,
    discount: z.coerce.number().min(0, "Discount must be non-negative").optional(),
    redeemLoyaltyPoints: z.coerce.number().int().min(0, "redeemLoyaltyPoints must be non-negative").optional(),
    notes: z.string().max(1000, "Notes cannot exceed 1000 characters").optional().default(""),
  }),
});

export const updateDraftInvoiceSchema = z.object({
  body: z
    .object({
      branchId: objectIdSchema.optional(),
      discountTotal: z.coerce.number().min(0, "Discount must be non-negative").optional(),
      redeemLoyaltyPoints: z.coerce.number().int().min(0, "redeemLoyaltyPoints must be non-negative").optional(),
      notes: z.string().max(1000, "Notes cannot exceed 1000 characters").optional(),
    })
    .strict("Only discountTotal, redeemLoyaltyPoints, and notes may be modified on a draft invoice"),
});

export const finalizeInvoiceSchema = z.object({
  body: z
    .object({
      branchId: objectIdSchema.optional(),
      notes: z.string().max(1000).optional(),
    })
    .optional(),
});

export const cancelInvoiceSchema = z.object({
  body: z.object({
    branchId: objectIdSchema.optional(),
    reason: z.string().trim().min(3, "Cancellation reason must be at least 3 characters").max(500).optional(),
  }),
});

export const recordPaymentSchema = z.object({
  body: z
    .object({
      branchId: objectIdSchema.optional(),
      amount: z.coerce.number().positive("Payment amount must be greater than zero"),
      method: z
        .enum(["cash", "card", "upi", "other"], {
          errorMap: () => ({ message: "Method must be one of: cash, card, upi, other" }),
        })
        .optional(),
      paymentMethod: z
        .enum(["cash", "card", "upi", "other"], {
          errorMap: () => ({ message: "Payment method must be one of: cash, card, upi, other" }),
        })
        .optional(),
      referenceNote: z.string().max(255).optional().default(""),
      idempotencyKey: z.string().trim().min(1).max(255).optional(),
    })
    .transform((data) => {
      const resolvedMethod = data.method || data.paymentMethod;
      return {
        ...data,
        method: resolvedMethod,
      };
    })
    .refine((data) => !!data.method, {
      message: "Method is required and must be one of: cash, card, upi, other",
      path: ["method"],
    }),
});

export const voidPaymentSchema = z.object({
  body: z.object({
    branchId: objectIdSchema.optional(),
    reason: z.string().trim().min(3, "Void reason must be at least 3 characters").max(500),
  }),
});

const dateOnlyRegex = /^\d{4}-\d{2}-\d{2}$/;

export const listInvoicesQuerySchema = z.object({
  query: z
    .object({
      page: z.coerce.number().int().min(1).optional().default(1),
      limit: z.coerce.number().int().min(1).max(100).optional().default(10),
      status: z.enum(["draft", "finalized", "cancelled"]).optional(),
      paymentStatus: z.enum(["unpaid", "partially_paid", "paid"]).optional(),
      customerId: objectIdSchema.optional(),
      branchId: objectIdSchema.optional(),
      appointmentId: objectIdSchema.optional(),
      startDate: z
        .string()
        .regex(dateOnlyRegex, "Invalid startDate format (YYYY-MM-DD)")
        .optional(),
      endDate: z
        .string()
        .regex(dateOnlyRegex, "Invalid endDate format (YYYY-MM-DD)")
        .optional(),
      search: z.string().trim().optional(),
      sortBy: z.string().optional().default("createdAt"),
      sortOrder: z.enum(["asc", "desc"]).optional().default("desc"),
    })
    .superRefine((data, ctx) => {
      if (data.startDate && data.endDate && data.startDate > data.endDate) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["endDate"],
          message: "endDate must be greater than or equal to startDate",
        });
      }
    }),
});

export const getCheckoutQueueQuerySchema = z.object({
  query: z.object({
    branchId: objectIdSchema.optional(),
    date: z
      .string()
      .regex(dateOnlyRegex, "Invalid date format (YYYY-MM-DD)")
      .optional(),
  }),
});

