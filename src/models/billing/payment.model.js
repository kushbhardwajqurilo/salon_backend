import mongoose from "mongoose";

const paymentSchema = new mongoose.Schema(
  {
    organizationId: { type: mongoose.Schema.Types.ObjectId, ref: "Organization", required: true, index: true },
    branchId: { type: mongoose.Schema.Types.ObjectId, ref: "Branch", required: true, index: true },
    invoiceId: { type: mongoose.Schema.Types.ObjectId, ref: "Invoice", required: true, index: true },
    customerId: { type: mongoose.Schema.Types.ObjectId, ref: "Customer", required: true, index: true },
    paymentNumber: { type: String, required: true, trim: true }, // PAY-YYYYMMDD-XXXX

    amount: { type: Number, required: true, min: 0.01 },
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

    isDeleted: { type: Boolean, default: false, index: true },
    deletedAt: { type: Date, default: null },
  },
  { timestamps: true }
);

// Indexes
paymentSchema.index({ organizationId: 1, paymentNumber: 1 }, { unique: true });
paymentSchema.index({ organizationId: 1, invoiceId: 1, createdAt: -1 });
paymentSchema.index({ organizationId: 1, branchId: 1, createdAt: -1 });

paymentSchema.set("toJSON", {
  transform: (doc, ret) => {
    ret.id = ret._id.toString();
    delete ret.__v;
    return ret;
  },
});

export const Payment = mongoose.model("Payment", paymentSchema);
