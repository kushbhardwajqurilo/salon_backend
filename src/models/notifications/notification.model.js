import mongoose from "mongoose";

const { Schema } = mongoose;

export const NOTIFICATION_STATUSES = Object.freeze([
  "pending",
  "queued",
  "processing",
  "sent",
  "delivered",
  "failed",
  "cancelled",
]);

export const NOTIFICATION_CHANNELS = Object.freeze([
  "email",
  "sms",
  "whatsapp",
  "in_app",
]);

export const RECIPIENT_TYPES = Object.freeze([
  "customer",
  "employee",
  "payer",
  "beneficiary",
  "admin",
]);

const notificationSchema = new Schema(
  {
    notificationId: {
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
    sourceEventId: {
      type: String,
      required: true,
      trim: true,
    },
    eventType: {
      type: String,
      required: true,
      trim: true,
    },
    purpose: {
      type: String,
      enum: ["transactional", "reminder", "operational", "marketing", "payroll"],
      required: true,
    },
    recipientType: {
      type: String,
      enum: RECIPIENT_TYPES,
      required: true,
    },
    recipientId: {
      type: Schema.Types.ObjectId,
      required: true,
    },
    channel: {
      type: String,
      enum: NOTIFICATION_CHANNELS,
      required: true,
    },
    status: {
      type: String,
      enum: NOTIFICATION_STATUSES,
      default: "pending",
      required: true,
    },
    idempotencyKey: {
      type: String,
      required: true,
      trim: true,
      maxlength: 250,
    },
    metadata: {
      type: Schema.Types.Mixed,
      default: {},
    },
    failureReason: {
      type: String,
      trim: true,
      maxlength: 500,
      default: null,
    },
    sentAt: {
      type: Date,
      default: null,
    },
    deliveredAt: {
      type: Date,
      default: null,
    },
    readAt: {
      type: Date,
      default: null,
    },
  },
  {
    timestamps: true,
  },
);

notificationSchema.index(
  { organizationId: 1, idempotencyKey: 1 },
  { unique: true },
);
notificationSchema.index({ organizationId: 1, recipientId: 1, createdAt: -1, _id: -1 });
notificationSchema.index({ organizationId: 1, createdAt: -1, _id: -1 });
notificationSchema.index({ organizationId: 1, recipientId: 1, readAt: 1 });
notificationSchema.index({ sourceEventId: 1 });

export const Notification = mongoose.model("Notification", notificationSchema);
