import mongoose from 'mongoose';
const { Schema } = mongoose;

// ProviderConfiguration — Organization-scoped provider credentials and settings
// Credentials encrypted at rest; never exposed to frontend
const providerConfigurationSchema = new Schema(
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
      required: true,
    },
    providerName: {
      type: String,
      required: true,
    },
    endpointUrl: {
      type: String,
    },
    integrationMethod: {
      type: String,
      enum: ['webhook', 'polling', 'file'],
    },
    isActive: {
      type: Boolean,
      default: true,
    },
    credentials: {
      type: Schema.Types.Mixed,
    },
    headers: {
      type: Schema.Types.Mixed,
      default: {},
    },
    deviceMappings: {
      type: Schema.Types.Mixed,
      default: {},
    },
    lastSync: {
      type: Date,
    },
    syncStatus: {
      type: String,
      enum: ['idle', 'syncing', 'error', 'paused'],
      default: 'idle',
    },
    errorMessage: {
      type: String,
    },
    lastErrorAt: {
      type: Date,
    },
    createdBy: {
      type: Schema.Types.ObjectId,
      ref: 'Staff',
    },
    createdAt: {
      type: Date,
      default: Date.now,
    },
    updatedBy: {
      type: Schema.Types.ObjectId,
      ref: 'Staff',
    },
    updatedAt: {
      type: Date,
      default: Date.now,
    },
  },
  {
    timestamps: true,
  }
);

// Organization-scoped provider — providerName not globally unique across orgs
providerConfigurationSchema.index({ organizationId: 1, providerName: 1 });

export const ProviderConfiguration =
  mongoose.models.ProviderConfiguration || mongoose.model('ProviderConfiguration', providerConfigurationSchema);