import mongoose from "mongoose";

const organizationSchema = new mongoose.Schema(
  {
    name: {
      type: String,
      required: true,
      trim: true,
    },
    logo: {
      type: String,
      default: null,
    },
    isActive: {
      type: Boolean,
      default: true,
    },
    expenseApprovalThreshold: {
      type: Number,
      default: 5000,
      min: 0,
    },
    allowedExpenseCategories: {
      type: [String],
      default: [
        "utilities",
        "maintenance",
        "consumables",
        "refreshments",
        "marketing",
        "other",
      ],
    },
  },
  {
    timestamps: true,
  }
);

export const Organization = mongoose.model("Organization", organizationSchema);
