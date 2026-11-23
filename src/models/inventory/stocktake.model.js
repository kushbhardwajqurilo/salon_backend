import mongoose from "mongoose";

const stocktakeSchema = new mongoose.Schema(
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
    stocktakeNumber: {
      type: String,
      required: true,
      trim: true,
    },
    status: {
      type: String,
      enum: ["draft", "in_progress", "posting", "completed", "cancelled"],
      default: "draft",
      index: true,
    },
    title: {
      type: String,
      trim: true,
      default: "Physical Stocktake",
    },
    targetDomain: {
      type: String,
      enum: ["all", "salon_consumables", "retail_products"],
      default: "all",
    },
    initiatedBy: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "User",
      required: true,
    },
    postedBy: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "User",
      default: null,
    },
    postedAt: {
      type: Date,
      default: null,
    },
    totalItems: {
      type: Number,
      default: 0,
      min: 0,
    },
    countedItemsCount: {
      type: Number,
      default: 0,
      min: 0,
    },
    discrepancyCount: {
      type: Number,
      default: 0,
      min: 0,
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
  },
  {
    timestamps: true,
  }
);

stocktakeSchema.index({ organizationId: 1, stocktakeNumber: 1 }, { unique: true });
stocktakeSchema.index({ organizationId: 1, branchId: 1, status: 1 });
stocktakeSchema.index(
  { organizationId: 1, idempotencyKey: 1 },
  {
    unique: true,
    partialFilterExpression: { idempotencyKey: { $type: "string" } },
  }
);

export const Stocktake =
  mongoose.models.Stocktake || mongoose.model("Stocktake", stocktakeSchema);
