import mongoose from "mongoose";

export const SUPPLIER_INVOICE_STATUSES = [
  "unpaid",
  "partially_paid",
  "paid",
  "cancelled",
];

const supplierInvoiceSchema = new mongoose.Schema(
  {
    organizationId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Organization",
      required: true,
      index: true,
    },
    branchId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Branch",
      required: true,
      index: true,
    },
    invoiceNumber: {
      type: String,
      required: true,
      trim: true,
    },
    supplierInvoiceRef: {
      type: String,
      trim: true,
      default: "",
    },
    supplierId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Supplier",
      required: true,
      index: true,
    },
    purchaseOrderId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "PurchaseOrder",
      default: null,
      index: true,
    },
    goodsReceiptId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "GoodsReceiptNote",
      default: null,
    },
    invoiceDate: {
      type: Date,
      required: true,
      default: Date.now,
    },
    dueDate: {
      type: Date,
      required: true,
    },
    totalAmount: {
      type: Number,
      required: true,
      min: 0,
    },
    amountPaid: {
      type: Number,
      default: 0,
      min: 0,
    },
    status: {
      type: String,
      enum: SUPPLIER_INVOICE_STATUSES,
      default: "unpaid",
      index: true,
    },
    notes: {
      type: String,
      trim: true,
      default: "",
    },
    createdBy: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "User",
      required: true,
    },
  },
  {
    timestamps: true,
  }
);

supplierInvoiceSchema.index({ organizationId: 1, invoiceNumber: 1 }, { unique: true });
supplierInvoiceSchema.index({ organizationId: 1, supplierId: 1, status: 1 });
supplierInvoiceSchema.index({ organizationId: 1, branchId: 1, createdAt: -1 });

supplierInvoiceSchema.virtual("outstandingAmount").get(function () {
  return Math.max(0, (this.totalAmount || 0) - (this.amountPaid || 0));
});

supplierInvoiceSchema.set("toJSON", {
  virtuals: true,
  transform: (doc, ret) => {
    ret.id = ret._id.toString();
    delete ret.__v;
    return ret;
  },
});

export const SupplierInvoice =
  mongoose.models.SupplierInvoice ||
  mongoose.model("SupplierInvoice", supplierInvoiceSchema);

