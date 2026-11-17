import mongoose from "mongoose";
import { SchemeAssignment } from "../../models/incentives/schemeAssignment.model.js";
import { IncentiveScheme } from "../../models/incentives/incentiveScheme.model.js";
import { IncentiveCalculationEngine } from "./incentiveCalculation.engine.js";
import { scopeLockService } from "./scopeLock.service.js";
import { AppError } from "../../utils/errors.js";

/**
 * Service managing the lifecycle, date-interval overlap prevention,
 * and concurrency-safe assignment of Incentive schemes.
 */
export class SchemeAssignmentService {
  async filterAssignmentsByCalculationBasis(
    assignments,
    calculationBasis,
    organizationId,
    session,
  ) {
    if (assignments.length === 0) return assignments;

    const schemeIds = [...new Set(assignments.map((assignment) => assignment.schemeId.toString()))]
      .map((id) => new mongoose.Types.ObjectId(id));
    let schemeQuery = IncentiveScheme.find({
      _id: { $in: schemeIds },
      organizationId,
    }).select("_id schemeType calculationBasis");
    if (session) schemeQuery = schemeQuery.session(session);
    const schemes = await schemeQuery.lean();
    const matchingSchemeIds = new Set(
      schemes
        .filter((scheme) =>
          scheme.schemeType === "COMMISSION"
            ? scheme.calculationBasis === calculationBasis
            : scheme.schemeType === "ATTENDANCE_BONUS" &&
              calculationBasis === "ATTENDANCE_DAYS",
        )
        .map((scheme) => scheme._id.toString()),
    );

    return assignments.filter((assignment) =>
      matchingSchemeIds.has(assignment.schemeId.toString()),
    );
  }

  /**
   * Validates whether two half-open intervals [startA, endA) and [startB, endB) overlap.
   * A null endDate represents an open-ended interval [start, +Infinity).
   * Two intervals overlap if and only if:
   *   startA < (endB || Infinity) && startB < (endA || Infinity)
   *
   * @param {Date} startA
   * @param {Date|null} endA
   * @param {Date} startB
   * @param {Date|null} endB
   * @returns {boolean}
   */
  static doIntervalsOverlap(startA, endA, startB, endB) {
    const tStartA = new Date(startA).getTime();
    const tEndA = endA ? new Date(endA).getTime() : Infinity;
    const tStartB = new Date(startB).getTime();
    const tEndB = endB ? new Date(endB).getTime() : Infinity;

    return tStartA < tEndB && tStartB < tEndA;
  }

