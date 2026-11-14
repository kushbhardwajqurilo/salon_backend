import mongoose from 'mongoose';
const { Schema } = mongoose;

// AttendanceLeaveAppointmentConflict — Appointment-versus-leave conflict lifecycle
const attendanceLeaveAppointmentConflictSchema = new Schema(
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
    conflictAppointmentId: {
      type: Schema.Types.ObjectId,
      ref: 'Appointment',
      required: true,
    },
    status: {
      type: String,
      enum: ['pending', 'resolved'],
      default: 'pending',
    },
    resolution: {
      type: String,
      enum: ['retain', 'reassign', 'cancel'],
    },
    resolvedBy: {
      type: Schema.Types.ObjectId,
      ref: 'Staff',
    },
    resolvedAt: {
      type: Date,
    },
    reason: {
      type: String,
    },
    isActive: {
      type: Boolean,
      default: true,
    },
  },
  {
    timestamps: true,
  }
);

// Prevent duplicate active conflicts for same leave/appointment pair
attendanceLeaveAppointmentConflictSchema.index(
  { organizationId: 1, leaveId: 1, conflictAppointmentId: 1 },
  { unique: true, partialFilterExpression: { status: 'pending', isActive: true } }
);

// Index for appointment-based queries
attendanceLeaveAppointmentConflictSchema.index({ conflictAppointmentId: 1, status: 1 });

export const AttendanceLeaveAppointmentConflict =
  mongoose.models.AttendanceLeaveAppointmentConflict ||
  mongoose.model('AttendanceLeaveAppointmentConflict', attendanceLeaveAppointmentConflictSchema);

// Cross-branch punch conflict — separate from leave-versus-appointment conflicts
// Tracks conflicts when punches from different branches claim the same (org, staff, date)
// Preserves original punch evidence and provides an auditable resolution path
const attendanceBranchConflictSchema = new Schema(
  {
    organizationId: {
      type: Schema.Types.ObjectId,
      ref: 'Organization',
      required: true,
      index: true,
    },
    staffId: {
      type: Schema.Types.ObjectId,
      ref: 'Staff',
      required: true,
    },
    date: {
      type: Date,
      required: true,
    },
    branchesInvolved: [
      new Schema(
        {
        branchId: {
          type: Schema.Types.ObjectId,
          ref: 'Branch',
        },
        punchCount: {
          type: Number,
          default: 1,
        },
        firstPunchAt: {
          type: Date,
        },
        lastPunchAt: {
          type: Date,
        },
        },
        { _id: false }
      ),
    ],
    primaryBranchId: {
      type: Schema.Types.ObjectId,
      ref: 'Branch',
    },
    conflictStatus: {
      type: String,
      enum: ['pending', 'resolved', 'disputed'],
      default: 'pending',
    },
    resolution: {
      type: String,
      enum: ['retain', 'reassign', 'cancel'],
    },
    resolvedBy: {
      type: Schema.Types.ObjectId,
      ref: 'Staff',
    },
    resolvedAt: {
      type: Date,
    },
    reason: {
      type: String,
    },
    evidence: {
      type: Schema.Types.Mixed,
      default: null,
    },
    isActive: {
      type: Boolean,
      default: true,
    },
  },
  {
    timestamps: true,
  }
);

// Prevent duplicate active conflicts for same organization/staff/date (pending only)
// Partial unique index: one pending conflict per (org, staff, date);
// inactive/resolved conflicts are allowed separately
attendanceBranchConflictSchema.index(
  { organizationId: 1, staffId: 1, date: 1 },
  { 
    unique: true, 
    partialFilterExpression: { conflictStatus: 'pending' } 
  }
);

// Index for staff-based queries
attendanceBranchConflictSchema.index({ staffId: 1, conflictStatus: 1 });

export const AttendanceBranchConflict =
  mongoose.models.AttendanceBranchConflict || mongoose.model('AttendanceBranchConflict', attendanceBranchConflictSchema);