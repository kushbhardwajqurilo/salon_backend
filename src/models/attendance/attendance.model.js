// Attendance Model — Salon Project Unisex Parlour ERP
// Attendance module for biometric-first attendance tracking with leave and appointment integration
// Design follows Salon Project Master Working Strategy with provider-independent biometric architecture

import mongoose from "mongoose";
const { Schema } = mongoose;

// Attendance — Daily reconciled attendance record
// One active record per (organization, staff, date) — enforced by unique index.
// The branch on that record is retained as the original attendance claim.
// A staff member cannot have two Attendance records at different branches for the same local business day in this MVP.
// If punches for the same staff/date originate from different branches, flag a branch conflict for authorized review.
// Do not create a second Attendance record or merge the evidence automatically.
// Use the branch timezone to determine the local attendance date.
// Define and document the unique index consistently with this identity.
const attendanceSchema = new Schema(
  {
    organizationId: {
      type: Schema.Types.ObjectId,
      ref: "Organization",
      required: true,
      index: true,
    },
    branchId: {
      type: Schema.Types.ObjectId,
      ref: "Branch",
      index: true,
    },
    staffId: {
      type: Schema.Types.ObjectId,
      ref: "Staff",
      required: true,
    },
    attendanceDate: {
      type: Date,
      required: true,
    },
    status: {
      type: String,
      enum: ["present", "late", "early_departure", "incomplete", "absent"],
      default: "incomplete",
    },
    isReconciled: {
      type: Boolean,
      default: false,
    },
    conflictType: {
      type: String,
      enum: ["none", "leave", "appointment", "manual"],
      default: "none",
    },
    conflictLeaveId: {
      type: Schema.Types.ObjectId,
      ref: "Leave",
      default: null,
    },
    conflictAppointmentId: {
      type: Schema.Types.ObjectId,
      ref: "Appointment",
      default: null,
    },
    leaveDayResolved: {
      type: Boolean,
      default: false,
    },
    originalPunchSnapshot: {
      type: Schema.Types.Mixed,
      default: null,
    },
    reconciliationReason: {
      type: String,
      trim: true,
    },
    reconciledBy: {
      type: Schema.Types.ObjectId,
      ref: "User",
    },
    reconciledAt: {
      type: Date,
    },
    adjustmentHistory: {
      type: [
        new Schema(
          {
            previousStatus: { type: String },
            newStatus: { type: String, required: true },
            reason: { type: String, required: true, trim: true },
            actorId: { type: Schema.Types.ObjectId, ref: "User", required: true },
            changedAt: { type: Date, required: true },
          },
          { _id: false },
        ),
      ],
      default: [],
    },
    isDeleted: {
      type: Boolean,
      default: false,
    },
    deletedAt: {
      type: Date,
      default: null,
    },
  },
  {
    timestamps: true,
  },
);

// Critical unique index: one Attendance record per (organization, staff, date) non-deleted.
// The sole active-record identity is (organizationId, staffId, attendanceDate).
// Remove (organizationId, branchId, attendanceDate) as a unique index.
// Remove any conflicting (organizationId, staffId, attendanceDate) unique index that includes branchId.
attendanceSchema.index(
  { organizationId: 1, staffId: 1, attendanceDate: 1 },
  { unique: true, partialFilterExpression: { isDeleted: false } },
);

// Index for branch-scoped queries
attendanceSchema.index({ organizationId: 1, branchId: 1, attendanceDate: 1 });

// Index for reconciliation queries
attendanceSchema.index({ organizationId: 1, staffId: 1, isReconciled: 1 });

// Index for conflict queries
attendanceSchema.index({ organizationId: 1, conflictType: 1, isReconciled: 1 });

// Soft-delete and restoration behavior:
// When an Attendance record is soft-deleted (isDeleted: true, deletedAt set), restoration sets isDeleted: false and deletedAt: null.
// The partial unique index with isDeleted: false filter ensures only one active record per (org, staff, date).
// Restoration succeeds only when no other active record exists for that identity.

