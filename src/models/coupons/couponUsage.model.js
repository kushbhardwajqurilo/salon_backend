import mongoose from "mongoose";

const couponUsageSchema = new mongoose.Schema(
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
    couponId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Coupon",
      required: true,
      index: true,
    },
    invoiceId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Invoice",
      required: true,
      index: true,
    },
    customerId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Customer",
      required: true,
      index: true,
    },
    discountAmount: {
      type: Number,
      required: true,
      min: 0,
    },
    consumedAt: {
      type: Date,
      default: Date.now,
      required: true,
    },
    status: {
      type: String,
      enum: ["consumed", "reversed"],
      default: "consumed",
      required: true,
      index: true,
    },
    reversedAt: {
      type: Date,
      default: null,
    },
    reversalReason: {
      type: String,
      default: null,
      trim: true,
    },
    createdBy: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "User",
      required: true,
    },
    reversedBy: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "User",
      default: null,
    },
  },
  { timestamps: true }
);

// Guaranteed idempotency: only one active consumed usage per invoice
couponUsageSchema.index(
  { organizationId: 1, invoiceId: 1 },
  { unique: true, partialFilterExpression: { status: "consumed" } }
);

// Fast query lookup for audit and historical ledgers
couponUsageSchema.index({ organizationId: 1, couponId: 1, createdAt: -1 });
couponUsageSchema.index({ organizationId: 1, customerId: 1, couponId: 1 });

export const CouponUsage = mongoose.model("CouponUsage", couponUsageSchema);

