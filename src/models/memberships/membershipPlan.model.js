import mongoose from "mongoose";
import { auditPlugin } from "../../database/plugins/audit.js";

/**
 * Membership Benefits Schema
 * Defines policy-driven percentage discounts, complimentary perks, or priority tier rules.
 * Does not duplicate Subscription service unit entitlements.
 */
const membershipBenefitsSchema = new mongoose.Schema(
  {
    serviceDiscountPercentage: {
      type: Number,
      default: 0,
      min: [0, "Service discount percentage cannot be negative"],
      max: [100, "Service discount percentage cannot exceed 100%"],
    },
    productDiscountPercentage: {
      type: Number,
      default: 0,
      min: [0, "Product discount percentage cannot be negative"],
      max: [100, "Product discount percentage cannot exceed 100%"],
    },
    // Optional category exclusions or specific inclusions
    eligibleServiceCategoryIds: [
      {
        type: mongoose.Schema.Types.ObjectId,
        ref: "ServiceCategory",
      },
    ],
    eligibleServiceIds: [
      {
        type: mongoose.Schema.Types.ObjectId,
        ref: "Service",
      },
    ],
    excludedServiceCategoryIds: [
      {
        type: mongoose.Schema.Types.ObjectId,
        ref: "ServiceCategory",
      },
    ],
    excludedServiceIds: [
      {
        type: mongoose.Schema.Types.ObjectId,
        ref: "Service",
      },
    ],
    complimentaryPerks: {
      type: [String],
      default: [],
    },
  },
  { _id: false }
);

const membershipPlanSchema = new mongoose.Schema(
  {
    organizationId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Organization",
      required: true,
      index: true,
    },
    name: {
      type: String,
      required: true,
      trim: true,
    },
    code: {
      type: String,
      trim: true,
      uppercase: true,
      default: null,
    },
    tier: {
      type: String,
      trim: true,
      default: "Standard",
    },
    description: {
      type: String,
      trim: true,
      default: "",
    },
    termsAndConditions: {
      type: String,
      trim: true,
      default: "",
    },
    price: {
      type: Number,
      required: true,
      min: [0, "Membership price must be non-negative"],
    },
    validityUnit: {
      type: String,
      enum: ["days", "months", "years"],
      default: "months",
    },
    validityDuration: {
      type: Number,
      default: 12,
      min: [1, "Validity duration must be at least 1"],
    },
    validityMonths: {
      type: Number,
      required: true,
      min: [1, "Validity must be at least 1 month"],
    },
    benefits: {
      type: membershipBenefitsSchema,
      required: true,
      default: () => ({}),
    },
    beneficiaryPolicy: {
      allowMultipleBeneficiaries: { type: Boolean, default: false },
      maxBeneficiaries: { type: Number, default: 1, min: 1 },
      payerMustBeBeneficiary: { type: Boolean, default: false },
      allowBeneficiaryChanges: { type: Boolean, default: true },
    },
    maxBeneficiaries: {
      type: Number,
      default: 1,
      min: [1, "Max beneficiaries must be at least 1"],
    },
    permittedBranchIds: [
      {
        type: mongoose.Schema.Types.ObjectId,
        ref: "Branch",
      },
    ],
    isActive: {
      type: Boolean,
      default: true,
      index: true,
    },
    isDeleted: {
      type: Boolean,
      default: false,
      index: true,
    },
  },
  {
    timestamps: true,
  }
);

// Unique code per organization when code is provided (sparse partial index)
membershipPlanSchema.index(
  { organizationId: 1, code: 1 },
  {
    unique: true,
    partialFilterExpression: { code: { $type: "string" }, isDeleted: false },
  }
);

// Fast lookups by org and active status
membershipPlanSchema.index({ organizationId: 1, isActive: 1, isDeleted: 1 });

membershipPlanSchema.set("toJSON", {
  transform: (doc, ret) => {
    ret.id = ret._id.toString();
    delete ret.__v;
    return ret;
  },
});

membershipPlanSchema.plugin(auditPlugin);

export const MembershipPlan = mongoose.model(
  "MembershipPlan",
  membershipPlanSchema
);

