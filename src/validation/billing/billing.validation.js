import { z } from "zod";

const objectIdRegex = /^[0-9a-fA-F]{24}$/;
const objectIdSchema = z.string().refine((val) => objectIdRegex.test(val), {
  message: "Invalid ObjectId format",
});

const invoiceProductLineInputSchema = z.object({
  productId: objectIdSchema,
  quantity: z.coerce.number().positive("Quantity must be greater than zero"),
  soldByStaffId: objectIdSchema.nullable().optional(),
});

const membershipBenefitsInputSchema = z.object({
  serviceDiscountPercentage: z.coerce.number().min(0).max(100).optional(),
  productDiscountPercentage: z.coerce.number().min(0).max(100).optional(),
  eligibleServiceCategoryIds: z.array(objectIdSchema).optional().default([]),
  eligibleServiceIds: z.array(objectIdSchema).optional().default([]),
  excludedServiceCategoryIds: z.array(objectIdSchema).optional().default([]),
  excludedServiceIds: z.array(objectIdSchema).optional().default([]),
  complimentaryPerks: z.array(z.string().trim()).optional().default([]),
});

const beneficiaryOverrideInputSchema = z.object({
  customerId: objectIdSchema,
  benefits: membershipBenefitsInputSchema.optional(),
});

const invoiceMembershipLineInputSchema = z.object({
  membershipPlanId: objectIdSchema,
  quantity: z.coerce.number().int().positive().default(1),
  payerCustomerId: objectIdSchema.nullable().optional(),
  beneficiaryCustomerIds: z.array(objectIdSchema).optional().default([]),
  beneficiaries: z.array(beneficiaryOverrideInputSchema).optional().default([]),
  soldByStaffId: objectIdSchema.nullable().optional(),
});

const invoiceSubscriptionLineInputSchema = z.object({
  planId: objectIdSchema,
  price: z.coerce.number().min(0, "Price must be non-negative").optional(),
  soldByStaffId: objectIdSchema.nullable().optional(),
});

const invoiceCustomServiceLineInputSchema = z.object({
  serviceId: objectIdSchema,
  quantity: z.coerce.number().int().positive().default(1),
  unitPrice: z.coerce.number().min(0).optional(),
  appliedSubscriptionId: objectIdSchema.optional().nullable(),
  performedByStaffId: objectIdSchema.nullable().optional(),
});

export const createInvoiceSchema = z.object({
  body: z
    .object({
      branchId: objectIdSchema,
      customerId: objectIdSchema.optional(),
      appointmentId: objectIdSchema.optional(),
      subscriptionId: objectIdSchema.optional(),
      // Unified cart collections
      productLines: z.array(invoiceProductLineInputSchema).optional().default([]),
      membershipLines: z.array(invoiceMembershipLineInputSchema).optional().default([]),
      subscriptionLines: z.array(invoiceSubscriptionLineInputSchema).optional().default([]),
      serviceLines: z.array(invoiceCustomServiceLineInputSchema).optional().default([]),
      // Single plan convenience inputs for backward compatibility
      membershipPlanId: objectIdSchema.optional(),
      discount: z.coerce.number().min(0, "Discount must be non-negative").optional(),
      discountTotal: z.coerce.number().min(0, "Discount must be non-negative").optional(),
      redeemLoyaltyPoints: z.coerce.number().int().min(0, "redeemLoyaltyPoints must be non-negative").optional(),
      notes: z.string().max(1000, "Notes cannot exceed 1000 characters").optional().default(""),
    })
    .refine(
      (data) =>
        data.appointmentId ||
        data.subscriptionId ||
        data.membershipPlanId ||
        (data.membershipLines && data.membershipLines.length > 0) ||
        (data.subscriptionLines && data.subscriptionLines.length > 0) ||
        (data.customerId && (
          (data.productLines && data.productLines.length > 0) ||
          (data.serviceLines && data.serviceLines.length > 0)
        )),
      {
        message: "An invoice must contain at least one valid line (appointment, subscription, membership, product, or service)",
        path: ["appointmentId"],
      }
    ),
});

export const createSubscriptionInvoiceSchema = z.object({
  body: z.object({
    branchId: objectIdSchema,
    subscriptionId: objectIdSchema,
    productLines: z.array(invoiceProductLineInputSchema).optional().default([]),
    discount: z.coerce.number().min(0, "Discount must be non-negative").optional(),
    redeemLoyaltyPoints: z.coerce.number().int().min(0, "redeemLoyaltyPoints must be non-negative").optional(),
    notes: z.string().max(1000, "Notes cannot exceed 1000 characters").optional().default(""),
  }),
});

