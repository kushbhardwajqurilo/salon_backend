import mongoose from "mongoose";

const supplierSchema = new mongoose.Schema(
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
    contactPerson: {
      type: String,
      trim: true,
      default: "",
    },
    phone: {
      type: String,
      trim: true,
      default: "",
    },
    email: {
      type: String,
      trim: true,
      lowercase: true,
      default: "",
    },
    address: {
      type: String,
      trim: true,
      default: "",
    },
    paymentTermsDays: {
      type: Number,
      min: 0,
      default: 30,
    },
    bankDetails: {
      accountNo: { type: String, trim: true, default: "" },
      ifscCode: { type: String, trim: true, default: "" },
      bankName: { type: String, trim: true, default: "" },
    },
    status: {
      type: String,
      enum: ["active", "inactive"],
      default: "active",
      index: true,
    },
    metadata: {
      type: mongoose.Schema.Types.Mixed,
      default: {},
    },
    isDeleted: {
      type: Boolean,
      default: false,
      index: true,
    },
    createdBy: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "User",
      default: null,
    },
    updatedBy: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "User",
      default: null,
    },
  },
  {
    timestamps: true,
  }
);

supplierSchema.index({ organizationId: 1, name: 1, isDeleted: 1 });
supplierSchema.index({ organizationId: 1, status: 1, isDeleted: 1 });

supplierSchema.set("toJSON", {
  transform: (doc, ret) => {
    ret.id = ret._id.toString();
    delete ret.__v;
    return ret;
  },
});

export const Supplier =
  mongoose.models.Supplier || mongoose.model("Supplier", supplierSchema);

