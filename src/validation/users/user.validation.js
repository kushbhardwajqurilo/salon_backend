import { z } from "zod";

const objectIdRegex = /^[0-9a-fA-F]{24}$/;
const objectIdSchema = z
  .string()
  .regex(objectIdRegex, "Invalid ObjectId format");

const usernameRegex = /^[a-z0-9._-]{3,30}$/;

export const createUserSchema = z.object({
  body: z
    .object({
      name: z.string().min(2, "Name must be at least 2 characters").trim(),
      username: z
        .string()
        .trim()
        .min(3, "Username must be at least 3 characters")
        .max(30, "Username must be at most 30 characters")
        .regex(
          usernameRegex,
          "Username can only contain lowercase letters, numbers, dots, underscores, or hyphens",
        )
        .optional(),
      email: z.string().email("Invalid email address").trim().toLowerCase(),
      phone: z
        .string()
        .regex(/^\+?[1-9]\d{1,14}$/, "Invalid phone number format (E.164)"),
      roleId: objectIdSchema,
      branchAccess: z
        .array(
          z.object({
            branchId: objectIdSchema,
            branchName: z.string().min(1, "Branch name is required"),
            isActive: z.boolean().optional().default(true),
          }),
        )
        .optional()
        .default([]),
      hasOrgWideAccess: z.boolean().optional().default(false),
    })
    .optional(),
});

export const updateUserSchema = z.object({
  body: z
    .object({
      name: z
        .string()
        .min(2, "Name must be at least 2 characters")
        .trim()
        .optional(),
      username: z
        .string()
        .trim()
        .min(3, "Username must be at least 3 characters")
        .max(30, "Username must be at most 30 characters")
        .regex(
          usernameRegex,
          "Username can only contain lowercase letters, numbers, dots, underscores, or hyphens",
        )
        .optional(),
      phone: z
        .string()
        .regex(/^\+?[1-9]\d{1,14}$/, "Invalid phone number format (E.164)")
        .optional(),
      branchAccess: z
        .array(
          z.object({
            branchId: objectIdSchema,
            branchName: z.string().min(1, "Branch name is required"),
            isActive: z.boolean().optional().default(true),
          }),
        )
        .optional(),
      hasOrgWideAccess: z.boolean().optional(),
    })
    .strict(),
});

const allowedSortFields = ["name", "email", "createdAt", "updatedAt"];

export const listUsersQuerySchema = z.object({
  query: z.object({
    page: z.coerce.number().int().positive().default(1),
    limit: z.coerce.number().int().positive().default(10),
    sort: z
      .string()
      .refine(
        (val) => {
          const field = val.startsWith("-") ? val.slice(1) : val;
          return allowedSortFields.includes(field);
        },
        {
          message: `Sort field must be one of: ${allowedSortFields.join(", ")} (optionally prefixed with '-')`,
        },
      )
      .default("-createdAt"),
    search: z.string().optional(),
  }),
});

export const updateUserStatusSchema = z.object({
  body: z
    .object({
      status: z.enum(["active", "inactive", "suspended"]),
    })
    .strict(),
});
