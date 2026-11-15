import mongoose from "mongoose";

const goodsReceiptItemSchema = new mongoose.Schema(
  {
    productId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Product",
      required: true,
    },
    targetDomain: {
      type: String,
      enum: ["salon_consumables", "retail_products"],
      required: true,
    },
    receivedQuantity: {
      type: Number,
      required: true,
      min: 0.001,
    },
    unitCostPrice: {
      type: Number,
      required: true,
      min: 0,
    },
    lineTotal: {
      type: Number,
      required: true,
      min: 0,
    },
  },
  { _id: true }
);

const goodsReceiptNoteSchema = new mongoose.Schema(
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
    grnNumber: {
      type: String,
      required: true,
      trim: true,
    },
    purchaseOrderId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "PurchaseOrder",
      required: true,
      index: true,
    },
    supplierId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Supplier",
      required: true,
      index: true,
    },
    items: {
      type: [goodsReceiptItemSchema],
      required: true,
      validate: [
        (val) => Array.isArray(val) && val.length > 0,
        "Goods receipt must contain at least one received item",
      ],
    },
    totalAmount: {
      type: Number,
      required: true,
      min: 0,
    },
    receivedBy: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "User",
      required: true,
    },
    receivedAt: {
      type: Date,
      default: Date.now,
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
  },
  {
    timestamps: true,
  }
);

goodsReceiptNoteSchema.index({ organizationId: 1, grnNumber: 1 }, { unique: true });
goodsReceiptNoteSchema.index({ organizationId: 1, purchaseOrderId: 1, createdAt: -1 });
goodsReceiptNoteSchema.index({ organizationId: 1, branchId: 1, createdAt: -1 });
goodsReceiptNoteSchema.index(
  { organizationId: 1, idempotencyKey: 1 },
  {
    unique: true,
    partialFilterExpression: { idempotencyKey: { $type: "string" } },
  }
);

goodsReceiptNoteSchema.set("toJSON", {
  transform: (doc, ret) => {
    ret.id = ret._id.toString();
    delete ret.__v;
    return ret;
  },
});

export const GoodsReceiptNote =
  mongoose.models.GoodsReceiptNote ||
  mongoose.model("GoodsReceiptNote", goodsReceiptNoteSchema);

