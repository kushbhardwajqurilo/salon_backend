import mongoose from "mongoose";

const { Schema } = mongoose;

const MAX_SAFE_PAISE = 10_000_000_000_000; // 10^13 paise

/**
 * Embedded recovery allocation schema
 */
const recoveryAllocationSchema = new Schema(
  {
    allocationEventId: {
      type: String,
      required: true,
      trim: true,
    },
    payoutBatchId: {
      type: Schema.Types.ObjectId,
      ref: "IncentivePayoutBatch",
      required: true,
    },
    allocatedPaise: {
      type: Number,
      required: true,
      min: [1, "allocatedPaise must be greater than zero"],
      max: [MAX_SAFE_PAISE, "allocatedPaise exceeds safe limit"],
      validate: {
        validator: Number.isInteger,
        message: "{VALUE} is not an integer paise value",
      },
    },
    state: {
      type: String,
      required: true,
      enum: ["reserved", "confirmed", "released", "reversed"],
      default: "reserved",
    },
    reservedAt: {
      type: Date,
      default: Date.now,
    },
    confirmedAt: {
      type: Date,
      default: null,
    },
    confirmedEventId: {
      type: String,
      default: null,
    },
    releasedAt: {
      type: Date,
      default: null,
    },
    releasedEventId: {
      type: String,
      default: null,
    },
    reversedAt: {
      type: Date,
      default: null,
    },
    reversalEventId: {
      type: String,
      default: null,
    },
  },
  { _id: true }
);

/**
 * IncentiveRecoveryObligation Schema
 * Tracks unrecovered clawbacks across payroll runs with 2-phase reservation & reversal.
 */
const incentiveRecoveryObligationSchema = new Schema(
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
    staffId: {
      type: Schema.Types.ObjectId,
      ref: "Staff",
      required: true,
      index: true,
    },
    clawbackLedgerId: {
      type: Schema.Types.ObjectId,
      ref: "IncentiveLedger",
      required: true,
      index: true,
    },
    originalClawbackInPaise: {
      type: Number,
      required: true,
      min: [1, "originalClawbackInPaise must be greater than zero"],
      max: [MAX_SAFE_PAISE, "originalClawbackInPaise exceeds safe limit"],
      validate: {
        validator: Number.isInteger,
        message: "{VALUE} is not an integer paise value",
      },
    },
    totalReservedInPaise: {
      type: Number,
      default: 0,
      min: [0, "totalReservedInPaise cannot be negative"],
      max: [MAX_SAFE_PAISE, "totalReservedInPaise exceeds safe limit"],
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
      validate: [
        {
          validator: Number.isInteger,
          message: "{VALUE} is not an integer paise value",
        },
        {
          validator: function (v) {
            const reserved = this.totalReservedInPaise || 0;
            const original = this.originalClawbackInPaise;
            if (original !== undefined && original !== null) {
              return (v || 0) + reserved <= original;
            }
            return true;
          },
          message: "Invariant violation: totalRecoveredInPaise + totalReservedInPaise cannot exceed originalClawbackInPaise",
        },
      ],
    },
    status: {
      type: String,
      required: true,
      enum: ["pending", "partially_recovered", "recovered", "written_off"],
      default: "pending",
      index: true,
    },
    allocations: {
      type: [recoveryAllocationSchema],
      default: [],
    },
  },
  {
    timestamps: true,
  }
);

// Compound Unique Index: One obligation document per clawback ledger entry
incentiveRecoveryObligationSchema.index(
  { organizationId: 1, clawbackLedgerId: 1 },
  { unique: true }
);

// Staff active unrecovered obligations lookup
incentiveRecoveryObligationSchema.index({
  organizationId: 1,
  staffId: 1,
  status: 1,
});

// Schema Pre-Save Invariant Enforcement
incentiveRecoveryObligationSchema.pre("validate", function () {
  if (
    this.totalRecoveredInPaise + this.totalReservedInPaise >
    this.originalClawbackInPaise
  ) {
    throw new Error(
      `Invariant violation: totalRecovered (${this.totalRecoveredInPaise}) + totalReserved (${this.totalReservedInPaise}) cannot exceed originalClawback (${this.originalClawbackInPaise})`
    );
  }
});

export const IncentiveRecoveryObligation = mongoose.model(
  "IncentiveRecoveryObligation",
  incentiveRecoveryObligationSchema
);
