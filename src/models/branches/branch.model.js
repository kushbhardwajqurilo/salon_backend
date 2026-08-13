import mongoose from "mongoose";

const branchSchema = new mongoose.Schema(
  {
    organizationId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Organization",
      required: true,
    },
    name: {
      type: String,
      required: true,
      trim: true,
    },
    address: {
      type: String,
      default: null,
    },
    phone: {
      type: String,
      default: null,
    },
    isActive: {
      type: Boolean,
      default: true,
    },
    timezone: {
      type: String,
      default: "Asia/Kolkata",
      trim: true,
    },
  },
  {
    timestamps: true,
  }
);

branchSchema.index({ organizationId: 1, name: 1 }, { unique: true });

export const Branch = mongoose.model("Branch", branchSchema);
