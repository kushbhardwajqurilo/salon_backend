import { z } from "zod";
import mongoose from "mongoose";

const objectIdSchema = z
  .string()
  .refine((val) => mongoose.Types.ObjectId.isValid(val), {
    message: "Invalid ObjectId format",
  });

export const createMembershipPlanSchema = z.object({
  body: z.object({
    name: z.string().trim().min(2, "Name must be at least 2 characters").max(100),
    code: z.string().trim().min(2).max(20).toUpperCase().optional().nullable(),
    tier: z.string().trim().default("Standard"),
    description: z.string().trim().max(1000).default(""),
    price: z.coerce.number().min(0, "Membership price must be non-negative"),
    validityMonths: z.coerce.number().int().min(1, "Validity must be at least 1 month"),
    maxBeneficiaries: z.coerce.number().int().min(1, "Max beneficiaries must be at least 1").default(1),
    benefits: z.object({
      serviceDiscountPercentage: z.coerce.number().min(0).max(100).default(0),
      productDiscountPercentage: z.coerce.number().min(0).max(100).default(0),
      eligibleServiceCategoryIds: z.array(objectIdSchema).optional().default([]),
      complimentaryPerks: z.array(z.string().trim()).optional().default([]),
    }).default({}),
    permittedBranchIds: z.array(objectIdSchema).optional().default([]),
    isActive: z.boolean().optional().default(true),
  }),
});

export const updateMembershipPlanSchema = z.object({
  params: z.object({
    id: objectIdSchema,
  }),
  body: z.object({
    name: z.string().trim().min(2).max(100).optional(),
    code: z.string().trim().min(2).max(20).toUpperCase().optional().nullable(),
    tier: z.string().trim().optional(),
    description: z.string().trim().max(1000).optional(),
    price: z.coerce.number().min(0).optional(),
    validityMonths: z.coerce.number().int().min(1).optional(),
    maxBeneficiaries: z.coerce.number().int().min(1).optional(),
    benefits: z.object({
      serviceDiscountPercentage: z.coerce.number().min(0).max(100).optional(),
      productDiscountPercentage: z.coerce.number().min(0).max(100).optional(),
      eligibleServiceCategoryIds: z.array(objectIdSchema).optional(),
      complimentaryPerks: z.array(z.string().trim()).optional(),
    }).optional(),
    permittedBranchIds: z.array(objectIdSchema).optional(),
    isActive: z.boolean().optional(),
  }),
});

export const queryMembershipPlanSchema = z.object({
  query: z.object({
    search: z.string().optional(),
    tier: z.string().optional(),
    isActive: z.enum(["true", "false"]).optional(),
    page: z.coerce.number().int().min(1).default(1),
    limit: z.coerce.number().int().min(1).max(100).default(50),
  }),
});

export const queryCustomerMembershipSchema = z.object({
  query: z.object({
    customerId: objectIdSchema.optional(),
    payerCustomerId: objectIdSchema.optional(),
    status: z.enum(["pending_payment", "active", "expired", "cancelled"]).optional(),
    membershipPlanId: objectIdSchema.optional(),
    search: z.string().optional(),
    page: z.coerce.number().int().min(1).default(1),
    limit: z.coerce.number().int().min(1).max(100).default(20),
  }),
});

export const cancelBeneficiaryMembershipSchema = z.object({
  params: z.object({
    id: objectIdSchema,
  }),
  body: z.object({
    reason: z.string().trim().min(3, "Reason must be at least 3 characters").max(500),
  }),
});
