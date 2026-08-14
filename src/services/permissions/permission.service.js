import { PermissionRepository } from "../../repositories/permissions/permission.repository.js";
import { AppError } from "../../utils/errors.js";
import { redis } from "../../utils/redis.js";

export class PermissionService {
  constructor() {
    this.permissionRepo = new PermissionRepository();
  }

  async createPermission(data, userId = null) {
    const existing = await this.permissionRepo.findByName(data.name);
    if (existing) {
      throw new AppError("Permission already exists", 400);
    }
    const created = await this.permissionRepo.create(data, userId);
    try {
      await redis.del("rbac:modules");
    } catch (err) {
      // Ignore cache invalidation error
    }
    return created;
  }

  async listPermissions(options) {
    return this.permissionRepo.listPermissions(options);
  }

  async listModules() {
    const cacheKey = "rbac:modules";
    try {
      const cached = await redis.get(cacheKey);
      if (cached) {
        return JSON.parse(cached);
      }
    } catch (err) {
      // Fallback to database query if Redis fails
    }

    const modules = await this.permissionRepo.getDistinctModules();

    try {
      await redis.setex(cacheKey, 86400, JSON.stringify(modules));
    } catch (err) {
      // Ignore cache write error
    }

    return modules;
  }
}
