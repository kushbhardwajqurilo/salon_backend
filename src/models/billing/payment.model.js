import mongoose from "mongoose";

const paymentSchema = new mongoose.Schema(
  {
    organizationId: { type: mongoose.Schema.Types.ObjectId, ref: "Organization", required: true, index: true },
    branchId: { type: mongoose.Schema.Types.ObjectId, ref: "Branch", required: true, index: true },
    invoiceId: { type: mongoose.Schema.Types.ObjectId, ref: "Invoice", required: true, index: true },
    customerId: { type: mongoose.Schema.Types.ObjectId, ref: "Customer", required: true, index: true },
    paymentNumber: { type: String, required: true, trim: true }, // PAY-YYYYMMDD-XXXX

    amount: { type: Number, required: true },
    type: {
      type: String,
      enum: ["payment", "refund"],
      default: "payment",
      index: true,
    },
    method: {
      type: String,
      enum: ["cash", "card", "upi", "other"],
      required: true,
    },
    referenceNote: { type: String, trim: true, default: "" },

    status: {
      type: String,
      enum: ["completed", "voided"],
      default: "completed",
      required: true,
      index: true,
    },

    recordedBy: { type: mongoose.Schema.Types.ObjectId, ref: "User", required: true },
    paymentDate: { type: Date, default: Date.now, required: true },

    voidedAt: { type: Date, default: null },
    voidedBy: { type: mongoose.Schema.Types.ObjectId, ref: "User", default: null },
    voidReason: { type: String, default: null, trim: true },

    idempotencyKey: { type: String, default: null, trim: true },
    requestPayloadHash: { type: String, default: null, trim: true },
    isManualRefundRecord: { type: Boolean, default: false, index: true },

    isDeleted: { type: Boolean, default: false, index: true },
    deletedAt: { type: Date, default: null },
  },
  { timestamps: true }
);

// Indexes
paymentSchema.index({ organizationId: 1, paymentNumber: 1 }, { unique: true });
paymentSchema.index(
  { organizationId: 1, idempotencyKey: 1 },
  {
    unique: true,
    partialFilterExpression: {
      isDeleted: false,
      idempotencyKey: { $type: "string" },
    },
  }
);
paymentSchema.index({ organizationId: 1, invoiceId: 1, createdAt: -1 });
paymentSchema.index({ organizationId: 1, branchId: 1, createdAt: -1 });
// Compound Index for Dashboard Collections & Refunds Aggregations (with branch filtering)
paymentSchema.index({
  organizationId: 1,
  branchId: 1,
  status: 1,
  paymentDate: 1,
  type: 1,
});
// Compound Index for Consolidated Multi-Branch Dashboard Aggregations (org-wide without branch filter)
paymentSchema.index({
  organizationId: 1,
  status: 1,
  paymentDate: 1,
  type: 1,
});

paymentSchema.set("toJSON", {
  transform: (doc, ret) => {
    ret.id = ret._id.toString();
    delete ret.__v;
    return ret;
  },
});

export const Payment = mongoose.model("Payment", paymentSchema);
