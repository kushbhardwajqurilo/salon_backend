import mongoose from "mongoose";
import { auditPlugin } from "../../database/plugins/audit.js";
import { sourceAttributionSchema } from "../staff/staffAttribution.schema.js";

const customerMembershipSchema = new mongoose.Schema(
  {
    organizationId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Organization",
      required: true,
      index: true,
    },
    customerId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Customer",
      required: true,
      index: true,
    },
    payerCustomerId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Customer",
      default: function () {
        return this.customerId;
      },
      index: true,
    },
    membershipPurchaseId: {
      type: mongoose.Schema.Types.ObjectId,
      default: () => new mongoose.Types.ObjectId(),
      index: true,
    },
    membershipPlanId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "MembershipPlan",
      required: true,
      index: true,
    },
    attribution: {
      type: sourceAttributionSchema,
      default: () => ({}),
    },
    membershipCode: {
      type: String,
      required: true,
      trim: true,
    },
    // Snapshot of plan details and benefit configuration at purchase time
    planSnapshot: {
      name: { type: String, required: true },
      tier: { type: String, default: "Standard" },
      price: { type: Number, required: true },
      validityMonths: { type: Number, required: true },
      benefits: {
        serviceDiscountPercentage: { type: Number, default: 0 },
        productDiscountPercentage: { type: Number, default: 0 },
        complimentaryPerks: { type: [String], default: [] },
      },
    },
    status: {
      type: String,
      enum: ["pending_payment", "active", "expired", "cancelled"],
      default: "pending_payment",
      required: true,
      index: true,
    },
    startDate: {
      type: Date,
      required: true,
    },
    endDate: {
      type: Date,
      required: true,
      index: true,
    },
    permittedBranchIds: [
      {
        type: mongoose.Schema.Types.ObjectId,
        ref: "Branch",
      },
    ],
    invoiceId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Invoice",
      default: null,
      index: true,
    },
    cancelledAt: {
      type: Date,
      default: null,
    },
    cancelledBy: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "User",
      default: null,
    },
    cancellationReason: {
      type: String,
      trim: true,
      default: null,
      maxlength: 500,
    },
    refundPaymentId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Payment",
      default: null,
    },
    lastBenefitReservationAt: {
      type: Date,
      default: null,
    },
    lastBenefitReservationInvoiceId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Invoice",
      default: null,
    },
    notes: {
      type: String,
      trim: true,
      default: "",
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

// Indexes for tenant isolation and quick active lookup
customerMembershipSchema.index({ organizationId: 1, membershipCode: 1 }, { unique: true });
customerMembershipSchema.index({ organizationId: 1, customerId: 1, status: 1 });
customerMembershipSchema.index({ organizationId: 1, payerCustomerId: 1 });
customerMembershipSchema.index({ organizationId: 1, membershipPurchaseId: 1 });
customerMembershipSchema.index({ organizationId: 1, endDate: 1, status: 1 });

customerMembershipSchema.set("toJSON", {
  transform: (doc, ret) => {
    ret.id = ret._id.toString();
    delete ret.__v;
    return ret;
  },
});

customerMembershipSchema.plugin(auditPlugin);

export const CustomerMembership = mongoose.model(
  "CustomerMembership",
  customerMembershipSchema
);

