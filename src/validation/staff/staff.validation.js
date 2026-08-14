import { z } from "zod";

const objectIdRegex = /^[0-9a-fA-F]{24}$/;
const objectIdSchema = z.string().regex(objectIdRegex, "Invalid ObjectId format");
const usernameRegex = /^[a-z0-9._-]{3,30}$/;

export const createStaffSchema = z.object({
  body: z.object({
    name: z.string().min(2, "Name must be at least 2 characters").trim(),
    email: z.string().email("Invalid email address").trim().toLowerCase(),
    phone: z.string().regex(/^\+?[1-9]\d{1,14}$/, "Invalid phone number format (E.164)"),
    designation: z.string().min(1, "Designation is required").trim(),
    joiningDate: z.preprocess(
      (val) => (typeof val === "string" ? new Date(val) : val),
      z.date({ required_error: "Joining date is required" })
    ),
    avatarUrl: z.string().url("Invalid URL format").or(z.literal("")).nullable().optional(),
    status: z.enum(["active", "inactive", "suspended"]).optional(),
    userId: z.union([
      objectIdSchema,
      z.string().trim().min(3).max(30).regex(usernameRegex),
    ]).or(z.literal("")).nullable().optional(),
  }),
});

export const updateStaffSchema = z.object({
  body: z.object({
    name: z.string().min(2, "Name must be at least 2 characters").trim().optional(),
    email: z.string().email("Invalid email address").trim().toLowerCase().optional(),
    phone: z.string().regex(/^\+?[1-9]\d{1,14}$/, "Invalid phone number format (E.164)").optional(),
    designation: z.string().min(1, "Designation is required").trim().optional(),
    joiningDate: z.preprocess(
      (val) => (typeof val === "string" ? new Date(val) : val),
      z.date().optional()
    ),
    avatarUrl: z.string().nullable().optional(),
    status: z.enum(["active", "inactive", "suspended"]).optional(),
    userId: z.union([
      objectIdSchema,
      z.string().trim().min(3).max(30).regex(usernameRegex),
    ]).or(z.literal("")).nullable().optional(),
  }),
});

const allowedSortFields = ["name", "staffCode", "joiningDate", "createdAt", "updatedAt"];

export const queryStaffSchema = z.object({
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
        }
      )
      .default("-createdAt"),
    search: z.string().optional(),
    status: z.enum(["active", "inactive", "suspended"]).optional(),
    branchId: objectIdSchema.optional(),
  }),
});

export const linkUserSchema = z.object({
  body: z.object({
    userId: z.union([
      objectIdSchema,
      z.string().trim().min(3, "User selection is required").max(30, "User selection is too long").regex(usernameRegex, "User selection must be a valid username or ObjectId"),
    ]),
  }).strict(),
});

export const assignBranchSchema = z.object({
  body: z.object({
    branchId: objectIdSchema,
    isPrimary: z.boolean().optional().default(false),
  }).strict(),
});

export const assignServiceSchema = z.object({
  body: z.object({
    serviceId: objectIdSchema,
  }).strict(),
});
