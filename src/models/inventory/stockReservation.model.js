import mongoose from "mongoose";

export const RESERVATION_STATUS = ["active", "consumed", "released", "expired"];

const stockReservationSchema = new mongoose.Schema(
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
    invoiceId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Invoice",
      required: true,
      index: true,
    },
    productId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Product",
      required: true,
      index: true,
    },
    quantity: {
      type: Number,
      required: true,
      min: 0.001,
    },
    status: {
      type: String,
      enum: RESERVATION_STATUS,
      default: "active",
      index: true,
    },
    expiresAt: {
      type: Date,
      required: true,
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

stockReservationSchema.index({ organizationId: 1, branchId: 1, invoiceId: 1, status: 1 });
stockReservationSchema.index({ status: 1, expiresAt: 1 });

export const StockReservation = mongoose.model("StockReservation", stockReservationSchema);

