import { z } from "zod";

export const objectIdSchema = z
  .string()
  .regex(/^[0-9a-fA-F]{24}$/, "Invalid ObjectId format");

const tierValidationSchema = z
  .object({
    minPaise: z.number().int().nonnegative("minPaise must be a non-negative integer"),
    maxPaise: z.number().int().nonnegative().nullable().optional(),
    percentage: z.number().min(0).max(100, "Percentage must be between 0 and 100"),
    fixedPaise: z.number().int().nonnegative().default(0),
  })
  .superRefine(({ minPaise, maxPaise }, context) => {
    if (maxPaise !== null && maxPaise !== undefined && maxPaise < minPaise) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["maxPaise"],
        message: "maxPaise must be greater than or equal to minPaise",
      });
    }
  });

const schemeIdentitySchema = {
    name: z.string().trim().min(2, "Scheme name must be at least 2 characters").max(120),
    code: z.string().trim().min(2).max(40).toUpperCase(),
    description: z.string().trim().max(500).optional().default(""),
};

const commissionSchemeSchema = z.object({
  ...schemeIdentitySchema,
  schemeType: z.literal("COMMISSION"),
  calculationBasis: z.enum([
    "SERVICE_NET_REVENUE",
    "SUBSCRIPTION_NET_REVENUE",
    "MEMBERSHIP_NET_REVENUE",
    "PRODUCT_NET_REVENUE",
  ]).default("SERVICE_NET_REVENUE"),
  rules: z.object({
      tiers: z.array(tierValidationSchema).optional().default([]),
      fixedAmountPaise: z.number().int().nonnegative().optional().default(0),
  }).strict("Unsupported commission rule fields are not allowed").default({}),
});

const attendanceBonusSchemeSchema = z.object({
  ...schemeIdentitySchema,
  schemeType: z.literal("ATTENDANCE_BONUS"),
  calculationBasis: z.literal("ATTENDANCE_DAYS"),
  rules: z.object({
    fixedAmountPaise: z.number().int().positive(),
    minimumAttendanceDays: z.number().int().min(1).max(31),
    tiers: z.array(tierValidationSchema).max(0).optional().default([]),
  }).strict("Unsupported attendance bonus rule fields are not allowed"),
});

export const createSchemeSchema = z.object({
  body: z.discriminatedUnion("schemeType", [
    commissionSchemeSchema,
    attendanceBonusSchemeSchema,
  ]),
});

export const updateSchemeSchema = z.object({
  params: z.object({
    id: objectIdSchema,
  }),
  body: z.object({
    name: z.string().trim().min(2).max(120).optional(),
    description: z.string().trim().max(500).optional(),
    calculationBasis: z.enum([
      "SERVICE_NET_REVENUE",
      "SUBSCRIPTION_NET_REVENUE",
      "MEMBERSHIP_NET_REVENUE",
      "PRODUCT_NET_REVENUE",
      "ATTENDANCE_DAYS",
    ]).optional(),
    rules: z.object({
      tiers: z.array(tierValidationSchema).optional(),
      fixedAmountPaise: z.number().int().nonnegative().optional(),
      minimumAttendanceDays: z.number().int().min(0).max(31).optional(),
    }).strict("Unsupported incentive rule fields are not allowed").optional(),
  }),
});

export const listSchemesSchema = z.object({
  query: z.object({
    page: z.string().regex(/^\d+$/).optional(),
    limit: z.string().regex(/^\d+$/).optional(),
    status: z.enum(["draft", "active", "paused", "archived"]).optional(),
    schemeType: z.enum(["COMMISSION", "TARGET_BONUS", "ATTENDANCE_BONUS", "HYBRID"]).optional(),
    search: z.string().trim().optional(),
  }),
});

export const createAssignmentSchema = z.object({
  body: z.object({
    schemeId: objectIdSchema,
    scopeType: z.enum(["ORGANIZATION", "BRANCH", "STAFF"]),
    scopeId: objectIdSchema.nullable().optional(),
    startDate: z.string().datetime({ offset: true }).or(z.string().regex(/^\d{4}-\d{2}-\d{2}/)),
    endDate: z.string().datetime({ offset: true }).or(z.string().regex(/^\d{4}-\d{2}-\d{2}/)).nullable().optional(),
    priority: z.number().int().optional().default(0),
  }),
});

