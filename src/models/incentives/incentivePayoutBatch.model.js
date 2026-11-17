import mongoose from "mongoose";
import { auditPlugin } from "../../database/plugins/audit.js";

const { Schema } = mongoose;

const MAX_SAFE_PAISE = 10_000_000_000_000; // 10^13 paise

/**
 * Staff payout summary embedded schema
 */
const staffPayoutSummarySchema = new Schema(
  {
    staffId: {
      type: Schema.Types.ObjectId,
      ref: "Staff",
      required: true,
    },
    grossEarningsInPaise: {
      type: Number,
      required: true,
      min: [0, "grossEarningsInPaise cannot be negative"],
      max: [MAX_SAFE_PAISE, "grossEarningsInPaise exceeds safe limit"],
      validate: {
        validator: Number.isInteger,
        message: "{VALUE} is not an integer paise value",
      },
    },
    bonusInPaise: {
      type: Number,
      default: 0,
      min: [0, "bonusInPaise cannot be negative"],
      max: [MAX_SAFE_PAISE, "bonusInPaise exceeds safe limit"],
      validate: {
        validator: Number.isInteger,
        message: "{VALUE} is not an integer paise value",
      },
    },
    allocatedRecoveryInPaise: {
      type: Number,
      default: 0,
      min: [0, "allocatedRecoveryInPaise cannot be negative"],
      max: [MAX_SAFE_PAISE, "allocatedRecoveryInPaise exceeds safe limit"],
      validate: {
        validator: Number.isInteger,
        message: "{VALUE} is not an integer paise value",
      },
    },
    netPayoutInPaise: {
      type: Number,
      required: true,
      min: [0, "netPayoutInPaise cannot be negative"],
      max: [MAX_SAFE_PAISE, "netPayoutInPaise exceeds safe limit"],
      validate: {
        validator: Number.isInteger,
        message: "{VALUE} is not an integer paise value",
      },
    },
  },
  { _id: true }
);

/**
 * IncentivePayoutBatch Schema
 * Groups staff incentive earnings, applied recoveries, and net payables for a monthly payroll cycle.
 */
const incentivePayoutBatchSchema = new Schema(
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
      default: null,
      index: true,
    },
    monthYear: {
      type: String,
      required: true,
      match: [/^\d{4}-(0[1-9]|1[0-2])$/, "monthYear must be in YYYY-MM format"],
    },
    status: {
      type: String,
      required: true,
      enum: ["draft", "locked", "approved", "synced", "cancelled"],
      default: "draft",
      index: true,
    },
    totalGrossInPaise: {
      type: Number,
      default: 0,
      min: [0, "totalGrossInPaise cannot be negative"],
      max: [MAX_SAFE_PAISE, "totalGrossInPaise exceeds safe limit"],
      validate: {
        validator: Number.isInteger,
        message: "{VALUE} is not an integer paise value",
      },
    },
    totalRecoveredInPaise: {
      type: Number,
      default: 0,
      min: [0, "totalRecoveredInPaise cannot be negative"],
      max: [MAX_SAFE_PAISE, "totalRecoveredInPaise exceeds safe limit"],
      validate: {
        validator: Number.isInteger,
        message: "{VALUE} is not an integer paise value",
      },
    },
    totalNetInPaise: {
      type: Number,
      default: 0,
      min: [0, "totalNetInPaise cannot be negative"],
      max: [MAX_SAFE_PAISE, "totalNetInPaise exceeds safe limit"],
      validate: {
        validator: Number.isInteger,
        message: "{VALUE} is not an integer paise value",
      },
    },
    staffSummaries: {
      type: [staffPayoutSummarySchema],
      default: [],
    },
    approvedAt: {
      type: Date,
      default: null,
    },
    approvedBy: {
      type: Schema.Types.ObjectId,
      ref: "User",
      default: null,
    },
    syncedAt: {
      type: Date,
      default: null,
    },
  },
  {
    timestamps: true,
  }
);

// Compound Unique Index: One batch per monthYear per organization (and optional branch)
incentivePayoutBatchSchema.index(
  { organizationId: 1, branchId: 1, monthYear: 1 },
  { unique: true }
);

incentivePayoutBatchSchema.plugin(auditPlugin);

export const IncentivePayoutBatch = mongoose.model(
  "IncentivePayoutBatch",
  incentivePayoutBatchSchema
);
