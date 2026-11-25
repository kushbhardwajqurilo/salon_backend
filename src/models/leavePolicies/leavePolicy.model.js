import mongoose from "mongoose";

const { Schema } = mongoose;

const leavePolicySchema = new Schema(
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
    code: {
      type: String,
      required: true,
      trim: true,
      uppercase: true,
      maxlength: 40,
    },
    name: {
      type: String,
      required: true,
      trim: true,
      maxlength: 100,
    },
    description: {
      type: String,
      trim: true,
      maxlength: 500,
      default: null,
    },
    isPaid: {
      type: Boolean,
      required: true,
      default: true,
    },
    annualEntitlement: {
      type: Number,
      required: true,
      min: 0,
      max: 365,
      default: 0,
    },
    carryForwardLimit: {
      type: Number,
      min: 0,
      max: 365,
      default: 0,
    },
    allowHalfDay: {
      type: Boolean,
      default: true,
    },
    maxConsecutiveDays: {
      type: Number,
      min: 1,
      max: 365,
      default: null,
    },
    excludeHolidays: {
      type: Boolean,
      default: true,
    },
    excludeWeeklyOffs: {
      type: Boolean,
      default: true,
    },
    excessBehavior: {
      type: String,
      enum: ["convert_to_unpaid", "reject"],
      default: "reject",
    },
    allowNegativeBalance: {
      type: Boolean,
      default: false,
    },
    negativeBalancePayrollTreatment: {
      type: String,
      enum: ["unpaid_deduction", "carry_forward_debt", "none"],
      default: "unpaid_deduction",
    },
    effectiveFrom: {
      type: Date,
      default: Date.now,
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

leavePolicySchema.index({ organizationId: 1, branchId: 1, isActive: 1 });
leavePolicySchema.index(
  { organizationId: 1, branchId: 1, code: 1 },
  {
    unique: true,
    partialFilterExpression: { isActive: true },
    name: "uniq_active_leave_policy_code",
  }
);

export const LeavePolicy =
  mongoose.models.LeavePolicy || mongoose.model("LeavePolicy", leavePolicySchema);
