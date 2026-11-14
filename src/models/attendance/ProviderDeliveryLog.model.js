import mongoose from 'mongoose';
const { Schema } = mongoose;

// ProviderDeliveryLog — Delivery attempts and duplicate outcomes
// Records delivery attempts and duplicate outcomes; does not mutate original canonical punch
const providerDeliveryLogSchema = new Schema(
  {
    organizationId: {
      type: Schema.Types.ObjectId,
      ref: 'Organization',
      required: true,
      index: true,
    },
    branchId: {
      type: Schema.Types.ObjectId,
      ref: 'Branch',
      index: true,
    },
    provider: {
      type: String,
      required: true,
    },
    deviceId: {
      type: String,
    },
    externalEventId: {
      type: String,
    },
    punchType: {
      type: String,
      enum: ['in', 'out'],
    },
    punchAt: {
      type: Date,
    },
    attemptedAt: {
      type: Date,
      default: Date.now,
    },
    status: {
      type: String,
      enum: ['success', 'duplicate', 'unmapped', 'failed'],
    },
    duplicateOf: {
      type: Schema.Types.ObjectId,
      ref: 'AttendancePunch',
    },
    retryCount: {
      type: Number,
      default: 0,
    },
    error: {
      type: String,
    },
    rawPayload: {
      type: Schema.Types.Mixed,
    },
  },
  {
    timestamps: true,
  }
);

// Index for delivery tracking
providerDeliveryLogSchema.index({ organizationId: 1, provider: 1, deviceId: 1, attemptedAt: 1 });
providerDeliveryLogSchema.index({ organizationId: 1, externalEventId: 1 });

export const ProviderDeliveryLog =
  mongoose.models.ProviderDeliveryLog || mongoose.model('ProviderDeliveryLog', providerDeliveryLogSchema);