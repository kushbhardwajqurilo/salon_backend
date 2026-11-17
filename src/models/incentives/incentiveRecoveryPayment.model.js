import mongoose from "mongoose";
import { auditPlugin } from "../../database/plugins/audit.js";

const { Schema } = mongoose;
const MAX_SAFE_PAISE = Number.MAX_SAFE_INTEGER;

const recoveryPaymentHistorySchema = new Schema(
  {
    action: {
      type: String,
      enum: ["recorded", "confirmed", "failed", "reversed"],
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
    reason: {
      type: String,
      trim: true,
      default: null,
    },
  },
  { _id: false },
);

const incentiveRecoveryPaymentSchema = new Schema(
  {
    organizationId: {
      type: Schema.Types.ObjectId,
      ref: "Organization",
      required: true,
      index: true,
      immutable: true,
    },
    branchId: {
      type: Schema.Types.ObjectId,
      ref: "Branch",
      required: true,
      index: true,
      immutable: true,
    },
    staffId: {
      type: Schema.Types.ObjectId,
      ref: "Staff",
      required: true,
      index: true,
      immutable: true,
    },
    obligationId: {
      type: Schema.Types.ObjectId,
      ref: "IncentiveRecoveryObligation",
      required: true,
      index: true,
      immutable: true,
    },
    clawbackLedgerId: {
      type: Schema.Types.ObjectId,
      ref: "IncentiveLedger",
      required: true,
      immutable: true,
    },
    sourceLedgerId: {
      type: Schema.Types.ObjectId,
      ref: "IncentiveLedger",
      required: true,
      immutable: true,
    },
    payrollAllocationId: {
      type: Schema.Types.ObjectId,
      ref: "PayrollIncentiveAllocation",
      required: true,
      immutable: true,
    },
    amountInPaise: {
      type: Number,
      required: true,
      min: 1,
      max: MAX_SAFE_PAISE,
      immutable: true,
      validate: { validator: Number.isSafeInteger },
    },
    paymentMethod: {
      type: String,
      enum: ["bank_transfer", "cash", "cheque", "upi"],
      required: true,
      immutable: true,
    },
    paymentReference: {
      type: String,
      required: true,
      trim: true,
      minlength: 1,
      immutable: true,
    },
    paymentDate: {
      type: Date,
      required: true,
      immutable: true,
    },
    reason: {
      type: String,
      required: true,
      trim: true,
      minlength: 3,
      immutable: true,
    },
    idempotencyKey: {
      type: String,
      required: true,
      trim: true,
      immutable: true,
    },
    requestPayloadHash: {
      type: String,
      required: true,
      immutable: true,
    },
    status: {
      type: String,
      enum: ["recorded", "confirmed", "failed", "reversed"],
      default: "recorded",
      required: true,
      index: true,
    },
    recordedBy: {
      type: Schema.Types.ObjectId,
      ref: "User",
      required: true,
      immutable: true,
    },
    recordedAt: {
      type: Date,
      required: true,
      immutable: true,
    },
    confirmedBy: {
      type: Schema.Types.ObjectId,
      ref: "User",
      default: null,
    },
    confirmedAt: {
      type: Date,
      default: null,
    },
    failedBy: {
      type: Schema.Types.ObjectId,
      ref: "User",
      default: null,
    },
    failedAt: {
      type: Date,
      default: null,
    },
    failureReason: {
      type: String,
      trim: true,
      default: null,
    },
    reversedBy: {
      type: Schema.Types.ObjectId,
      ref: "User",
      default: null,
    },
    reversedAt: {
      type: Date,
      default: null,
    },
    reversalReason: {
      type: String,
      trim: true,
      default: null,
    },
    history: {
      type: [recoveryPaymentHistorySchema],
      default: [],
    },
  },
  { timestamps: true },
);

incentiveRecoveryPaymentSchema.index(
  { organizationId: 1, idempotencyKey: 1 },
  { unique: true },
);
incentiveRecoveryPaymentSchema.index({
  organizationId: 1,
  obligationId: 1,
  createdAt: -1,
});
incentiveRecoveryPaymentSchema.plugin(auditPlugin);

export const IncentiveRecoveryPayment =
  mongoose.models.IncentiveRecoveryPayment ||
  mongoose.model("IncentiveRecoveryPayment", incentiveRecoveryPaymentSchema);
