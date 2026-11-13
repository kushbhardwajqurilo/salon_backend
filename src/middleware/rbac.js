import { RoleRepository } from "../repositories/roles/role.repository.js";
import { AppError } from "../utils/errors.js";
import { asyncHandler } from "../utils/errors.js";
import { redis } from "../utils/redis.js";
import { logger } from "../utils/logger.js";
import { PERMISSION_ALIASES } from "../config/permissions.js";

const roleRepo = new RoleRepository();

/**
 * Helper to resolve permissions for a given role within an organization.
 * Checks tenant-scoped Redis key, falls back to global Redis key, and finally queries MongoDB.
 *
 * @param {string} roleName
 * @param {string|null} organizationId
 * @returns {Promise<string[]>}
 */
async function resolveRolePermissions(roleName, organizationId) {
  const normalizedRole = roleName ? roleName.toLowerCase().trim() : "";
  if (!normalizedRole) return [];

  const orgScope = organizationId ? organizationId.toString() : null;
  const tenantCacheKey = orgScope ? `rbac:org:${orgScope}:role:${normalizedRole}:permissions` : null;
  const globalCacheKey = `rbac:org:global:role:${normalizedRole}:permissions`;

  let permissions = null;

  try {
    // 1. Check tenant-scoped cache first if organizationId is present
    if (tenantCacheKey) {
      const cachedPermissions = await redis.get(tenantCacheKey);
      if (cachedPermissions) {
        permissions = JSON.parse(cachedPermissions);
      }
    } else {
      // If no organizationId is provided, check the global system role cache directly
      const globalCached = await redis.get(globalCacheKey);
      if (globalCached) {
        permissions = JSON.parse(globalCached);
      }
    }
  } catch (err) {
    logger.error(`Error resolving permissions from Redis cache: ${err.message}`);
  }

  if (permissions) {
    return permissions;
  }

  // 3. Cache miss: fetch role from MongoDB using the repository contract.
  let roleObj;
  try {
    if (organizationId) {
      roleObj = await roleRepo.findByNameInOrg(normalizedRole, organizationId);
    } else {
      roleObj = await roleRepo.findByName(normalizedRole);
    }
  } catch (err) {
    logger.error(`Error querying role from DB: ${err.message}`);
  }

  if (!roleObj) {
    throw new AppError("Access denied. Role not found.", 403);
  }

  if (roleObj.populate) {
    await roleObj.populate("permissions");
  }

  permissions = (roleObj.permissions || []).map((p) => (p && p.name ? p.name : p.toString()));

  // 4. Cache the permissions in Redis for 24 hours (86400 seconds)
  // Establish role ownership using repository / model contract (roleObj.isSystem)
  // Do not infer system-role ownership from a missing organizationId.
  // If role is system-owned and accessed within an organization context, cache both
  // in tenant cache (for instantaneous tenant-isolated hits on subsequent requests)
  // and in the global system cache.
  try {
    const isSystemRole = Boolean(roleObj.isSystem);
    if (isSystemRole) {
      await redis.setex(globalCacheKey, 86400, JSON.stringify(permissions));
      if (tenantCacheKey) {
        await redis.setex(tenantCacheKey, 86400, JSON.stringify(permissions));
      }
    } else if (tenantCacheKey) {
      await redis.setex(tenantCacheKey, 86400, JSON.stringify(permissions));
    }
  } catch (cacheErr) {
    logger.warn(`Failed to cache permissions in Redis for role '${normalizedRole}': ${cacheErr.message}`);
  }

  return permissions;
}

/**
 * Middleware to enforce permissions and branch-level scope constraints.
 * Uses Redis caching with tenant scoping and bidirectional alias resolution.
 * @param {String} requiredPermission - The name of the permission (e.g., 'customers.update')
 * @param {Boolean} checkBranchScope - If true, checks if the branch in req.params/req.query is allowed for the user
 */
export const authorize = (requiredPermission, checkBranchScope = false) => {
  return asyncHandler(async (req, res, next) => {
    const { role: roleName, branchAccess } = req.user || {};
    const organizationId = req.user?.organizationId;

    const permissions = await resolveRolePermissions(roleName, organizationId);

    // Expand candidate permissions via permanent bidirectional alias map
    const candidatePermissions = PERMISSION_ALIASES[requiredPermission] || [requiredPermission];
    const hasPermission = candidatePermissions.some((perm) => permissions.includes(perm));

    if (!hasPermission) {
      throw new AppError(
        "Access denied. You do not have the required permissions.",
        403,
      );
    }

    // Check branch scope if required
    if (checkBranchScope) {
      const branchId =
        req.params.branchId || req.query.branchId || req.body.branchId;
      if (branchId) {
        const isBranchAuthorized = (branchAccess || []).some(
          (b) => b.branchId.toString() === branchId.toString() && b.isActive,
        );
        if (!isBranchAuthorized) {
          throw new AppError(
            "Access denied. You do not have access to this branch.",
            403,
          );
        }
      }
    }

    next();
  });
};

export const requirePermission = (requiredPermission) => {
  return asyncHandler(async (req, res, next) => {
    const { role: roleName } = req.user || {};
    const organizationId = req.user?.organizationId;

    const permissions = await resolveRolePermissions(roleName, organizationId);

    const requiredList = Array.isArray(requiredPermission)
      ? requiredPermission
      : [requiredPermission];

    const hasPermission = requiredList.some((reqPerm) => {
      const candidatePermissions = PERMISSION_ALIASES[reqPerm] || [reqPerm];
      return candidatePermissions.some((perm) => permissions.includes(perm));
    });

    if (!hasPermission) {
      throw new AppError(
        "Access denied. You do not have the required permissions.",
        403,
      );
    }

    next();
  });
};
