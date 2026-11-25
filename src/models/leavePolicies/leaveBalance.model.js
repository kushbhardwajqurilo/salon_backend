import mongoose from "mongoose";

const { Schema } = mongoose;

const leaveBalanceSchema = new Schema(
  {
    organizationId: {
      type: Schema.Types.ObjectId,
      ref: "Organization",
      required: true,
    },
    staffId: {
      type: Schema.Types.ObjectId,
      ref: "Staff",
      required: true,
    },
    leavePolicyId: {
      type: Schema.Types.ObjectId,
      ref: "LeavePolicy",
      required: true,
    },
    periodYear: {
      type: Number,
      required: true,
    },
    openingBalance: {
      type: Number,
      default: 0,
    },
    credits: {
      type: Number,
      default: 0,
      min: 0,
    },
    debits: {
      type: Number,
      default: 0,
      min: 0,
    },
    adjustments: {
      type: Number,
      default: 0,
    },
    availableBalance: {
      type: Number,
      default: 0,
    },
  },
  {
    timestamps: true,
  }
);

leaveBalanceSchema.index(
  { organizationId: 1, staffId: 1, leavePolicyId: 1, periodYear: 1 },
  { unique: true, name: "uniq_staff_policy_year_balance" }
);

export const LeaveBalance =
  mongoose.models.LeaveBalance || mongoose.model("LeaveBalance", leaveBalanceSchema);
