import { z } from "zod";

export const objectIdSchema = z
  .string()
  .regex(/^[0-9a-fA-F]{24}$/, "Invalid ObjectId format");

export const createSupplierSchema = z.object({
  body: z.object({
    name: z.string().trim().min(2, "Supplier name must be at least 2 characters"),
    contactPerson: z.string().trim().optional(),
    phone: z.string().trim().optional(),
    email: z.string().trim().email("Invalid email").optional().or(z.literal("")),
    address: z.string().trim().optional(),
    paymentTermsDays: z.number().int().min(0).default(30),
    bankDetails: z
      .object({
        accountNo: z.string().trim().optional(),
        ifscCode: z.string().trim().optional(),
        bankName: z.string().trim().optional(),
      })
      .optional(),
    metadata: z.record(z.unknown()).optional(),
  }),
});

export const updateSupplierSchema = z.object({
  params: z.object({
    id: objectIdSchema,
  }),
  body: z.object({
    name: z.string().trim().min(2).optional(),
    contactPerson: z.string().trim().optional(),
    phone: z.string().trim().optional(),
    email: z.string().trim().email().optional().or(z.literal("")),
    address: z.string().trim().optional(),
    paymentTermsDays: z.number().int().min(0).optional(),
    bankDetails: z
      .object({
        accountNo: z.string().trim().optional(),
        ifscCode: z.string().trim().optional(),
        bankName: z.string().trim().optional(),
      })
      .optional(),
    status: z.enum(["active", "inactive"]).optional(),
    metadata: z.record(z.unknown()).optional(),
  }),
});

export const listSuppliersSchema = z.object({
  query: z.object({
    page: z.string().regex(/^\d+$/).optional(),
    limit: z.string().regex(/^\d+$/).optional(),
    status: z.enum(["active", "inactive"]).optional(),
    search: z.string().optional(),
  }),
});

export const createPurchaseOrderSchema = z.object({
  body: z.object({
    branchId: objectIdSchema.optional(),
    supplierId: objectIdSchema,
    expectedDeliveryDate: z.string().datetime().optional().nullable().or(z.string().optional()),
    notes: z.string().trim().optional(),
    items: z
      .array(
        z.object({
          productId: objectIdSchema,
          targetDomain: z.enum(["salon_consumables", "retail_products"]),
          orderedQuantity: z.number().positive("Ordered quantity must be greater than zero"),
          unitCostPrice: z.number().min(0, "Unit cost price cannot be negative"),
        })
      )
      .min(1, "Order must have at least one item"),
  }),
});

export const updatePurchaseOrderStatusSchema = z.object({
  params: z.object({
    id: objectIdSchema,
  }),
  body: z.object({
    status: z.enum(["ordered", "cancelled"]),
    cancelReason: z.string().trim().optional(),
  }),
});

const PO_STATUSES = [
  "draft",
  "ordered",
  "partially_received",
  "received",
  "cancelled",
];

export const listPurchaseOrdersSchema = z.object({
  query: z.object({
    page: z.string().regex(/^\d+$/).optional(),
    limit: z.string().regex(/^\d+$/).optional(),
    branchId: objectIdSchema.optional(),
    supplierId: objectIdSchema.optional(),
    status: z
      .string()
      .refine(
        (val) => val.split(",").every((s) => PO_STATUSES.includes(s.trim())),
        { message: "Invalid purchase order status filter" },
      )
      .optional(),
    search: z.string().optional(),
  }),
});

export const receiveGoodsSchema = z.object({
  params: z.object({
    id: objectIdSchema,
  }),
  body: z.object({
    branchId: objectIdSchema.optional(),
    notes: z.string().trim().optional(),
    idempotencyKey: z.string().trim().optional(),
    items: z
      .array(
        z.object({
          productId: objectIdSchema,
          receivedQuantity: z.number().positive("Received quantity must be greater than zero"),
          targetDomain: z.enum(["salon_consumables", "retail_products"]).optional(),
        })
      )
      .min(1, "Receipt must contain at least one item"),
  }),
});

export const listGoodsReceiptsSchema = z.object({
  query: z.object({
    page: z.string().regex(/^\d+$/).optional(),
    limit: z.string().regex(/^\d+$/).optional(),
    branchId: objectIdSchema.optional(),
    purchaseOrderId: objectIdSchema.optional(),
    supplierId: objectIdSchema.optional(),
  }),
});

export const createSupplierInvoiceSchema = z.object({
  body: z.object({
    branchId: objectIdSchema.optional(),
    supplierId: objectIdSchema,
    purchaseOrderId: objectIdSchema
      .optional()
      .nullable()
      .or(z.literal(""))
      .transform((v) => (v === "" ? undefined : v)),
    goodsReceiptId: objectIdSchema
      .optional()
      .nullable()
      .or(z.literal(""))
      .transform((v) => (v === "" ? undefined : v)),
    supplierInvoiceRef: z.string().trim().optional(),
    invoiceDate: z.string().datetime().optional().or(z.string().optional()),
    dueDate: z.string().datetime().optional().or(z.string()),
    totalAmount: z.number().positive("Invoice total must be positive"),
    notes: z.string().trim().optional(),
  }),
});

export const listSupplierInvoicesSchema = z.object({
  query: z.object({
    page: z.string().regex(/^\d+$/).optional(),
    limit: z.string().regex(/^\d+$/).optional(),
    branchId: objectIdSchema.optional(),
    supplierId: objectIdSchema.optional(),
    status: z.enum(["unpaid", "partially_paid", "paid", "cancelled"]).optional(),
  }),
});

export const recordSupplierPaymentSchema = z.object({
  body: z.object({
    branchId: objectIdSchema.optional(),
    supplierId: objectIdSchema,
    supplierInvoiceId: objectIdSchema,
    amount: z.number().positive("Payment amount must be greater than zero"),
    paymentMethod: z.enum(["cash", "card", "bank_transfer", "upi", "other"]),
    referenceNote: z.string().trim().optional(),
    paymentDate: z.string().datetime().optional().or(z.string().optional()),
    idempotencyKey: z.string().trim().optional(),
  }),
});

export const listSupplierPaymentsSchema = z.object({
  query: z.object({
    page: z.string().regex(/^\d+$/).optional(),
    limit: z.string().regex(/^\d+$/).optional(),
    branchId: objectIdSchema.optional(),
    supplierId: objectIdSchema.optional(),
    supplierInvoiceId: objectIdSchema.optional(),
  }),
});

