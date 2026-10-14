import mongoose from "mongoose";

export const LOYALTY_TRANSACTION_TYPES = {
  EARNED: "EARNED",
  REDEEMED: "REDEEMED",
  ADJUSTED: "ADJUSTED",
  EARNING_REVERSED: "EARNING_REVERSED",
  REDEMPTION_RESTORED: "REDEMPTION_RESTORED",
};

const loyaltyTransactionSchema = new mongoose.Schema(
  {
    organizationId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Organization",
      required: true,
      index: true,
    },
    customerId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Customer",
      required: true,
      index: true,
    },
    branchId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Branch",
      default: null,
      index: true,
    },
    type: {
      type: String,
      enum: Object.values(LOYALTY_TRANSACTION_TYPES),
      required: true,
      index: true,
    },
    // Signed points change: positive for credits, negative for debits
    pointsDelta: {
      type: Number,
      required: true,
    },
    balanceBefore: {
      type: Number,
      required: true,
    },
    balanceAfter: {
      type: Number,
      required: true,
    },
    invoiceId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Invoice",
      default: null,
      index: true,
    },
    paymentId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Payment",
      default: null,
      index: true,
    },
    originalTransactionId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "LoyaltyTransaction",
      default: null,
      index: true,
    },
    idempotencyKey: {
      type: String,
      default: null,
      trim: true,
    },
    // Source event key to guarantee at-most-once processing per event
    sourceEventKey: {
      type: String,
      default: null,
      trim: true,
    },
    reason: {
      type: String,
      trim: true,
      default: "",
    },
    actorId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "User",
      default: null,
    },
    // Historical rates snapshot
    rateSnapshot: {
      earnThresholdAmount: { type: Number, default: null },
      earnPointsPerUnit: { type: Number, default: null },
      redemptionRate: { type: Number, default: null },
      eligibleSpendAmount: { type: Number, default: null },
    },
  },
  {
    timestamps: { createdAt: true, updatedAt: false },
  }
);

// Indexes
loyaltyTransactionSchema.index({ organizationId: 1, customerId: 1, createdAt: -1 });
loyaltyTransactionSchema.index({ organizationId: 1, invoiceId: 1 });
loyaltyTransactionSchema.index(
  { organizationId: 1, sourceEventKey: 1 },
  {
    unique: true,
    partialFilterExpression: {
      sourceEventKey: { $type: "string" },
    },
  }
);
loyaltyTransactionSchema.index(
  { organizationId: 1, idempotencyKey: 1 },
  {
    unique: true,
    partialFilterExpression: {
      idempotencyKey: { $type: "string" },
    },
  }
);

loyaltyTransactionSchema.set("toJSON", {
  transform: (doc, ret) => {
    ret.id = ret._id.toString();
    delete ret.__v;
    return ret;
  },
});

export const LoyaltyTransaction = mongoose.model(
  "LoyaltyTransaction",
  loyaltyTransactionSchema
);
