import { PermissionService } from "../../services/permissions/permission.service.js";
import { RoleService, invalidateRoleCache } from "../../services/roles/role.service.js";
import { AuditLogService, extractAuditContext } from "../../services/audit/auditLog.service.js";
import { AUDIT_ACTIONS } from "../../models/audit/auditLog.model.js";
import { sendResponse } from "../../utils/response.js";
import { asyncHandler } from "../../utils/errors.js";

const permissionService = new PermissionService();
const roleService = new RoleService();
const auditLogService = new AuditLogService();

export const createPermission = asyncHandler(async (req, res) => {
  const permission = await permissionService.createPermission(req.body, req.user.id);
  await auditLogService.createAuditLog(
    {
      action: AUDIT_ACTIONS.PERMISSION_CREATED,
      entityType: "Permission",
      entityId: permission._id || permission.id,
      description: `Permission '${permission.name}' created`,
      ...extractAuditContext(req),
      metadata: { name: permission.name, module: permission.module },
    },
    req.organizationId || null,
    req.user?.userId || req.user?.id
  );
  return sendResponse(res, 201, "Permission created successfully", permission);
});

export const listPermissions = asyncHandler(async (req, res) => {
  const result = await permissionService.listPermissions(req.query);
  return sendResponse(res, 200, "Permissions retrieved successfully", result.data, result.meta);
});

export const listModules = asyncHandler(async (req, res) => {
  const modules = await permissionService.listModules();
  return sendResponse(res, 200, "Permission modules retrieved successfully", modules);
});

export const createRole = asyncHandler(async (req, res) => {
  const role = await roleService.createRole(req.body, req.organizationId, req.user?.id);
  await auditLogService.createAuditLog(
    {
      action: AUDIT_ACTIONS.ROLE_CREATED,
      entityType: "Role",
      entityId: role._id || role.id,
      description: `Role '${role.name}' created`,
      ...extractAuditContext(req),
      metadata: { name: role.name },
    },
    req.organizationId || null,
    req.user?.userId || req.user?.id
  );
  return sendResponse(res, 201, "Role created successfully", role);
});

export const listRoles = asyncHandler(async (req, res) => {
  const result = await roleService.listRoles(req.organizationId, req.query);
  return sendResponse(res, 200, "Roles retrieved successfully", result.data, result.meta);
});

export const getRoleById = asyncHandler(async (req, res) => {
  const { roleId } = req.params;
  const role = await roleService.getRoleById(roleId, req.organizationId);
  return sendResponse(res, 200, "Role details retrieved successfully", role);
});

export const assignPermissionsToRole = asyncHandler(async (req, res) => {
  const { roleId } = req.params;
  const { permissions } = req.body;

  const role = await roleService.assignPermissionsToRole(roleId, permissions, req.organizationId, req.user?.id);

  // Invalidate Redis permissions cache for this role using org-scoped helper
  await invalidateRoleCache(req.organizationId || role.organizationId, role.name);

  await auditLogService.createAuditLog(
    {
      action: AUDIT_ACTIONS.ROLE_PERMISSIONS_UPDATED,
      entityType: "Role",
      entityId: role._id || role.id || roleId,
      description: `Permissions updated for role '${role.name}'`,
      ...extractAuditContext(req),
      metadata: { roleName: role.name, permissionsCount: Array.isArray(permissions) ? permissions.length : 0 },
    },
    req.organizationId || role.organizationId || null,
    req.user?.userId || req.user?.id
  );

  return sendResponse(res, 200, `Permissions successfully assigned to role '${role.name}'`, role);
});

export const deleteRole = asyncHandler(async (req, res) => {
  const { roleId } = req.params;
  const role = await roleService.deleteRole(roleId, req.organizationId);

  // Invalidate Redis permissions cache for this role using org-scoped helper
  if (role) {
    await invalidateRoleCache(req.organizationId || role.organizationId, role.name);
    await auditLogService.createAuditLog(
      {
        action: AUDIT_ACTIONS.ROLE_DELETED,
        entityType: "Role",
        entityId: role._id || role.id || roleId,
        description: `Role '${role.name}' deleted`,
        ...extractAuditContext(req),
        metadata: { roleName: role.name },
      },
      req.organizationId || role.organizationId || null,
      req.user?.userId || req.user?.id
    );
  }

  return sendResponse(res, 200, "Role deleted successfully", null);
});
