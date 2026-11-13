import mongoose from "mongoose";

const stockBalanceSchema = new mongoose.Schema(
  {
    organizationId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Organization",
      required: true,
      index: true
    },
    branchId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Branch",
      required: true,
      index: true
    },
    productId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Product",
      required: true,
      index: true
    },
    onHand: {
      type: Number,
      required: true,
      default: 0,
      min: 0
    },
    allocated: {
      type: Number,
      required: true,
      default: 0,
      min: 0
    },
    lastMovementAt: {
      type: Date,
      default: Date.now
    }
  },
  {
    timestamps: true
  }
);

// One aggregate stock balance per organization, branch and product
stockBalanceSchema.index(
  { organizationId: 1, branchId: 1, productId: 1 },
  { unique: true }
);

export const StockBalance =
  mongoose.models.StockBalance || mongoose.model("StockBalance", stockBalanceSchema);
