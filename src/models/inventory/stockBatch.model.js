import mongoose from "mongoose";

export const BATCH_SOURCE_TYPES = [
  "procurement_grn",
  "opening_stock",
  "manual_adjustment",
  "transfer_in",
];

const stockBatchSchema = new mongoose.Schema(
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
    stockDomain: {
      type: String,
      enum: ["salon_consumables", "retail_products"],
      required: true,
      index: true,
    },
    batchNumber: {
      type: String,
      required: true,
      trim: true,
    },
    sourceType: {
      type: String,
      enum: BATCH_SOURCE_TYPES,
      required: true,
      index: true,
    },
    sourceReference: {
      entityType: { type: String, required: true },
      entityId: { type: mongoose.Schema.Types.ObjectId, default: null },
      identifier: { type: String, default: null },
    },
    supplierId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Supplier",
      default: null,
    },
    supplierInvoiceId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "SupplierInvoice",
      default: null,
    },
    receivedDate: {
      type: Date,
      required: true,
      default: Date.now,
      index: true,
    },
    initialQuantityMilli: {
      type: Number,
      required: true,
      min: 1, // Normalized to milli-units (1.000 = 1000)
    },
    remainingQuantityMilli: {
      type: Number,
      required: true,
      min: 0,
      index: true,
    },
    isValued: {
      type: Boolean,
      required: true,
      default: true,
      index: true,
    },
    unitCostPaise: {
      type: Number,
      default: null,
      min: 0,
    },
    totalCostPaise: {
      type: Number,
      default: null,
      min: 0,
    },
    expiryDate: {
      type: Date,
      default: null,
      index: true,
    },
    status: {
      type: String,
      enum: ["active", "depleted", "quarantined", "expired"],
      default: "active",
      index: true,
    },
    openingValuationMetadata: {
      valuedBy: { type: mongoose.Schema.Types.ObjectId, ref: "User", default: null },
      valuedAt: { type: Date, default: null },
      sourceDocumentRef: { type: String, default: null },
      notes: { type: String, default: null },
    },
    createdBy: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "User",
      required: true,
    },
  },
  {
    timestamps: true,
  }
);

// Compound indexes
stockBatchSchema.index(
  { organizationId: 1, branchId: 1, productId: 1, stockDomain: 1, status: 1, receivedDate: 1, _id: 1 },
  { name: "idx_fifo_depletion_lookup" }
);

stockBatchSchema.index(
  { organizationId: 1, branchId: 1, isValued: 1, remainingQuantityMilli: 1 },
  { name: "idx_batch_valuation_reconciliation" }
);

stockBatchSchema.index(
  { organizationId: 1, batchNumber: 1 },
  { unique: true, name: "idx_unique_batch_number_per_org" }
);

stockBatchSchema.set("toJSON", {
  transform: (doc, ret) => {
    ret.id = ret._id.toString();
    ret.initialQuantity = (ret.initialQuantityMilli || 0) / 1000;
    ret.remainingQuantity = (ret.remainingQuantityMilli || 0) / 1000;
    delete ret.__v;
    return ret;
  },
});

export const StockBatch =
  mongoose.models.StockBatch || mongoose.model("StockBatch", stockBatchSchema);
