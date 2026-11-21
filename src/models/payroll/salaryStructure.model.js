import mongoose from "mongoose";
import { auditPlugin } from "../../database/plugins/audit.js";

const { Schema } = mongoose;

const allowanceItemSchema = new Schema(
  {
    name: {
      type: String,
      required: true,
      trim: true,
    },
    amount: {
      type: Number,
      required: true,
      min: 0,
    },
  },
  { _id: false }
);

const deductionItemSchema = new Schema(
  {
    name: {
      type: String,
      required: true,
      trim: true,
    },
    amount: {
      type: Number,
      required: true,
      min: 0,
    },
  },
  { _id: false }
);

const salaryStructureSchema = new Schema(
  {
    organizationId: {
      type: Schema.Types.ObjectId,
      ref: "Organization",
      required: true,
      index: true,
    },
    staffId: {
      type: Schema.Types.ObjectId,
      ref: "Staff",
      required: true,
      index: true,
    },
    payType: {
      type: String,
      enum: ["fixed_monthly", "hourly"],
      default: "fixed_monthly",
      required: true,
    },
    baseSalary: {
      type: Number,
      required: true,
      min: 0,
    },
    hourlyRate: {
      type: Number,
      default: 0,
      min: 0,
    },
    paidLeavePolicy: {
      annualEntitlement: {
        type: Number,
        required: true,
        min: 0,
        max: 365,
        default: 0,
      },
      carryForwardDays: {
        type: Number,
        min: 0,
        max: 365,
        default: 0,
      },
    },
    allowances: {
      type: [allowanceItemSchema],
      default: [],
    },
    deductions: {
      type: [deductionItemSchema],
      default: [],
    },
    effectiveFrom: {
      type: Date,
      required: true,
    },
    effectiveTo: {
      type: Date,
      default: null,
    },
    isActive: {
      type: Boolean,
      default: true,
      index: true,
    },
    isDeleted: {
      type: Boolean,
      default: false,
      index: true,
    },
    deletedAt: {
      type: Date,
      default: null,
    },
  },
  {
    timestamps: true,
  }
);

salaryStructureSchema.index(
  { organizationId: 1, staffId: 1, effectiveFrom: -1, isDeleted: 1 }
);

salaryStructureSchema.plugin(auditPlugin);

export const SalaryStructure = mongoose.model(
  "SalaryStructure",
  salaryStructureSchema
);
