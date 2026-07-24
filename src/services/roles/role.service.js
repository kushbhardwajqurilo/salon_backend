import { RoleRepository } from "../../repositories/roles/role.repository.js";
import { PermissionRepository } from "../../repositories/permissions/permission.repository.js";
import { AppError } from "../../utils/errors.js";

export class RoleService {
  constructor() {
    this.roleRepo = new RoleRepository();
    this.permissionRepo = new PermissionRepository();
  }

  async createRole(data) {
    const existing = await this.roleRepo.findByName(data.name);
    if (existing) {
      throw new AppError("Role already exists", 400);
    }
    return this.roleRepo.create(data);
  }

  async assignPermissionsToRole(roleId, permissionNames, userId = null) {
    const role = await this.roleRepo.findById(roleId);
    if (!role) {
      throw new AppError("Role not found", 404);
    }

    const permissions = await this.permissionRepo.findManyByNames(permissionNames);
    role.permissions = permissions.map((p) => p._id);
    return role.save();
  }

  async listRoles(options) {
    return this.roleRepo.find({}, { ...options, populate: ["permissions"] });
  }
}
