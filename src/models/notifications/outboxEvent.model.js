import mongoose from "mongoose";
import { NOTIFICATION_EVENT_TYPES } from "../../services/notifications/notificationEventContract.js";

const { Schema } = mongoose;

const outboxErrorSchema = new Schema(
  {
    code: { type: String, trim: true, default: null },
    message: { type: String, trim: true, maxlength: 500, default: null },
    occurredAt: { type: Date, default: null },
  },
  { _id: false },
);

const outboxEventSchema = new Schema(
  {
    eventId: {
      type: String,
      required: true,
      unique: true,
      trim: true,
    },
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
    eventType: {
      type: String,
      required: true,
      enum: NOTIFICATION_EVENT_TYPES,
      trim: true,
    },
    idempotencyKey: {
      type: String,
      required: true,
      trim: true,
      maxlength: 200,
    },
    schemaVersion: {
      type: Number,
      required: true,
      default: 1,
      min: 1,
    },
    payload: {
      type: Schema.Types.Mixed,
      required: true,
      default: {},
    },
    status: {
      type: String,
      enum: ["pending", "processing", "published", "failed"],
      default: "pending",
      required: true,
    },
    attempts: {
      type: Number,
      default: 0,
      min: 0,
    },
    availableAt: {
      type: Date,
      default: Date.now,
      required: true,
    },
    claimedAt: {
      type: Date,
      default: null,
    },
    claimedBy: {
      type: String,
      trim: true,
      default: null,
    },
    publishedAt: {
      type: Date,
      default: null,
    },
    lastError: {
      type: outboxErrorSchema,
      default: null,
    },
  },
  {
    timestamps: true,
  },
);

// Org-scoped idempotency guarantee
outboxEventSchema.index(
  { organizationId: 1, idempotencyKey: 1 },
  { unique: true },
);

// Relay polling index for pending/retryable events
outboxEventSchema.index({ status: 1, availableAt: 1 });

// Lease recovery index for stale processing events
outboxEventSchema.index({ status: 1, claimedAt: 1 });

// Tenant & branch audit/inspection index
outboxEventSchema.index({ organizationId: 1, branchId: 1, createdAt: -1 });

export const OutboxEvent = mongoose.model("OutboxEvent", outboxEventSchema);
