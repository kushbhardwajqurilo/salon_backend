import mongoose from 'mongoose';
const { Schema } = mongoose;

// ProviderSyncState — Provider/device/stream checkpoint tracking
const providerSyncStateSchema = new Schema(
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
    streamIdentifier: {
      type: String,
      enum: ['daily', 'realtime', 'manual_import'],
      required: true,
    },
    lastSuccessfulCheckpoint: {
      type: String,
    },
    outcome: {
      type: String,
      enum: ['processing', 'completed', 'partial', 'failed'],
      default: 'processing',
    },
    eventCount: {
      type: Number,
      default: 0,
    },
    processedCount: {
      type: Number,
      default: 0,
    },
    syncStatus: {
      type: String,
      enum: ['idle', 'syncing', 'error', 'paused'],
      default: 'idle',
    },
    retryCount: {
      type: Number,
      default: 0,
    },
    lastError: {
      type: String,
    },
    lastSuccessfulAt: {
      type: Date,
    },
    lastAttemptedAt: {
      type: Date,
    },
  },
  {
    timestamps: true,
  }
);

// Unique index per (org, provider, device, stream)
providerSyncStateSchema.index(
  { organizationId: 1, provider: 1, deviceId: 1, streamIdentifier: 1 },
  { unique: true }
);

export const ProviderSyncState =
  mongoose.models.ProviderSyncState || mongoose.model('ProviderSyncState', providerSyncStateSchema);