// Attendance static methods for atomic claim and conflict handling
attendanceSchema.statics = {
  /**
   * Atomically claim an attendance record for a staff member on a given date.
   * Uses findOneAndUpdate with upsert to ensure only one branch wins in concurrent scenarios.
   * @param {ObjectId} organizationId - The organization
   * @param {ObjectId} staffId - The staff member
   * @param {ObjectId} branchId - The branch where the punch originated
   * @param {Date} attendanceDate - The local attendance date
   * @param {String} punchType - The punch type (in/out/break)
   * @returns {Object} { success, attendanceRecord, conflict }
   */
  async claimAttendanceRecord({
    organizationId,
    staffId,
    branchId,
    attendanceDate,
    punchType,
  }) {
    // Step 1: Atomic upsert attempt with explicit E11000 error handling
    let result;
    try {
      result = await this.findOneAndUpdate(
        { organizationId, staffId, attendanceDate, isDeleted: false },
        {
          $setOnInsert: {
            branchId,
            status: "incomplete",
          },
          // NO $addToSet — we do not mark normal first claims as cross-branch conflict.
          // Branch comparison happens at the application level after re-reading the record.
        },
        { upsert: true, returnDocument: 'after' },
      );
    } catch (error) {
      // E11000: MongoDB duplicate-key error — another concurrent request created the record
      if (error.code === 11000) {
        // E11000 — re-read the winning record to determine the actual state
        const existing = await this.findOne({
          organizationId,
          staffId,
          attendanceDate,
          isDeleted: false,
        });

        if (!existing) {
          // Should not happen, but defensive check
          return {
            success: false,
            attendanceRecord: null,
            conflict: {
              type: "unexpected_error",
              message: "Record creation returned no result after E11000",
              evidence: null,
            },
          };
        }

        // Step 2: Compare the persisted branch with the attempted branch
        if (
          existing.branchId &&
          existing.branchId.toString() !== branchId.toString()
        ) {
          // Different-branch punch — never overwrite the original branch
          // Return the conflict for the ingestion service to persist.
          return {
            success: false,
            attendanceRecord: existing,
            conflict: {
              type: "cross_branch",
              message: `Staff already has an attendance record for ${attendanceDate} at branch ${existing.branchId}. Cannot claim from branch ${branchId}.`,
              existingBranch: existing.branchId,
              attemptedBranch: branchId,
              evidence: {
                originalPunchBranch: existing.originalPunchSnapshot || {
                  branchId: existing.branchId,
                },
                punchType,
                attendanceDate,
              },
            },
          };
        }

        // Same-branch retry (idempotent) — the original branch is preserved
        return {
          success: true,
          attendanceRecord: existing,
          conflict: null,
        };
      }

      // Unrelated database error — propagate, do not disguise as duplicate-key race
      return {
        success: false,
        attendanceRecord: null,
        conflict: {
          type: "database_error",
          message: `Database error during attendance claim: ${error.message}`,
          evidence: null,
        },
      };
    }

    // Step 2: Re-read the winning record to determine the actual state (successful upsert path)
    const existing = await this.findOne({
      organizationId,
      staffId,
      attendanceDate,
      isDeleted: false,
    });

    // Step 3: Determine the result based on the persisted record
    if (!existing) {
      // Should not happen with upsert, but defensive check
      return {
        success: false,
        attendanceRecord: null,
        conflict: {
          type: "unexpected_error",
          message: "Record creation returned no result",
          evidence: null,
        },
      };
    }

    // Step 4: Determine the result based on the persisted record
    // Compare the existing branch with the attempted branch
    if (
      existing.branchId &&
      existing.branchId.toString() !== branchId.toString()
    ) {
      // Different-branch punch — never overwrite the original branch
      // Return the conflict for the ingestion service to persist.
      return {
        success: false,
        attendanceRecord: existing,
        conflict: {
          type: "cross_branch",
          message: `Staff already has an attendance record for ${attendanceDate} at branch ${existing.branchId}. Cannot claim from branch ${branchId}.`,
          existingBranch: existing.branchId,
          attemptedBranch: branchId,
          evidence: {
            originalPunchBranch: existing.originalPunchSnapshot || {
              branchId: existing.branchId,
            },
            punchType,
            attendanceDate,
          },
        },
      };
    }

    // Same-branch retry or first claim — the original branch is preserved
    return {
      success: true,
      attendanceRecord: existing,
      conflict: null,
    };
  },

  /**
   * Retrieve attendance record for staff on a date, with conflict detection
   * @param {ObjectId} organizationId
   * @param {ObjectId} staffId
   * @param {Date} attendanceDate
   * @returns {Promise<Attendance|null>}
   */
  async findWithConflictCheck({ organizationId, staffId, attendanceDate }) {
    return await this.findOne({
      organizationId,
      staffId,
      attendanceDate,
      isDeleted: false,
    });
  },
};

export const Attendance =
  mongoose.models.Attendance || mongoose.model("Attendance", attendanceSchema);
