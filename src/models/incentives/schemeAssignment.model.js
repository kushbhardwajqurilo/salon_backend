import mongoose from "mongoose";
import { auditPlugin } from "../../database/plugins/audit.js";

const { Schema } = mongoose;

/**
 * SchemeAssignment Schema
 * Assigns an IncentiveScheme to staff members, branches, or roles with date-interval validity.
 */
const schemeAssignmentSchema = new Schema(
  {
    organizationId: {
      type: Schema.Types.ObjectId,
      ref: "Organization",
      required: true,
      index: true,
    },
    schemeId: {
      type: Schema.Types.ObjectId,
      ref: "IncentiveScheme",
      required: true,
      index: true,
    },
    scopeType: {
      type: String,
      required: true,
      enum: ["ORGANIZATION", "BRANCH", "ROLE", "STAFF"],
    },
    scopeId: {
      type: Schema.Types.ObjectId,
      default: null,
      index: true,
    },
    startDate: {
      type: Date,
      required: true,
      index: true,
    },
    endDate: {
      type: Date,
      default: null,
      validate: {
        validator: function (v) {
          return v === null || v >= this.startDate;
        },
        message: "endDate must be greater than or equal to startDate",
      },
    },
    priority: {
      type: Number,
      default: 0,
    },
    status: {
      type: String,
      required: true,
      enum: ["active", "inactive"],
      default: "active",
      index: true,
    },
  },
  {
    timestamps: true,
  }
);

// Compound index for scope queries & overlap lookups
schemeAssignmentSchema.index({
  organizationId: 1,
  scopeType: 1,
  scopeId: 1,
  startDate: 1,
  endDate: 1,
});

schemeAssignmentSchema.plugin(auditPlugin);

export const SchemeAssignment = mongoose.model("SchemeAssignment", schemeAssignmentSchema);
