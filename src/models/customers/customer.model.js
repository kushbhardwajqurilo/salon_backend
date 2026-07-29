import mongoose from "mongoose";

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
    preferences: {
      preferredStaff: [
        {
          type: mongoose.Schema.Types.ObjectId,
          ref: "User",
        },
      ],
      preferredServices: [String],
      drinkPreference: {
        type: String,
        default: "",
      },
      remarks: {
        type: String,
        default: "",
      },
    },
    notes: [
      {
        text: { type: String, required: true },
        createdBy: { type: mongoose.Schema.Types.ObjectId, ref: "User", required: true },
        createdAt: { type: Date, default: Date.now },
      },
    ],
    activityTimeline: [
      {
        action: { type: String, required: true },
        description: { type: String, required: true },
        date: { type: Date, default: Date.now },
        performedBy: { type: mongoose.Schema.Types.ObjectId, ref: "User", required: true },
      },
    ],
    isActive: {
      type: Boolean,
      default: true,
      index: true,
    },
  },
  {
    timestamps: true,
  }
);

customerSchema.pre("save", function () {
  if (this.phone) {
    this.phone = this.phone.replace(/[^\d+]/g, "");
  }
});

customerSchema.index({ organizationId: 1, phone: 1 });
customerSchema.index({ organizationId: 1, homeBranchId: 1 });
customerSchema.index({ organizationId: 1, visitedBranchIds: 1 });

export const Customer = mongoose.model("Customer", customerSchema);
