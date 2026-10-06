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

export const createSubscriptionSchema = z.object({
  body: z.object({
    customerId: objectIdSchema,
    price: z.number().min(0, "Price must be non-negative"),
    entitlements: z
      .array(entitlementInputSchema)
      .min(1, "At least one service entitlement is required"),
    permittedBranchIds: z.array(objectIdSchema).optional().default([]),
    startDate: z.string().datetime("Invalid ISO date for startDate").or(
      z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "Invalid date format (YYYY-MM-DD)")
    ),
    endDate: z.string().datetime("Invalid ISO date for endDate").or(
      z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "Invalid date format (YYYY-MM-DD)")
    ),
    planId: objectIdSchema.optional().nullable(),
    notes: z.string().trim().max(1000).optional().default(""),
  }),
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
  }),
});

export const sendOtpSchema = z.object({
  body: z.object({
    branchId: objectIdSchema.optional(), // Can also be resolved from req.branchId
  }),
});

export const redeemSubscriptionSchema = z.object({
  body: z
    .object({
      otp: z.string().trim().min(4).optional(),
      services: z
        .array(redeemServiceInputSchema)
        .min(1, "At least one service to redeem must be specified"),
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
    status: z.enum(["active", "expired", "exhausted", "cancelled"]).optional(),
    branchId: objectIdSchema.optional(),
    search: z.string().trim().optional(),
  }),
});
