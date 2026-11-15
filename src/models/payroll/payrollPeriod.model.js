import mongoose from "mongoose";
import { auditPlugin } from "../../database/plugins/audit.js";

const { Schema } = mongoose;

const payrollPeriodSchema = new Schema(
  {
    organizationId: {
      type: Schema.Types.ObjectId,
      ref: "Organization",
      required: true,
      index: true,
    },
    year: {
      type: Number,
      required: true,
      min: 2000,
      max: 2100,
    },
    month: {
      type: Number,
      required: true,
      min: 1,
      max: 12,
    },
    monthYear: {
      type: String, // "YYYY-MM"
      required: true,
    },
    startDate: {
      type: Date,
      required: true,
    },
    endDate: {
      type: Date,
      required: true,
    },
    totalDays: {
      type: Number,
      required: true,
    },
    status: {
      type: String,
      enum: ["open", "processing", "closed"],
      default: "open",
      required: true,
    },
    isDeleted: {
      type: Boolean,
      default: false,
      index: true,
    },
  },
  {
    timestamps: true,
  }
);

payrollPeriodSchema.index(
  { organizationId: 1, monthYear: 1 },
  { unique: true, partialFilterExpression: { isDeleted: false } }
);

payrollPeriodSchema.plugin(auditPlugin);

export const PayrollPeriod = mongoose.model(
  "PayrollPeriod",
  payrollPeriodSchema
);
