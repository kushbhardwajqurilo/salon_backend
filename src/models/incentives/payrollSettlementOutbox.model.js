import mongoose from "mongoose";

const { Schema } = mongoose;

const MAX_SAFE_PAISE = 10_000_000_000_000; // 10^13 paise

/**
 * Payload schema for PayrollSettlementOutbox events
 */
const outboxPayloadSchema = new Schema(
  {
    payrollRecordId: {
      type: Schema.Types.ObjectId,
      ref: "PayrollRecord",
      required: true,
    },
    monthYear: {
      type: String,
      required: true,
    },
    payoutBatchId: {
      type: Schema.Types.ObjectId,
      ref: "IncentivePayoutBatch",
      default: null,
    },
    staffId: {
      type: Schema.Types.ObjectId,
      ref: "Staff",
      default: null,
    },
    amountInPaise: {
      type: Number,
      required: true,
      min: [0, "amountInPaise cannot be negative"],
      max: [MAX_SAFE_PAISE, "amountInPaise exceeds safe limit"],
      validate: {
        validator: Number.isInteger,
        message: "{VALUE} is not an integer paise value",
      },
    },
    reason: {
      type: String,
      default: null,
    },
  },
  { _id: false }
);

/**
 * Contract-only hand-off for payroll settlements and reversals. Payroll's current
 * recordPayment/reversePayment lifecycle does not produce or consume these events.
 */
const payrollSettlementOutboxSchema = new Schema(
  {
    organizationId: {
      type: Schema.Types.ObjectId,
      ref: "Organization",
      required: true,
      index: true,
    },
    eventType: {
      type: String,
      required: true,
      enum: ["payroll_paid", "payroll_reversed", "draft_cancelled"],
    },
    idempotencyKey: {
      type: String,
      required: true,
      trim: true,
    },
    payload: {
      type: outboxPayloadSchema,
      required: true,
    },
    status: {
      type: String,
      required: true,
      enum: ["pending", "processing", "processed", "failed", "dead_letter"],
      default: "pending",
      index: true,
    },
    retryCount: {
      type: Number,
      default: 0,
      min: 0,
    },
    maxRetries: {
      type: Number,
      default: 5,
    },
    lastError: {
      type: String,
      default: null,
    },
    leaseOwner: {
      type: String,
      default: null,
    },
    leaseExpiresAt: {
      type: Date,
      default: null,
      index: true,
    },
    processedAt: {
      type: Date,
      default: null,
    },
  },
  {
    timestamps: true,
  }
);

// Compound Unique Index: Exactly one outbox event per logical action
payrollSettlementOutboxSchema.index(
  { organizationId: 1, idempotencyKey: 1 },
  { unique: true }
);

// Compound Index for Worker Lease Polling
payrollSettlementOutboxSchema.index({
  status: 1,
  leaseExpiresAt: 1,
  createdAt: 1,
});

export const PayrollSettlementOutbox = mongoose.model(
  "PayrollSettlementOutbox",
  payrollSettlementOutboxSchema
);
