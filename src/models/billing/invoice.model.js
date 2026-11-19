import mongoose from "mongoose";
import { sourceAttributionSchema } from "../staff/staffAttribution.schema.js";

const invoiceCustomerSnapshotSchema = new mongoose.Schema(
  {
    name: { type: String, required: true, trim: true },
    phone: { type: String, required: true, trim: true },
    email: { type: String, default: null, trim: true, lowercase: true },
  },
  { _id: false }
);

const invoiceCouponSnapshotSchema = new mongoose.Schema(
  {
    couponId: { type: mongoose.Schema.Types.ObjectId, ref: "Coupon", required: true },
    code: { type: String, required: true, trim: true },
    codeUpper: { type: String, required: true, trim: true, uppercase: true },
    discountType: { type: String, enum: ["fixed", "percentage"], required: true },
    discountValue: { type: Number, required: true, min: 0 },
    calculatedDiscountAmount: { type: Number, required: true, min: 0 },
    appliedAt: { type: Date, default: Date.now },
    appliedBy: { type: mongoose.Schema.Types.ObjectId, ref: "User", default: null },
    usageLedgerId: { type: mongoose.Schema.Types.ObjectId, ref: "CouponUsage", default: null },
  },
  { _id: false }
);

const appointmentPricingSnapshotSchema = new mongoose.Schema(
  {
    subtotal: { type: Number, required: true, min: 0 },
    discount: { type: Number, required: true, min: 0 },
    total: { type: Number, required: true, min: 0 },
  },
  { _id: false }
);

const discountAllocationSchema = new mongoose.Schema(
  {
    lineId: { type: mongoose.Schema.Types.ObjectId, required: true },
    lineName: { type: String, default: null },
    allocatedAmount: { type: Number, required: true, min: 0 },
  },
  { _id: false }
);

const activeDiscountItemSchema = new mongoose.Schema(
  {
    discountId: { type: mongoose.Schema.Types.ObjectId, default: () => new mongoose.Types.ObjectId() },
    name: { type: String, trim: true, default: "Discount" },
    discountLevel: {
      type: String,
      enum: ["line", "selected_lines", "invoice"],
      required: true,
    },
    lineId: { type: mongoose.Schema.Types.ObjectId, default: null },
    lineIds: { type: [mongoose.Schema.Types.ObjectId], default: undefined },
    discountType: {
      type: String,
      enum: ["fixed", "percentage"],
      required: true,
    },
    enteredValue: { type: Number, required: true, min: 0 },
    calculatedAmount: { type: Number, required: true, min: 0 },
    reason: { type: String, required: true, trim: true, maxlength: 500 },
    appliedBy: { type: mongoose.Schema.Types.ObjectId, ref: "User", default: null },
    appliedAt: { type: Date, default: Date.now },
    isLegacy: { type: Boolean, default: false },
  },
  { _id: false }
);

const discountHistorySnapshotSchema = new mongoose.Schema(
  {
    subtotal: { type: Number, required: true },
    subscriptionCoveredAmount: { type: Number, required: true },
    eligibleUncoveredAmount: { type: Number, default: 0 },
    lineDiscountsTotal: { type: Number, required: true },
    invoiceDiscountsTotal: { type: Number, required: true },
    loyaltyDiscountAmount: { type: Number, default: 0 },
    discountTotal: { type: Number, required: true },
    grossPayable: { type: Number, default: 0 },
    payableAmount: { type: Number, required: true },
    amountPaid: { type: Number, required: true },
    amountDue: { type: Number, required: true },
    paymentStatus: { type: String, default: "unpaid" },
  },
  { _id: false }
);

const discountHistorySchema = new mongoose.Schema(
  {
    historyId: { type: mongoose.Schema.Types.ObjectId, default: () => new mongoose.Types.ObjectId() },
    action: {
      type: String,
      enum: ["applied", "modified", "removed"],
      required: true,
    },
    discountId: { type: mongoose.Schema.Types.ObjectId, required: true },
    discountLevel: {
      type: String,
      enum: ["line", "selected_lines", "invoice"],
      required: true,
    },
    lineId: { type: mongoose.Schema.Types.ObjectId, default: null },
    lineIds: { type: [mongoose.Schema.Types.ObjectId], default: undefined },
    lineName: { type: String, default: null },
    allocations: { type: [discountAllocationSchema], default: undefined },
    discountType: {
      type: String,
      enum: ["fixed", "percentage"],
      required: true,
    },
    enteredValue: { type: Number, required: true, min: 0 },
    calculatedAmount: { type: Number, required: true, min: 0 },
    reason: { type: String, required: true, trim: true, minlength: 3, maxlength: 500 },
    performedBy: { type: mongoose.Schema.Types.ObjectId, ref: "User", default: null },
    performedAt: { type: Date, default: Date.now },
    snapshotBefore: { type: discountHistorySnapshotSchema, required: true },
    snapshotAfter: { type: discountHistorySnapshotSchema, required: true },
    notes: { type: String, default: "" },
  },
  { _id: false }
);

