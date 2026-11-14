import mongoose from 'mongoose';
const { Schema } = mongoose;

// StaffDeviceMapping — Persistent mapping of provider/device employee codes to ERP staff
const staffDeviceMappingSchema = new Schema(
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
    externalEmployeeCode: {
      type: String,
    },
    staffId: {
      type: Schema.Types.ObjectId,
      ref: 'Staff',
      required: true,
    },
    mappingStatus: {
      type: String,
      enum: ['mapped', 'unmapped', 'partial', 'unknown'],
      default: 'mapped',
    },
    mappingMethod: {
      type: String,
      enum: ['code_match', 'name_match', 'phone_match', 'admin_overriden'],
      default: 'code_match',
    },
    isActive: {
      type: Boolean,
      default: true,
    },
    effectiveFrom: {
      type: Date,
      default: Date.now,
    },
    effectiveTo: {
      type: Date,
    },
    notes: {
      type: String,
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

// Active uniqueness: one active mapping per (org, branch, provider, device, externalEmployeeCode)
// This allows multiple different external codes to map to the same provider device,
// while preventing duplicate mappings of the same code to the same device.
staffDeviceMappingSchema.index(
  { organizationId: 1, branchId: 1, provider: 1, deviceId: 1, externalEmployeeCode: 1 },
  { unique: true, partialFilterExpression: { isActive: true } }
);

// Index for looking up mappings by external employee code (may have duplicates across providers)
staffDeviceMappingSchema.index({ organizationId: 1, branchId: 1, externalEmployeeCode: 1 });

// Index for staff-based lookups
staffDeviceMappingSchema.index({ organizationId: 1, staffId: 1 });

export const StaffDeviceMapping =
  mongoose.models.StaffDeviceMapping || mongoose.model('StaffDeviceMapping', staffDeviceMappingSchema);