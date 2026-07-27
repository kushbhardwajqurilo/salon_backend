import { z } from "zod";

const objectIdRegex = /^[0-9a-fA-F]{24}$/;
const objectIdSchema = z.string().regex(objectIdRegex, "Invalid ObjectId format");

export const createPermissionSchema = z.object({
  body: z.object({
    name: z
      .string()
      .min(3, "Permission name must be at least 3 characters")
      .regex(/^[a-z_]+(?:\.[a-z_]+)+$/, "Permission name must follow format 'module.action' or 'module.submodule.action' (e.g. 'customers.create')")
      .trim()
      .lowercase(),
    module: z.string().min(2, "Module must be at least 2 characters").trim(),
    action: z.string().min(2, "Action must be at least 2 characters").trim(),
    description: z.string().min(5, "Description must be at least 5 characters").trim(),
  }),
});

export const createRoleSchema = z.object({
  body: z.object({
    name: z
      .string()
      .min(3, "Role name must be at least 3 characters")
      .regex(/^[a-z_]+$/, "Role name can only contain lowercase letters and underscores")
      .trim()
      .lowercase(),
    description: z.string().min(5, "Description must be at least 5 characters").trim(),
  }),
});

export const assignPermissionsSchema = z.object({
  params: z.object({
    roleId: objectIdSchema,
  }),
  body: z.object({
    permissions: z.array(z.string()).min(1, "At least one permission name must be provided"),
  }),
});