const invoiceLineSchema = new mongoose.Schema(
  {
    lineType: {
      type: String,
      enum: ["service", "subscription", "product", "membership"],
      default: "service",
      required: true,
    },
    serviceType: {
      type: String,
      enum: ["registered", "custom"],
      default: "registered",
      required: function () {
        return this.lineType === "service";
      },
    },
    serviceId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Service",
      required: function () {
        return this.lineType === "service" && this.serviceType === "registered";
      },
      default: null,
    },
    staffId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Staff",
      default: null,
    },
    attribution: {
      type: sourceAttributionSchema,
      default: () => ({}),
    },
    subscriptionId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Subscription",
      default: null,
    },
    subscriptionPlanId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "SubscriptionPlan",
      default: null,
    },
    // Membership purchase fields
    membershipPlanId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "MembershipPlan",
      required: function () {
        return this.lineType === "membership";
      },
      default: null,
    },
    customerMembershipId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "CustomerMembership",
      default: null,
    },
    // Multi-beneficiary membership support
    customerMembershipIds: [
      {
        type: mongoose.Schema.Types.ObjectId,
        ref: "CustomerMembership",
      },
    ],
    beneficiaryCustomerIds: [
      {
        type: mongoose.Schema.Types.ObjectId,
        ref: "Customer",
      },
    ],
    // Per-beneficiary independent benefit configurations
    beneficiaryOverrides: [
      {
        customerId: {
          type: mongoose.Schema.Types.ObjectId,
          ref: "Customer",
          required: true,
        },
        benefits: {
          serviceDiscountPercentage: { type: Number, default: 0 },
          productDiscountPercentage: { type: Number, default: 0 },
          complimentaryPerks: { type: [String], default: [] },
          eligibleServiceCategoryIds: [{ type: mongoose.Schema.Types.ObjectId, ref: "ServiceCategory" }],
          eligibleServiceIds: [{ type: mongoose.Schema.Types.ObjectId, ref: "Service" }],
          excludedServiceCategoryIds: [{ type: mongoose.Schema.Types.ObjectId, ref: "ServiceCategory" }],
          excludedServiceIds: [{ type: mongoose.Schema.Types.ObjectId, ref: "Service" }],
        },
      },
    ],
    payerCustomerId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Customer",
      default: null,
    },
    membershipPurchaseId: {
      type: mongoose.Schema.Types.ObjectId,
      default: null,
    },
    membershipTierSnapshot: {
      type: String,
      default: null,
      trim: true,
    },
    appointmentServiceId: {
      type: mongoose.Schema.Types.ObjectId,
      required: false,
      default: null,
    },
    // Product POS fields
    productId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Product",
      required: function () {
        return this.lineType === "product";
      },
      default: null,
    },
    sku: {
      type: String,
      trim: true,
      required: function () {
        return this.lineType === "product";
      },
      default: null,
    },
    stockUnit: {
      type: String,
      trim: true,
      default: null,
    },
    costPriceSnapshot: {
      type: Number,
      min: 0,
      default: 0,
    },
    name: { type: String, required: true, trim: true },
    duration: {
      type: Number,
      required: function () {
        return this.lineType === "service";
      },
      default: 0,
      min: 0,
    },
    quantity: { type: Number, required: true, default: 1, min: 1 },
    unitPrice: { type: Number, required: true, min: 0 },
    lineTotal: { type: Number, required: true, min: 0 },

    // Subscription coverage representation (for service lines)
    isCoveredBySubscription: { type: Boolean, default: false, required: true },
    appliedSubscriptionId: { type: mongoose.Schema.Types.ObjectId, ref: "Subscription", default: null },
    subscriptionUsageId: { type: mongoose.Schema.Types.ObjectId, ref: "SubscriptionUsage", default: null },
    subscriptionCoveredAmount: { type: Number, default: 0, min: 0, required: true },

    // Membership benefit application (for service or product lines)
    isDiscountedByMembership: { type: Boolean, default: false },
    appliedCustomerMembershipId: { type: mongoose.Schema.Types.ObjectId, ref: "CustomerMembership", default: null },
    membershipBenefitSourceLineId: { type: mongoose.Schema.Types.ObjectId, default: null },
    membershipDiscountAmount: { type: Number, default: 0, min: 0 },

    // Discount tracking per line
    appliedDiscounts: { type: [activeDiscountItemSchema], default: [] },
    lineDiscountTotal: { type: Number, default: 0, min: 0 },
    allocatedInvoiceDiscount: { type: Number, default: 0, min: 0 },
    discountAmount: { type: Number, default: 0, min: 0, required: true },

    customerPayable: { type: Number, required: true, min: 0 },
    returnedQuantity: { type: Number, default: 0, min: 0 },
  },
  { _id: true }
);

