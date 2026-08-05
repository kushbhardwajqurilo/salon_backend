import mongoose from "mongoose";

const staffBranchSchema = new mongoose.Schema(
  {
    staffId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Staff",
      required: true,
    },
    branchId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Branch",
      required: true,
    },
    organizationId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Organization",
      required: true,
    },
    isPrimary: {
      type: Boolean,
      default: false,
    },
    isActive: {
      type: Boolean,
      default: true,
    },
  },
  {
    timestamps: true,
  }
);

// Indexes
staffBranchSchema.index(
  { organizationId: 1, staffId: 1, branchId: 1 },
  { unique: true, partialFilterExpression: { isActive: true } }
);
staffBranchSchema.index({ organizationId: 1, branchId: 1, staffId: 1 });

export const StaffBranch = mongoose.model("StaffBranch", staffBranchSchema);
