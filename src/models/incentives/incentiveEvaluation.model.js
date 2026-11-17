import mongoose from "mongoose";
import { auditPlugin } from "../../database/plugins/audit.js";

const { Schema } = mongoose;

const MAX_SAFE_PAISE = 10_000_000_000_000; // 10^13 paise
const attendanceDaySchema = new Schema(
  {
    date: { type: String, required: true },
    status: { type: String, required: true },
    creditedDays: { type: Number, required: true, min: 0, max: 1 },
    attendanceRecordId: { type: Schema.Types.ObjectId, ref: "Attendance", default: null },
    punchIds: [{ type: Schema.Types.ObjectId, ref: "AttendancePunch" }],
    leaveIds: [{ type: Schema.Types.ObjectId, ref: "Leave" }],
    leaveExceptionIds: [{ type: Schema.Types.ObjectId, ref: "AttendanceLeaveException" }],
  },
  { _id: false }
);

/**
 * IncentiveEvaluation Schema
 * Stores monthly target and attendance bonus achievement evaluations per staff member.
 */
const incentiveEvaluationSchema = new Schema(
  {
    organizationId: {
      type: Schema.Types.ObjectId,
      ref: "Organization",
      required: true,
      index: true,
    },
    branchId: {
      type: Schema.Types.ObjectId,
      ref: "Branch",
      required: true,
      index: true,
    },
    staffId: {
      type: Schema.Types.ObjectId,
      ref: "Staff",
      required: true,
      index: true,
    },
    schemeId: {
      type: Schema.Types.ObjectId,
      ref: "IncentiveScheme",
      required: true,
      index: true,
    },
    monthYear: {
      type: String,
      required: true,
      match: [/^\d{4}-(0[1-9]|1[0-2])$/, "monthYear must be in YYYY-MM format"],
    },
    evaluationType: {
      type: String,
      required: true,
      enum: ["TARGET_BONUS", "ATTENDANCE_BONUS"],
    },
    targetPaise: {
      type: Number,
      default: 0,
      min: [0, "targetPaise cannot be negative"],
      max: [MAX_SAFE_PAISE, "targetPaise exceeds safe limit"],
      validate: {
        validator: Number.isInteger,
        message: "{VALUE} is not an integer paise value",
      },
    },
    achievedPaise: {
      type: Number,
      default: 0,
      min: [0, "achievedPaise cannot be negative"],
      max: [MAX_SAFE_PAISE, "achievedPaise exceeds safe limit"],
      validate: {
        validator: Number.isInteger,
        message: "{VALUE} is not an integer paise value",
      },
    },
    targetDays: {
      type: Number,
      default: 0,
      min: 0,
    },
    achievedDays: {
      type: Number,
      default: 0,
      min: 0,
    },
    attendanceSnapshot: {
      timezone: { type: String, default: null },
      sourceAttendanceRecordIds: [{ type: Schema.Types.ObjectId, ref: "Attendance" }],
      sourcePunchIds: [{ type: Schema.Types.ObjectId, ref: "AttendancePunch" }],
      sourceLeaveRecordIds: [{ type: Schema.Types.ObjectId, ref: "Leave" }],
      sourceLeaveExceptionIds: [{ type: Schema.Types.ObjectId, ref: "AttendanceLeaveException" }],
      days: { type: [attendanceDaySchema], default: [] },
    },
    blockReasons: {
      type: [String],
      default: [],
    },
    isTargetMet: {
      type: Boolean,
      required: true,
      default: false,
    },
    finalizedBy: {
      type: Schema.Types.ObjectId,
      ref: "User",
      default: null,
    },
    finalizedAt: {
      type: Date,
      default: null,
    },
    bonusAwardedInPaise: {
      type: Number,
      default: 0,
      min: [0, "bonusAwardedInPaise cannot be negative"],
      max: [MAX_SAFE_PAISE, "bonusAwardedInPaise exceeds safe limit"],
      validate: {
        validator: Number.isInteger,
        message: "{VALUE} is not an integer paise value",
      },
    },
    status: {
      type: String,
      required: true,
      enum: ["computed", "overridden", "finalized"],
      default: "computed",
      index: true,
    },
  },
  {
    timestamps: true,
  }
);

// Compound Unique Index: Exactly one evaluation per staff per scheme per monthYear
incentiveEvaluationSchema.index(
  { organizationId: 1, staffId: 1, schemeId: 1, monthYear: 1 },
  { unique: true }
);

incentiveEvaluationSchema.plugin(auditPlugin);

export const IncentiveEvaluation = mongoose.model(
  "IncentiveEvaluation",
  incentiveEvaluationSchema
);