  /**
   * Creates a new SchemeAssignment under ScopeLock serialization and interval overlap protection.
   *
   * @param {Object} data
   * @param {mongoose.Types.ObjectId|string} organizationId
   * @param {mongoose.Types.ObjectId|string} userId
   * @param {Object} [options]
   * @param {mongoose.ClientSession} [options.externalSession]
   * @returns {Promise<SchemeAssignment>}
   */
  async createAssignment(data, organizationId, userId, options = {}) {
    if (!organizationId) {
      throw new AppError("Organization scope is required", 400);
    }
    const {
      schemeId,
      scopeType,
      scopeId = null,
      startDate,
      endDate = null,
      priority = 0,
      status = "active",
    } = data;

    if (!schemeId || !scopeType || !startDate) {
      throw new AppError("schemeId, scopeType, and startDate are required", 400);
    }

    const orgObjectId = new mongoose.Types.ObjectId(organizationId);
    const schemeObjectId = new mongoose.Types.ObjectId(schemeId);
    const scopeObjectId = scopeId ? new mongoose.Types.ObjectId(scopeId) : null;
    const startDt = new Date(startDate);
    const endDt = endDate ? new Date(endDate) : null;

    if (endDt && endDt <= startDt) {
      throw new AppError("endDate must be strictly greater than startDate in half-open interval [startDate, endDate)", 400);
    }

    const session = options.externalSession || (await mongoose.startSession());
    const isLocalSession = !options.externalSession;
    if (isLocalSession) {
      session.startTransaction();
    }

    const lockOwner = `CREATE_ASSIGNMENT:${Date.now()}:${Math.random().toString(36).slice(2, 9)}`;
    const scopeKey = scopeObjectId ? scopeObjectId.toString() : "GLOBAL";

    try {
      // 1. Verify target scheme exists and belongs to the authenticated organization
      const scheme = await IncentiveScheme.findOne(
        { _id: schemeObjectId, organizationId: orgObjectId },
        null,
        { session }
      );
      if (!scheme) {
        throw new AppError("Incentive scheme not found within organization", 404);
      }
      if (!IncentiveCalculationEngine.supportsAssignableScheme(scheme)) {
        throw new AppError(
          "Only supported service, subscription-sale, membership-sale commission, and verified attendance bonus schemes can be assigned",
          400
        );
      }

      // 2. Acquire ScopeLock for the target scope
      await scopeLockService.acquireLock({
        organizationId: orgObjectId,
        scopeType,
        scopeKey,
        lockOwner,
        session,
      });

      // 3. Query existing active assignments for this exact scope to check interval overlap
      const activeAssignments = await SchemeAssignment.find(
        {
          organizationId: orgObjectId,
          scopeType,
          scopeId: scopeObjectId,
          status: "active",
        },
        null,
        { session }
      );
      const existingAssignments = await this.filterAssignmentsByCalculationBasis(
        activeAssignments,
        scheme.calculationBasis,
        orgObjectId,
        session,
      );

      for (const existing of existingAssignments) {
        if (
          SchemeAssignmentService.doIntervalsOverlap(
            startDt,
            endDt,
            existing.startDate,
            existing.endDate
          )
        ) {
          throw new AppError(
            `Assignment overlap conflict: Scope [${scopeType}:${scopeKey}] already has active scheme '${existing.schemeId}' effective from ${existing.startDate.toISOString()} to ${existing.endDate ? existing.endDate.toISOString() : "open-ended"}`,
            409
          );
        }
      }

      // 4. Persist the new assignment
      const [assignment] = await SchemeAssignment.create(
        [
          {
            organizationId: orgObjectId,
            schemeId: schemeObjectId,
            scopeType,
            scopeId: scopeObjectId,
            startDate: startDt,
            endDate: endDt,
            priority,
            status,
            createdBy: userId,
            updatedBy: userId,
          },
        ],
        { session }
      );

      // Release lock
      await scopeLockService.releaseLock({
        organizationId: orgObjectId,
        scopeType,
        scopeKey,
        lockOwner,
        session,
      });

      if (isLocalSession) {
        await session.commitTransaction();
      }

      return assignment;
    } catch (err) {
      if (isLocalSession) {
        await session.abortTransaction();
      }
      throw err;
    } finally {
      if (isLocalSession) {
        await session.endSession();
      }
    }
  }

