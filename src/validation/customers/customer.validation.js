import { z } from "zod";

const objectIdRegex = /^[0-9a-fA-F]{24}$/;
const objectIdSchema = z.string().regex(objectIdRegex, "Invalid ObjectId format");

export const createCustomerSchema = z.object({
  body: z.object({
    name: z.string().min(2, "Name must be at least 2 characters").trim(),
    email: z.string().email("Invalid email address").trim().toLowerCase().optional().nullable(),
    // Enforce strict E.164 phone format
    phone: z.string().regex(/^\+?[1-9]\d{1,14}$/, "Invalid phone number format (E.164)"),
    preferences: z
      .object({
        preferredStaff: z.array(objectIdSchema).optional(),
        preferredServices: z.array(z.string()).optional(),
        drinkPreference: z.string().optional(),
        remarks: z.string().optional(),
      })
      .optional(),
    gender: z.string().optional(),
    dateOfBirth: z.string().optional().nullable(),
    address: z.string().optional(),
    isActive: z.boolean().optional(),
  }),
});

export const updateCustomerSchema = z.object({
  body: z
    .object({
      name: z.string().min(2, "Name must be at least 2 characters").trim().optional(),
      email: z.string().email("Invalid email address").trim().toLowerCase().optional().nullable(),
      phone: z.string().regex(/^\+?[1-9]\d{1,14}$/, "Invalid phone number format (E.164)").optional(),
      preferences: z
        .object({
          preferredStaff: z.array(objectIdSchema).optional(),
          preferredServices: z.array(z.string()).optional(),
          drinkPreference: z.string().optional(),
          remarks: z.string().optional(),
        })
        .optional(),
      gender: z.string().optional(),
      dateOfBirth: z.string().datetime("Invalid date format").optional().nullable(),
      address: z.string().optional(),
      isActive: z.boolean().optional(),
      organizationId: z.any().optional(),
      homeBranchId: z.any().optional(),
      visitedBranchIds: z.any().optional(),
    })
    .strict(), // Reject request if any other field is sent (like loyaltyPoints)
});

export const addNoteSchema = z.object({
  body: z.object({
    text: z.string().min(1, "Note text cannot be empty").trim(),
  }),
});

const allowedSortFields = ["name", "createdAt", "updatedAt", "loyaltyPoints"];

export const queryCustomerSchema = z.object({
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
    isActive: z.preprocess((val) => {
      if (typeof val === "boolean") return val;
      if (val === "true") return true;
      if (val === "false") return false;
      return undefined;
    }, z.boolean().optional()),
  }),
});

export const customerStatusUpdateSchema = z.object({
  params: z.object({
    id: objectIdSchema,
  }),
});
