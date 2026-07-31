import { z } from "zod";

const objectIdRegex = /^[0-9a-fA-F]{24}$/;
const objectIdSchema = z.string().regex(objectIdRegex, "Invalid ObjectId format");

const serviceCodeRegex = /^[A-Z0-9_-]{3,20}$/;

export const createServiceCategorySchema = z.object({
  body: z.object({
    name: z.string().min(1, "Category name is required").trim().max(100, "Category name cannot exceed 100 characters"),
    description: z.string().trim().optional().default(""),
    displayOrder: z.coerce.number().int().optional().default(0),
  }),
});

export const updateServiceCategorySchema = z.object({
  body: z.object({
    name: z.string().min(1, "Category name is required").trim().max(100, "Category name cannot exceed 100 characters").optional(),
    description: z.string().trim().optional(),
    status: z.enum(["active", "inactive"]).optional(),
    displayOrder: z.coerce.number().int().optional(),
  }).strict(),
});

const allowedCategorySortFields = ["name", "createdAt", "updatedAt", "displayOrder"];

export const queryServiceCategorySchema = z.object({
  query: z.object({
    page: z.coerce.number().int().positive().default(1),
    limit: z.coerce.number().int().positive().default(10),
    sort: z
      .string()
      .refine(
        (val) => {
          const field = val.startsWith("-") ? val.slice(1) : val;
          return allowedCategorySortFields.includes(field);
        },
        {
          message: `Sort field must be one of: ${allowedCategorySortFields.join(", ")} (optionally prefixed with '-')`,
        }
      )
      .default("displayOrder"),
    search: z.string().optional(),
    status: z.enum(["active", "inactive"]).optional(),
  }),
});

export const createServiceSchema = z.object({
  body: z.object({
    name: z.string().min(1, "Service name is required").trim().max(100, "Service name cannot exceed 100 characters"),
    serviceCode: z.string().regex(serviceCodeRegex, "Service code must be 3-20 characters long and contain only uppercase letters, numbers, hyphens or underscores").trim().toUpperCase().optional(),
    description: z.string().trim().optional().default(""),
    categoryId: objectIdSchema,
    duration: z.coerce.number().int().positive("Duration must be a positive integer"),
    basePrice: z.coerce.number().nonnegative("Base price must be a non-negative number"),
    taxable: z.boolean().optional().default(false),
    taxRate: z.coerce.number().nonnegative("Tax rate must be a non-negative number").optional().default(0),
    displayOrder: z.coerce.number().int().optional().default(0),
  }),
});

export const updateServiceSchema = z.object({
  body: z.object({
    name: z.string().min(1, "Service name is required").trim().max(100, "Service name cannot exceed 100 characters").optional(),
    serviceCode: z.string().regex(serviceCodeRegex, "Service code format is invalid").trim().toUpperCase().optional(),
    description: z.string().trim().optional(),
    categoryId: objectIdSchema.optional(),
    duration: z.coerce.number().int().positive("Duration must be a positive integer").optional(),
    pricing: z.object({
      basePrice: z.coerce.number().nonnegative("Base price must be a non-negative number"),
    }).optional(),
    taxConfiguration: z.object({
      taxable: z.boolean().optional(),
      taxRate: z.coerce.number().nonnegative("Tax rate must be a non-negative number").optional(),
    }).optional(),
    status: z.enum(["active", "inactive"]).optional(),
    displayOrder: z.coerce.number().int().optional(),
  }).strict(),
});

const allowedServiceSortFields = ["name", "createdAt", "updatedAt", "displayOrder", "pricing.basePrice"];

export const queryServiceSchema = z.object({
  query: z.object({
    page: z.coerce.number().int().positive().default(1),
    limit: z.coerce.number().int().positive().default(10),
    sort: z
      .string()
      .refine(
        (val) => {
          const field = val.startsWith("-") ? val.slice(1) : val;
          return allowedServiceSortFields.includes(field);
        },
        {
          message: `Sort field must be one of: ${allowedServiceSortFields.join(", ")} (optionally prefixed with '-')`,
        }
      )
      .default("displayOrder"),
    search: z.string().optional(),
    status: z.enum(["active", "inactive"]).optional(),
    categoryId: objectIdSchema.optional(),
  }),
});

export const serviceStatusUpdateSchema = z.object({
  body: z.object({
    status: z.enum(["active", "inactive"]),
  }).strict(),
});
