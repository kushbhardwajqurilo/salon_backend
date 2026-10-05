import mongoose from "mongoose";
import { auditPlugin } from "../../database/plugins/audit.js";

const staffSchema = new mongoose.Schema(
  {
    name: {
      type: String,
      required: true,
      trim: true,
    },
    phone: {
      type: String,
      required: true,
      trim: true,
    },
    email: {
      type: String,
      required: true,
      lowercase: true,
      trim: true,
    },
    organizationId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Organization",
      required: true,
    },
    userId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "User",
      default: null,
    },
    designation: {
      type: String,
      required: true,
      trim: true,
    },
    status: {
      type: String,
      enum: ["active", "inactive", "suspended"],
      default: "active",
      required: true,
    },
    staffCode: {
      type: String,
      required: true,
    },
    avatarUrl: {
      type: String,
      default: null,
    },
    joiningDate: {
      type: Date,
      required: true,
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
  },
  {
    timestamps: true,
  }
);

// Indexes
staffSchema.index({ organizationId: 1, isDeleted: 1 });
staffSchema.index(
  { organizationId: 1, staffCode: 1 },
  { unique: true, partialFilterExpression: { isDeleted: false } }
);
staffSchema.index(
  { organizationId: 1, email: 1 },
  { unique: true, partialFilterExpression: { isDeleted: false } }
);
staffSchema.index(
  { organizationId: 1, phone: 1 },
  { unique: true, partialFilterExpression: { isDeleted: false } }
);
staffSchema.index(
  { organizationId: 1, userId: 1 },
  {
    unique: true,
    partialFilterExpression: {
      isDeleted: false,
      userId: { $type: "objectId" },
    },
  }
);

staffSchema.plugin(auditPlugin);

staffSchema.methods.softDelete = async function (userId) {
  this.isDeleted = true;
  this.deletedAt = new Date();
  if (userId) {
    this.deletedBy = userId;
  }
  return this.save();
};

staffSchema.post("deleteOne", { document: true, query: false }, function (doc) {
  if (doc?.avatarUrl) {
    import("../../services/cloudinary.service.js")
      .then(({ deleteFromCloudinary }) => {
        deleteFromCloudinary(doc.avatarUrl).catch((err) =>
          console.warn("Non-blocking: Failed to delete avatar on employee removal", err)
        );
      })
      .catch((err) => console.warn("Failed to load cloudinary service for avatar purge", err));
  }
});

staffSchema.post("findOneAndDelete", function (doc) {
  if (doc?.avatarUrl) {
    import("../../services/cloudinary.service.js")
      .then(({ deleteFromCloudinary }) => {
        deleteFromCloudinary(doc.avatarUrl).catch((err) =>
          console.warn("Non-blocking: Failed to delete avatar on employee removal", err)
        );
      })
      .catch((err) => console.warn("Failed to load cloudinary service for avatar purge", err));
  }
});

export const Staff = mongoose.model("Staff", staffSchema);
