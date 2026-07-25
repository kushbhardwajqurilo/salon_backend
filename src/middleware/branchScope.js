import { AppError } from "../utils/errors.js";
import { asyncHandler } from "../utils/errors.js";
import { Branch } from "../models/branches/branch.model.js";

export const resolveBranchScope = asyncHandler(async (req, res, next) => {
  const branchId = req.headers["x-branch-id"];
  
  if (!req.user) {
    return next(new AppError("User authentication required before resolving branch scope", 401));
  }

  const { role, organizationId, branchAccess } = req.user;

  if (branchId) {
    // Check access
    let hasAccess = false;

    if (role === "Owner" || role === "owner" || role === "admin" || role === "superadmin") {
      // Owner / admin has access to any branch within their organization
      const branch = await Branch.findOne({ _id: branchId, organizationId });
      if (branch) {
        hasAccess = true;
      }
    } else {
      // Check explicit branch access
      hasAccess = branchAccess.some(
        (b) => b.branchId.toString() === branchId.toString() && b.isActive
      );
    }

    if (!hasAccess) {
      return next(new AppError("Access denied. You do not have access to this branch.", 403));
    }

    req.branchId = branchId;
  } else {
    req.branchId = null; // all-branches scope
  }

  next();
});
