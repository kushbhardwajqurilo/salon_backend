import { RoleRepository } from "../repositories/roles/role.repository.js";
import { AppError } from "../utils/errors.js";
import { asyncHandler } from "../utils/errors.js";
import { redis } from "../utils/redis.js";
import { logger } from "../utils/logger.js";

const roleRepo = new RoleRepository();

/**
 * Middleware to enforce permissions and branch-level scope constraints.
 * Uses Redis caching to minimize database query overhead.
 * @param {String} requiredPermission - The name of the permission (e.g., 'customer:create')
 * @param {Boolean} checkBranchScope - If true, checks if the branch in req.params/req.query is allowed for the user
 */
export const authorize = (requiredPermission, checkBranchScope = false) => {
  return asyncHandler(async (req, res, next) => {
    const { role: roleName, branches } = req.user;

    // Super Admin bypasses all permissions checks
    if (roleName === "admin" || roleName === "superadmin") {
      return next();
    }

    const cacheKey = `rbac:role:${roleName}:permissions`;
    let permissions = [];

    try {
      const cachedPermissions = await redis.get(cacheKey);
      if (cachedPermissions) {
        permissions = JSON.parse(cachedPermissions);
      } else {
        // Cache miss: fetch role permissions from MongoDB
        const roleObj = await roleRepo.findOne({ name: roleName }, ["permissions"]);
        if (!roleObj) {
          throw new AppError("Access denied. Role not found.", 403);
        }

        // Map populated permission documents to names list
        permissions = roleObj.permissions.map((p) => p.name);

        // Cache the permissions list in Redis for 24 hours (86400 seconds)
        await redis.setex(cacheKey, 86400, JSON.stringify(permissions));
      }
    } catch (err) {
      logger.error(`Error resolving permissions from cache/db: ${err.message}`);
      // Fallback directly to DB if Redis fails
      const roleObj = await roleRepo.findOne({ name: roleName }, ["permissions"]);
      if (!roleObj) {
        throw new AppError("Access denied. Role not found.", 403);
      }
      permissions = roleObj.permissions.map((p) => p.name);
    }

    // Verify permission exists
    const hasPermission = permissions.includes(requiredPermission);
    if (!hasPermission) {
      throw new AppError("Access denied. You do not have the required permissions.", 403);
    }

    // Check branch scope if required
    if (checkBranchScope) {
      const branchId = req.params.branchId || req.query.branchId || req.body.branchId;
      if (branchId) {
        const isBranchAuthorized = branches.some((b) => b.toString() === branchId.toString());
        if (!isBranchAuthorized) {
          throw new AppError("Access denied. You do not have access to this branch.", 403);
        }
      }
    }

    next();
  });
};