export const updateDraftInvoiceSchema = z.object({
  body: z.object({
    branchId: objectIdSchema.optional(),
    productLines: z.array(invoiceProductLineInputSchema).optional(),
    membershipLines: z.array(invoiceMembershipLineInputSchema).optional(),
    subscriptionLines: z.array(invoiceSubscriptionLineInputSchema).optional(),
    serviceLines: z.array(invoiceCustomServiceLineInputSchema).optional(),
    discountTotal: z.coerce.number().min(0, "Discount must be non-negative").optional(),
    redeemLoyaltyPoints: z.coerce.number().int().min(0, "redeemLoyaltyPoints must be non-negative").optional(),
    notes: z.string().max(1000, "Notes cannot exceed 1000 characters").optional(),
  }).strict(),
});

export const correctInvoiceAttributionSchema = z.object({
  params: z.object({
    id: objectIdSchema,
  }),
  body: z.object({
    branchId: objectIdSchema,
    lineId: objectIdSchema,
    sourceRole: z.enum(["seller", "renewal_handler"]),
    staffId: objectIdSchema.nullable(),
    reason: z.string().trim().min(3).max(500),
  }).strict(),
});

export const returnInvoiceItemsSchema = z.object({
  body: z  .object({
    branchId: objectIdSchema.optional(),
    items: z
      .array(
        z.object({
          lineId: objectIdSchema,
          quantity: z.coerce.number().positive("Return quantity must be greater than zero"),
          condition: z.enum(["unopened", "damaged", "defective"]).default("unopened"),
          acceptPhysicalRestock: z.boolean().default(true),
          restockReason: z.string().trim().max(500).optional(),
        })
      )
      .min(1, "At least one item must be returned"),
    refundPaymentMethod: z.enum(["cash", "card", "upi", "other"]).default("cash"),
    reason: z.string().trim().min(3, "Return reason must be at least 3 characters").max(500),
  }).superRefine((data, ctx) => {
    const lineIds = data.items.map((item) => item.lineId);
    if (new Set(lineIds).size !== lineIds.length) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["items"],
        message: "Duplicate invoice lines are not allowed in a return request",
      });
    }
  }),
});

export const refundMembershipLineSchema = z.object({
  body: z.object({
    branchId: objectIdSchema.optional(),
    lineId: objectIdSchema,
    refundPaymentMethod: z.enum(["cash", "card", "upi", "other"]),
    reason: z.string().trim().min(3).max(500),
  }).strict(),
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

export const applyInvoiceDiscountSchema = z.object({
  body: z
    .object({
      branchId: objectIdSchema,
      discountLevel: z.enum(["line", "selected_lines", "invoice"]),
      lineId: objectIdSchema.optional().nullable(),
      lineIds: z.array(objectIdSchema).optional().nullable(),
      name: z.string().trim().min(1).max(100).default("Discount"),
      discountType: z.enum(["fixed", "percentage"]),
      enteredValue: z.coerce.number().positive("Discount value must be greater than zero"),
      reason: z.string().trim().min(3, "Reason must be at least 3 characters").max(500),
    })
    .superRefine((data, ctx) => {
      if (data.discountLevel === "line") {
        if (!data.lineId) {
          ctx.addIssue({
            code: z.ZodIssueCode.custom,
            path: ["lineId"],
            message: "lineId is required for line-level discount",
          });
        }
      }
      if (data.discountLevel === "selected_lines") {
        if (!Array.isArray(data.lineIds) || data.lineIds.length === 0) {
          ctx.addIssue({
            code: z.ZodIssueCode.custom,
            path: ["lineIds"],
            message: "lineIds array is required and must contain at least one lineId for selected_lines discount",
          });
        } else {
          const uniqueIds = new Set(data.lineIds.map((id) => id.toString()));
          if (uniqueIds.size !== data.lineIds.length) {
            ctx.addIssue({
              code: z.ZodIssueCode.custom,
              path: ["lineIds"],
              message: "Duplicate line IDs are not allowed in lineIds",
            });
          }
        }
      }
      if (data.discountType === "percentage" && data.enteredValue > 100) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["enteredValue"],
          message: "Percentage discount cannot exceed 100%",
        });
      }
    }),
});

export const modifyInvoiceDiscountSchema = z.object({
  body: z.object({
    branchId: objectIdSchema,
    enteredValue: z.coerce.number().positive("Discount value must be greater than zero"),
    reason: z.string().trim().min(3, "Reason must be at least 3 characters").max(500),
  }),
});

export const removeInvoiceDiscountSchema = z.object({
  body: z.object({
    branchId: objectIdSchema,
    reason: z.string().trim().min(3, "Reason must be at least 3 characters").max(500),
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
    customerId: objectIdSchema.optional(),
    date: z
      .string()
      .regex(dateOnlyRegex, "Invalid date format (YYYY-MM-DD)")
      .optional(),
  }),
});

export const applyCouponSchema = z.object({
  params: z.object({
    id: objectIdSchema,
  }),
  body: z.object({
    code: z
      .string()
      .trim()
      .min(1, "Coupon code is required")
      .max(50, "Coupon code cannot exceed 50 characters"),
  }),
});

export const removeCouponSchema = z.object({
  params: z.object({
    id: objectIdSchema,
  }),
});


