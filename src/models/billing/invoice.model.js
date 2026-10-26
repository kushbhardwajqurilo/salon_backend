import mongoose from "mongoose";

const invoiceCustomerSnapshotSchema = new mongoose.Schema(
  {
    name: { type: String, required: true, trim: true },
    phone: { type: String, required: true, trim: true },
    email: { type: String, default: null, trim: true, lowercase: true },
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

const invoiceLineSchema = new mongoose.Schema(
  {
    lineType: {
      type: String,
      enum: ["service", "subscription"],
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
    subscriptionId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Subscription",
      default: null,
    },
    appointmentServiceId: {
      type: mongoose.Schema.Types.ObjectId,
      required: function () {
        return this.lineType === "service";
      },
      default: null,
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
    discountAmount: { type: Number, default: 0, min: 0, required: true },

    customerPayable: { type: Number, required: true, min: 0 },
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
      enum: ["appointment", "subscription", "combined"],
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

    customerId: { type: mongoose.Schema.Types.ObjectId, ref: "Customer", required: true, index: true },
    customerSnapshot: { type: invoiceCustomerSnapshotSchema, required: true },

    lines: { type: [invoiceLineSchema], required: true },

    // Financial breakdown (NO TAX / NO GST)
    subtotal: { type: Number, required: true, min: 0 },
    discountTotal: { type: Number, required: true, min: 0, default: 0 },
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