  /**
   * Updates an existing assignment with multi-scope lock acquisition when scope changes.
   *
   * @param {mongoose.Types.ObjectId|string} assignmentId
   * @param {Object} updateData
   * @param {mongoose.Types.ObjectId|string} organizationId
   * @param {mongoose.Types.ObjectId|string} userId
   * @returns {Promise<SchemeAssignment>}
   */
  async updateAssignment(assignmentId, updateData, organizationId, userId) {
    if (!organizationId) {
      throw new AppError("Organization scope is required", 400);
    }
    const orgObjectId = new mongoose.Types.ObjectId(organizationId);
    const assignObjectId = new mongoose.Types.ObjectId(assignmentId);

    const session = await mongoose.startSession();
    session.startTransaction();

    const lockOwner = `UPDATE_ASSIGNMENT:${Date.now()}:${Math.random().toString(36).slice(2, 9)}`;

    try {
      const assignment = await SchemeAssignment.findOne(
        { _id: assignObjectId, organizationId: orgObjectId },
        null,
        { session }
      );
      if (!assignment) {
        throw new AppError("Scheme assignment not found", 404);
      }
      const targetScheme = await IncentiveScheme.findOne(
        {
          _id: updateData.schemeId || assignment.schemeId,
          organizationId: orgObjectId,
        },
        null,
        { session },
      );
      if (!targetScheme || !IncentiveCalculationEngine.supportsAssignableScheme(targetScheme)) {
        throw new AppError("Target scheme is missing or unsupported", 400);
      }

      const oldScopeType = assignment.scopeType;
      const oldScopeKey = assignment.scopeId ? assignment.scopeId.toString() : "GLOBAL";

      const targetScopeType = updateData.scopeType !== undefined ? updateData.scopeType : oldScopeType;
      const targetScopeId =
        updateData.scopeId !== undefined
          ? updateData.scopeId
            ? new mongoose.Types.ObjectId(updateData.scopeId)
            : null
          : assignment.scopeId;
      const targetScopeKey = targetScopeId ? targetScopeId.toString() : "GLOBAL";

      // Acquire both old and new locks in deterministic sorted order
      const scopesToLock = [
        { scopeType: oldScopeType, scopeKey: oldScopeKey },
        { scopeType: targetScopeType, scopeKey: targetScopeKey },
      ];

      await scopeLockService.acquireMultipleLocks({
        organizationId: orgObjectId,
        scopes: scopesToLock,
        lockOwner,
        session,
      });

      const startDt = updateData.startDate ? new Date(updateData.startDate) : assignment.startDate;
      const endDt =
        updateData.endDate !== undefined
          ? updateData.endDate
            ? new Date(updateData.endDate)
            : null
          : assignment.endDate;

      if (endDt && endDt <= startDt) {
        throw new AppError("endDate must be strictly greater than startDate", 400);
      }

      const status = updateData.status !== undefined ? updateData.status : assignment.status;

      if (status === "active") {
        // Check for overlaps with other assignments in the target scope
        const activeAssignments = await SchemeAssignment.find(
          {
            _id: { $ne: assignObjectId },
            organizationId: orgObjectId,
            scopeType: targetScopeType,
            scopeId: targetScopeId,
            status: "active",
          },
          null,
          { session }
        );
        const existingAssignments = await this.filterAssignmentsByCalculationBasis(
          activeAssignments,
          targetScheme.calculationBasis,
          orgObjectId,
          session,
        );

        for (const existing of existingAssignments) {
          if (
            SchemeAssignmentService.doIntervalsOverlap(
              startDt,
              endDt,
              existing.startDate,
              existing.endDate
            )
          ) {
            throw new AppError(
              `Assignment overlap conflict in target scope [${targetScopeType}:${targetScopeKey}]`,
              409
            );
          }
        }
      }

      // Apply updates
      assignment.scopeType = targetScopeType;
      assignment.scopeId = targetScopeId;
      assignment.startDate = startDt;
      assignment.endDate = endDt;
      assignment.status = status;
      if (updateData.priority !== undefined) assignment.priority = updateData.priority;
      if (updateData.schemeId !== undefined) {
        assignment.schemeId = new mongoose.Types.ObjectId(updateData.schemeId);
      }
      assignment.updatedBy = userId;

      await assignment.save({ session });

      // Release locks
      for (const s of scopesToLock) {
        await scopeLockService.releaseLock({
          organizationId: orgObjectId,
          scopeType: s.scopeType,
          scopeKey: s.scopeKey,
          lockOwner,
          session,
        });
      }

      await session.commitTransaction();
      return assignment;
    } catch (err) {
      await session.abortTransaction();
      throw err;
    } finally {
      await session.endSession();
    }
  }

