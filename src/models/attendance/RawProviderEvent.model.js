import mongoose from 'mongoose';
const { Schema } = mongoose;

// RawProviderEvent — Raw provider payload preservation
// Unmapped/ambiguous events retained here; never auto-create AttendancePunch
const rawProviderEventSchema = new Schema(
  {
    organizationId: {
      type: Schema.Types.ObjectId,
      ref: 'Organization',
      required: true,
      index: true,
    },
    provider: {
      type: String,
      required: true,
    },
    deviceId: {
      type: String,
      required: true,
    },
    externalEventId: {
      type: String,
      set: (value) => typeof value === 'string' ? value.trim() || undefined : undefined,
    },
    rawPayload: {
      type: Schema.Types.Mixed,
    },
    mappingStatus: {
      type: String,
      enum: ['mapped', 'unmapped', 'partial', 'unknown'],
      default: 'unmapped',
    },
    isDeleted: {
      type: Boolean,
      default: false,
    },
    createdAt: {
      type: Date,
      default: Date.now,
    },
  },
  {
    timestamps: true,
  }
);

// Partial unique index for stable event IDs within org (org, provider, device, externalEventId)
// Ensures events with stable, non-empty external IDs are deduplicated.
// Events without stable IDs (missing or empty externalEventId) are retained without timestamp-based dedup.
// Filter uses one valid externalEventId expression; $ne is not used in partialFilterExpression.
rawProviderEventSchema.index(
  { organizationId: 1, provider: 1, deviceId: 1, externalEventId: 1 },
  { unique: true, partialFilterExpression: { isDeleted: false, externalEventId: { $type: 'string' } } }
);

// Index for device-based queries
rawProviderEventSchema.index({ organizationId: 1, provider: 1, deviceId: 1 });

export const RawProviderEvent =
  mongoose.models.RawProviderEvent || mongoose.model('RawProviderEvent', rawProviderEventSchema);