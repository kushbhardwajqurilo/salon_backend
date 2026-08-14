import mongoose from "mongoose";

const roleSchema = new mongoose.Schema(
  {
    name: {
      type: String,
      required: true,
      trim: true,
      lowercase: true,
    },
    description: {
      type: String,
      required: true,
      trim: true,
    },
    organizationId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Organization",
      default: null,
    },
    isSystem: {
      type: Boolean,
      default: false,
    },
    permissions: [
      {
        type: mongoose.Schema.Types.ObjectId,
        ref: "Permission",
      },
    ],
  },
  {
    timestamps: true,
  }
);

roleSchema.index(
  { name: 1 },
  {
    unique: true,
    partialFilterExpression: { isSystem: true },
  }
);

roleSchema.index(
  { organizationId: 1, name: 1 },
  {
    unique: true,
    partialFilterExpression: { organizationId: { $type: "objectId" } },
  }
);

export const Role = mongoose.model("Role", roleSchema);
