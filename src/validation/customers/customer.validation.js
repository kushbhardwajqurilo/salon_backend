import { z } from "zod";

const objectIdRegex = /^[0-9a-fA-F]{24}$/;

const objectIdSchema = z.string().regex(objectIdRegex, "Invalid ObjectId format");

export const createCustomerSchema = z.object({
  body: z.object({
    name: z.string().min(2, "Name must be at least 2 characters").trim(),
    email: z.string().email("Invalid email address").trim().toLowerCase().optional().nullable(),
    phone: z.string().regex(/^\+?[1-9]\d{1,14}$/, "Invalid phone number format (E.164)"),
    branchId: objectIdSchema,
    loyaltyPoints: z.number().int().nonnegative().optional(),
    preferences: z
      .object({
        preferredStaff: z.array(objectIdSchema).optional(),
        preferredServices: z.array(z.string()).optional(),
        drinkPreference: z.string().optional(),
        remarks: z.string().optional(),
      })
      .optional(),
  }),
});

export const updateCustomerSchema = z.object({
  body: z
    .object({
      name: z.string().min(2, "Name must be at least 2 characters").trim().optional(),
      email: z.string().email("Invalid email address").trim().toLowerCase().optional().nullable(),
      phone: z.string().regex(/^\+?[1-9]\d{1,14}$/, "Invalid phone number format (E.164)").optional(),
      branchId: objectIdSchema.optional(),
      loyaltyPoints: z.number().int().nonnegative().optional(),
      preferences: z
        .object({
          preferredStaff: z.array(objectIdSchema).optional(),
          preferredServices: z.array(z.string()).optional(),
          drinkPreference: z.string().optional(),
          remarks: z.string().optional(),
        })
        .optional(),
    })
    .strict(),
});

export const addNoteSchema = z.object({
  body: z.object({
    text: z.string().min(1, "Note text cannot be empty").trim(),
  }),
});

export const updatePreferencesSchema = z.object({
  body: z.object({
    preferredStaff: z.array(objectIdSchema).optional(),
    preferredServices: z.array(z.string()).optional(),
    drinkPreference: z.string().optional(),
    remarks: z.string().optional(),
  }),
});

export const addVisitSchema = z.object({
  body: z.object({
    appointmentId: objectIdSchema.optional(),
    date: z.string().datetime("Invalid date format (must be ISO8601)"),
    totalAmount: z.number().nonnegative(),
    status: z.string().min(1, "Status is required").trim(),
  }),
});

export const addServiceSchema = z.object({
  body: z.object({
    serviceId: objectIdSchema.optional(),
    serviceName: z.string().min(1, "Service name is required").trim(),
    date: z.string().datetime("Invalid date format (must be ISO8601)"),
  }),
});

export const addMembershipSchema = z.object({
  body: z.object({
    membershipName: z.string().min(1, "Membership name is required").trim(),
    startDate: z.string().datetime(),
    endDate: z.string().datetime(),
    status: z.enum(["active", "expired", "cancelled"]).default("active"),
  }),
});

export const adjustLoyaltySchema = z.object({
  body: z.object({
    points: z.number().int("Points must be an integer"),
  }),
});

export const queryCustomerSchema = z.object({
  query: z.object({
    page: z.coerce.number().int().positive().default(1),
    limit: z.coerce.number().int().positive().default(10),
    sort: z.string().default("-createdAt"),
    search: z.string().optional(),
    branchId: objectIdSchema.optional(),
  }),
});
