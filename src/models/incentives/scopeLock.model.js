import mongoose from "mongoose";

const { Schema } = mongoose;

/**
 * ScopeLock Schema
 * Provides mutual exclusion and serialization locks for assignment mutations,
 * scheme adjustments, and payout batching across organization, branch, and role scopes.
 */
const scopeLockSchema = new Schema(
  {
    organizationId: {
      type: Schema.Types.ObjectId,
      ref: "Organization",
      required: true,
      index: true,
    },
    scopeType: {
      type: String,
      required: true,
      enum: ["ORGANIZATION", "BRANCH", "ROLE", "STAFF"],
    },
    scopeKey: {
      type: String,
      required: true,
      trim: true,
    },
    lockedAt: {
      type: Date,
      default: Date.now,
    },
    lockOwner: {
      type: String,
      required: true,
      trim: true,
    },
    leaseExpiresAt: {
      type: Date,
      default: null,
      index: true,
    },
  },
  {
    timestamps: true,
  }
);

// Compound Unique Index: Strictly one lock document per logical scope entity within an organization
scopeLockSchema.index(
  { organizationId: 1, scopeType: 1, scopeKey: 1 },
  { unique: true }
);

export const ScopeLock = mongoose.model("ScopeLock", scopeLockSchema);
