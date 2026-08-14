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

export const roleIdParamSchema = z.object({
  params: z.object({
    roleId: objectIdSchema,
  }),
});

export const createRoleSchema = z.object({
  body: z.object({
    name: z
      .string()
      .min(2, "Role name must be at least 2 characters")
      .trim(),
    description: z.string().min(3, "Description must be at least 3 characters").trim(),
  }),
});

export const assignPermissionsSchema = z.object({
  params: z.object({
    roleId: objectIdSchema,
  }),
  body: z.object({
    permissions: z.array(z.string()),
  }),
});

export const listPermissionsQuerySchema = z.object({
  query: z.object({
    page: z.union([z.string(), z.number()]).optional().transform((val) => {
      const p = Number(val);
      return isNaN(p) || p < 1 ? 1 : Math.floor(p);
    }),
    limit: z.union([z.string(), z.number()]).optional().transform((val) => {
      const l = Number(val);
      return isNaN(l) || l < 1 ? 10 : Math.min(Math.floor(l), 100);
    }),
    search: z.string().optional(),
    module: z.string().optional(),
  }),
});
