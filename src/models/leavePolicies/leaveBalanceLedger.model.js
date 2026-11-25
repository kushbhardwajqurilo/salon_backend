import mongoose from "mongoose";

const { Schema } = mongoose;

const leaveBalanceLedgerSchema = new Schema(
  {
    organizationId: {
      type: Schema.Types.ObjectId,
      ref: "Organization",
      required: true,
    },
    staffId: {
      type: Schema.Types.ObjectId,
      ref: "Staff",
      required: true,
    },
    leavePolicyId: {
      type: Schema.Types.ObjectId,
      ref: "LeavePolicy",
      required: true,
    },
    leaveId: {
      type: Schema.Types.ObjectId,
      ref: "Leave",
      default: null,
    },
    periodYear: {
      type: Number,
      required: true,
    },
    entryType: {
      type: String,
      enum: ["grant", "deduction", "restoration", "adjustment"],
      required: true,
    },
    deltaDays: {
      type: Number,
      required: true,
    },
    balanceAfter: {
      type: Number,
      required: true,
    },
    idempotencyKey: {
      type: String,
      required: true,
      trim: true,
    },
    reason: {
      type: String,
      trim: true,
      default: null,
    },
    actorId: {
      type: Schema.Types.ObjectId,
      ref: "User",
      default: null,
    },
  },
  {
    timestamps: { createdAt: true, updatedAt: false },
  }
);

leaveBalanceLedgerSchema.index(
  { organizationId: 1, idempotencyKey: 1 },
  { unique: true, name: "uniq_leave_ledger_idempotency" }
);
leaveBalanceLedgerSchema.index({ organizationId: 1, staffId: 1, periodYear: 1, createdAt: -1 });

export const LeaveBalanceLedger =
  mongoose.models.LeaveBalanceLedger ||
  mongoose.model("LeaveBalanceLedger", leaveBalanceLedgerSchema);
