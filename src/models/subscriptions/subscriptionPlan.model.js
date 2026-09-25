import mongoose from "mongoose";
import { auditPlugin } from "../../database/plugins/audit.js";

const planEntitlementSchema = new mongoose.Schema(
  {
    serviceId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Service",
      required: true,
    },
    quantity: {
      type: Number,
      required: true,
      min: 1,
    },
  },
  { _id: false }
);

const subscriptionPlanSchema = new mongoose.Schema(
  {
    organizationId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Organization",
      required: true,
      index: true,
    },
    name: {
      type: String,
      required: true,
      trim: true,
    },
    code: {
      type: String,
      trim: true,
      default: null,
    },
    description: {
      type: String,
      trim: true,
      default: "",
    },
    suggestedPrice: {
      type: Number,
      required: true,
      min: 0,
    },
    validityMonths: {
      type: Number,
      required: true,
      min: 1,
    },
    entitlements: {
      type: [planEntitlementSchema],
      required: true,
      validate: [
        (val) => Array.isArray(val) && val.length > 0,
        "Subscription plan must contain at least one service entitlement",
      ],
    },
    permittedBranchIds: [
      {
        type: mongoose.Schema.Types.ObjectId,
        ref: "Branch",
      },
    ],
    isActive: {
      type: Boolean,
      default: true,
      index: true,
    },
  },
  {
    timestamps: true,
  }
);

// Unique code per organization when code is provided (sparse partial index)
subscriptionPlanSchema.index(
  { organizationId: 1, code: 1 },
  {
    unique: true,
    partialFilterExpression: { code: { $type: "string" }, isDeleted: false },
  }
);

// Fast lookups by org and active status
subscriptionPlanSchema.index({ organizationId: 1, isActive: 1 });

subscriptionPlanSchema.plugin(auditPlugin);

export const SubscriptionPlan = mongoose.model(
  "SubscriptionPlan",
  subscriptionPlanSchema
);
