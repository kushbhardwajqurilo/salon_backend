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
    serviceId: { type: mongoose.Schema.Types.ObjectId, ref: "Service", required: true },
    appointmentServiceId: { type: mongoose.Schema.Types.ObjectId, required: true },
    name: { type: String, required: true, trim: true },
    duration: { type: Number, required: true, min: 1 },
    quantity: { type: Number, required: true, default: 1, min: 1 },
    unitPrice: { type: Number, required: true, min: 0 },
    lineTotal: { type: Number, required: true, min: 0 },

    // Subscription coverage representation
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

    // Phase 1: appointmentId is strictly required
    appointmentId: { type: mongoose.Schema.Types.ObjectId, ref: "Appointment", required: true, index: true },
    appointmentCode: { type: String, required: true, trim: true },
    appointmentPricingSnapshot: { type: appointmentPricingSnapshotSchema, required: true },

    customerId: { type: mongoose.Schema.Types.ObjectId, ref: "Customer", required: true, index: true },
    customerSnapshot: { type: invoiceCustomerSnapshotSchema, required: true },

    lines: { type: [invoiceLineSchema], required: true },

    // Financial breakdown (NO TAX / NO GST)
    subtotal: { type: Number, required: true, min: 0 },
    discountTotal: { type: Number, required: true, min: 0, default: 0 },
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
      status: { $in: ["draft", "finalized"] },
    },
  }
);
invoiceSchema.index({ organizationId: 1, branchId: 1, createdAt: -1 });
invoiceSchema.index({ organizationId: 1, customerId: 1, createdAt: -1 });

invoiceSchema.set("toJSON", {
  transform: (doc, ret) => {
    ret.id = ret._id.toString();
    delete ret.__v;
    return ret;
  },
});

export const Invoice = mongoose.model("Invoice", invoiceSchema);
