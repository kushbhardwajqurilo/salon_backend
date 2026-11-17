import mongoose from "mongoose";
import { sourceAttributionSchema } from "../staff/staffAttribution.schema.js";

const { Schema } = mongoose;

const MAX_SAFE_PAISE = 10_000_000_000_000; // 10^13 paise

const refundAllocationSchema = new Schema(
  {
    lineItemId: {
      type: Schema.Types.ObjectId,
      required: true,
    },
    refundAmountInPaise: {
      type: Number,
      required: true,
      min: 1,
      max: MAX_SAFE_PAISE,
      validate: {
        validator: Number.isInteger,
        message: "{VALUE} is not an integer paise value",
      },
    },
    quantity: {
      type: Number,
      min: 0.001,
      default: null,
    },
  },
  { _id: false },
);

const returnItemSchema = new Schema(
  {
    lineItemId: {
      type: Schema.Types.ObjectId,
      required: true,
    },
    productId: {
      type: Schema.Types.ObjectId,
      default: null,
    },
    quantity: {
      type: Number,
      required: true,
      min: 0.001,
    },
    condition: {
      type: String,
      enum: ["unopened", "damaged", "defective"],
      required: true,
    },
    physicalRestockAccepted: {
      type: Boolean,
      required: true,
    },
    restockReason: {
      type: String,
      trim: true,
      default: "",
      maxlength: 500,
    },
    refundDueInPaise: {
      type: Number,
      required: true,
      min: 0,
      max: MAX_SAFE_PAISE,
      validate: {
        validator: Number.isInteger,
        message: "{VALUE} is not an integer paise value",
      },
    },
    refundAmountInPaise: {
      type: Number,
      required: true,
      min: 0,
      max: MAX_SAFE_PAISE,
      validate: {
        validator: Number.isInteger,
        message: "{VALUE} is not an integer paise value",
      },
    },
  },
  { _id: false },
);

/**
 * Staff attribution embedded schema for invoice line items
 */
const staffAttributionSchema = new Schema(
  {
    staffId: {
      type: Schema.Types.ObjectId,
      ref: "Staff",
      required: true,
    },
    splitPercentage: {
      type: Number,
      required: true,
      min: [0, "splitPercentage cannot be negative"],
      max: [100, "splitPercentage cannot exceed 100"],
    },
    attributedPaise: {
      type: Number,
      required: true,
      min: [0, "attributedPaise cannot be negative"],
      max: [MAX_SAFE_PAISE, "attributedPaise exceeds safe limit"],
      validate: {
        validator: Number.isInteger,
        message: "{VALUE} is not an integer paise value",
      },
    },
  },
  { _id: true }
);

/**
 * Line item snapshot embedded schema
 */
const lineItemSnapshotSchema = new Schema(
  {
    itemId: {
      type: Schema.Types.ObjectId,
      required: true,
    },
    sourceEntityId: {
      type: Schema.Types.ObjectId,
      default: null,
    },
    itemType: {
      type: String,
      required: true,
      enum: ["service", "product", "custom_service", "membership", "package", "subscription"],
    },
    name: {
      type: String,
      required: true,
    },
    priceInPaise: {
      type: Number,
      required: true,
      min: [0, "priceInPaise cannot be negative"],
      max: [MAX_SAFE_PAISE, "priceInPaise exceeds safe limit"],
      validate: {
        validator: Number.isInteger,
        message: "{VALUE} is not an integer paise value",
      },
    },
    discountInPaise: {
      type: Number,
      default: 0,
      min: [0, "discountInPaise cannot be negative"],
      max: [MAX_SAFE_PAISE, "discountInPaise exceeds safe limit"],
      validate: {
        validator: Number.isInteger,
        message: "{VALUE} is not an integer paise value",
      },
    },
    netRevenueInPaise: {
      type: Number,
      required: true,
      min: [0, "netRevenueInPaise cannot be negative"],
      max: [MAX_SAFE_PAISE, "netRevenueInPaise exceeds safe limit"],
      validate: {
        validator: Number.isInteger,
        message: "{VALUE} is not an integer paise value",
      },
    },
    staffAttributions: {
      type: [staffAttributionSchema],
      default: [],
    },
    sourceAttribution: {
      type: sourceAttributionSchema,
      default: () => ({}),
    },
  },
  { _id: true }
);

