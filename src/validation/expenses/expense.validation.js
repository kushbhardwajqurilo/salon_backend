import { z } from "zod";

export const createExpenseSchema = z.object({
  body: z.object({
    category: z.string().trim().min(1, "Category is required"),
    amount: z.number().positive("Amount must be greater than zero"),
    paymentMethod: z.enum(["petty_cash", "upi", "card", "bank_transfer"], {
      errorMap: () => ({ message: "Payment method must be petty_cash, upi, card, or bank_transfer" }),
    }),
    payeeName: z.string().trim().min(1, "Payee name is required"),
    invoiceNumber: z.string().trim().optional().nullable(),
    receiptUrl: z.string().trim().url("Invalid receipt URL").optional().nullable(),
    description: z.string().trim().optional().nullable(),
    sourceType: z.enum(["manual", "procurement_invoice", "procurement_payment", "inventory_consumption", "payroll", "other"]).optional().default("manual"),
    sourceReference: z.string().trim().optional().nullable(),
    supplierId: z.string().regex(/^[0-9a-fA-F]{24}$/, "Valid supplierId required").optional().nullable(),
    supplierInvoiceId: z.string().regex(/^[0-9a-fA-F]{24}$/, "Valid supplierInvoiceId required").optional().nullable(),
    expenseDate: z.string().datetime({ offset: true }).or(z.string().regex(/^\d{4}-\d{2}-\d{2}/)).optional(),
    branchId: z.string().regex(/^[0-9a-fA-F]{24}$/, "Valid branchId required").optional(),
  }),
});

export const updateExpenseSchema = z.object({
  params: z.object({
    id: z.string().regex(/^[0-9a-fA-F]{24}$/, "Valid expense ID required"),
  }),
  body: z.object({
    category: z.string().trim().min(1).optional(),
    payeeName: z.string().trim().min(1).optional(),
    invoiceNumber: z.string().trim().optional().nullable(),
    receiptUrl: z.string().trim().url().optional().nullable(),
    description: z.string().trim().optional().nullable(),
    expenseDate: z.string().datetime({ offset: true }).or(z.string().regex(/^\d{4}-\d{2}-\d{2}/)).optional(),
  }),
});

export const rejectExpenseSchema = z.object({
  params: z.object({
    id: z.string().regex(/^[0-9a-fA-F]{24}$/, "Valid expense ID required"),
  }),
  body: z.object({
    reason: z.string().trim().min(1, "Rejection reason is required"),
  }),
});

export const listExpensesQuerySchema = z.object({
  query: z.object({
    page: z.string().regex(/^\d+$/).transform(Number).optional().default("1"),
    limit: z.string().regex(/^\d+$/).transform(Number).optional().default("20"),
    category: z.string().trim().optional(),
    paymentMethod: z.enum(["petty_cash", "upi", "card", "bank_transfer"]).optional(),
    approvalStatus: z.enum(["pending_approval", "approved", "rejected"]).optional(),
    paymentStatus: z.enum(["unpaid", "settled"]).optional(),
    startDate: z.string().trim().optional(),
    endDate: z.string().trim().optional(),
    search: z.string().trim().optional(),
    sortBy: z.enum(["expenseDate", "amount", "createdAt"]).optional().default("expenseDate"),
    sortOrder: z.enum(["asc", "desc"]).optional().default("desc"),
  }),
});

export const replenishPettyCashSchema = z.object({
  body: z.object({
    amount: z.number().positive("Amount must be greater than zero"),
    description: z.string().trim().min(1, "Description is required"),
  }),
});

export const recoverPettyCashPayoutSchema = z.object({
  body: z.object({
    linkedExpenseId: z.string().regex(/^[0-9a-fA-F]{24}$/, "Valid linkedExpenseId required"),
    originalPayoutId: z.string().regex(/^[0-9a-fA-F]{24}$/, "Valid originalPayoutId required"),
    recoveredAmount: z.number().positive("Recovered amount must be greater than zero"),
    recoveryDate: z.string().datetime({ offset: true }).or(z.string().regex(/^\d{4}-\d{2}-\d{2}/)).optional(),
    reason: z.string().trim().min(1, "Recovery reason is required"),
  }),
});
