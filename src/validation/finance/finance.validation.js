import { z } from "zod";

export const getSystemTotalsQuerySchema = z.object({
  query: z.object({
    businessDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "businessDate must be YYYY-MM-DD"),
  }),
});

export const submitDayClosureSchema = z.object({
  body: z.object({
    businessDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "businessDate must be YYYY-MM-DD"),
    physicalCounts: z.object({
      cash: z.number().min(0, "Cash count must be non-negative"),
      card: z.number().min(0, "Card count must be non-negative"),
      upi: z.number().min(0, "UPI count must be non-negative"),
      other: z.number().min(0, "Other count must be non-negative").optional().default(0),
    }),
    discrepancyReason: z.string().trim().optional(),
  }),
});

export const approveDayClosureSchema = z.object({
  params: z.object({
    id: z.string().regex(/^[0-9a-fA-F]{24}$/, "Valid DayClosure ID required"),
  }),
  body: z.object({
    managerNotes: z.string().trim().optional().default(""),
  }),
});

export const listDayClosuresQuerySchema = z.object({
  query: z.object({
    page: z.string().regex(/^\d+$/).transform(Number).optional().default("1"),
    limit: z.string().regex(/^\d+$/).transform(Number).optional().default("20"),
    startDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
    endDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
    status: z.enum(["submitted", "approved"]).optional(),
    reconciliationResult: z.enum(["balanced", "discrepant"]).optional(),
  }),
});

export const getOperatingProfitQuerySchema = z.object({
  query: z.object({
    startDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "startDate must be YYYY-MM-DD"),
    endDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "endDate must be YYYY-MM-DD"),
    page: z.coerce.number().int().min(1).optional(),
    limit: z.coerce.number().int().min(1).max(100).optional(),
  }),
});

export const getBranchPerformanceQuerySchema = z.object({
  query: z.object({
    startDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "startDate must be YYYY-MM-DD"),
    endDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "endDate must be YYYY-MM-DD"),
    page: z.coerce.number().int().min(1).optional(),
    limit: z.coerce.number().int().min(1).max(100).optional(),
  }),
});

export const getTransactionsQuerySchema = z.object({
  query: z.object({
    startDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
    endDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
    type: z.enum([
      "all",
      "customer_payment",
      "customer_refund",
      "expense",
      "petty_cash",
      "payroll_payment",
      "supplier_payment"
    ]).optional().default("all"),
    method: z.enum([
      "all",
      "cash",
      "card",
      "upi",
      "bank_transfer",
      "cheque",
      "other"
    ]).optional().default("all"),
    search: z.string().trim().optional(),
    minAmount: z.string().regex(/^\d+(\.\d+)?$/).transform(Number).optional(),
    maxAmount: z.string().regex(/^\d+(\.\d+)?$/).transform(Number).optional(),
    page: z.string().regex(/^\d+$/).transform(Number).optional().default("1"),
    limit: z.string().regex(/^\d+$/).transform(Number).optional().default("20"),
  }),
});

export const getAuditHistoryQuerySchema = z.object({
  query: z.object({
    startDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
    endDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
    entityType: z.enum(["all", "day_closure", "expense", "petty_cash"]).optional().default("all"),
    page: z.string().regex(/^\d+$/).transform(Number).optional().default("1"),
    limit: z.string().regex(/^\d+$/).transform(Number).optional().default("20"),
  }),
});

export const getReportsQuerySchema = z.object({
  query: z.object({
    reportType: z.enum([
      "pnl_statement",
      "tender_reconciliation",
      "expense_breakdown",
      "revenue_streams"
    ]),
    startDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "startDate must be YYYY-MM-DD"),
    endDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "endDate must be YYYY-MM-DD"),
    page: z.coerce.number().int().min(1).optional(),
    limit: z.coerce.number().int().min(1).max(100).optional(),
    format: z.enum(["json", "csv"]).optional().default("json"),
  }),
});
