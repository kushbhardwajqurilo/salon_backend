import mongoose from "mongoose";

const { Schema } = mongoose;

const breakWindowSchema = new Schema(
  {
    startTime: { type: String, required: true, trim: true },
    endTime: { type: String, required: true, trim: true },
    label: { type: String, trim: true, default: "Break" },
  },
  { _id: false }
);

const branchSettingsSchema = new Schema(
  {
    organizationId: {
      type: Schema.Types.ObjectId,
      ref: "Organization",
      required: true,
    },
    branchId: {
      type: Schema.Types.ObjectId,
      ref: "Branch",
      required: true,
    },
    breakWindows: {
      type: Map,
      of: [breakWindowSchema],
      default: {},
    },
    weeklyOffDays: {
      type: [Number],
      default: null,
      validate: {
        validator: (arr) =>
          arr === null ||
          (Array.isArray(arr) && arr.every((d) => Number.isInteger(d) && d >= 0 && d <= 6)),
        message: "Weekly off days must be null or integers between 0 and 6",
      },
    },
    appointmentOverrides: {
      bufferMinutes: { type: Number, min: 0, max: 240, default: null },
      allowWalkIns: { type: Boolean, default: null },
      allowAdvanceBookings: { type: Boolean, default: null },
      reminderDefaultOffsetMinutes: { type: Number, min: 0, max: 10080, default: null },
    },
    attendanceOverrides: {
      graceMinutes: { type: Number, min: 0, max: 180, default: null },
      autoMarkAbsentAfterCutoff: { type: Boolean, default: null },
    },
    leaveOverrides: {
      allowHalfDay: { type: Boolean, default: null },
      allowBranchPolicyOverrides: { type: Boolean, default: null },
    },
    updatedBy: {
      type: Schema.Types.ObjectId,
      ref: "User",
      default: null,
    },
  },
  {
    timestamps: true,
  }
);

branchSettingsSchema.index({ organizationId: 1, branchId: 1 }, { unique: true });

export const BranchSettings =
  mongoose.models.BranchSettings ||
  mongoose.model("BranchSettings", branchSettingsSchema);
