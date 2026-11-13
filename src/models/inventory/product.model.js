import mongoose from "mongoose";

export const PRODUCT_USAGE_TYPES = ["retail_sale", "salon_consumption", "both"];

export const STOCK_UNITS = [
  "piece",
  "bottle",
  "box",
  "pack",
  "kit",
  "ml",
  "l",
  "g",
  "kg"
];

// Discrete units that strictly forbid fractional quantities
export const DISCRETE_STOCK_UNITS = ["piece", "bottle", "box", "pack", "kit"];

const productSchema = new mongoose.Schema(
  {
    organizationId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Organization",
      required: true,
      index: true
    },
    name: {
      type: String,
      required: true,
      trim: true
    },
    sku: {
      type: String,
      required: true,
      trim: true,
      uppercase: true
    },
    category: {
      type: String,
      required: true,
      trim: true
    },
    usageType: {
      type: String,
      required: true,
      enum: PRODUCT_USAGE_TYPES,
      default: "both",
      index: true
    },
    stockUnit: {
      type: String,
      required: true,
      enum: STOCK_UNITS,
      trim: true,
      lowercase: true
    },
    costPrice: {
      type: Number,
      min: 0,
      default: 0
    },
    sellingPrice: {
      type: Number,
      min: 0,
      default: 0
    },
    reorderLevel: {
      type: Number,
      min: 0,
      default: 0
    },
    status: {
      type: String,
      enum: ["active", "inactive"],
      default: "active",
      index: true
    },
    isDeleted: {
      type: Boolean,
      default: false,
      index: true
    },
    createdBy: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "User",
      default: null
    },
    updatedBy: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "User",
      default: null
    }
  },
  {
    timestamps: true
  }
);

// Compound index to enforce unique SKU per organization
productSchema.index({ organizationId: 1, sku: 1 }, { unique: true });
productSchema.index({ organizationId: 1, status: 1, isDeleted: 1 });

export const Product = mongoose.models.Product || mongoose.model("Product", productSchema);
