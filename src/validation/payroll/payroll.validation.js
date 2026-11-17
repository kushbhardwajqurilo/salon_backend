import { z } from "zod";

const objectIdRegex = /^[0-9a-fA-F]{24}$/;
const objectIdSchema = z.string().regex(objectIdRegex, "Invalid ObjectId format");

const allowanceDeductionSchema = z.object({
  name: z.string().min(1, "Name is required").trim(),
  amount: z.number().min(0, "Amount must be at least 0"),
});

export const createSalaryStructureSchema = z.object({
  body: z.object({
    staffId: objectIdSchema,
    payType: z.enum(["fixed_monthly", "hourly"]).default("fixed_monthly"),
    baseSalary: z.number().min(0, "Base salary must be at least 0"),
    hourlyRate: z.number().min(0).default(0),
    allowances: z.array(allowanceDeductionSchema).default([]),
    deductions: z.array(allowanceDeductionSchema).default([]),
    effectiveFrom: z.preprocess(
      (val) => (typeof val === "string" ? new Date(val) : val),
      z.date({ required_error: "Effective from date is required" })
    ),
    effectiveTo: z
      .preprocess(
        (val) => (val ? (typeof val === "string" ? new Date(val) : val) : null),
        z.date().nullable().optional()
      )
      .default(null),
  }),
});

export const createPayrollPeriodSchema = z.object({
  body: z.object({
    year: z.number().int().min(2000).max(2100),
    month: z.number().int().min(1).max(12),
  }),
});

export const calculatePayrollSchema = z.object({
  body: z.object({
    payrollPeriodId: objectIdSchema,
    staffIds: z.array(objectIdSchema).optional(), // optional array: if omitted, calculate for all active staff
    branchId: objectIdSchema.optional(), // optional cost-center filter
  }),
});

export const approvePayrollRecordSchema = z.object({
  params: z.object({
    id: objectIdSchema,
  }),
});

export const payPayrollRecordSchema = z.object({
  params: z.object({
    id: objectIdSchema,
  }),
  body: z.object({
    paymentMethod: z.enum(["bank_transfer", "cash", "cheque", "upi"]),
    paymentReference: z.string().min(1, "Payment reference is required").max(200).trim(),
    amountInPaise: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
    paymentDate: z.string().datetime({ offset: true }),
    idempotencyKey: z.string().min(8).max(128).trim(),
  }),
});

export const confirmPayrollPaymentSchema = z.object({
  params: z.object({
    id: objectIdSchema,
    paymentId: objectIdSchema,
  }),
  body: z.object({
    confirmActualPayment: z.literal(true),
  }),
});

export const failPayrollPaymentSchema = z.object({
  params: z.object({
    id: objectIdSchema,
    paymentId: objectIdSchema,
  }),
  body: z.object({
    failureReason: z.string().min(3).max(500).trim(),
  }),
});

export const reversePayrollRecordSchema = z.object({
  params: z.object({
    id: objectIdSchema,
  }),
  body: z.object({
    reversalReason: z.string().min(3, "Reversal reason must be at least 3 characters").trim(),
  }),
});

export const addAdjustmentSchema = z.object({
  params: z.object({
    id: objectIdSchema,
  }),
  body: z.object({
    type: z.enum(["earning", "deduction"]),
    amount: z.number().positive("Adjustment amount must be greater than zero"),
    reason: z.string().min(3, "Reason must be at least 3 characters").trim(),
    reference: z.string().trim().optional(),
  }),
});
