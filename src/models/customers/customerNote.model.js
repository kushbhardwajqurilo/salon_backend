import mongoose from "mongoose";

const customerNoteSchema = new mongoose.Schema(
  {
    organizationId: {
      type: mongoose.Schema.Types.Mixed,
      ref: "Organization",
      required: true,
    },
    branchId: {
      type: mongoose.Schema.Types.Mixed,
      ref: "Branch",
      required: true,
    },
    customerId: {
      type: mongoose.Schema.Types.Mixed,
      ref: "Customer",
      required: true,
    },
    text: {
      type: String,
      required: true,
      trim: true,
      maxlength: 2000,
    },
    createdBy: {
      type: mongoose.Schema.Types.Mixed,
      ref: "User",
      required: true,
    },
  },
  {
    timestamps: true,
  }
);

// Indexes
customerNoteSchema.index({ organizationId: 1, customerId: 1, createdAt: -1 });
customerNoteSchema.index({ organizationId: 1, branchId: 1 });

export const CustomerNote = mongoose.model("CustomerNote", customerNoteSchema);
