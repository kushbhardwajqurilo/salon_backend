import { z } from "zod";

const objectIdSchema = z.string().regex(/^[0-9a-fA-F]{24}$/, "Invalid ObjectId format");

export const leavePolicyIdParamSchema = z.object({
  params: z.object({
    id: objectIdSchema,
  }),
});

export const listLeavePoliciesQuerySchema = z.object({
  query: z
    .object({
      branchId: objectIdSchema.optional(),
      includeInactive: z.enum(["true", "false"]).optional(),
    })
    .strict(),
});

export const createLeavePolicySchema = z.object({
  body: z
    .object({
      branchId: objectIdSchema.nullable().optional(),
      code: z.string().trim().min(1, "Code is required").max(40),
      name: z.string().trim().min(1, "Name is required").max(100),
      description: z.string().trim().max(500).nullable().optional(),
      isPaid: z.boolean().default(true),
      annualEntitlement: z.number().min(0).max(365),
      carryForwardLimit: z.number().min(0).max(365).optional().default(0),
      allowHalfDay: z.boolean().optional().default(true),
      maxConsecutiveDays: z.number().int().min(1).max(365).nullable().optional(),
      excludeHolidays: z.boolean().optional().default(true),
      excludeWeeklyOffs: z.boolean().optional().default(true),
      excessBehavior: z.enum(["convert_to_unpaid", "reject"]).optional().default("reject"),
      allowNegativeBalance: z.boolean().optional().default(false),
      negativeBalancePayrollTreatment: z
        .enum(["unpaid_deduction", "carry_forward_debt", "none"])
        .optional()
        .default("unpaid_deduction"),
      effectiveFrom: z.string().datetime().optional(),
      effectiveTo: z.string().datetime().nullable().optional(),
    })
    .strict(),
});

export const updateLeavePolicySchema = z.object({
  params: z.object({
    id: objectIdSchema,
  }),
  body: z
    .object({
      name: z.string().trim().min(1).max(100).optional(),
      description: z.string().trim().max(500).nullable().optional(),
      isPaid: z.boolean().optional(),
      annualEntitlement: z.number().min(0).max(365).optional(),
      carryForwardLimit: z.number().min(0).max(365).optional(),
      allowHalfDay: z.boolean().optional(),
      maxConsecutiveDays: z.number().int().min(1).max(365).nullable().optional(),
      excludeHolidays: z.boolean().optional(),
      excludeWeeklyOffs: z.boolean().optional(),
      excessBehavior: z.enum(["convert_to_unpaid", "reject"]).optional(),
      allowNegativeBalance: z.boolean().optional(),
      negativeBalancePayrollTreatment: z
        .enum(["unpaid_deduction", "carry_forward_debt", "none"])
        .optional(),
      effectiveTo: z.string().datetime().nullable().optional(),
    })
    .strict(),
});
