import mongoose from "mongoose";

export const MOVEMENT_TYPES = [
  "purchase_in",
  "pos_sale",
  "service_consumption",
  "adjustment",
  "transfer_out",
  "transfer_in",
  "stocktake"
];

const stockMovementSchema = new mongoose.Schema(
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
    quantityDelta: {
      type: Number,
      required: true
    },
    balanceAfter: {
      type: Number,
      required: true,
      min: 0
    },
    movementType: {
      type: String,
      required: true,
      enum: MOVEMENT_TYPES,
      index: true
    },
    reference: {
      entityType: {
        type: String,
        required: true,
        trim: true
      },
      entityId: {
        type: mongoose.Schema.Types.ObjectId,
        default: null
      },
      identifier: {
        type: String,
        trim: true,
        default: null
      }
    },
    actorId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "User",
      required: true
    },
    notes: {
      type: String,
      trim: true,
      default: ""
    },
    idempotencyKey: {
      type: String,
      trim: true,
      default: null,
      index: true
    },
    // Extensibility placeholder for future batch tracking:
    batchInfo: {
      type: mongoose.Schema.Types.Mixed,
      default: null
    }
  },
  {
    timestamps: { createdAt: true, updatedAt: false } // Immutable records
  }
);

stockMovementSchema.index({ organizationId: 1, branchId: 1, productId: 1, createdAt: -1 });
stockMovementSchema.index({ organizationId: 1, movementType: 1, createdAt: -1 });
// Unique compound index for idempotency per organization when key is provided
stockMovementSchema.index(
  { organizationId: 1, idempotencyKey: 1 },
  {
    unique: true,
    partialFilterExpression: { idempotencyKey: { $type: "string" } }
  }
);

export const StockMovement =
  mongoose.models.StockMovement || mongoose.model("StockMovement", stockMovementSchema);
