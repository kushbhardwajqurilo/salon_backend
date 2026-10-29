import { z } from "zod";

const objectIdRegex = /^[0-9a-fA-F]{24}$/;
const objectIdSchema = z.string().regex(objectIdRegex, "Invalid ObjectId format");

const entitlementInputSchema = z.object({
  serviceId: objectIdSchema,
  quantity: z.number().int().min(1, "Quantity must be at least 1"),
});

const redeemServiceInputSchema = z.object({
  serviceId: objectIdSchema,
  quantity: z.number().int().min(1, "Quantity must be at least 1").default(1),
});

const memberInputSchema = z.object({
  customerId: objectIdSchema,
  entitlements: z
    .array(entitlementInputSchema)
    .min(1, "At least one service entitlement is required for member"),
  permittedBranchIds: z.array(objectIdSchema).optional().default([]),
  notes: z.string().trim().max(1000).optional().default(""),
});

export const createSubscriptionSchema = z.object({
  body: z
    .object({
      // Payer and Legacy Customer
      payerCustomerId: objectIdSchema.optional(),
      customerId: objectIdSchema.optional(),
      price: z.number().min(0, "Price must be non-negative"),
      // Multi-customer allocations
      members: z.array(memberInputSchema).min(1).optional(),
      // Legacy single-customer entitlements
      entitlements: z.array(entitlementInputSchema).min(1).optional(),
      permittedBranchIds: z.array(objectIdSchema).optional().default([]),
      startDate: z.string().datetime("Invalid ISO date for startDate").or(
        z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "Invalid date format (YYYY-MM-DD)")
      ),
      endDate: z.string().datetime("Invalid ISO date for endDate").or(
        z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "Invalid date format (YYYY-MM-DD)")
      ),
      planId: objectIdSchema.optional().nullable(),
      notes: z.string().trim().max(1000).optional().default(""),
      billImmediately: z.boolean().optional().default(false),
      branchId: objectIdSchema.optional().nullable(),
    })
    .refine(
      (data) => (data.members && data.members.length > 0) || (data.customerId && data.entitlements && data.entitlements.length > 0),
      {
        message: "Either 'members' array or ('customerId' with 'entitlements') is required",
        path: ["members"],
      }
    ),
});

export const updateSubscriptionSchema = z.object({
  body: z.object({
    permittedBranchIds: z.array(objectIdSchema).optional(),
    endDate: z
      .string()
      .datetime("Invalid ISO date for endDate")
      .or(z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "Invalid date format (YYYY-MM-DD)"))
      .optional(),
    notes: z.string().trim().max(1000).optional(),
  }),
});

export const cancelSubscriptionSchema = z.object({
  body: z.object({
    reason: z.string().trim().max(500).optional().default(""),
    refund: z.boolean().optional().default(false),
  }),
});

export const renewSubscriptionSchema = z.object({
  body: z.object({
    price: z.number().positive("Price must be greater than 0").optional(),
    startDate: z
      .string()
      .datetime("Invalid ISO date for startDate")
      .or(z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "Invalid date format (YYYY-MM-DD)"))
      .optional(),
    endDate: z
      .string()
      .datetime("Invalid ISO date for endDate")
      .or(z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "Invalid date format (YYYY-MM-DD)")),
    permittedBranchIds: z.array(objectIdSchema).optional(),
    notes: z.string().trim().max(1000).optional().default(""),
    billImmediately: z.boolean().optional().default(false),
    branchId: objectIdSchema.optional().nullable(),
  }),
});

export const sendOtpSchema = z.object({
  body: z.object({
    branchId: objectIdSchema.optional(), // Can also be resolved from req.branchId
    memberCustomerId: objectIdSchema.optional(),
  }),
});

export const redeemSubscriptionSchema = z.object({
  body: z
    .object({
      otp: z.string().trim().min(4).optional(),
      services: z
        .array(redeemServiceInputSchema)
        .min(1, "At least one service to redeem must be specified"),
      memberCustomerId: objectIdSchema.optional(),
      appointmentId: objectIdSchema.optional().nullable(),
      branchId: objectIdSchema.optional(), // Can also be resolved from req.branchId
      isManual: z.boolean().optional().default(false),
      reason: z.string().trim().max(1000).optional(),
      idempotencyKey: z.string().trim().max(255).optional(),
    })
    .refine(
      (data) => data.isManual || (data.otp && data.otp.length >= 4),
      {
        message: "OTP is required for customer verification unless performing authorized manual redemption",
        path: ["otp"],
      }
    )
    .refine(
      (data) => !data.isManual || (data.reason && data.reason.trim().length > 0),
      {
        message: "Reason is required for manual subscription redemption",
        path: ["reason"],
      }
    ),
});

export const querySubscriptionSchema = z.object({
  query: z.object({
    page: z.string().regex(/^\d+$/).transform(Number).optional().default("1"),
    limit: z.string().regex(/^\d+$/).transform(Number).optional().default("20"),
    customerId: objectIdSchema.optional(),
    status: z.enum(["active", "pending_payment", "expired", "exhausted", "cancelled"]).optional(),
    branchId: objectIdSchema.optional(),
    search: z.string().trim().optional(),
  }),
});
