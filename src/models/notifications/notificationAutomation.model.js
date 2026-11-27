import mongoose from "mongoose";
import { NOTIFICATION_EVENT_TYPES } from "../../services/notifications/notificationEventContract.js";

const { Schema } = mongoose;

const notificationAutomationSchema = new Schema(
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
    name: {
      type: String,
      required: true,
      trim: true,
      maxlength: 120,
    },
    description: {
      type: String,
      trim: true,
      maxlength: 500,
      default: "",
    },
    triggerType: {
      type: String,
      enum: ["event", "schedule"],
      required: true,
    },
    eventType: {
      type: String,
      enum: NOTIFICATION_EVENT_TYPES,
      required: true,
    },
    scheduleCron: {
      type: String,
      trim: true,
      default: null,
    },
    channel: {
      type: String,
      enum: ["email", "sms"],
      required: true,
    },
    purpose: {
      type: String,
      enum: ["transactional", "reminder", "operational", "marketing", "payroll"],
      required: true,
    },
    templateId: {
      type: Schema.Types.ObjectId,
      ref: "NotificationTemplate",
      default: null,
    },
    isEnabled: {
      type: Boolean,
      default: true,
    },
    createdBy: {
      type: Schema.Types.ObjectId,
      ref: "User",
      default: null,
    },
    updatedBy: {
      type: Schema.Types.ObjectId,
      ref: "User",
      default: null,
    },
  },
  {
    timestamps: true,
  },
);

notificationAutomationSchema.index({ organizationId: 1, isEnabled: 1, triggerType: 1 });
notificationAutomationSchema.index({ organizationId: 1, branchId: 1 });

export const NotificationAutomation = mongoose.model(
  "NotificationAutomation",
  notificationAutomationSchema,
);
