import mongoose from "mongoose";
import { auditPlugin } from "../../database/plugins/audit.js";

const subscriptionUsageSchema = new mongoose.Schema(
  {
    organizationId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Organization",
      required: true,
      index: true,
    },
    subscriptionId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Subscription",
      required: true,
      index: true,
    },
    customerId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Customer",
      required: true,
      index: true,
    },
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
    quantity: {
      type: Number,
      required: true,
      min: 1,
      default: 1,
    },
    branchId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Branch",
      required: true,
      index: true,
    },
    verifiedBy: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "User",
      required: true,
    },
    verificationMethod: {
      type: String,
      enum: ["otp", "manual"],
      default: "otp",
    },
    reason: {
      type: String,
      trim: true,
      maxlength: 1000,
      default: null,
    },
    appointmentId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Appointment",
      default: null,
    },
    appointmentServiceId: {
      type: mongoose.Schema.Types.ObjectId,
      default: null,
    },
    appointmentCode: {
      type: String,
      trim: true,
      default: null,
    },
  },
  {
    timestamps: true,
  }
);

// Compound indexes for fast historical timeline queries
subscriptionUsageSchema.index({ organizationId: 1, subscriptionId: 1, createdAt: -1 });
subscriptionUsageSchema.index({ organizationId: 1, customerId: 1, createdAt: -1 });
subscriptionUsageSchema.index({ organizationId: 1, branchId: 1, createdAt: -1 });

// Unique index enforcing that a specific appointment service line can only be redeemed once
subscriptionUsageSchema.index(
  { appointmentId: 1, appointmentServiceId: 1 },
  { unique: true, partialFilterExpression: { appointmentServiceId: { $type: "objectId" } } }
);

subscriptionUsageSchema.plugin(auditPlugin);

export const SubscriptionUsage = mongoose.model(
  "SubscriptionUsage",
  subscriptionUsageSchema
);