  /**
   * Resolves the authoritative active SchemeAssignment using strict scope precedence:
   *   1. ScopeType: STAFF (Highest precedence)
   *   2. ScopeType: BRANCH (Medium precedence)
   *   3. ScopeType: ORGANIZATION (Default tenant-wide scheme)
   *
   * Rejects ambiguous assignments (multiple distinct schemes at the same scope tier).
   *
   * @param {Object} params
   * @param {mongoose.Types.ObjectId|string} params.organizationId
   * @param {mongoose.Types.ObjectId|string} params.staffId
   * @param {mongoose.Types.ObjectId|string} [params.branchId]
   * @param {Date} [params.effectiveDate]
   * @param {mongoose.ClientSession} [params.session]
   * @returns {Promise<SchemeAssignment|null>}
   */
  async resolveActiveAssignment({
    organizationId,
    staffId,
    branchId = null,
    calculationBasis = "SERVICE_NET_REVENUE",
    effectiveDate = new Date(),
    session = null,
  }) {
    if (!organizationId || !staffId) {
      throw new AppError("organizationId and staffId are required for resolveActiveAssignment", 400);
    }

    const orgObjectId = new mongoose.Types.ObjectId(organizationId);
    const staffObjectId = new mongoose.Types.ObjectId(staffId);
    const branchObjectId = branchId ? new mongoose.Types.ObjectId(branchId) : null;
    const targetDate = new Date(effectiveDate);

    const baseFilter = {
      organizationId: orgObjectId,
      status: "active",
      startDate: { $lte: targetDate },
      $or: [
        { endDate: null },
        { endDate: { $gt: targetDate } },
      ],
    };

    // Query tiers in order of precedence: STAFF -> BRANCH -> ORGANIZATION
    // 1. Staff tier
    const staffAssignmentsRaw = await SchemeAssignment.find(
      {
        ...baseFilter,
        scopeType: "STAFF",
        scopeId: staffObjectId,
      },
      null,
      session ? { session } : {}
    ).sort({ priority: -1 });
    const staffAssignments = await this.filterAssignmentsByCalculationBasis(
      staffAssignmentsRaw,
      calculationBasis,
      orgObjectId,
      session,
    );

    if (staffAssignments.length > 1) {
      // Check if ambiguous (multiple distinct schemes at highest priority)
      const topPriority = staffAssignments[0].priority;
      const topCandidates = staffAssignments.filter((a) => a.priority === topPriority);
      const distinctSchemes = new Set(topCandidates.map((a) => a.schemeId.toString()));
      if (distinctSchemes.size > 1) {
        throw new AppError(
          `Ambiguous scheme assignment detected at STAFF scope for staff ${staffId}`,
          409
        );
      }
    }
    if (staffAssignments.length > 0) {
      return staffAssignments[0];
    }

    // 2. Branch tier
    if (branchObjectId) {
      const branchAssignmentsRaw = await SchemeAssignment.find(
        {
          ...baseFilter,
          scopeType: "BRANCH",
          scopeId: branchObjectId,
        },
        null,
        session ? { session } : {}
      ).sort({ priority: -1 });
      const branchAssignments = await this.filterAssignmentsByCalculationBasis(
        branchAssignmentsRaw,
        calculationBasis,
        orgObjectId,
        session,
      );

      if (branchAssignments.length > 1) {
        const topPriority = branchAssignments[0].priority;
        const topCandidates = branchAssignments.filter((a) => a.priority === topPriority);
        const distinctSchemes = new Set(topCandidates.map((a) => a.schemeId.toString()));
        if (distinctSchemes.size > 1) {
          throw new AppError(
            `Ambiguous scheme assignment detected at BRANCH scope for branch ${branchId}`,
            409
          );
        }
      }
      if (branchAssignments.length > 0) {
        return branchAssignments[0];
      }
    }

    // 3. Organization tier (Default)
    const orgAssignmentsRaw = await SchemeAssignment.find(
      {
        ...baseFilter,
        scopeType: "ORGANIZATION",
      },
      null,
      session ? { session } : {}
    ).sort({ priority: -1 });
    const orgAssignments = await this.filterAssignmentsByCalculationBasis(
      orgAssignmentsRaw,
      calculationBasis,
      orgObjectId,
      session,
    );

    if (orgAssignments.length > 1) {
      const topPriority = orgAssignments[0].priority;
      const topCandidates = orgAssignments.filter((a) => a.priority === topPriority);
      const distinctSchemes = new Set(topCandidates.map((a) => a.schemeId.toString()));
      if (distinctSchemes.size > 1) {
        throw new AppError(
          `Ambiguous scheme assignment detected at ORGANIZATION scope for org ${organizationId}`,
          409
        );
      }
    }
    if (orgAssignments.length > 0) {
      return orgAssignments[0];
    }

    return null;
  }
}

export const schemeAssignmentService = new SchemeAssignmentService();
