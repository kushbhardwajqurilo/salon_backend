import mongoose from "mongoose";
import { auditPlugin } from "../../database/plugins/audit.js";

const batchItemErrorSchema = new mongoose.Schema(
  {
    appointmentId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Appointment",
      default: null,
    },
    appointmentServiceId: {
      type: mongoose.Schema.Types.ObjectId,
      default: null,
    },
    usageId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "SubscriptionUsage",
      default: null,
    },
    invoiceId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Invoice",
      default: null,
    },
    reason: {
      type: String,
      required: true,
      trim: true,
    },
    timestamp: {
      type: Date,
      default: Date.now,
    },
  },
  { _id: true }
);

const subscriptionCancellationOperationSchema = new mongoose.Schema(
  {
    operationId: {
      type: String,
      required: true,
      trim: true,
      index: true,
    },
    organizationId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Organization",
      required: true,
      index: true,
    },
    branchId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Branch",
      default: null,
      index: true,
    },
    subscriptionId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Subscription",
      required: true,
      index: true,
    },
    idempotencyKey: {
      type: String,
      trim: true,
      default: null,
      index: true,
    },
    status: {
      type: String,
      enum: ["pending", "processing", "completed", "failed", "requires_reconciliation"],
      default: "pending",
      required: true,
      index: true,
    },
    cancellationReason: {
      type: String,
      trim: true,
      maxlength: 1000,
      default: "",
    },
    initiatedBy: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "User",
      required: true,
    },
    // Progress Counters
    totalUsageCount: {
      type: Number,
      default: 0,
      min: 0,
    },
    totalAppointmentCount: {
      type: Number,
      default: 0,
      min: 0,
    },
    totalServiceLineCount: {
      type: Number,
      default: 0,
      min: 0,
    },
    processedUsageCount: {
      type: Number,
      default: 0,
      min: 0,
    },
    processedAppointmentCount: {
      type: Number,
      default: 0,
      min: 0,
    },
    processedServiceLineCount: {
      type: Number,
      default: 0,
      min: 0,
    },
    // Breakdown of appointment statuses
    breakdown: {
      pendingAppointments: { type: Number, default: 0 },
      completedAppointments: { type: Number, default: 0 },
      otherAppointments: { type: Number, default: 0 },
    },
    // Snapshot of affected IDs to guarantee deterministic processing
    affectedUsageIds: [
      {
        type: mongoose.Schema.Types.ObjectId,
        ref: "SubscriptionUsage",
      },
    ],
    affectedAppointmentIds: [
      {
        type: mongoose.Schema.Types.ObjectId,
        ref: "Appointment",
      },
    ],
    affectedInvoiceIds: [
      {
        type: mongoose.Schema.Types.ObjectId,
        ref: "Invoice",
      },
    ],
    // Processed Batches tracking for idempotency and recovery
    completedBatchIndexes: {
      type: [Number],
      default: [],
    },
    // Reconciliation and error recording
    operationErrors: {
      type: [batchItemErrorSchema],
      default: [],
    },
    startedAt: {
      type: Date,
      default: null,
    },
    completedAt: {
      type: Date,
      default: null,
    },
    requestPayloadHash: {
      type: String,
      trim: true,
      default: null,
    },
    metadata: {
      type: mongoose.Schema.Types.Mixed,
      default: {},
    },
    workerLockToken: {
      type: String,
      default: null,
      index: true,
    },
    heartbeatAt: {
      type: Date,
      default: null,
    },
  },
  {
    timestamps: true,
  }
);

subscriptionCancellationOperationSchema.index(
  { organizationId: 1, idempotencyKey: 1 },
  {
    unique: true,
    partialFilterExpression: {
      idempotencyKey: { $type: "string" },
    },
  }
);

subscriptionCancellationOperationSchema.index({ organizationId: 1, subscriptionId: 1, status: 1 });

subscriptionCancellationOperationSchema.plugin(auditPlugin);

export const SubscriptionCancellationOperation = mongoose.model(
  "SubscriptionCancellationOperation",
  subscriptionCancellationOperationSchema
);
