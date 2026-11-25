import mongoose from "mongoose";

const { Schema } = mongoose;

export const CALENDAR_EVENT_TYPES = Object.freeze([
  "public_holiday",
  "org_holiday",
  "branch_holiday",
  "branch_closure",
  "special_working_day",
]);

const operatingHoursOverrideSchema = new Schema(
  {
    isOpen: { type: Boolean, default: true },
    openTime: { type: String, trim: true, default: null },
    closeTime: { type: String, trim: true, default: null },
  },
  { _id: false }
);

const holidayCalendarSchema = new Schema(
  {
    organizationId: {
      type: Schema.Types.ObjectId,
      ref: "Organization",
      required: true,
    },
    branchId: {
      type: Schema.Types.ObjectId,
      ref: "Branch",
      default: null,
    },
    date: {
      type: String,
      required: true,
      trim: true,
    },
    endDate: {
      type: String,
      trim: true,
      default: null,
    },
    eventType: {
      type: String,
      enum: CALENDAR_EVENT_TYPES,
      required: true,
    },
    name: {
      type: String,
      required: true,
      trim: true,
      maxlength: 120,
    },
    description: {
      type: String,
      trim: true,
      maxlength: 500,
      default: null,
    },
    isPaid: {
      type: Boolean,
      default: false,
    },
    isWorkingDay: {
      type: Boolean,
      required: true,
    },
    operatingHoursOverride: {
      type: operatingHoursOverrideSchema,
      default: null,
    },
    effectiveFrom: {
      type: Date,
      default: null,
    },
    effectiveTo: {
      type: Date,
      default: null,
    },
    isActive: {
      type: Boolean,
      default: true,
    },
    createdBy: {
      type: Schema.Types.ObjectId,
      ref: "User",
      default: null,
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

holidayCalendarSchema.index({ organizationId: 1, branchId: 1, date: 1, endDate: 1, isActive: 1 });
holidayCalendarSchema.index(
  { organizationId: 1, branchId: 1, date: 1, eventType: 1 },
  {
    unique: true,
    partialFilterExpression: { isActive: true },
    name: "uniq_active_holiday_calendar_entry",
  }
);

export const HolidayCalendar =
  mongoose.models.HolidayCalendar ||
  mongoose.model("HolidayCalendar", holidayCalendarSchema);
