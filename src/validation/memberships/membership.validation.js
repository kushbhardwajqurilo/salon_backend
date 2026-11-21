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
    termsAndConditions: z.string().trim().max(5000).optional().default(""),
    price: z.coerce.number().min(0, "Membership price must be non-negative"),
    validityMonths: z.coerce.number().int().min(1, "Validity must be at least 1 month"),
    validityUnit: z.enum(["days", "months", "years"]).optional().default("months"),
    validityDuration: z.coerce.number().int().min(1).optional().default(12),
    maxBeneficiaries: z.coerce.number().int().min(1, "Max beneficiaries must be at least 1").default(1),
    benefits: z.object({
      serviceDiscountPercentage: z.coerce.number().min(0).max(100).default(0),
      productDiscountPercentage: z.coerce.number().min(0).max(100).default(0),
      eligibleServiceCategoryIds: z.array(objectIdSchema).optional().default([]),
      eligibleServiceIds: z.array(objectIdSchema).optional().default([]),
      excludedServiceCategoryIds: z.array(objectIdSchema).optional().default([]),
      excludedServiceIds: z.array(objectIdSchema).optional().default([]),
      complimentaryPerks: z.array(z.string().trim()).optional().default([]),
    }).default({}),
    beneficiaryPolicy: z.object({
      allowMultipleBeneficiaries: z.boolean().optional().default(false),
      maxBeneficiaries: z.coerce.number().int().min(1).optional().default(1),
      payerMustBeBeneficiary: z.boolean().optional().default(false),
      allowBeneficiaryChanges: z.boolean().optional().default(true),
    }).optional(),
    permittedBranchIds: z.array(objectIdSchema).optional().default([]),
    isCustom: z.boolean().optional().default(false),
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
    termsAndConditions: z.string().trim().max(5000).optional(),
    price: z.coerce.number().min(0).optional(),
    validityMonths: z.coerce.number().int().min(1).optional(),
    validityUnit: z.enum(["days", "months", "years"]).optional(),
    validityDuration: z.coerce.number().int().min(1).optional(),
    maxBeneficiaries: z.coerce.number().int().min(1).optional(),
    benefits: z.object({
      serviceDiscountPercentage: z.coerce.number().min(0).max(100).optional(),
      productDiscountPercentage: z.coerce.number().min(0).max(100).optional(),
      eligibleServiceCategoryIds: z.array(objectIdSchema).optional(),
      eligibleServiceIds: z.array(objectIdSchema).optional(),
      excludedServiceCategoryIds: z.array(objectIdSchema).optional(),
      excludedServiceIds: z.array(objectIdSchema).optional(),
      complimentaryPerks: z.array(z.string().trim()).optional(),
    }).optional(),
    beneficiaryPolicy: z.object({
      allowMultipleBeneficiaries: z.boolean().optional(),
      maxBeneficiaries: z.coerce.number().int().min(1).optional(),
      payerMustBeBeneficiary: z.boolean().optional(),
      allowBeneficiaryChanges: z.boolean().optional(),
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
    isCustom: z.enum(["true", "false"]).optional(),
    includeCustom: z.enum(["true", "false"]).optional(),
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

export const addBeneficiaryToMembershipSchema = z.object({
  params: z.object({
    id: objectIdSchema,
  }),
  body: z.object({
    customerId: objectIdSchema,
    benefitsOverride: z
      .object({
        serviceDiscountPercentage: z.coerce.number().min(0).max(100).optional(),
        productDiscountPercentage: z.coerce.number().min(0).max(100).optional(),
        eligibleServiceCategoryIds: z.array(objectIdSchema).optional(),
        eligibleServiceIds: z.array(objectIdSchema).optional(),
        excludedServiceCategoryIds: z.array(objectIdSchema).optional(),
        excludedServiceIds: z.array(objectIdSchema).optional(),
        complimentaryPerks: z.array(z.string().trim()).optional(),
      })
      .optional(),
  }),
});

export const sellMembershipSchema = z.object({
  body: z.object({
    planId: objectIdSchema.optional(),
    membershipPlanId: objectIdSchema.optional(),
    payerCustomerId: objectIdSchema,
    beneficiaryCustomerIds: z.array(objectIdSchema).optional(),
    beneficiaries: z
      .array(
        z.object({
          customerId: objectIdSchema,
          benefits: z
            .object({
              serviceDiscountPercentage: z.coerce.number().min(0).max(100).optional(),
              productDiscountPercentage: z.coerce.number().min(0).max(100).optional(),
              eligibleServiceCategoryIds: z.array(objectIdSchema).optional(),
              eligibleServiceIds: z.array(objectIdSchema).optional(),
              excludedServiceCategoryIds: z.array(objectIdSchema).optional(),
              excludedServiceIds: z.array(objectIdSchema).optional(),
              complimentaryPerks: z.array(z.string().trim()).optional(),
            })
            .optional(),
        })
      )
      .optional(),
    branchId: objectIdSchema.optional().nullable(),
    soldByStaffId: objectIdSchema.optional().nullable(),
    notes: z.string().trim().max(1000).optional().default(""),
    billImmediately: z.boolean().optional().default(false),
    customPlan: z
      .object({
        name: z.string().trim().min(2).max(100),
        code: z.string().trim().min(2).max(20).toUpperCase().optional().nullable(),
        tier: z.string().trim().default("Custom"),
        description: z.string().trim().max(1000).default(""),
        price: z.coerce.number().min(0),
        validityMonths: z.coerce.number().int().min(1).default(12),
        maxBeneficiaries: z.coerce.number().int().min(1).default(1),
        benefits: z
          .object({
            serviceDiscountPercentage: z.coerce.number().min(0).max(100).default(0),
            productDiscountPercentage: z.coerce.number().min(0).max(100).default(0),
            eligibleServiceCategoryIds: z.array(objectIdSchema).optional().default([]),
            eligibleServiceIds: z.array(objectIdSchema).optional().default([]),
            excludedServiceCategoryIds: z.array(objectIdSchema).optional().default([]),
            excludedServiceIds: z.array(objectIdSchema).optional().default([]),
            complimentaryPerks: z.array(z.string().trim()).optional().default([]),
          })
          .default({}),
        permittedBranchIds: z.array(objectIdSchema).optional().default([]),
        isCustom: z.boolean().optional().default(true),
        isActive: z.boolean().optional().default(true),
      })
      .optional(),
  }).refine((data) => data.planId || data.membershipPlanId || data.customPlan, {
    message: "Either planId, membershipPlanId or customPlan is required",
    path: ["planId"],
  }),
});
