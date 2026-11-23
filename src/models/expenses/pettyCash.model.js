import mongoose from "mongoose";

const pettyCashTransactionSchema = new mongoose.Schema(
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
    transactionNumber: {
      type: String,
      required: true,
      trim: true,
    },
    type: {
      type: String,
      enum: ["opening_balance", "replenishment", "expense_payout", "payout_reversal"],
      required: true,
      index: true,
    },
    amount: {
      type: Number,
      required: true,
      min: 0.01,
    },
    recoveredAmountSoFar: {
      type: Number,
      default: 0,
      min: 0,
    },
    linkedExpenseId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Expense",
      default: null,
      index: true,
    },
    originalPayoutId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "PettyCashTransaction",
      default: null,
      index: true,
    },
    description: {
      type: String,
      trim: true,
      default: "",
    },
    idempotencyKey: {
      type: String,
      trim: true,
      default: null,
    },
    requestPayloadHash: {
      type: String,
      trim: true,
      default: null,
    },
    recordedBy: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "User",
      required: true,
    },
    transactionDate: {
      type: Date,
      required: true,
      default: Date.now,
      index: true,
    },
  },
  { timestamps: true }
);

// Indexes
pettyCashTransactionSchema.index({ organizationId: 1, transactionNumber: 1 }, { unique: true });
pettyCashTransactionSchema.index(
  { organizationId: 1, idempotencyKey: 1 },
  {
    unique: true,
    partialFilterExpression: { idempotencyKey: { $type: "string" } },
  }
);
pettyCashTransactionSchema.index({ organizationId: 1, branchId: 1, transactionDate: -1 });

pettyCashTransactionSchema.set("toJSON", {
  transform: (doc, ret) => {
    ret.id = ret._id.toString();
    delete ret.__v;
    return ret;
  },
});

export const PettyCashTransaction = mongoose.model(
  "PettyCashTransaction",
  pettyCashTransactionSchema
);
