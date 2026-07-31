import mongoose from "mongoose";

const serviceSchema = new mongoose.Schema(
  {
    name: {
      type: String,
      required: true,
      trim: true,
    },
    serviceCode: {
      type: String,
      trim: true,
      uppercase: true,
      default: null,
    },
    description: {
      type: String,
      trim: true,
      default: "",
    },
    categoryId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "ServiceCategory",
      required: true,
    },
    duration: {
      type: Number, // positive integer in minutes
      required: true,
    },
    pricing: {
      basePrice: {
        type: Number,
        required: true,
        min: 0,
      },
    },
    taxConfiguration: {
      taxable: {
        type: Boolean,
        default: false,
      },
      taxRate: {
        type: Number,
        min: 0,
        default: 0,
      },
    },
    status: {
      type: String,
      enum: ["active", "inactive"],
      default: "active",
      index: true,
    },
    isDeleted: {
      type: Boolean,
      default: false,
      index: true,
    },
    deletedAt: {
      type: Date,
      default: null,
    },
    displayOrder: {
      type: Number,
      default: 0,
    },
    organizationId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Organization",
      required: true,
    },
    branchId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Branch",
      required: true,
    },
    createdBy: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "User",
    },
    updatedBy: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "User",
    },
  },
  { timestamps: true }
);

// Enforce unique service name per branch (for active services)
serviceSchema.index(
  { branchId: 1, name: 1 },
  { unique: true, partialFilterExpression: { isDeleted: false } }
);

// Enforce unique serviceCode per branch (for active services with a code)
serviceSchema.index(
  { branchId: 1, serviceCode: 1 },
  { unique: true, partialFilterExpression: { isDeleted: false, serviceCode: { $type: "string" } } }
);

serviceSchema.index({ organizationId: 1, branchId: 1 });
serviceSchema.index({ categoryId: 1 });

export const Service = mongoose.model("Service", serviceSchema);
