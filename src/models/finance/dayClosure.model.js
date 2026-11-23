import mongoose from "mongoose";

const dayClosureSchema = new mongoose.Schema(
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
    businessDate: {
      type: String, // "YYYY-MM-DD" in branch timezone
      required: true,
      trim: true,
    },
    branchTimezone: {
      type: String,
      required: true,
      trim: true,
      default: "Asia/Kolkata",
    },
    systemTotals: {
      cash: { type: Number, required: true, default: 0 },
      card: { type: Number, required: true, default: 0 },
      upi: { type: Number, required: true, default: 0 },
      other: { type: Number, required: true, default: 0 },
      totalCollected: { type: Number, required: true, default: 0 },
      totalRefunded: { type: Number, required: true, default: 0 },
      netExpected: { type: Number, required: true, default: 0 },
    },
    physicalCounts: {
      cash: { type: Number, required: true, default: 0 },
      card: { type: Number, required: true, default: 0 },
      upi: { type: Number, required: true, default: 0 },
      other: { type: Number, required: true, default: 0 },
      totalCounted: { type: Number, required: true, default: 0 },
    },
    discrepancy: {
      cashDelta: { type: Number, required: true, default: 0 },
      cardDelta: { type: Number, required: true, default: 0 },
      upiDelta: { type: Number, required: true, default: 0 },
      otherDelta: { type: Number, required: true, default: 0 },
      totalDelta: { type: Number, required: true, default: 0 },
      reason: { type: String, trim: true, default: "" },
    },
    reconciliationResult: {
      type: String,
      enum: ["balanced", "discrepant"],
      required: true,
      index: true,
    },
    status: {
      type: String,
      enum: ["submitted", "approved"],
      default: "submitted",
      required: true,
      index: true,
    },
    submittedBy: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "User",
      required: true,
    },
    submittedAt: {
      type: Date,
      required: true,
      default: Date.now,
    },
    approvedBy: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "User",
      default: null,
    },
    approvedAt: {
      type: Date,
      default: null,
    },
    managerNotes: {
      type: String,
      trim: true,
      default: "",
    },
  },
  { timestamps: true }
);

// Compound unique index ensuring exactly 1 day closure per branch per business date
dayClosureSchema.index({ organizationId: 1, branchId: 1, businessDate: 1 }, { unique: true });
dayClosureSchema.index({ organizationId: 1, branchId: 1, status: 1 });

dayClosureSchema.set("toJSON", {
  transform: (doc, ret) => {
    ret.id = ret._id.toString();
    delete ret.__v;
    return ret;
  },
});

export const DayClosure = mongoose.model("DayClosure", dayClosureSchema);
