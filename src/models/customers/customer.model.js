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
      unique: true,
      trim: true,
    },
    branchId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Branch",
      required: true,
      index: true,
    },
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
    visits: [
      {
        appointmentId: { type: mongoose.Schema.Types.ObjectId },
        date: { type: Date, required: true },
        totalAmount: { type: Number, required: true },
        status: { type: String, required: true },
      },
    ],
    services: [
      {
        serviceId: { type: mongoose.Schema.Types.ObjectId },
        serviceName: { type: String, required: true },
        date: { type: Date, required: true },
      },
    ],
    memberships: [
      {
        membershipName: { type: String, required: true },
        startDate: { type: Date, required: true },
        endDate: { type: Date, required: true },
        status: { type: String, enum: ["active", "expired", "cancelled"], default: "active" },
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
  },
  {
    timestamps: true,
  }
);

customerSchema.index({ phone: 1 }, { unique: true });
customerSchema.index({ branchId: 1, phone: 1 });

export const Customer = mongoose.model("Customer", customerSchema);
