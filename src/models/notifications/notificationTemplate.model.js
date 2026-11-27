import mongoose from "mongoose";
import { NOTIFICATION_EVENT_TYPES } from "../../services/notifications/notificationEventContract.js";

const { Schema } = mongoose;

const notificationTemplateSchema = new Schema(
  {
    organizationId: {
      type: Schema.Types.ObjectId,
      ref: "Organization",
      default: null, // null = global default template
    },
    eventType: {
      type: String,
      required: true,
      enum: NOTIFICATION_EVENT_TYPES,
      trim: true,
    },
    channel: {
      type: String,
      required: true,
      enum: ["email", "sms"],
    },
    purpose: {
      type: String,
      required: true,
      enum: ["transactional", "reminder", "operational", "marketing", "payroll"],
    },
    subject: {
      type: String,
      trim: true,
      maxlength: 200,
      default: "",
    },
    body: {
      type: String,
      required: true,
      maxlength: 4000,
    },
    allowedVariables: {
      type: [String],
      default: [],
    },
    isActive: {
      type: Boolean,
      default: true,
    },
  },
  {
    timestamps: true,
  },
);

notificationTemplateSchema.index(
  { organizationId: 1, eventType: 1, channel: 1 },
  { unique: true },
);

export const NotificationTemplate = mongoose.model(
  "NotificationTemplate",
  notificationTemplateSchema,
);
