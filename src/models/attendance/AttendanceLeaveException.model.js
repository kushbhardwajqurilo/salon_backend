import mongoose from 'mongoose';
const { Schema } = mongoose;

// AttendanceLeaveException — Date-level exception without modifying Leave record
const attendanceLeaveExceptionSchema = new Schema(
  {
    organizationId: {
      type: Schema.Types.ObjectId,
      ref: 'Organization',
      required: true,
      index: true,
    },
    leaveId: {
      type: Schema.Types.ObjectId,
      ref: 'Leave',
      required: true,
    },
    resolvedDate: {
      type: String, // YYYY-MM-DD
      required: true,
    },
    decision: {
      type: String,
      enum: ['worked', 'absent', 'half-day'],
    },
    reason: {
      type: String,
    },
    isActive: {
      type: Boolean,
      default: true,
    },
    resolvedBy: {
      type: Schema.Types.ObjectId,
      ref: 'Staff',
    },
    resolvedAt: {
      type: Date,
    },
  },
  {
    timestamps: true,
  }
);

// Only one active exception per (org, leave, date)
attendanceLeaveExceptionSchema.index(
  { organizationId: 1, leaveId: 1, resolvedDate: 1 },
  { unique: true, partialFilterExpression: { isActive: true } }
);

// Index for date-based queries
attendanceLeaveExceptionSchema.index({ organizationId: 1, resolvedDate: 1 });

export const AttendanceLeaveException =
  mongoose.models.AttendanceLeaveException || mongoose.model('AttendanceLeaveException', attendanceLeaveExceptionSchema);