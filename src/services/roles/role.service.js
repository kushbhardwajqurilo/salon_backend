import { RoleRepository } from "../../repositories/roles/role.repository.js";
import { PermissionRepository } from "../../repositories/permissions/permission.repository.js";
import { User } from "../../models/users/user.model.js";
import { AppError } from "../../utils/errors.js";

export class RoleService {
  constructor() {
    this.roleRepo = new RoleRepository();
    this.permissionRepo = new PermissionRepository();
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
    return this.roleRepo.create(payload, userId);
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
    await role.save();
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

    await this.roleRepo.model.deleteOne({ _id: roleId });
    return role;
  }
}
