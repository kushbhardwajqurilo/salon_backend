import mongoose from "mongoose";

const shiftTimeSchema = new mongoose.Schema(
  {
    startTime: { type: String, required: true, trim: true }, // "HH:mm" (24h)
    endTime: { type: String, required: true, trim: true }, // "HH:mm" (24h)
  },
  { _id: false },
);

const dayScheduleSchema = new mongoose.Schema(
  {
    dayOfWeek: { type: Number, required: true, min: 0, max: 6 }, // 0 = Sunday, 1 = Monday, ..., 6 = Saturday
    isWorkingDay: { type: Boolean, default: true },
    shifts: { type: [shiftTimeSchema], default: [] },
  },
  { _id: false },
);

const dateOverrideSchema = new mongoose.Schema(
  {
    date: { type: String, required: true, trim: true }, // "YYYY-MM-DD"
    isWorkingDay: { type: Boolean, default: true },
    reason: { type: String, trim: true, default: "" },
    shifts: { type: [shiftTimeSchema], default: [] },
  },
  { _id: false },
);

const staffRosterSchema = new mongoose.Schema(
  {
    organizationId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Organization",
      required: true,
      index: true,
    },
    branchId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Branch",
      required: true,
      index: true,
    },
    staffId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Staff",
      required: true,
      index: true,
    },
    effectiveFrom: {
      type: Date,
      default: Date.now,
    },
    effectiveTo: {
      type: Date,
      default: null,
    },
    weeklySchedule: {
      type: [dayScheduleSchema],
      default: () => [
        { dayOfWeek: 0, isWorkingDay: false, shifts: [] },
        { dayOfWeek: 1, isWorkingDay: true, shifts: [{ startTime: "09:00", endTime: "20:00" }] },
        { dayOfWeek: 2, isWorkingDay: true, shifts: [{ startTime: "09:00", endTime: "20:00" }] },
        { dayOfWeek: 3, isWorkingDay: true, shifts: [{ startTime: "09:00", endTime: "20:00" }] },
        { dayOfWeek: 4, isWorkingDay: true, shifts: [{ startTime: "09:00", endTime: "20:00" }] },
        { dayOfWeek: 5, isWorkingDay: true, shifts: [{ startTime: "09:00", endTime: "20:00" }] },
        { dayOfWeek: 6, isWorkingDay: true, shifts: [{ startTime: "09:00", endTime: "20:00" }] },
      ],
    },
    overrides: {
      type: [dateOverrideSchema],
      default: [],
    },
    isActive: {
      type: Boolean,
      default: true,
      index: true,
    },
  },
  { timestamps: true },
);

// Indexes
staffRosterSchema.index(
  { organizationId: 1, staffId: 1, branchId: 1 },
  { unique: true, partialFilterExpression: { isActive: true } },
);
staffRosterSchema.index({ organizationId: 1, branchId: 1, isActive: 1 });
staffRosterSchema.index({ organizationId: 1, staffId: 1, isActive: 1 });

staffRosterSchema.set("toJSON", {
  transform: (doc, ret) => {
    ret.id = ret._id.toString();
    delete ret.__v;
    return ret;
  },
});

export const StaffRoster =
  mongoose.models.StaffRoster || mongoose.model("StaffRoster", staffRosterSchema);
