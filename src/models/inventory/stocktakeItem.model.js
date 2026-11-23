import mongoose from "mongoose";

const stocktakeItemSchema = new mongoose.Schema(
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
    stocktakeId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Stocktake",
      required: true,
      index: true,
    },
    productId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Product",
      required: true,
      index: true,
    },
    stockDomain: {
      type: String,
      enum: ["salon_consumables", "retail_products"],
      required: true,
      index: true,
    },
    stockUnit: {
      type: String,
      required: true,
      trim: true,
    },
    snapshotQuantity: {
      type: Number,
      required: true,
      min: 0,
    },
    // The live lastMovementAt recorded on StockBalance when snapshot was created
    snapshotMovementAt: {
      type: Date,
      default: null,
    },
    countedQuantity: {
      type: Number,
      default: null,
      min: 0,
    },
    // Server-assigned timestamp marking the instant the count was recorded/updated
    countedAt: {
      type: Date,
      default: null,
    },
    // The live lastMovementAt recorded on StockBalance at the instant the count was submitted
    verifiedMovementAt: {
      type: Date,
      default: null,
    },
    countedBy: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "User",
      default: null,
    },
    systemQuantityAtPost: {
      type: Number,
      default: null,
    },
    varianceQuantity: {
      type: Number,
      default: null,
    },
    status: {
      type: String,
      enum: ["uncounted", "counted", "recount_required"],
      default: "uncounted",
      index: true,
    },
    notes: {
      type: String,
      trim: true,
      default: "",
    },
  },
  {
    timestamps: true,
  }
);

stocktakeItemSchema.index(
  { stocktakeId: 1, productId: 1, stockDomain: 1 },
  { unique: true }
);
stocktakeItemSchema.index({ organizationId: 1, branchId: 1, stocktakeId: 1 });

export const StocktakeItem =
  mongoose.models.StocktakeItem || mongoose.model("StocktakeItem", stocktakeItemSchema);
