import { z } from "zod";

const objectIdRegex = /^[0-9a-fA-F]{24}$/;
const objectIdSchema = z.string().regex(objectIdRegex, "Invalid ObjectId format");

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
    avatarUrl: z.string().url("Invalid URL format").nullable().optional(),
  }).strict(),
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
    avatarUrl: z.string().url("Invalid URL format").nullable().optional(),
    status: z.enum(["active", "inactive", "suspended"]).optional(),
  }).strict(),
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
    userId: objectIdSchema,
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