const invoiceSchema = new mongoose.Schema(
  {
    organizationId: { type: mongoose.Schema.Types.ObjectId, ref: "Organization", required: true, index: true },
    branchId: { type: mongoose.Schema.Types.ObjectId, ref: "Branch", required: true, index: true },
    invoiceNumber: { type: String, required: true, trim: true },

    invoiceType: {
      type: String,
      enum: ["appointment", "subscription", "retail", "combined", "membership", "unified"],
      default: "appointment",
      required: true,
      index: true,
    },

    // Appointment reference (required only for appointment-related invoices)
    appointmentId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Appointment",
      default: null,
      index: true,
    },
    appointmentCode: { type: String, default: null, trim: true },
    appointmentPricingSnapshot: {
      type: appointmentPricingSnapshotSchema,
      default: null,
    },

    // Subscription reference (populated for subscription sales)
    subscriptionId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Subscription",
      default: null,
      index: true,
    },
    subscriptionCode: { type: String, default: null, trim: true },

    // Membership reference (populated for membership sales)
    membershipPlanId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "MembershipPlan",
      default: null,
      index: true,
    },
    customerMembershipId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "CustomerMembership",
      default: null,
      index: true,
    },
    // Multi-beneficiary membership references
    customerMembershipIds: [
      {
        type: mongoose.Schema.Types.ObjectId,
        ref: "CustomerMembership",
      },
    ],
    membershipPurchaseId: {
      type: mongoose.Schema.Types.ObjectId,
      default: null,
      index: true,
    },
    membershipCode: { type: String, default: null, trim: true },

    customerId: { type: mongoose.Schema.Types.ObjectId, ref: "Customer", required: true, index: true },
    customerSnapshot: { type: invoiceCustomerSnapshotSchema, required: true },

    lines: { type: [invoiceLineSchema], required: true },

    // Financial breakdown (NO TAX / NO GST)
    subtotal: { type: Number, required: true, min: 0 },
    lineDiscountsTotal: { type: Number, default: 0, min: 0 },
    invoiceDiscountsTotal: { type: Number, default: 0, min: 0 },
    discountTotal: { type: Number, required: true, min: 0, default: 0 },
    appliedDiscounts: { type: [activeDiscountItemSchema], default: [] },
    discountHistory: { type: [discountHistorySchema], default: [] },
    coupon: { type: invoiceCouponSnapshotSchema, default: null },
    loyaltyRedeemedPoints: { type: Number, default: 0, min: 0 },
    loyaltyDiscountAmount: { type: Number, default: 0, min: 0 },
    loyaltyPointsEarned: { type: Number, default: 0, min: 0 },
    loyaltyTransactionId: { type: mongoose.Schema.Types.ObjectId, ref: "LoyaltyTransaction", default: null },
    grossPayable: { type: Number, required: true, min: 0 },
    subscriptionCoveredAmount: { type: Number, required: true, min: 0, default: 0 },
    payableAmount: { type: Number, required: true, min: 0 },
    amountPaid: { type: Number, required: true, min: 0, default: 0 },
    amountDue: { type: Number, required: true, min: 0 },

    status: {
      type: String,
      enum: ["draft", "finalized", "cancelled"],
      default: "draft",
      required: true,
      index: true,
    },
    paymentStatus: {
      type: String,
      enum: ["unpaid", "partially_paid", "paid"],
      default: "unpaid",
      required: true,
      index: true,
    },

    notes: { type: String, trim: true, default: "" },
    createdBy: { type: mongoose.Schema.Types.ObjectId, ref: "User", required: true },
    finalizedAt: { type: Date, default: null },
    finalizedBy: { type: mongoose.Schema.Types.ObjectId, ref: "User", default: null },
    cancelledAt: { type: Date, default: null },
    cancelledBy: { type: mongoose.Schema.Types.ObjectId, ref: "User", default: null },
    cancellationReason: { type: String, default: null, trim: true },

    isDeleted: { type: Boolean, default: false, index: true },
    deletedAt: { type: Date, default: null },
  },
  { timestamps: true }
);

// Indexes
invoiceSchema.index({ organizationId: 1, invoiceNumber: 1 }, { unique: true });
invoiceSchema.index(
  { organizationId: 1, appointmentId: 1 },
  {
    unique: true,
    partialFilterExpression: {
      isDeleted: false,
      appointmentId: { $type: "objectId" },
      status: { $in: ["draft", "finalized"] },
    },
  }
);
invoiceSchema.index(
  { organizationId: 1, subscriptionId: 1 },
  {
    unique: true,
    partialFilterExpression: {
      isDeleted: false,
      subscriptionId: { $type: "objectId" },
      invoiceType: "subscription",
      status: { $in: ["draft", "finalized"] },
    },
  }
);
invoiceSchema.index({ organizationId: 1, branchId: 1, createdAt: -1 });
invoiceSchema.index({ organizationId: 1, customerId: 1, createdAt: -1 });
invoiceSchema.index({ appointmentId: 1, status: 1 });
invoiceSchema.index({ subscriptionId: 1, status: 1 });

invoiceSchema.set("toJSON", {
  transform: (doc, ret) => {
    ret.id = ret._id.toString();
    delete ret.__v;
    return ret;
  },
});

export const Invoice = mongoose.model("Invoice", invoiceSchema);
