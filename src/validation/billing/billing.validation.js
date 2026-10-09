import { z } from "zod";

const objectIdRegex = /^[0-9a-fA-F]{24}$/;
const objectIdSchema = z.string().refine((val) => objectIdRegex.test(val), {
  message: "Invalid ObjectId format",
});

export const createInvoiceSchema = z.object({
  body: z.object({
    branchId: objectIdSchema,
    appointmentId: objectIdSchema,
    discount: z.coerce.number().min(0, "Discount must be non-negative").optional(),
    notes: z.string().max(1000, "Notes cannot exceed 1000 characters").optional().default(""),
  }),
});

export const updateDraftInvoiceSchema = z.object({
  body: z
    .object({
      branchId: objectIdSchema.optional(),
      discountTotal: z.coerce.number().min(0, "Discount must be non-negative").optional(),
      notes: z.string().max(1000, "Notes cannot exceed 1000 characters").optional(),
    })
    .strict("Only discountTotal and notes may be modified on a draft invoice"),
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

export const listInvoicesQuerySchema = z.object({
  query: z.object({
    page: z.coerce.number().int().min(1).optional().default(1),
    limit: z.coerce.number().int().min(1).max(100).optional().default(10),
    status: z.enum(["draft", "finalized", "cancelled"]).optional(),
    paymentStatus: z.enum(["unpaid", "partially_paid", "paid"]).optional(),
    customerId: objectIdSchema.optional(),
    branchId: objectIdSchema.optional(),
    appointmentId: objectIdSchema.optional(),
    sortBy: z.string().optional().default("createdAt"),
    sortOrder: z.enum(["asc", "desc"]).optional().default("desc"),
  }),
});
