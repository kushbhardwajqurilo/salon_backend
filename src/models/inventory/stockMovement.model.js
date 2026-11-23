import mongoose from "mongoose";

export const MOVEMENT_TYPES = [
  "purchase_in",
  "pos_sale",
  "service_consumption",
  "adjustment",
  "transfer_out",
  "transfer_in",
  "stocktake",
  "domain_allocation",
  "movement_reversal",
];

const batchAllocationSchema = new mongoose.Schema(
  {
    batchId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "StockBatch",
      required: true,
    },
    batchNumber: {
      type: String,
      required: true,
    },
    quantityMilli: {
      type: Number,
      required: true,
    },
    isValued: {
      type: Boolean,
      required: true,
    },
    unitCostPaise: {
      type: Number,
      default: null,
    },
    allocatedCostPaise: {
      type: Number,
      default: null, // Integer paise: Math.round((quantityMilli * unitCostPaise) / 1000)
    },
  },
  { _id: true }
);

const stockMovementSchema = new mongoose.Schema(
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
    productId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Product",
      required: true,
      index: true,
    },
    quantityDelta: {
      type: Number,
      required: true,
    },
    quantityDeltaMilli: {
      type: Number,
      default: null,
    },
    balanceAfter: {
      type: Number,
      required: true,
      min: 0,
    },
    balanceAfterMilli: {
      type: Number,
      default: null,
      min: 0,
    },
    movementType: {
      type: String,
      required: true,
      enum: MOVEMENT_TYPES,
      index: true,
    },
    stockDomain: {
      type: String,
      enum: ["salon_consumables", "retail_products", "general"],
      default: "general",
      index: true,
    },
    reference: {
      entityType: {
        type: String,
        required: true,
        trim: true,
      },
      entityId: {
        type: mongoose.Schema.Types.ObjectId,
        default: null,
      },
      identifier: {
        type: String,
        trim: true,
        default: null,
      },
    },
    actorId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "User",
      required: true,
    },
    notes: {
      type: String,
      trim: true,
      default: "",
    },
    idempotencyKey: {
      type: String,
      trim: true,
      default: null,
      index: true,
    },
    // Accounting date (authoritative event date in branch timezone)
    accountingDate: {
      type: Date,
      required: true,
      default: Date.now,
      index: true,
    },
    // FIFO Valuation Fields
    isValued: {
      type: Boolean,
      default: false,
      index: true,
    },
    valuedQuantityMilli: {
      type: Number,
      default: 0,
    },
    unvaluedQuantityMilli: {
      type: Number,
      default: 0,
    },
    totalCostPaise: {
      type: Number,
      default: null, // Exact integer sum of lotAllocations.allocatedCostPaise
    },
    lotAllocations: {
      type: [batchAllocationSchema],
      default: [],
    },
    // Reversal pointers
    isReversed: {
      type: Boolean,
      default: false,
      index: true,
    },
    reversedByMovementId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "StockMovement",
      default: null,
    },
    reversesMovementId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "StockMovement",
      default: null,
      index: true,
    },
    batchInfo: {
      type: mongoose.Schema.Types.Mixed,
      default: null,
    },
  },
  {
    timestamps: { createdAt: true, updatedAt: false }, // Immutable records
  }
);

stockMovementSchema.index({ organizationId: 1, branchId: 1, productId: 1, createdAt: -1 });
stockMovementSchema.index({ organizationId: 1, movementType: 1, createdAt: -1 });
stockMovementSchema.index(
  { organizationId: 1, branchId: 1, accountingDate: 1, isValued: 1, movementType: 1 },
  { name: "idx_cogs_accounting_aggregation" }
);

// Unique compound index for idempotency per organization when key is provided
stockMovementSchema.index(
  { organizationId: 1, idempotencyKey: 1 },
  {
    unique: true,
    partialFilterExpression: { idempotencyKey: { $type: "string" } },
  }
);

export const StockMovement =
  mongoose.models.StockMovement || mongoose.model("StockMovement", stockMovementSchema);
