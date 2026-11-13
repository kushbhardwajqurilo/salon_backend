import { RoleRepository } from "../../repositories/roles/role.repository.js";
import { PermissionRepository } from "../../repositories/permissions/permission.repository.js";
import { User } from "../../models/users/user.model.js";
import { AppError } from "../../utils/errors.js";
import { redis } from "../../utils/redis.js";
import { logger } from "../../utils/logger.js";

/**
 * Invalidate Redis permissions cache for a given role and organization.
 * Ensures tenant-scoped keys and global system keys are accurately deleted post-commit.
 *
 * @param {string|null} organizationId
 * @param {string} roleName
 */
export const invalidateRoleCache = async (organizationId, roleName) => {
  if (!roleName) return;
  const normalizedRole = roleName.toLowerCase().trim();
  const orgScope = organizationId ? organizationId.toString() : "global";
  const cacheKey = `rbac:org:${orgScope}:role:${normalizedRole}:permissions`;

  try {
    await redis.del(cacheKey);
    // If invalidating without org or in global scope, ensure the global key is purged
    if (!organizationId || orgScope === "global") {
      await redis.del(`rbac:org:global:role:${normalizedRole}:permissions`);
    }
    // Also clean up any legacy un-scoped cache key to prevent stale reads during migration
    await redis.del(`rbac:role:${normalizedRole}:permissions`);
  } catch (err) {
    logger.warn(`Failed to invalidate Redis cache for key '${cacheKey}': ${err.message}`);
  }
};

export class RoleService {
  constructor() {
    this.roleRepo = new RoleRepository();
    this.permissionRepo = new PermissionRepository();
  }

  static async invalidateRoleCache(organizationId, roleName) {
    return invalidateRoleCache(organizationId, roleName);
  }

  async invalidateRoleCache(organizationId, roleName) {
    return invalidateRoleCache(organizationId, roleName);
  }

  async createRole(data, organizationId = null, userId = null) {
    const roleName = data.name.toLowerCase().trim();
    const existing = await this.roleRepo.findByNameInOrg(roleName, organizationId);
    if (existing) {
      throw new AppError("Role already exists", 400);
    }
    const payload = {
      ...data,
      name: roleName,
      organizationId: organizationId || null,
      isSystem: false,
    };
    const created = await this.roleRepo.create(payload, userId);
    await invalidateRoleCache(organizationId, roleName);
    return created;
  }

  async getRoleById(roleId, organizationId = null) {
    const role = await this.roleRepo.findRoleByIdAndOrg(roleId, organizationId);
    if (!role) {
      throw new AppError("Role not found", 404);
    }
    return role;
  }

  async assignPermissionsToRole(roleId, permissionNames, organizationId = null, userId = null) {
    const role = await this.roleRepo.findRoleByIdAndOrg(roleId, organizationId);
    if (!role) {
      throw new AppError("Role not found", 404);
    }

    if (role.isSystem) {
      throw new AppError("Cannot modify permissions for system roles", 400);
    }

    const permissions = await this.permissionRepo.findManyByNames(permissionNames);
    if (permissions.length !== permissionNames.length) {
      throw new AppError("One or more provided permission names are invalid", 400);
    }

    role.permissions = permissions.map((p) => p._id);
    if (userId) {
      role.updatedBy = userId;
    }
    // Database write
    await role.save();

    // Post-commit cache invalidation: only invalidate after database write succeeds
    await invalidateRoleCache(role.organizationId || organizationId, role.name);

    return this.roleRepo.findRoleByIdAndOrg(role._id, organizationId);
  }

  async listRoles(organizationId = null, options = {}) {
    if (organizationId) {
      return this.roleRepo.findRolesForOrganization(organizationId, options);
    }
    return this.roleRepo.find({}, { ...options, populate: ["permissions"] });
  }

  async deleteRole(roleId, organizationId = null) {
    const role = await this.roleRepo.findRoleByIdAndOrg(roleId, organizationId);
    if (!role) {
      throw new AppError("Role not found", 404);
    }

    if (role.isSystem || role.name === "owner") {
      throw new AppError("System roles cannot be deleted", 400);
    }

    const assignedUsersCount = await User.countDocuments({ role: roleId });
    if (assignedUsersCount > 0) {
      throw new AppError("Cannot delete role. Active users are currently assigned to this role.", 400);
    }

    // Database deletion
    await this.roleRepo.model.deleteOne({ _id: roleId });

    // Post-commit cache invalidation: only invalidate after database write succeeds
    await invalidateRoleCache(role.organizationId || organizationId, role.name);

    return role;
  }
}