/**
 * InvoiceSettlementEvent Schema
 * Immutable snapshot emitted when an invoice transitions to paid/settled or voided/returned.
 */
const invoiceSettlementEventSchema = new Schema(
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
    invoiceId: {
      type: Schema.Types.ObjectId,
      ref: "Invoice",
      required: true,
      index: true,
    },
    paymentId: {
      type: Schema.Types.ObjectId,
      ref: "Payment",
      required: true,
      index: true,
    },
    appointmentId: {
      type: Schema.Types.ObjectId,
      ref: "Appointment",
      default: null,
      index: true,
    },
    subscriptionId: {
      type: Schema.Types.ObjectId,
      ref: "Subscription",
      default: null,
      index: true,
    },
    customerMembershipId: {
      type: Schema.Types.ObjectId,
      ref: "CustomerMembership",
      default: null,
      index: true,
    },
    eventType: {
      type: String,
      required: true,
      enum: ["SETTLED", "UNSETTLED", "RETURN_PROCESSED"],
    },
    settlementCycle: {
      type: Number,
      required: true,
      min: 1,
      validate: {
        validator: Number.isInteger,
        message: "{VALUE} must be an integer settlement cycle",
      },
    },
    grossAmountInPaise: {
      type: Number,
      required: true,
      min: [0, "grossAmountInPaise cannot be negative"],
      max: [MAX_SAFE_PAISE, "grossAmountInPaise exceeds safe limit"],
      validate: {
        validator: Number.isInteger,
        message: "{VALUE} is not an integer paise value",
      },
    },
    discountAmountInPaise: {
      type: Number,
      default: 0,
      min: [0, "discountAmountInPaise cannot be negative"],
      max: [MAX_SAFE_PAISE, "discountAmountInPaise exceeds safe limit"],
      validate: {
        validator: Number.isInteger,
        message: "{VALUE} is not an integer paise value",
      },
    },
    taxAmountInPaise: {
      type: Number,
      default: 0,
      min: [0, "taxAmountInPaise cannot be negative"],
      max: [MAX_SAFE_PAISE, "taxAmountInPaise exceeds safe limit"],
      validate: {
        validator: Number.isInteger,
        message: "{VALUE} is not an integer paise value",
      },
    },
    netSettledInPaise: {
      type: Number,
      required: true,
      min: [0, "netSettledInPaise cannot be negative"],
      max: [MAX_SAFE_PAISE, "netSettledInPaise exceeds safe limit"],
      validate: {
        validator: Number.isInteger,
        message: "{VALUE} is not an integer paise value",
      },
    },
    lineItems: {
      type: [lineItemSnapshotSchema],
      default: [],
    },
    refundAllocations: {
      type: [refundAllocationSchema],
      default: [],
    },
    returnItems: {
      type: [returnItemSchema],
      default: [],
    },
    requestPayloadHash: {
      type: String,
      trim: true,
      default: null,
    },
    restockedMovementIds: {
      type: [Schema.Types.ObjectId],
      ref: "StockMovement",
      default: [],
    },
    reason: {
      type: String,
      trim: true,
      default: null,
    },
    recordedBy: {
      type: Schema.Types.ObjectId,
      ref: "User",
      default: null,
    },
    commissionSkipReason: {
      type: String,
      enum: ["UNALLOCATED_LOYALTY_DISCOUNT"],
      default: null,
    },
    idempotencyKey: {
      type: String,
      required: true,
      trim: true,
    },
    eventTimestamp: {
      type: Date,
      default: Date.now,
      index: true,
    },
  },
  {
    timestamps: true,
  }
);

// Compound Unique Index: Strictly once per logical settlement cycle attempt
invoiceSettlementEventSchema.index(
  { organizationId: 1, idempotencyKey: 1 },
  { unique: true }
);

// Compound Index for cycle ordering & auditing
invoiceSettlementEventSchema.index({
  organizationId: 1,
  invoiceId: 1,
  settlementCycle: 1,
});

export const InvoiceSettlementEvent = mongoose.model(
  "InvoiceSettlementEvent",
  invoiceSettlementEventSchema
);
