import mongoose from "mongoose";

const couponCustomerUsageSchema = new mongoose.Schema(
  {
    organizationId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Organization",
      required: true,
      index: true,
    },
    couponId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Coupon",
      required: true,
      index: true,
    },
    customerId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Customer",
      required: true,
      index: true,
    },
    activeUsageCount: {
      type: Number,
      default: 0,
      min: 0,
      required: true,
    },
    historicalUsageCount: {
      type: Number,
      default: 0,
      min: 0,
      required: true,
    },
  },
  { timestamps: true }
);

// Unique compound index guarantees strictly 1 counter document per organization + coupon + customer
couponCustomerUsageSchema.index(
  { organizationId: 1, couponId: 1, customerId: 1 },
  { unique: true }
);

export const CouponCustomerUsage = mongoose.model(
  "CouponCustomerUsage",
  couponCustomerUsageSchema
);

