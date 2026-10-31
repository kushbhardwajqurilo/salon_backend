import mongoose from "mongoose";

const subscriptionConsumptionChallengeSchema = new mongoose.Schema(
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
    appointmentId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Appointment",
      required: true,
      index: true,
    },
    subscriptionIds: [
      {
        type: mongoose.Schema.Types.ObjectId,
        ref: "Subscription",
        required: true,
      },
    ],
    customerId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Customer",
      required: true,
      index: true,
    },
    serviceIds: [
      {
        type: mongoose.Schema.Types.ObjectId,
        ref: "Service",
        required: true,
      },
    ],
    otpHash: {
      type: String,
      required: true,
    },
    attempts: {
      type: Number,
      default: 0,
      min: 0,
    },
    resendAvailableAt: {
      type: Date,
      required: true,
    },
    expiresAt: {
      type: Date,
      required: true,
    },
    status: {
      type: String,
      enum: ["pending", "in_redemption", "verified", "exhausted", "expired"],
      default: "pending",
      index: true,
    },
    redemptionState: {
      type: String,
      enum: ["pending", "in_redemption", "decremented", "completed", "failed", "restoring", "reconciled"],
      default: "pending",
      index: true,
    },
    redemptionOperationId: {
      type: String,
      default: null,
      index: true,
    },
    reconciliationClaimedAt: {
      type: Date,
      default: null,
      index: true,
    },
    decrements: [
      {
        operationId: { type: String, default: null },
        subscriptionId: { type: mongoose.Schema.Types.ObjectId, ref: "Subscription", required: true },
        memberCustomerId: { type: mongoose.Schema.Types.ObjectId, ref: "Customer", required: true },
        serviceId: { type: mongoose.Schema.Types.ObjectId, ref: "Service", required: true },
        quantity: { type: Number, required: true },
        appointmentServiceId: { type: mongoose.Schema.Types.ObjectId, default: null },
        decrementedAt: { type: Date, default: null },
        isDecremented: { type: Boolean, default: false },
        isRestored: { type: Boolean, default: false },
        restorationState: {
          type: String,
          enum: ["none", "restoring", "restored"],
          default: "none",
        },
        restoredAt: { type: Date, default: null },
      },
    ],
  },
  {
    timestamps: true,
  }
);

// TTL index for automatic expiry cleanup
subscriptionConsumptionChallengeSchema.index({ expiresAt: 1 }, { expireAfterSeconds: 0 });

// Active challenges lookup compound index
subscriptionConsumptionChallengeSchema.index({
  appointmentId: 1,
  status: 1,
});

export const SubscriptionConsumptionChallenge = mongoose.model(
  "SubscriptionConsumptionChallenge",
  subscriptionConsumptionChallengeSchema
);