export const listAssignmentsSchema = z.object({
  query: z.object({
    schemeId: objectIdSchema.optional(),
    scopeType: z.enum(["ORGANIZATION", "BRANCH", "ROLE", "STAFF"]).optional(),
    scopeId: objectIdSchema.optional(),
    status: z.enum(["active", "inactive"]).optional(),
    page: z.string().regex(/^\d+$/).optional(),
    limit: z.string().regex(/^\d+$/).optional(),
  }),
});

export const listSummarySchema = z.object({
  query: z.object({
    branchId: objectIdSchema.optional(),
  }),
});

export const previewCalculationSchema = z.object({
  body: z.object({
    schemeId: objectIdSchema.optional(),
    revenueInPaise: z.number().int().nonnegative(),
    staffId: objectIdSchema.optional(),
    branchId: objectIdSchema.optional(),
    date: z.string().optional(),
  }),
});

export const listLedgerSchema = z.object({
  query: z.object({
    staffId: objectIdSchema.optional(),
    branchId: objectIdSchema.optional(),
    entryType: z.enum(["ACCRUAL", "CLAWBACK"]).optional(),
    fulfillmentStatus: z.enum(["pending", "confirmed", "corrected", "cancelled"]).optional(),
    page: z.string().regex(/^\d+$/).optional(),
    limit: z.string().regex(/^\d+$/).optional(),
  }),
});

export const listRecoveryObligationsSchema = z.object({
  query: z.object({
    staffId: objectIdSchema.optional(),
    status: z.enum(["pending", "partially_recovered", "recovered", "written_off"]).optional(),
    page: z.string().regex(/^\d+$/).optional(),
    limit: z.string().regex(/^\d+$/).optional(),
  }),
});

export const recordRecoveryPaymentSchema = z.object({
  params: z.object({ id: objectIdSchema }),
  body: z.object({
    amountInPaise: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
    paymentMethod: z.enum(["bank_transfer", "cash", "cheque", "upi"]),
    paymentReference: z.string().trim().min(1).max(200),
    paymentDate: z.string().datetime({ offset: true }),
    reason: z.string().trim().min(3).max(500),
    idempotencyKey: z.string().trim().min(8).max(128),
  }),
});

export const confirmRecoveryPaymentSchema = z.object({
  params: z.object({
    id: objectIdSchema,
    paymentId: objectIdSchema,
  }),
  body: z.object({
    confirmActualPayment: z.literal(true),
  }),
});

export const failRecoveryPaymentSchema = z.object({
  params: z.object({
    id: objectIdSchema,
    paymentId: objectIdSchema,
  }),
  body: z.object({
    failureReason: z.string().trim().min(3).max(500),
  }),
});

export const reverseRecoveryPaymentSchema = z.object({
  params: z.object({
    id: objectIdSchema,
    paymentId: objectIdSchema,
  }),
  body: z.object({
    confirmActualReversal: z.literal(true),
    reversalReason: z.string().trim().min(3).max(500),
  }),
});

export const computeAttendanceEvaluationSchema = z.object({
  body: z.object({
    staffId: objectIdSchema,
    schemeId: objectIdSchema,
    monthYear: z.string().regex(/^\d{4}-(0[1-9]|1[0-2])$/),
  }),
});

export const finalizeAttendanceEvaluationSchema = z.object({
  params: z.object({
    id: objectIdSchema,
  }),
});

export const confirmWalkInFulfillmentSchema = z.object({
  body: z.object({
    invoiceId: objectIdSchema,
    lineIds: z.array(objectIdSchema).min(1).max(100),
    reason: z.string().trim().min(3).max(1000),
  }).superRefine((body, context) => {
    if (new Set(body.lineIds).size !== body.lineIds.length) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["lineIds"],
        message: "Duplicate invoice line IDs are not allowed",
      });
    }
  }),
});

export const listWalkInFulfillmentSchema = z.object({
  query: z.object({
    invoiceId: objectIdSchema,
  }),
});
