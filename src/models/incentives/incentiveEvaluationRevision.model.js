import mongoose from "mongoose";

const { Schema } = mongoose;

const MAX_SAFE_PAISE = 10_000_000_000_000; // 10^13 paise

/**
 * IncentiveEvaluationRevision Schema
 * Strictly append-only audit trail of manual adjustments or overrides to IncentiveEvaluation records.
 */
const incentiveEvaluationRevisionSchema = new Schema(
  {
    organizationId: {
      type: Schema.Types.ObjectId,
      ref: "Organization",
      required: true,
      index: true,
    },
    evaluationId: {
      type: Schema.Types.ObjectId,
      ref: "IncentiveEvaluation",
      required: true,
      index: true,
    },
    revisionNumber: {
      type: Number,
      required: true,
      min: 1,
      validate: {
        validator: Number.isInteger,
        message: "{VALUE} must be an integer revision number",
      },
    },
    previousValueInPaise: {
      type: Number,
      required: true,
      min: [0, "previousValueInPaise cannot be negative"],
      max: [MAX_SAFE_PAISE, "previousValueInPaise exceeds safe limit"],
      validate: {
        validator: Number.isInteger,
        message: "{VALUE} is not an integer paise value",
      },
    },
    newValueInPaise: {
      type: Number,
      required: true,
      min: [0, "newValueInPaise cannot be negative"],
      max: [MAX_SAFE_PAISE, "newValueInPaise exceeds safe limit"],
      validate: {
        validator: Number.isInteger,
        message: "{VALUE} is not an integer paise value",
      },
    },
    deltaInPaise: {
      type: Number,
      required: true,
      min: [-MAX_SAFE_PAISE, "deltaInPaise exceeds negative safe limit"],
      max: [MAX_SAFE_PAISE, "deltaInPaise exceeds positive safe limit"],
      validate: {
        validator: Number.isInteger,
        message: "{VALUE} is not an integer paise value",
      },
    },
    reason: {
      type: String,
      required: true,
      trim: true,
      minlength: 3,
    },
    adjustedBy: {
      type: Schema.Types.ObjectId,
      ref: "User",
      required: true,
    },
    adjustedAt: {
      type: Date,
      default: Date.now,
    },
  },
  {
    timestamps: true,
  }
);

// Compound Unique Index: Strictly monotonically increasing revisions per evaluation
incentiveEvaluationRevisionSchema.index(
  { organizationId: 1, evaluationId: 1, revisionNumber: 1 },
  { unique: true }
);

export const IncentiveEvaluationRevision = mongoose.model(
  "IncentiveEvaluationRevision",
  incentiveEvaluationRevisionSchema
);
