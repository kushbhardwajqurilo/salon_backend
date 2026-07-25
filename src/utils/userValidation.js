import { AppError } from "./errors.js";
import { Branch } from "../models/branches/branch.model.js";

/**
 * Validates user modifications to prevent privilege escalation.
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
      throw new AppError("Access denied. You do not have permissions to modify organization assignments.", 403);
    }
  }

  // 3. A user cannot assign themselves or another user hasOrgWideAccess: true unless they have hasOrgWideAccess
  if (updates.hasOrgWideAccess === true && !reqUser.hasOrgWideAccess) {
    throw new AppError("Access denied. You cannot grant organization-wide access.", 403);
  }

  // 4. Any branch assigned through branchAccess must belong to the target user's organization.
  // 5. A user cannot grant branchAccess for a branch belonging to another organization.
  if (updates.branchAccess && Array.isArray(updates.branchAccess)) {
    const targetOrgId = updates.organizationId || (targetUser ? targetUser.organizationId : reqUser.organizationId);
    
    for (const access of updates.branchAccess) {
      const branch = await Branch.findOne({ _id: access.branchId, organizationId: targetOrgId });
      if (!branch) {
        throw new AppError("Invalid branch assignment. Branch must belong to the target organization.", 403);
      }
    }
  }

  // 6. A user cannot grant permissions that exceed their own administrative authority.
  if (updates.role && !reqUser.hasOrgWideAccess) {
    throw new AppError("Access denied. You cannot modify roles or permissions beyond your authority.", 403);
  }
}
