import mongoose from "mongoose";

const { Schema } = mongoose;

const MAX_SAFE_PAISE = 10_000_000_000_000; // 10^13 paise

/**
 * IncentiveLedger Schema
 * Strictly append-only financial ledger of commission accruals and clawbacks.
 */
const incentiveLedgerSchema = new Schema(
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
    schemeId: {
      type: Schema.Types.ObjectId,
      ref: "IncentiveScheme",
      required: true,
      index: true,
    },
    entryType: {
      type: String,
      required: true,
      enum: ["ACCRUAL", "CLAWBACK"],
    },
    sourceType: {
      type: String,
      required: true,
      enum: [
        "service_commission",
        "subscription_sale_commission",
        "membership_sale_commission",
        "retail_sale_commission",
        "attendance_bonus",
      ],
      default: "service_commission",
      index: true,
    },
    evaluationId: {
      type: Schema.Types.ObjectId,
      ref: "IncentiveEvaluation",
      default: null,
      index: true,
    },
    settlementEventId: {
      type: Schema.Types.ObjectId,
      ref: "InvoiceSettlementEvent",
      required: function () {
        return [
          "service_commission",
          "subscription_sale_commission",
          "membership_sale_commission",
          "retail_sale_commission",
        ].includes(this.sourceType);
      },
      default: null,
      index: true,
    },
    invoiceId: {
      type: Schema.Types.ObjectId,
      ref: "Invoice",
      required: function () {
        return [
          "service_commission",
          "subscription_sale_commission",
          "membership_sale_commission",
          "retail_sale_commission",
        ].includes(this.sourceType);
      },
      default: null,
      index: true,
    },
    lineItemId: {
      type: Schema.Types.ObjectId,
      required: function () {
        return [
          "service_commission",
          "subscription_sale_commission",
          "membership_sale_commission",
          "retail_sale_commission",
        ].includes(this.sourceType);
      },
      default: null,
    },
    reversesLedgerId: {
      type: Schema.Types.ObjectId,
      ref: "IncentiveLedger",
      default: null,
      index: true,
    },
    refundAmountInPaise: {
      type: Number,
      default: null,
      min: 0,
      max: MAX_SAFE_PAISE,
      validate: {
        validator: (value) => value === null || Number.isInteger(value),
        message: "{VALUE} must be null or integer paise",
      },
    },
    fulfillmentStatus: {
      type: String,
      required: true,
      enum: ["pending", "confirmed", "corrected", "cancelled", "not_applicable"],
      default: "confirmed",
      index: true,
    },
    fulfillmentConfirmedAt: {
      type: Date,
      default: null,
    },
    fulfillmentConfirmedBy: {
      type: Schema.Types.ObjectId,
      ref: "User",
      default: null,
    },
    sourceRevenueInPaise: {
      type: Number,
      required: true,
      min: [0, "sourceRevenueInPaise cannot be negative"],
      max: [MAX_SAFE_PAISE, "sourceRevenueInPaise exceeds safe limit"],
      validate: {
        validator: Number.isInteger,
        message: "{VALUE} is not an integer paise value",
      },
    },
    attributedRevenueInPaise: {
      type: Number,
      required: true,
      min: [0, "attributedRevenueInPaise cannot be negative"],
      max: [MAX_SAFE_PAISE, "attributedRevenueInPaise exceeds safe limit"],
      validate: {
        validator: Number.isInteger,
        message: "{VALUE} is not an integer paise value",
      },
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
    calculationSnapshot: {
      calculationBasis: {
        type: String,
        default: null,
      },
      schemeCode: {
        type: String,
        default: null,
      },
      appliedRate: {
        type: Number,
        default: null,
      },
      fixedAmountPaise: {
        type: Number,
        default: 0,
      },
      tierMinPaise: {
        type: Number,
        default: null,
      },
      tierMaxPaise: {
        type: Number,
        default: null,
      },
      evaluationType: {
        type: String,
        default: null,
      },
      targetDays: {
        type: Number,
        default: null,
      },
      achievedDays: {
        type: Number,
        default: null,
      },
    },
    idempotencyKey: {
      type: String,
      required: true,
      trim: true,
    },
    payoutBatchId: {
      type: Schema.Types.ObjectId,
      ref: "IncentivePayoutBatch",
      default: null,
      index: true,
    },
  },
  {
    timestamps: true,
  }
);

// Compound Unique Index: Prevents duplicate ledger entries for the same logical operation
incentiveLedgerSchema.index(
  { organizationId: 1, idempotencyKey: 1 },
  { unique: true }
);

// Staff period accruals & reporting lookup index
incentiveLedgerSchema.index({
  organizationId: 1,
  staffId: 1,
  entryType: 1,
  fulfillmentStatus: 1,
  createdAt: 1,
});

export const IncentiveLedger = mongoose.model(
  "IncentiveLedger",
  incentiveLedgerSchema
);
