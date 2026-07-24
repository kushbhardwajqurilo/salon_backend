import { PermissionService } from "../../services/permissions/permission.service.js";
import { RoleService } from "../../services/roles/role.service.js";
import { sendResponse } from "../../utils/response.js";
import { asyncHandler } from "../../utils/errors.js";
import { redis } from "../../utils/redis.js";

const permissionService = new PermissionService();
const roleService = new RoleService();

export const createPermission = asyncHandler(async (req, res) => {
  const permission = await permissionService.createPermission(req.body, req.user.id);
  return sendResponse(res, 201, "Permission created successfully", permission);
});

export const listPermissions = asyncHandler(async (req, res) => {
  const result = await permissionService.listPermissions(req.query);
  return sendResponse(res, 200, "Permissions retrieved successfully", result.data, result.meta);
});

export const createRole = asyncHandler(async (req, res) => {
  const role = await roleService.createRole(req.body);
  return sendResponse(res, 201, "Role created successfully", role);
});

export const listRoles = asyncHandler(async (req, res) => {
  const result = await roleService.listRoles(req.query);
  return sendResponse(res, 200, "Roles retrieved successfully", result.data, result.meta);
});

export const assignPermissionsToRole = asyncHandler(async (req, res) => {
  const { roleId } = req.params;
  const { permissions } = req.body;

  const role = await roleService.assignPermissionsToRole(roleId, permissions, req.user.id);

  // Invalidate Redis permissions cache for this role
  const cacheKey = `rbac:role:${role.name}:permissions`;
  await redis.del(cacheKey);

  return sendResponse(res, 200, `Permissions successfully assigned to role '${role.name}'`, role);
});
