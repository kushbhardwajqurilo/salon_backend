import mongoose from "mongoose";

const { Schema } = mongoose;

export const EXPORT_DOMAINS = Object.freeze([
  "staff",
  "customers",
  "appointments",
  "attendance",
  "leaves",
]);

export const EXPORT_FORMATS = Object.freeze(["json", "csv"]);

const exportJobSchema = new Schema(
  {
    organizationId: {
      type: Schema.Types.ObjectId,
      ref: "Organization",
      required: true,
    },
    branchId: {
      type: Schema.Types.ObjectId,
      ref: "Branch",
      default: null,
    },
    requestedBy: {
      type: Schema.Types.ObjectId,
      ref: "User",
      required: true,
    },
    domain: {
      type: String,
      enum: EXPORT_DOMAINS,
      required: true,
    },
    format: {
      type: String,
      enum: EXPORT_FORMATS,
      required: true,
    },
    status: {
      type: String,
      enum: ["pending", "processing", "completed", "failed", "expired"],
      default: "pending",
      required: true,
    },
    idempotencyKey: {
      type: String,
      trim: true,
      default: null,
    },
    recordCount: {
      type: Number,
      default: 0,
    },
    payloadContent: {
      type: String,
      default: null,
      select: false,
    },
    expiresAt: {
      type: Date,
      required: true,
    },
    completedAt: {
      type: Date,
      default: null,
    },
    errorMessage: {
      type: String,
      default: null,
    },
  },
  {
    timestamps: true,
  }
);

exportJobSchema.index({ organizationId: 1, branchId: 1, createdAt: -1 });
exportJobSchema.index({ expiresAt: 1 }, { expireAfterSeconds: 0 });
exportJobSchema.index(
  { organizationId: 1, idempotencyKey: 1 },
  {
    unique: true,
    partialFilterExpression: { idempotencyKey: { $type: "string" } },
    name: "uniq_export_job_idempotency",
  }
);

export const ExportJob =
  mongoose.models.ExportJob || mongoose.model("ExportJob", exportJobSchema);
