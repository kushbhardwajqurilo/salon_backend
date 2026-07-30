import { z } from "zod";

const objectIdRegex = /^[0-9a-fA-F]{24}$/;
const objectIdSchema = z.string().regex(objectIdRegex, "Invalid ObjectId format");

const addressSchema = z.object({
  addressLine1: z.string().trim().optional().default(""),
  addressLine2: z.string().trim().optional().default(""),
  city: z.string().trim().optional().default(""),
  state: z.string().trim().optional().default(""),
  postalCode: z.string().trim().optional().default(""),
  country: z.string().trim().optional().default(""),
});

const preferencesSchema = z.object({
  preferredStaff: z.array(objectIdSchema).optional().default([]),
  preferredServices: z.array(objectIdSchema).optional().default([]),
  drinkPreference: z.string().trim().optional().default(""),
  preferredContactTime: z.string().trim().optional().default(""),
  language: z.string().trim().optional().default(""),
  remarks: z.string().trim().optional().default(""),
});

const marketingPreferencesSchema = z.object({
  sms: z.boolean().optional().default(false),
  email: z.boolean().optional().default(false),
  whatsapp: z.boolean().optional().default(false),
  promotions: z.boolean().optional().default(false),
  appointmentReminders: z.boolean().optional().default(false),
});

export const createCustomerSchema = z.object({
  body: z.object({
    name: z.string().min(2, "Name must be at least 2 characters").trim(),
    email: z.preprocess((val) => (val === "" ? null : val), z.string().email("Invalid email address").trim().toLowerCase().optional().nullable()),
    phone: z.string().regex(/^\+?[1-9]\d{1,14}$/, "Invalid phone number format (E.164)"),
    gender: z.enum(["male", "female", "other", "prefer_not_to_say"]).optional().default("prefer_not_to_say"),
    dateOfBirth: z.preprocess((val) => (val === "" ? null : val), z.string().datetime("Invalid date format").or(z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "Invalid date format (YYYY-MM-DD)")).optional().nullable()),
    alternatePhone: z.preprocess((val) => (val === "" ? null : val), z.string().regex(/^\+?[1-9]\d{1,14}$/, "Invalid alternate phone number format (E.164)").optional().nullable()),
    address: addressSchema.optional(),
    preferences: preferencesSchema.optional(),
    marketingPreferences: marketingPreferencesSchema.optional(),
    doNotContact: z.boolean().optional().default(false),
    acquisitionSource: z.enum(["walk_in", "instagram", "facebook", "google", "website", "advertisement", "referral", "other"]).optional().default("walk_in"),
    referredByCustomerId: z.preprocess((val) => (val === "" ? null : val), objectIdSchema.optional().nullable()),
    tags: z.array(objectIdSchema).optional().default([]),
    status: z.enum(["active", "inactive", "blocked"]).optional().default("active"),
    allergies: z.array(z.string()).optional().default([]),
    sensitivities: z.array(z.string()).optional().default([]),
    isActive: z.boolean().optional(),
    loyaltyPoints: z.any().optional(),
    loyaltyPointsBalance: z.any().optional(),
  }),
});

export const updateCustomerSchema = z.object({
  body: z
    .object({
      name: z.string().min(2, "Name must be at least 2 characters").trim().optional(),
      email: z.preprocess((val) => (val === "" ? null : val), z.string().email("Invalid email address").trim().toLowerCase().optional().nullable()),
      phone: z.string().regex(/^\+?[1-9]\d{1,14}$/, "Invalid phone number format (E.164)").optional(),
      gender: z.enum(["male", "female", "other", "prefer_not_to_say"]).optional(),
      dateOfBirth: z.preprocess((val) => (val === "" ? null : val), z.string().datetime("Invalid date format").or(z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "Invalid date format (YYYY-MM-DD)")).optional().nullable()),
      alternatePhone: z.preprocess((val) => (val === "" ? null : val), z.string().regex(/^\+?[1-9]\d{1,14}$/, "Invalid alternate phone number format (E.164)").optional().nullable()),
      address: addressSchema.optional(),
      preferences: preferencesSchema.optional(),
      marketingPreferences: marketingPreferencesSchema.optional(),
      doNotContact: z.boolean().optional(),
      acquisitionSource: z.enum(["walk_in", "instagram", "facebook", "google", "website", "advertisement", "referral", "other"]).optional(),
      referredByCustomerId: z.preprocess((val) => (val === "" ? null : val), objectIdSchema.optional().nullable()),
      tags: z.array(z.string()).optional(),
      status: z.enum(["active", "inactive", "blocked"]).optional(),
      allergies: z.array(z.string()).optional(),
      sensitivities: z.array(z.string()).optional(),
      isActive: z.boolean().optional(),
      organizationId: z.any().optional(),
      homeBranchId: z.any().optional(),
      visitedBranchIds: z.any().optional(),
      loyaltyPoints: z.any().optional(),
      loyaltyPointsBalance: z.any().optional(),
    })
    .strict(),
});

export const addNoteSchema = z.object({
  body: z.object({
    text: z.string().min(1, "Note text cannot be empty").max(2000, "Note text exceeds maximum length of 2000 characters").trim(),
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
    status: z.enum(["active", "inactive", "blocked"]).optional(),
  }),
});

export const queryNotesSchema = z.object({
  query: z.object({
    page: z.coerce.number().int().positive().default(1),
    limit: z.coerce.number().int().positive().default(10),
  }),
});

export const queryActivitySchema = z.object({
  query: z.object({
    page: z.coerce.number().int().positive().default(1),
    limit: z.coerce.number().int().positive().default(10),
  }),
});

export const customerStatusUpdateSchema = z.object({
  params: z.object({
    id: objectIdSchema,
  }),
});
