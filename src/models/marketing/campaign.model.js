import mongoose from "mongoose";

export const CAMPAIGN_CHANNELS = [
  "google_ads",
  "meta_ads",
  "instagram",
  "sms",
  "whatsapp",
  "email",
  "influencer",
  "flyer_print",
  "referral_program",
  "walk_in_promo",
  "other",
];

export const CAMPAIGN_STATUSES = ["draft", "active", "paused", "completed", "archived"];

const campaignSchema = new mongoose.Schema(
  {
    organizationId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Organization",
      required: true,
      index: true,
    },
    branchId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Branch",
      required: true,
      index: true,
    },
    name: {
      type: String,
      required: true,
      trim: true,
    },
    campaignCode: {
      type: String,
      required: true,
      trim: true,
      uppercase: true,
    },
    channel: {
      type: String,
      enum: CAMPAIGN_CHANNELS,
      required: true,
      index: true,
    },
    status: {
      type: String,
      enum: CAMPAIGN_STATUSES,
      default: "draft",
      index: true,
    },
    startDate: {
      type: Date,
      required: true,
      index: true,
    },
    endDate: {
      type: Date,
      default: null,
      index: true,
    },
    budgetPaise: {
      type: Number,
      default: 0,
      min: 0,
    },
    targetAudience: {
      type: String,
      trim: true,
      default: "",
    },
    utmSource: {
      type: String,
      trim: true,
      default: null,
    },
    utmMedium: {
      type: String,
      trim: true,
      default: null,
    },
    utmCampaign: {
      type: String,
      trim: true,
      default: null,
    },
    // Attribution window in days (default: 14 days)
    attributionWindowDays: {
      type: Number,
      default: 14,
      min: 1,
      max: 90,
    },
    createdBy: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "User",
      required: true,
    },
    updatedBy: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "User",
      required: true,
    },
  },
  {
    timestamps: true,
  }
);

// Indexes
campaignSchema.index({ organizationId: 1, campaignCode: 1 }, { unique: true });
campaignSchema.index({ organizationId: 1, branchId: 1, status: 1, startDate: -1 });

campaignSchema.set("toJSON", {
  transform: (doc, ret) => {
    ret.id = ret._id.toString();
    ret.budget = (ret.budgetPaise || 0) / 100;
    delete ret.__v;
    return ret;
  },
});

export const Campaign = mongoose.models.Campaign || mongoose.model("Campaign", campaignSchema);
