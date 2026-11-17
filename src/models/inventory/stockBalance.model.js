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
    // Total aggregate onHand = onHandConsumables + onHandRetail (backward compatible)
    onHand: {
      type: Number,
      required: true,
      default: 0,
      min: 0
    },
    // Domain-isolated balance for Salon Consumables (internal service consumption)
    onHandConsumables: {
      type: Number,
      required: true,
      default: 0,
      min: 0
    },
    // Domain-isolated balance for Retail Products (POS sales)
    onHandRetail: {
      type: Number,
      required: true,
      default: 0,
      min: 0
    },
    // Unallocated historical stock for products with usageType: "both"
    // Requires manual manager assignment to consumables or retail before becoming available.
    onHandUnallocated: {
      type: Number,
      required: true,
      default: 0,
      min: 0
    },
    // Total allocated = allocatedConsumables + allocatedRetail
    allocated: {
      type: Number,
      required: true,
      default: 0,
      min: 0
    },
    allocatedConsumables: {
      type: Number,
      required: true,
      default: 0,
      min: 0
    },
    allocatedRetail: {
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
