import { PermissionRepository } from "../../repositories/permissions/permission.repository.js";
import { AppError } from "../../utils/errors.js";

export class PermissionService {
  constructor() {
    this.permissionRepo = new PermissionRepository();
  }

  async createPermission(data, userId = null) {
    const existing = await this.permissionRepo.findByName(data.name);
    if (existing) {
      throw new AppError("Permission already exists", 400);
    }
    return this.permissionRepo.create(data, userId);
  }

  async listPermissions(options) {
    return this.permissionRepo.find({}, options);
  }
}
