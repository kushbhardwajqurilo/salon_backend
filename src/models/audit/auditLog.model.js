import mongoose from "mongoose";

export const AUDIT_ACTIONS = {
  CUSTOMER_CREATED: "CUSTOMER_CREATED",
  CUSTOMER_UPDATED: "CUSTOMER_UPDATED",
  CUSTOMER_DEACTIVATED: "CUSTOMER_DEACTIVATED",
  CUSTOMER_REACTIVATED: "CUSTOMER_REACTIVATED",
  CUSTOMER_DELETED: "CUSTOMER_DELETED",
  NOTE_ADDED: "NOTE_ADDED",
};

const auditLogSchema = new mongoose.Schema(
  {
    organizationId: {
      type: mongoose.Schema.Types.Mixed,
      ref: "Organization",
      required: true,
    },
    branchId: {
      type: mongoose.Schema.Types.Mixed,
      ref: "Branch",
      required: true,
    },
    actorId: {
      type: mongoose.Schema.Types.Mixed,
      ref: "User",
      required: true,
    },
    action: {
      type: String,
      required: true,
      enum: Object.values(AUDIT_ACTIONS),
    },
    entityType: {
      type: String,
      required: true,
    },
    entityId: {
      type: mongoose.Schema.Types.Mixed,
      required: true,
    },
    description: {
      type: String,
      required: true,
    },
    metadata: {
      type: mongoose.Schema.Types.Mixed,
      default: {},
    },
  },
  {
    timestamps: { createdAt: true, updatedAt: false },
  }
);

// Indexes
auditLogSchema.index({ organizationId: 1, entityType: 1, entityId: 1, createdAt: -1 });
auditLogSchema.index({ organizationId: 1, branchId: 1, createdAt: -1 });

export const AuditLog = mongoose.model("AuditLog", auditLogSchema);
