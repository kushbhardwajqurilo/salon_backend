import mongoose from "mongoose";

const { Schema } = mongoose;

const organizationSettingsSchema = new Schema(
  {
    organizationId: {
      type: Schema.Types.ObjectId,
      ref: "Organization",
      required: true,
    },
    profile: {
      displayName: { type: String, trim: true, default: null },
      email: { type: String, trim: true, lowercase: true, default: null },
      phone: { type: String, trim: true, default: null },
      address: { type: String, trim: true, default: null },
      website: { type: String, trim: true, default: null },
    },
    regional: {
      timezone: { type: String, trim: true, default: "Asia/Kolkata" },
      currency: { type: String, trim: true, uppercase: true, default: "INR" },
      locale: { type: String, trim: true, default: "en-IN" },
      dateFormat: {
        type: String,
        enum: ["YYYY-MM-DD", "DD/MM/YYYY", "MM/DD/YYYY", "DD-MM-YYYY"],
        default: "YYYY-MM-DD",
      },
      timeFormat: {
        type: String,
        enum: ["HH:mm", "hh:mm A"],
        default: "HH:mm",
      },
      firstDayOfWeek: {
        type: Number,
        min: 0,
        max: 6,
        default: 1,
      },
    },
    defaults: {
      appointmentBufferMinutes: { type: Number, min: 0, max: 240, default: 0 },
      allowWalkIns: { type: Boolean, default: true },
      allowAdvanceBookings: { type: Boolean, default: true },
      reminderDefaultOffsetMinutes: { type: Number, min: 0, max: 10080, default: 60 },
      attendanceGraceMinutes: { type: Number, min: 0, max: 180, default: 15 },
      autoMarkAbsentAfterCutoff: { type: Boolean, default: false },
      defaultWeeklyOffDays: {
        type: [Number],
        default: [0],
        validate: {
          validator: (arr) => Array.isArray(arr) && arr.every((d) => Number.isInteger(d) && d >= 0 && d <= 6),
          message: "Weekly off days must be integers between 0 (Sunday) and 6 (Saturday)",
        },
      },
      defaultHalfDayEligible: { type: Boolean, default: true },
      exportRetentionHours: { type: Number, min: 1, max: 720, default: 24 },
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

organizationSettingsSchema.index({ organizationId: 1 }, { unique: true });

export const OrganizationSettings =
  mongoose.models.OrganizationSettings ||
  mongoose.model("OrganizationSettings", organizationSettingsSchema);
