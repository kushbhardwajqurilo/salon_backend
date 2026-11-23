import mongoose from "mongoose";

const expenseSchema = new mongoose.Schema(
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
    expenseCode: {
      type: String,
      required: true,
      trim: true,
    },
    category: {
      type: String,
      required: true,
      trim: true,
      lowercase: true,
    },
    amount: {
      type: Number,
      required: true,
      min: 0.01,
    },
    paymentMethod: {
      type: String,
      enum: ["petty_cash", "upi", "card", "bank_transfer"],
      required: true,
    },
    payeeName: {
      type: String,
      required: true,
      trim: true,
    },
    invoiceNumber: {
      type: String,
      trim: true,
      default: null,
    },
    receiptUrl: {
      type: String,
      trim: true,
      default: null,
    },
    description: {
      type: String,
      trim: true,
      default: "",
    },
    // Integration linkages (Procurement / Inventory / Payroll / Billing)
    sourceType: {
      type: String,
      enum: ["manual", "procurement_invoice", "procurement_payment", "inventory_consumption", "payroll", "other"],
      default: "manual",
      index: true,
    },
    sourceReference: {
      type: String,
      trim: true,
      default: null,
      index: true,
    },
    supplierId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Supplier",
      default: null,
      index: true,
    },
    supplierInvoiceId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "SupplierInvoice",
      default: null,
      index: true,
    },
    campaignId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Campaign",
      default: null,
      index: true,
    },
    expenseDate: {
      type: Date,
      required: true,
      default: Date.now,
      index: true,
    },
    approvalStatus: {
      type: String,
      enum: ["pending_approval", "approved", "rejected"],
      default: "pending_approval",
      required: true,
      index: true,
    },
    paymentStatus: {
      type: String,
      enum: ["unpaid", "settled"],
      default: "unpaid",
      required: true,
      index: true,
    },
    approvalThresholdAtCreation: {
      type: Number,
      required: true,
      min: 0,
    },
    approvedBy: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "User",
      default: null,
    },
    approvedAt: {
      type: Date,
      default: null,
    },
    rejectedBy: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "User",
      default: null,
    },
    rejectedAt: {
      type: Date,
      default: null,
    },
    rejectionReason: {
      type: String,
      trim: true,
      default: null,
    },
    recordedBy: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "User",
      required: true,
    },
    isDeleted: {
      type: Boolean,
      default: false,
      index: true,
    },
    deletedAt: {
      type: Date,
      default: null,
    },
    deletedBy: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "User",
      default: null,
    },
  },
  { timestamps: true }
);

// Indexes
expenseSchema.index({ organizationId: 1, expenseCode: 1 }, { unique: true });
expenseSchema.index({ organizationId: 1, branchId: 1, expenseDate: -1 });
expenseSchema.index({ organizationId: 1, branchId: 1, approvalStatus: 1, paymentStatus: 1 });
expenseSchema.index({ organizationId: 1, campaignId: 1, expenseDate: -1 });

expenseSchema.set("toJSON", {
  transform: (doc, ret) => {
    ret.id = ret._id.toString();
    delete ret.__v;
    return ret;
  },
});

export const Expense = mongoose.model("Expense", expenseSchema);
