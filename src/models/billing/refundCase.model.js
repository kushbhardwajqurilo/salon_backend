import mongoose from "mongoose";

const refundAllocationSchema = new mongoose.Schema(
  {
    lineId: { type: mongoose.Schema.Types.ObjectId, required: true },
    lineType: {
      type: String,
      enum: ["service", "product", "membership", "subscription"],
      required: true,
    },
    quantity: { type: Number, default: 1, min: 0 },
    allocatedAmountPaise: {
      type: Number,
      required: true,
      min: 0,
      validate: {
        validator: Number.isInteger,
        message: "allocatedAmountPaise must be an integer",
      },
    },
    loyaltyAllocatedPaise: {
      type: Number,
      default: 0,
      min: 0,
      validate: {
        validator: Number.isInteger,
        message: "loyaltyAllocatedPaise must be an integer",
      },
    },
    domainReversalStatus: {
      type: String,
      enum: ["not_applicable", "pending", "completed", "failed"],
      default: "not_applicable",
      required: true,
    },
    domainReferenceId: { type: mongoose.Schema.Types.ObjectId, default: null },
  },
  { _id: false }
);

const domainReversalTrackSchema = new mongoose.Schema(
  {
    status: {
      type: String,
      enum: ["not_applicable", "pending", "partially_completed", "completed", "failed", "skipped"],
      default: "pending",
      required: true,
    },
    referenceIds: { type: [mongoose.Schema.Types.ObjectId], default: [] },
    errorMessage: { type: String, default: null, trim: true },
  },
  { _id: false }
);

const refundCaseSchema = new mongoose.Schema(
  {
    organizationId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Organization",
      required: true,
      index: true,
    },
    branchId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Branch",
      required: true,
      index: true,
    },
    invoiceId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Invoice",
      required: true,
      index: true,
    },
    customerId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Customer",
      required: true,
      index: true,
    },
    refundNumber: {
      type: String,
      required: true,
      trim: true,
    },
    refundMode: {
      type: String,
      enum: ["financial_only", "item_linked"],
      required: true,
    },
    requestedAmountPaise: {
      type: Number,
      required: true,
      min: 1,
      validate: {
        validator: Number.isInteger,
        message: "requestedAmountPaise must be an integer",
      },
    },
    pendingAmountPaise: {
      type: Number,
      required: true,
      default: 0,
      min: 0,
      validate: {
        validator: Number.isInteger,
        message: "pendingAmountPaise must be an integer",
      },
    },
    settledAmountPaise: {
      type: Number,
      required: true,
      default: 0,
      min: 0,
      validate: {
        validator: Number.isInteger,
        message: "settledAmountPaise must be an integer",
      },
    },
    refundMethod: {
      type: String,
      enum: ["cash", "card", "upi", "other"],
      required: true,
    },
    settlementType: {
      type: String,
      enum: ["manual_record"],
      default: "manual_record",
      required: true,
    },
    status: {
      type: String,
      enum: [
        "pending",
        "processing",
        "completed",
        "partially_completed",
        "failed",
        "rejected",
        "cancelled",
      ],
      default: "pending",
      required: true,
      index: true,
    },
    paymentSettlementStatus: {
      type: String,
      enum: ["pending", "settled", "failed", "cancelled"],
      default: "pending",
      required: true,
    },
    paymentId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Payment",
      default: null,
    },
    allocations: {
      type: [refundAllocationSchema],
      default: [],
    },
    domainReversals: {
      inventory: { type: domainReversalTrackSchema, default: () => ({}) },
      membership: { type: domainReversalTrackSchema, default: () => ({}) },
      subscription: { type: domainReversalTrackSchema, default: () => ({}) },
      loyalty: { type: domainReversalTrackSchema, default: () => ({}) },
      incentives: { type: domainReversalTrackSchema, default: () => ({}) },
      appointment: { type: domainReversalTrackSchema, default: () => ({}) },
    },
    reason: {
      type: String,
      required: true,
      trim: true,
      minlength: 3,
      maxlength: 500,
    },
    initiatedBy: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "User",
      required: true,
    },
    approvedBy: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "User",
      default: null,
    },
    idempotencyKey: {
      type: String,
      default: null,
      trim: true,
    },
    requestPayloadHash: {
      type: String,
      default: null,
      trim: true,
    },
    isDeleted: {
      type: Boolean,
      default: false,
      index: true,
    },
    deletedAt: {
      type: Date,
      default: null,
    },
  },
  { timestamps: true }
);

refundCaseSchema.index({ organizationId: 1, refundNumber: 1 }, { unique: true });
refundCaseSchema.index(
  { organizationId: 1, idempotencyKey: 1 },
  {
    unique: true,
    partialFilterExpression: {
      isDeleted: false,
      idempotencyKey: { $type: "string" },
    },
  }
);
refundCaseSchema.index({ organizationId: 1, invoiceId: 1, status: 1, createdAt: -1 });
refundCaseSchema.index({ organizationId: 1, branchId: 1, createdAt: -1 });

refundCaseSchema.set("toJSON", {
  transform: (doc, ret) => {
    ret.id = ret._id.toString();
    delete ret.__v;
    return ret;
  },
});

export const RefundCase = mongoose.model("RefundCase", refundCaseSchema);
