import mongoose from "mongoose";
import { normalizePhone } from "../../utils/phone.js";

const customerSchema = new mongoose.Schema(
  {
    name: {
      type: String,
      required: true,
      trim: true,
    },
    email: {
      type: String,
      trim: true,
      lowercase: true,
      default: null,
    },
    phone: {
      type: String,
      required: true,
      trim: true,
    },
    organizationId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Organization",
      required: true,
    },
    homeBranchId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Branch",
      required: true,
    },
    visitedBranchIds: [
      {
        type: mongoose.Schema.Types.ObjectId,
        ref: "Branch",
      },
    ],
    loyaltyPoints: {
      type: Number,
      default: 0,
    },
    gender: {
      type: String,
      enum: ["male", "female", "other", "prefer_not_to_say"],
      default: "prefer_not_to_say",
    },
    dateOfBirth: {
      type: Date,
      default: null,
    },
    alternatePhone: {
      type: String,
      trim: true,
      default: null,
    },
    address: {
      addressLine1: { type: String, default: "" },
      addressLine2: { type: String, default: "" },
      city: { type: String, default: "" },
      state: { type: String, default: "" },
      postalCode: { type: String, default: "" },
      country: { type: String, default: "" },
    },
    preferences: {
      preferredStaff: [
        {
          type: mongoose.Schema.Types.ObjectId,
          ref: "User",
        },
      ],
      preferredServices: [
        {
          type: mongoose.Schema.Types.ObjectId,
          ref: "Service",
        },
      ],
      drinkPreference: {
        type: String,
        default: "",
      },
      preferredContactTime: {
        type: String,
        default: "",
      },
      language: {
        type: String,
        default: "",
      },
      remarks: {
        type: String,
        default: "",
      },
    },
    marketingPreferences: {
      sms: { type: Boolean, default: false },
      email: { type: Boolean, default: false },
      whatsapp: { type: Boolean, default: false },
      promotions: { type: Boolean, default: false },
      appointmentReminders: { type: Boolean, default: false },
    },
    doNotContact: {
      type: Boolean,
      default: false,
    },
    acquisitionSource: {
      type: String,
      enum: ["walk_in", "instagram", "facebook", "google", "website", "advertisement", "referral", "other"],
      default: "walk_in",
    },
    referredByCustomerId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Customer",
      default: null,
    },
    tags: [String],
    status: {
      type: String,
      enum: ["active", "inactive", "blocked"],
      default: "active",
      index: true,
    },
    allergies: [String],
    sensitivities: [String],
    isDeleted: {
      type: Boolean,
      default: false,
      index: true,
    },
    deletedAt: {
      type: Date,
      default: null,
    },
  },
  {
    timestamps: true,
  }
);

customerSchema.pre("save", function () {
  if (this.phone) {
    this.phone = normalizePhone(this.phone);
  }
  if (this.alternatePhone) {
    this.alternatePhone = normalizePhone(this.alternatePhone);
  }
});

// Enforce unique phone number per organization for active customers
customerSchema.index(
  { organizationId: 1, phone: 1 },
  { unique: true, partialFilterExpression: { isDeleted: false } }
);
customerSchema.index({ organizationId: 1, homeBranchId: 1 });
customerSchema.index({ organizationId: 1, visitedBranchIds: 1 });
customerSchema.index({ organizationId: 1, isDeleted: 1, status: 1 });

export const Customer = mongoose.model("Customer", customerSchema);

