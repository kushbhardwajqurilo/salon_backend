import mongoose from "mongoose";
import { auditPlugin } from "../../database/plugins/audit.js";

const entitlementSchema = new mongoose.Schema(
  {
    serviceId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Service",
      required: true,
    },
    serviceName: {
      type: String,
      required: true,
      trim: true,
    },
    totalQuantity: {
      type: Number,
      required: true,
      min: 1,
    },
    usedQuantity: {
      type: Number,
      required: true,
      default: 0,
      min: 0,
    },
    remainingQuantity: {
      type: Number,
      required: true,
      min: 0,
    },
  },
  { _id: true },
);

const memberSchema = new mongoose.Schema(
  {
    customerId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Customer",
      required: true,
      index: true,
    },
    status: {
      type: String,
      enum: ["active", "pending_payment", "exhausted", "cancelled"],
      default: "active",
      index: true,
    },
    permittedBranchIds: [
      {
        type: mongoose.Schema.Types.ObjectId,
        ref: "Branch",
      },
    ],
    entitlements: {
      type: [entitlementSchema],
      required: true,
      validate: [
        (val) => Array.isArray(val) && val.length > 0,
        "Member must have at least one entitlement",
      ],
    },
    notes: {
      type: String,
      default: "",
      trim: true,
    },
  },
  { _id: true },
);

const subscriptionSchema = new mongoose.Schema(
  {
    organizationId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Organization",
      required: true,
      index: true,
    },
    payerCustomerId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Customer",
      required: true,
      index: true,
    },
    customerId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Customer",
      required: true,
      index: true,
    },
    subscriptionCode: {
      type: String,
      required: true,
      trim: true,
    },
    planId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "SubscriptionPlan",
      default: null,
      index: true,
    },
    price: {
      type: Number,
      required: true,
      min: [0, "Price must be non-negative"],
    },
    // Canonical member allocations - one per enrolled customer
    members: {
      type: [memberSchema],
      required: true,
      validate: [
        (val) => Array.isArray(val) && val.length > 0,
        "Subscription must have at least one member",
      ],
    },
    // Optional legacy array for backward-compatibility with direct reads
    entitlements: {
      type: [entitlementSchema],
      default: [],
    },
    permittedBranchIds: [
      {
        type: mongoose.Schema.Types.ObjectId,
        ref: "Branch",
      },
    ],
    startDate: {
      type: Date,
      required: true,
    },
    endDate: {
      type: Date,
      required: true,
    },
    status: {
      type: String,
      enum: ["pending_payment", "active", "expired", "exhausted", "cancelled"],
      default: "active",
      index: true,
    },
    invoiceId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Invoice",
      default: null,
      index: true,
    },
    notes: {
      type: String,
      default: "",
      trim: true,
    },
  },
  {
    timestamps: true,
  },
);

// Pre-validate hook for backward compatibility with legacy writes/test fixtures
subscriptionSchema.pre("validate", function () {
  if (!this.payerCustomerId && this.customerId) {
    this.payerCustomerId = this.customerId;
  }
  if (!this.customerId && this.payerCustomerId) {
    this.customerId = this.payerCustomerId;
  }
  if ((!this.members || this.members.length === 0) && this.customerId) {
    this.members = [
      {
        customerId: this.customerId,
        status: this.status || "active",
        permittedBranchIds: this.permittedBranchIds || [],
        entitlements: this.entitlements || [],
        notes: this.notes || "",
      },
    ];
  }
});

// Post-init hook for transparent backward compatibility on direct Mongoose document reads
subscriptionSchema.post("init", function () {
  if (Array.isArray(this.members) && this.members.length > 0) {
    const rawRootEnts = this._doc && Array.isArray(this._doc.entitlements) ? this._doc.entitlements : null;
    const primaryMember = this.members.find((m) => m.customerId?.toString() === this.customerId?.toString()) || this.members[0];
    if (primaryMember && Array.isArray(primaryMember.entitlements)) {
      if (rawRootEnts) {
        // If raw root entitlements exist (e.g. from legacy direct updates), sync lower remainingQuantity to member
        for (const re of rawRootEnts) {
          const me = primaryMember.entitlements.find((e) => e.serviceId?.toString() === re.serviceId?.toString());
          if (me && typeof re.remainingQuantity === "number" && re.remainingQuantity < me.remainingQuantity) {
            me.remainingQuantity = re.remainingQuantity;
            me.usedQuantity = re.usedQuantity;
          }
        }
      }
      this.entitlements = primaryMember.entitlements;
    }
  }
});

// Indexes
subscriptionSchema.index(
  { organizationId: 1, subscriptionCode: 1 },
  { unique: true, partialFilterExpression: { isDeleted: false } },
);

// Index customer and members
subscriptionSchema.index({ organizationId: 1, customerId: 1, status: 1 });
subscriptionSchema.index({ organizationId: 1, payerCustomerId: 1, status: 1 });
subscriptionSchema.index({ organizationId: 1, "members.customerId": 1, status: 1 });
subscriptionSchema.index({ organizationId: 1, "members.customerId": 1, "members.status": 1 });

// Expiry queries index
subscriptionSchema.index({ organizationId: 1, status: 1, endDate: 1 });

// Audit plugin provides: isDeleted, deletedAt, createdBy, updatedBy, deletedBy, softDelete(), optimisticConcurrency
subscriptionSchema.plugin(auditPlugin);

export const Subscription = mongoose.model("Subscription", subscriptionSchema);
