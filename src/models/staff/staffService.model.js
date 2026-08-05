import mongoose from "mongoose";

const staffServiceSchema = new mongoose.Schema(
  {
    staffId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Staff",
      required: true,
    },
    serviceId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Service",
      required: true,
    },
    organizationId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Organization",
      required: true,
    },
    isActive: {
      type: Boolean,
      default: true,
    },
  },
  {
    timestamps: true,
  }
);

// Indexes
staffServiceSchema.index(
  { organizationId: 1, staffId: 1, serviceId: 1 },
  { unique: true, partialFilterExpression: { isActive: true } }
);
staffServiceSchema.index({ organizationId: 1, serviceId: 1, staffId: 1 });

export const StaffService = mongoose.model("StaffService", staffServiceSchema);
