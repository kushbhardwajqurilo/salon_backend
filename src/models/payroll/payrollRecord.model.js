import mongoose from "mongoose";
import { auditPlugin } from "../../database/plugins/audit.js";

const { Schema } = mongoose;

const adjustmentItemSchema = new Schema(
  {
    type: {
      type: String,
      enum: ["earning", "deduction"],
      required: true,
    },
    amount: {
      type: Number,
      required: true,
      min: 0,
    },
    reason: {
      type: String,
      required: true,
      trim: true,
      minlength: 3,
    },
    reference: {
      type: String,
      trim: true,
      default: null,
    },
    createdBy: {
      type: Schema.Types.ObjectId,
      ref: "User",
      required: true,
    },
    createdAt: {
      type: Date,
      default: Date.now,
    },
  },
  { _id: true }
);

const payrollRecordSchema = new Schema(
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
    payrollPeriodId: {
      type: Schema.Types.ObjectId,
      ref: "PayrollPeriod",
      required: true,
      index: true,
    },
    staffId: {
      type: Schema.Types.ObjectId,
      ref: "Staff",
      required: true,
      index: true,
    },
    monthYear: {
      type: String, // "YYYY-MM"
      required: true,
      index: true,
    },
    status: {
      type: String,
      enum: ["draft", "pending_approval", "approved", "paid", "cancelled"],
      default: "draft",
      required: true,
      index: true,
    },
    salaryStructureSnapshot: {
      salaryStructureId: { type: Schema.Types.ObjectId, ref: "SalaryStructure" },
      payType: { type: String, required: true },
      baseSalary: { type: Number, required: true },
      hourlyRate: { type: Number, default: 0 },
      allowances: [
        {
          name: { type: String, required: true },
          amount: { type: Number, required: true },
        },
      ],
      deductions: [
        {
          name: { type: String, required: true },
          amount: { type: Number, required: true },
        },
      ],
    },
    attendanceSummarySnapshot: {
      totalDaysInMonth: { type: Number, required: true },
      eligibleDays: { type: Number, required: true },
      presentDays: { type: Number, default: 0 },
      lateDays: { type: Number, default: 0 },
      earlyDepartureDays: { type: Number, default: 0 },
      incompleteDays: { type: Number, default: 0 },
      unresolvedConflicts: { type: Number, default: 0 },
      paidLeaveDays: { type: Number, default: 0 },
      unpaidLeaveDays: { type: Number, default: 0 },
      absentDays: { type: Number, default: 0 },
      sourceAttendanceRecordIds: [{ type: Schema.Types.ObjectId, ref: "Attendance" }],
      sourceLeaveRecordIds: [{ type: Schema.Types.ObjectId, ref: "Leave" }],
    },
    calculations: {
      prorationFactor: { type: Number, required: true },
      grossBaseSalary: { type: Number, required: true },
      totalAllowances: { type: Number, required: true },
      totalGrossPay: { type: Number, required: true },
      unpaidLeaveDeduction: { type: Number, required: true },
      fixedDeductions: { type: Number, required: true },
      totalAdjustmentsEarning: { type: Number, default: 0 },
      totalAdjustmentsDeduction: { type: Number, default: 0 },
      totalDeductions: { type: Number, required: true },
      netPayable: { type: Number, required: true },
    },
    adjustments: {
      type: [adjustmentItemSchema],
      default: [],
    },
    approvalBlocked: {
      type: Boolean,
      default: false,
    },
    approvalBlockReasons: {
      type: [String],
      default: [],
    },
    approvedBy: {
      type: Schema.Types.ObjectId,
      ref: "User",
      default: null,
    },
    approvedAt: {
      type: Date,
      default: null,
    },
    paymentMethod: {
      type: String,
      enum: ["bank_transfer", "cash", "cheque", "upi"],
      default: null,
    },
    paymentReference: {
      type: String,
      trim: true,
      default: null,
    },
    disbursedAt: {
      type: Date,
      default: null,
    },
    disbursedBy: {
      type: Schema.Types.ObjectId,
      ref: "User",
      default: null,
    },
    reversedAt: {
      type: Date,
      default: null,
    },
    reversedBy: {
      type: Schema.Types.ObjectId,
      ref: "User",
      default: null,
    },
    reversalReason: {
      type: String,
      trim: true,
      default: null,
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

payrollRecordSchema.index(
  { organizationId: 1, staffId: 1, monthYear: 1 },
  {
    unique: true,
    partialFilterExpression: {
      isDeleted: false,
      status: { $in: ["draft", "pending_approval", "approved", "paid"] },
    },
  }
);

payrollRecordSchema.index({ organizationId: 1, branchId: 1, monthYear: 1 });
payrollRecordSchema.index({ organizationId: 1, payrollPeriodId: 1 });

payrollRecordSchema.plugin(auditPlugin);

export const PayrollRecord = mongoose.model(
  "PayrollRecord",
  payrollRecordSchema
);
