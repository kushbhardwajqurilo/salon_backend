import { AppError } from "../utils/errors.js";
import { asyncHandler } from "../utils/errors.js";
import { Branch } from "../models/branches/branch.model.js";
import mongoose from "mongoose";

/*
  Middleware to enforce organization-wide scope.
  Obtains organization ID strictly from req.user context.
 */
export const requireOrganizationScope = asyncHandler(async (req, res, next) => {
  if (!req.user) {
    throw new AppError("User authentication required", 401);
  }
  // Enforce context strictly from session token (never query/body parameters)
  req.organizationId = req.user.organizationId;
  next();
});

/*
  Middleware to enforce branch-scoped operations.
  Requires and validates the X-Branch-Id header against organization and authorization constraints.
 */
export const requireBranchScope = asyncHandler(async (req, res, next) => {
  const branchId = req.headers?.["x-branch-id"] || req.headers?.["X-Branch-Id"] || req.query?.branchId;

  if (!req.user) {
    throw new AppError("User authentication required", 401);
  }

  const { organizationId, hasOrgWideAccess, branchAccess } = req.user;
  // If X-Branch-Id is omitted and user has organization-wide access, proceed organization-wide
  if (!branchId && hasOrgWideAccess === true) {
    req.organizationId = organizationId;
    req.branchId = undefined;
    return next();
  }
  if (!branchId) {
    throw new AppError("X-Branch-Id header is required for this request.", 400);
  }

  // Validate format before query
  if (!mongoose.Types.ObjectId.isValid(branchId)) {
    throw new AppError("Invalid branch ID format.", 400);
  }

  // Never query globally first. Always use a tenant-scoped lookup filtering active branches.
  const branch = await Branch.findOne({
    _id: branchId,
    organizationId: organizationId,
    isActive: true,
  });

  // Treat missing or inactive branch as not found within the user's organization (return 404)
  if (!branch) {
    throw new AppError("Resource not found", 404);
  }

  // Validate authorization
  let isAuthorized = false;
  if (hasOrgWideAccess === true) {
    isAuthorized = true;
  } else {
    isAuthorized = branchAccess.some(
      (b) => b.branchId.toString() === branchId.toString() && b.isActive,
    );
  }

  if (!isAuthorized) {
    throw new AppError(
      "Access denied. You do not have access to this branch.",
      403,
    );
  }

  // OLD CODE:
  // req.organizationId = organizationId;
  // req.branchId = branchId;
  // next();

  // UPDATED CODE: Attach cached/validated branch context to request to eliminate downstream duplicate DB queries
  req.organizationId = organizationId;
  req.branchId = branchId;
  req.currentBranch = branch;
  next();
});

/*
  Middleware to strictly enforce active branch context for branch-scoped mutations (like selling subscriptions).
  Does not allow omitting X-Branch-Id even for users with organization-wide access.
  Rejects "all", validates ObjectId, verifies tenant-scoped active branch existence (404),
  and verifies user branch authorization (403).
 */
export const requireActiveBranch = asyncHandler(async (req, res, next) => {
  const branchId =
    req.headers?.["x-branch-id"] ||
    req.headers?.["X-Branch-Id"] ||
    req.body?.branchId ||
    req.query?.branchId;

  if (!req.user) {
    throw new AppError("User authentication required", 401);
  }

  if (!branchId || branchId === "all") {
    throw new AppError("X-Branch-Id header is required to perform this action.", 400);
  }

  if (!mongoose.Types.ObjectId.isValid(branchId)) {
    throw new AppError("Invalid branch ID format.", 400);
  }

  const { organizationId, hasOrgWideAccess, branchAccess } = req.user;

  const branch = await Branch.findOne({
    _id: branchId,
    organizationId: organizationId,
    isActive: true,
  });

  if (!branch) {
    throw new AppError("Resource not found", 404);
  }

  let isAuthorized = false;
  if (hasOrgWideAccess === true) {
    isAuthorized = true;
  } else {
    isAuthorized = (branchAccess || []).some(
      (b) => b.branchId.toString() === branchId.toString() && b.isActive,
    );
  }

  if (!isAuthorized) {
    throw new AppError(
      "Access denied. You do not have access to this branch.",
      403,
    );
  }

  // OLD CODE:
  // req.organizationId = organizationId;
  // req.branchId = branch._id.toString();
  // if (req.body && typeof req.body === "object") {
  //   req.body.branchId = branch._id.toString();
  // }
  // next();

  // UPDATED CODE: Attach current branch to avoid downstream DB re-queries
  req.organizationId = organizationId;
  req.branchId = branch._id.toString();
  req.currentBranch = branch;
  if (req.body && typeof req.body === "object") {
    req.body.branchId = branch._id.toString();
  }
  next();
});

