import mongoose from 'mongoose';
const { Schema } = mongoose;

const attendancePunchSchema = new Schema({
  organizationId: { type: Schema.Types.ObjectId, ref: 'Organization', required: true, index: true },
  branchId: { type: Schema.Types.ObjectId, ref: 'Branch', required: true, index: true },
  staffId: { type: Schema.Types.ObjectId, ref: 'Staff', required: true, index: true },
  punchType: { type: String, enum: ['in', 'out'], required: true },
  punchAt: { type: Date, required: true, index: true },
  provider: { type: String, required: true },
  externalEventId: {
    type: String,
    set: (value) => typeof value === 'string' ? value.trim() || undefined : undefined,
  },
  isDuplicate: { type: Boolean, default: false },
  mappingStatus: { type: String, enum: ['mapped', 'unmapped', 'partial', 'unknown'], default: 'mapped' },
  rawEvent: { type: Schema.Types.Mixed },
  deviceId: { type: String },
  deviceSource: { type: String },
  rawPayload: { type: Schema.Types.Mixed },
  processed: { type: Boolean, default: false },
  processingNote: { type: String, default: null },
  isDeleted: { type: Boolean, default: false },
  deletedAt: { type: Date, default: null },
});

attendancePunchSchema.index(
  { organizationId: 1, provider: 1, deviceId: 1, externalEventId: 1 },
  { unique: true, partialFilterExpression: { isDeleted: false, externalEventId: { $type: 'string' } } }
);

attendancePunchSchema.index({ organizationId: 1, staffId: 1, punchAt: 1 });
attendancePunchSchema.index({ organizationId: 1, provider: 1, punchAt: 1 });

export const AttendancePunch =
  mongoose.models.AttendancePunch || mongoose.model('AttendancePunch', attendancePunchSchema);