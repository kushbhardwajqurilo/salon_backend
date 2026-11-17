import mongoose from "mongoose";
import { auditPlugin } from "../../database/plugins/audit.js";

const { Schema } = mongoose;

const MAX_SAFE_PAISE = 10_000_000_000_000; // 10^13 paise (₹100 Crore ceiling)

/**
 * Tier Schema for graduated revenue/service commission calculation
 */
const tierSchema = new Schema(
  {
    minPaise: {
      type: Number,
      required: true,
      min: [0, "minPaise cannot be negative"],
      max: [MAX_SAFE_PAISE, "minPaise exceeds safe limit"],
      validate: {
        validator: Number.isInteger,
        message: "{VALUE} is not an integer paise value",
      },
    },
    maxPaise: {
      type: Number,
      default: null,
      validate: [
        {
          validator: (v) => v === null || Number.isInteger(v),
          message: "{VALUE} must be null or an integer paise value",
        },
        {
          validator: function (v) {
            return v === null || (v >= 0 && v <= MAX_SAFE_PAISE && v >= this.minPaise);
          },
          message: "maxPaise must be greater than or equal to minPaise",
        },
      ],
    },
    percentage: {
      type: Number,
      required: true,
      min: [0, "Percentage cannot be negative"],
      max: [100, "Percentage cannot exceed 100%"],
    },
    fixedPaise: {
      type: Number,
      default: 0,
      min: [0, "fixedPaise cannot be negative"],
      max: [MAX_SAFE_PAISE, "fixedPaise exceeds safe limit"],
      validate: {
        validator: Number.isInteger,
        message: "{VALUE} is not an integer paise value",
      },
    },
  },
  { _id: true }
);

/**
 * IncentiveScheme Schema
 * Encapsulates commission schemes, target bonuses, and attendance rules.
 */
const incentiveSchemeSchema = new Schema(
  {
    organizationId: {
      type: Schema.Types.ObjectId,
      ref: "Organization",
      required: true,
      index: true,
    },
    name: {
      type: String,
      required: true,
      trim: true,
      minlength: 2,
      maxlength: 120,
    },
    code: {
      type: String,
      required: true,
      trim: true,
      uppercase: true,
    },
    description: {
      type: String,
      trim: true,
      default: "",
    },
    schemeType: {
      type: String,
      required: true,
      enum: ["COMMISSION", "TARGET_BONUS", "ATTENDANCE_BONUS", "HYBRID"],
    },
    calculationBasis: {
      type: String,
      required: true,
      enum: [
        "SERVICE_NET_REVENUE",
        "SUBSCRIPTION_NET_REVENUE",
        "MEMBERSHIP_NET_REVENUE",
        "PRODUCT_NET_REVENUE",
        "TOTAL_INVOICE_NET_REVENUE",
        "SERVICE_COUNT",
        "ATTENDANCE_DAYS",
      ],
      default: "SERVICE_NET_REVENUE",
    },
    rules: {
      tiers: {
        type: [tierSchema],
        default: [],
      },
      fixedAmountPaise: {
        type: Number,
        default: 0,
        min: [0, "fixedAmountPaise cannot be negative"],
        max: [MAX_SAFE_PAISE, "fixedAmountPaise exceeds safe limit"],
        validate: {
          validator: Number.isInteger,
          message: "{VALUE} is not an integer paise value",
        },
      },
      targetThresholdPaise: {
        type: Number,
        default: 0,
        min: [0, "targetThresholdPaise cannot be negative"],
        max: [MAX_SAFE_PAISE, "targetThresholdPaise exceeds safe limit"],
        validate: {
          validator: Number.isInteger,
          message: "{VALUE} is not an integer paise value",
        },
      },
      minimumAttendanceDays: {
        type: Number,
        default: 0,
        min: 0,
        max: 31,
      },
    },
    status: {
      type: String,
      required: true,
      enum: ["draft", "active", "paused", "inactive", "archived"],
      default: "draft",
      index: true,
    },
  },
  {
    timestamps: true,
  }
);

// Compound Unique Index: scheme code must be unique within an organization
incentiveSchemeSchema.index(
  { organizationId: 1, code: 1 },
  { unique: true }
);

// Audit Plugin integration
incentiveSchemeSchema.plugin(auditPlugin);

export const IncentiveScheme = mongoose.model("IncentiveScheme", incentiveSchemeSchema);
