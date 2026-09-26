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
      enum: ["pending", "verified", "exhausted", "expired"],
      default: "pending",
      index: true,
    },
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
