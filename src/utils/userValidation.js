import mongoose from "mongoose";
import { AppError } from "./errors.js";
import {
  assertCanManageBranches,
  assertStaffBranchSubsetOfUserAccess,
} from "./branchAuthorization.js";
import { Staff } from "../models/staff/staff.model.js";

/**
 * Validates user modifications to prevent privilege escalation and enforce branch invariants.
 * @param {Object} reqUser - The authenticated user making the request (req.user)
 * @param {Object} targetUser - The current state of the user being modified (from DB, or null if creating)
 * @param {Object} updates - The requested updates (req.body)
 */
export async function validateUserUpdate(reqUser, targetUser, updates) {
  // 1. A user cannot change their own organizationId.
  if (
    targetUser &&
    targetUser._id.toString() === reqUser.id.toString() &&
    updates.organizationId &&
    updates.organizationId.toString() !== targetUser.organizationId.toString()
  ) {
    throw new AppError("You cannot change your own organization context.", 403);
  }

  // 2. A user cannot change another user's organizationId unless they have hasOrgWideAccess
  if (
    updates.organizationId &&
    targetUser &&
    targetUser.organizationId.toString() !== updates.organizationId.toString()
  ) {
    if (!reqUser.hasOrgWideAccess) {
      throw new AppError(
        "Access denied. You do not have permissions to modify organization assignments.",
        403,
      );
    }
  }

  // 3. A user cannot assign themselves or another user hasOrgWideAccess: true unless they have hasOrgWideAccess
  if (updates.hasOrgWideAccess === true && !reqUser.hasOrgWideAccess) {
    throw new AppError(
      "Access denied. You cannot grant organization-wide access.",
      403,
    );
  }

  const targetOrgId =
    updates.organizationId ||
    (targetUser ? targetUser.organizationId : reqUser.organizationId);

  // 4. Validate branch access management using total caller authorization
  if (updates.branchAccess && Array.isArray(updates.branchAccess) && updates.branchAccess.length > 0) {
    const targetBranchIds = updates.branchAccess.map(
      (access) => access.branchId || access,
    );

    await assertCanManageBranches(reqUser, targetBranchIds, targetOrgId);
  }

  // 5. Enforce invariant: Staff assigned branches ⊆ User authorized branches
  if (
    targetUser &&
    (updates.branchAccess !== undefined || updates.hasOrgWideAccess !== undefined) &&
    mongoose.Types.ObjectId.isValid(targetUser._id) &&
    mongoose.Types.ObjectId.isValid(targetOrgId)
  ) {
    const linkedStaff = await Staff.findOne({
      userId: targetUser._id,
      isDeleted: false,
      organizationId: targetOrgId,
    });

    if (linkedStaff) {
      const candidateUser = {
        _id: targetUser._id,
        hasOrgWideAccess:
          updates.hasOrgWideAccess !== undefined
            ? updates.hasOrgWideAccess
            : targetUser.hasOrgWideAccess,
        branchAccess:
          updates.branchAccess !== undefined
            ? updates.branchAccess
            : targetUser.branchAccess,
      };
      await assertStaffBranchSubsetOfUserAccess(
        candidateUser,
        linkedStaff._id,
        targetOrgId,
      );
    }
  }

  // 6. A user cannot grant permissions that exceed their own administrative authority.
  if (updates.role && !reqUser.hasOrgWideAccess) {
    throw new AppError(
      "Access denied. You cannot modify roles or permissions beyond your authority.",
      403,
    );
  }
}


