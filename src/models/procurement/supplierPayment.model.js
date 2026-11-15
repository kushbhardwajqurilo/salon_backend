import mongoose from "mongoose";

const supplierPaymentSchema = new mongoose.Schema(
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
    paymentNumber: {
      type: String,
      required: true,
      trim: true,
    },
    supplierId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Supplier",
      required: true,
      index: true,
    },
    supplierInvoiceId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "SupplierInvoice",
      required: true,
      index: true,
    },
    amount: {
      type: Number,
      required: true,
      min: 0.01,
    },
    paymentMethod: {
      type: String,
      enum: ["cash", "card", "bank_transfer", "upi", "other"],
      required: true,
    },
    referenceNote: {
      type: String,
      trim: true,
      default: "",
    },
    paymentDate: {
      type: Date,
      default: Date.now,
      required: true,
    },
    recordedBy: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "User",
      required: true,
    },
    idempotencyKey: {
      type: String,
      trim: true,
      default: null,
      index: true,
    },
  },
  {
    timestamps: true,
  }
);

supplierPaymentSchema.index({ organizationId: 1, paymentNumber: 1 }, { unique: true });
supplierPaymentSchema.index({ organizationId: 1, supplierInvoiceId: 1, createdAt: -1 });
supplierPaymentSchema.index({ organizationId: 1, supplierId: 1, createdAt: -1 });
supplierPaymentSchema.index(
  { organizationId: 1, idempotencyKey: 1 },
  {
    unique: true,
    partialFilterExpression: { idempotencyKey: { $type: "string" } },
  }
);

supplierPaymentSchema.set("toJSON", {
  transform: (doc, ret) => {
    ret.id = ret._id.toString();
    delete ret.__v;
    return ret;
  },
});

export const SupplierPayment =
  mongoose.models.SupplierPayment ||
  mongoose.model("SupplierPayment", supplierPaymentSchema);

