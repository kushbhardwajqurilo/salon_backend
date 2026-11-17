import mongoose from "mongoose";
import { auditPlugin } from "../../database/plugins/audit.js";

const { Schema } = mongoose;
const MAX_SAFE_PAISE = Number.MAX_SAFE_INTEGER;

const paymentHistorySchema = new Schema(
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

const payrollPaymentSchema = new Schema(
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
    payrollRecordId: {
      type: Schema.Types.ObjectId,
      ref: "PayrollRecord",
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
    source: {
      type: String,
      enum: ["MANUAL", "BANK_API", "PAYMENT_GATEWAY", "IMPORT"],
      required: true,
      default: "MANUAL",
      immutable: true,
    },
    amountInPaise: {
      type: Number,
      required: true,
      min: 1,
      max: MAX_SAFE_PAISE,
      immutable: true,
      validate: {
        validator: Number.isSafeInteger,
        message: "{VALUE} is not a safe integer paise amount",
      },
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
      immutable: true,
      trim: true,
      minlength: 1,
    },
    paymentDate: {
      type: Date,
      required: true,
      immutable: true,
    },
    status: {
      type: String,
      enum: ["recorded", "confirmed", "failed", "reversed"],
      required: true,
      default: "recorded",
      index: true,
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
      trim: true,
      immutable: true,
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
    incentiveEvaluationIds: [{
      type: Schema.Types.ObjectId,
      ref: "IncentiveEvaluation",
      immutable: true,
    }],
    incentiveAmountInPaise: {
      type: Number,
      default: 0,
      min: 0,
      max: MAX_SAFE_PAISE,
      immutable: true,
      validate: {
        validator: Number.isSafeInteger,
        message: "{VALUE} is not a safe integer paise amount",
      },
    },
    incentiveLedgerEntryIds: [{
      type: Schema.Types.ObjectId,
      ref: "IncentiveLedger",
      immutable: true,
    }],
    incentiveLedgerAmountInPaise: {
      type: Number,
      default: 0,
      min: 0,
      max: MAX_SAFE_PAISE,
      immutable: true,
      validate: {
        validator: Number.isSafeInteger,
        message: "{VALUE} is not a safe integer paise amount",
      },
    },
    history: {
      type: [paymentHistorySchema],
      default: [],
    },
  },
  { timestamps: true },
);

payrollPaymentSchema.index(
  { organizationId: 1, idempotencyKey: 1 },
  { unique: true },
);
payrollPaymentSchema.index({
  organizationId: 1,
  payrollRecordId: 1,
  createdAt: -1,
});
payrollPaymentSchema.plugin(auditPlugin);

export const PayrollPayment =
  mongoose.models.PayrollPayment ||
  mongoose.model("PayrollPayment", payrollPaymentSchema);
