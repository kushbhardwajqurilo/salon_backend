import mongoose from "mongoose";

const loyaltyProgramConfigSchema = new mongoose.Schema(
  {
    organizationId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Organization",
      required: true,
      unique: true,
      index: true,
    },
    isEnabled: {
      type: Boolean,
      default: false,
      required: true,
    },
    // Earning: points awarded per earnThresholdAmount of eligible spend
    // Default: 1 point per ₹100
    earnPointsPerUnit: {
      type: Number,
      default: 1,
      min: 0,
      required: true,
    },
    earnThresholdAmount: {
      type: Number,
      default: 100,
      min: 1,
      required: true,
    },
    // Redemption: currency value in ₹ per point redeemed (default: ₹1.00)
    redemptionRate: {
      type: Number,
      default: 1,
      min: 0.01,
      required: true,
    },
    // Minimum points required to perform any redemption (default: 20 points)
    minRedemptionPoints: {
      type: Number,
      default: 20,
      min: 1,
      required: true,
    },
    // Maximum redemption discount percentage of eligible bill value (default: 20%)
    maxRedemptionPercentage: {
      type: Number,
      default: 20,
      min: 1,
      max: 100,
      required: true,
    },
    updatedBy: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "User",
      default: null,
    },
  },
  {
    timestamps: true,
  }
);

loyaltyProgramConfigSchema.set("toJSON", {
  transform: (doc, ret) => {
    ret.id = ret._id.toString();
    delete ret.__v;
    return ret;
  },
});

export const LoyaltyProgramConfig = mongoose.model(
  "LoyaltyProgramConfig",
  loyaltyProgramConfigSchema
);
