import mongoose from "mongoose";
import { auditPlugin } from "../../database/plugins/audit.js";

const { Schema } = mongoose;
const MAX_SAFE_PAISE = Number.MAX_SAFE_INTEGER;

const allocationHistorySchema = new Schema(
  {
    action: {
      type: String,
      enum: ["approved", "paid", "released"],
      required: true,
    },
    actorId: {
      type: Schema.Types.ObjectId,
      ref: "User",
      required: true,
    },
    occurredAt: {
      type: Date,
      required: true,
    },
    payrollRecordId: {
      type: Schema.Types.ObjectId,
      ref: "PayrollRecord",
      required: true,
    },
  },
  { _id: false },
);

const payrollIncentiveAllocationSchema = new Schema(
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
    sourceBranchId: {
      type: Schema.Types.ObjectId,
      ref: "Branch",
      required: true,
      index: true,
    },
    payrollBranchId: {
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
    payrollRecordId: {
      type: Schema.Types.ObjectId,
      ref: "PayrollRecord",
      required: true,
      index: true,
    },
    incentiveLedgerId: {
      type: Schema.Types.ObjectId,
      ref: "IncentiveLedger",
      required: true,
      index: true,
    },
    sourceType: {
      type: String,
      required: true,
      enum: [
        "service_commission",
        "subscription_sale_commission",
        "membership_sale_commission",
        "retail_sale_commission",
      ],
    },
    sourceAmountInPaise: {
      type: Number,
      required: true,
      min: 0,
      max: MAX_SAFE_PAISE,
      validate: { validator: Number.isSafeInteger },
    },
    reversedAmountInPaise: {
      type: Number,
      required: true,
      min: 0,
      max: MAX_SAFE_PAISE,
      validate: { validator: Number.isSafeInteger },
    },
    payableAmountInPaise: {
      type: Number,
      required: true,
      min: 1,
      max: MAX_SAFE_PAISE,
      validate: { validator: Number.isSafeInteger },
    },
    coveredClawbackLedgerIds: [{
      type: Schema.Types.ObjectId,
      ref: "IncentiveLedger",
    }],
    status: {
      type: String,
      required: true,
      enum: ["approved", "paid", "released"],
      default: "approved",
      index: true,
    },
    paymentId: {
      type: Schema.Types.ObjectId,
      ref: "PayrollPayment",
      default: null,
    },
    recoveredInPaise: {
      type: Number,
      default: 0,
      min: 0,
      max: MAX_SAFE_PAISE,
      validate: { validator: Number.isSafeInteger },
    },
    reservedRecoveryInPaise: {
      type: Number,
      default: 0,
      min: 0,
      max: MAX_SAFE_PAISE,
      validate: { validator: Number.isSafeInteger },
    },
    history: {
      type: [allocationHistorySchema],
      default: [],
    },
  },
  { timestamps: true },
);

payrollIncentiveAllocationSchema.index(
  { organizationId: 1, incentiveLedgerId: 1 },
  { unique: true },
);
payrollIncentiveAllocationSchema.index({
  organizationId: 1,
  payrollRecordId: 1,
  status: 1,
});
payrollIncentiveAllocationSchema.plugin(auditPlugin);

export const PayrollIncentiveAllocation =
  mongoose.models.PayrollIncentiveAllocation ||
  mongoose.model("PayrollIncentiveAllocation", payrollIncentiveAllocationSchema);
