import mongoose from "mongoose";
import { auditPlugin } from "../../database/plugins/audit.js";

const entitlementSchema = new mongoose.Schema(
  {
    serviceId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Service",
      required: true,
    },
    serviceName: {
      type: String,
      required: true,
      trim: true,
    },
    totalQuantity: {
      type: Number,
      required: true,
      min: 1,
    },
    usedQuantity: {
      type: Number,
      required: true,
      default: 0,
      min: 0,
    },
    remainingQuantity: {
      type: Number,
      required: true,
      min: 0,
    },
  },
  { _id: true }
);

const subscriptionSchema = new mongoose.Schema(
  {
    organizationId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Organization",
      required: true,
      index: true,
    },
    customerId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Customer",
      required: true,
      index: true,
    },
    subscriptionCode: {
      type: String,
      required: true,
      trim: true,
    },
    planId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "SubscriptionPlan",
      default: null,
      index: true,
    },
    price: {
      type: Number,
      required: true,
      min: 0,
    },
    entitlements: {
      type: [entitlementSchema],
      required: true,
      validate: [
        (val) => Array.isArray(val) && val.length > 0,
        "Subscription must have at least one entitlement",
      ],
    },
    permittedBranchIds: [
      {
        type: mongoose.Schema.Types.ObjectId,
        ref: "Branch",
      },
    ],
    startDate: {
      type: Date,
      required: true,
    },
    endDate: {
      type: Date,
      required: true,
    },
    status: {
      type: String,
      enum: ["active", "expired", "exhausted", "cancelled"],
      default: "active",
      index: true,
    },
    notes: {
      type: String,
      default: "",
      trim: true,
    },
  },
  {
    timestamps: true,
  }
);

// Unique subscriptionCode per organization for non-deleted records
subscriptionSchema.index(
  { organizationId: 1, subscriptionCode: 1 },
  { unique: true, partialFilterExpression: { isDeleted: false } }
);

// Customer subscriptions index
subscriptionSchema.index({ organizationId: 1, customerId: 1, status: 1 });

// Expiry queries index
subscriptionSchema.index({ organizationId: 1, status: 1, endDate: 1 });

// Audit plugin provides: isDeleted, deletedAt, createdBy, updatedBy, deletedBy, softDelete(), optimisticConcurrency
subscriptionSchema.plugin(auditPlugin);

export const Subscription = mongoose.model("Subscription", subscriptionSchema);
