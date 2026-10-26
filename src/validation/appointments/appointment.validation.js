import { z } from "zod";

const objectIdRegex = /^[0-9a-fA-F]{24}$/;
const objectIdSchema = z.string().refine((val) => objectIdRegex.test(val), {
  message: "Invalid ObjectId format",
});

const dateStringRegex = /^\d{4}-\d{2}-\d{2}$/;
const timeStringRegex = /^([01]\d|2[0-3]):[0-5]\d$/;

const registeredServiceItemSchema = z.object({
  type: z.literal("registered"),
  serviceType: z.enum(["registered", "custom"]).optional(),
  serviceId: objectIdSchema,
  customPrice: z.coerce
    .number()
    .min(0, "Custom price must be a non-negative number")
    .optional(),
  appliedSubscriptionId: objectIdSchema.or(z.literal("auto")).optional().nullable(),
  _id: z.string().optional(),
});

const customServiceItemSchema = z.object({
  type: z.literal("custom"),
  serviceType: z.enum(["registered", "custom"]).optional(),
  name: z.string().trim().min(1, "Custom service name is required").max(120),
  duration: z.coerce
    .number()
    .int("Duration must be an integer")
    .min(1, "Duration must be at least 1 minute")
    .max(720, "Duration cannot exceed 720 minutes"),
  price: z.coerce
    .number()
    .min(0, "Price must be a non-negative number")
    .optional(),
  // Custom lines strictly cannot consume subscriptions
  appliedSubscriptionId: z.null().optional(),
  _id: z.string().optional(),
}).refine(
  (data) => !data.appliedSubscriptionId,
  {
    message: "Custom services cannot have subscription assignments or redemption",
    path: ["appliedSubscriptionId"],
  }
).refine(
  (data) => data._id || data.price !== undefined,
  {
    message: "Price is required for new custom services",
    path: ["price"],
  }
);

export const appointmentServiceItemSchema = z.preprocess((val) => {
  if (typeof val === "object" && val !== null) {
    if (val.serviceType === "custom" || val.type === "custom" || (!val.serviceId && val.name && val.duration !== undefined)) {
      return { ...val, type: "custom", serviceType: "custom" };
    }
    return { ...val, type: "registered", serviceType: "registered" };
  }
  return val;
}, z.discriminatedUnion("type", [
  registeredServiceItemSchema,
  customServiceItemSchema,
]));

export const createAppointmentSchema = z.object({
  body: z
    .object({
      branchId: objectIdSchema,
      customerId: objectIdSchema,
      staffId: objectIdSchema.optional().nullable(),
      serviceIds: z
        .array(objectIdSchema)
        .optional()
        .nullable(),
      services: z
        .array(appointmentServiceItemSchema)
        .optional()
        .nullable(),
      appointmentDate: z
        .string()
        .regex(dateStringRegex, "Invalid date format (YYYY-MM-DD)")
        .optional(),
      date: z
        .string()
        .regex(dateStringRegex, "Invalid date format (YYYY-MM-DD)")
        .optional(),
      startTime: z
        .string()
        .regex(timeStringRegex, "Invalid time format (HH:mm 24-hr)"),
      bookingType: z.enum(["advance", "walk_in"]),
      notes: z.string().max(1000).optional(),
      discount: z.number().min(0).optional().default(0),
      reminder: z
        .object({
          enabled: z.boolean().optional().default(true),
          channel: z.enum(["email", "sms", "both"]).optional().default("sms"),
          offsetMinutes: z.number().min(5).max(1440).optional().default(60),
        })
        .optional(),
    })
    .refine(
      (data) =>
        (Array.isArray(data.services) && data.services.length > 0) ||
        (Array.isArray(data.serviceIds) && data.serviceIds.length > 0),
      {
        message:
          "At least one service must be selected (provide services or serviceIds)",
        path: ["services"],
      },
    ),
});

export const updateAppointmentSchema = z.object({
  body: z.object({
    branchId: objectIdSchema,
    serviceIds: z.array(objectIdSchema).optional().nullable(),
    services: z.array(appointmentServiceItemSchema).optional().nullable(),
    staffId: objectIdSchema.optional().nullable(),
    notes: z.string().max(1000).optional(),
    discount: z.number().min(0).optional(),
    reminder: z
      .object({
        enabled: z.boolean().optional(),
        channel: z.enum(["email", "sms", "both"]).optional(),
        offsetMinutes: z.number().min(5).max(1440).optional(),
      })
      .optional(),
  }).refine(
    (data) => {
      // If neither serviceIds nor services is provided, update is valid (updating notes/staff/etc.)
      if (data.serviceIds === undefined && data.services === undefined) return true;
      const hasServiceIds = Array.isArray(data.serviceIds) && data.serviceIds.length > 0;
      const hasServices = Array.isArray(data.services) && data.services.length > 0;
      return hasServiceIds || hasServices;
    },
    {
      message: "At least one service must be selected when updating services",
      path: ["services"],
    }
  ),
});

export const rescheduleAppointmentSchema = z.object({
  body: z.object({
    branchId: objectIdSchema,
    appointmentDate: z
      .string()
      .regex(dateStringRegex, "Invalid date format (YYYY-MM-DD)")
      .optional(),
    date: z
      .string()
      .regex(dateStringRegex, "Invalid date format (YYYY-MM-DD)")
      .optional(),
    startTime: z
      .string()
      .regex(timeStringRegex, "Invalid time format (HH:mm 24-hr)"),
  }),
});

export const updateAppointmentStatusSchema = z.object({
  body: z.object({
    branchId: objectIdSchema,
    status: z.enum([
      "in_progress",
      "completed",
      "cancelled",
      "no_show",
      "scheduled",
    ]),
    reason: z.string().max(1000).optional(),
    forceEarlyStart: z.boolean().optional(),
    allowOverdueStaffOverride: z.boolean().optional(),
  }),
});

export const assignStaffSchema = z.object({
  body: z.object({
    branchId: objectIdSchema,
    staffId: objectIdSchema.nullable(),
  }),
});

export const cancelAppointmentSchema = z.object({
  body: z.object({
    branchId: objectIdSchema,
    reason: z.string().max(1000).optional(),
  }),
});

export const triggerReminderSchema = z.object({
  body: z.object({
    branchId: objectIdSchema,
  }),
});

export const requestConsumptionOtpSchema = z.object({
  body: z.object({
    branchId: objectIdSchema,
  }),
});

export const completeAppointmentWithSubscriptionSchema = z.object({
  body: z.object({
    branchId: objectIdSchema,
    otp: z.string().trim().min(4, "OTP is required"),
  }),
});

export const previewServiceModificationSchema = z.object({
  body: z.object({
    branchId: objectIdSchema,
    serviceIds: z.array(objectIdSchema).optional().nullable(),
    services: z.array(appointmentServiceItemSchema).optional().nullable(),
    discount: z.number().min(0).optional(),
  }).refine(
    (data) => (Array.isArray(data.services) && data.services.length > 0) || (Array.isArray(data.serviceIds) && data.serviceIds.length > 0),
    {
      message: "At least one service must be selected (provide services or serviceIds)",
      path: ["services"],
    }
  ),
});

export const commitServiceModificationSchema = z.object({
  body: z.object({
    branchId: objectIdSchema,
    previewToken: z.string().min(10, "Valid previewToken is required"),
    serviceIds: z.array(objectIdSchema).optional().nullable(),
    services: z.array(appointmentServiceItemSchema).optional().nullable(),
    discount: z.number().min(0).optional(),
    managerOverrideReason: z.string().max(1000).optional(),
  }).refine(
    (data) => (Array.isArray(data.services) && data.services.length > 0) || (Array.isArray(data.serviceIds) && data.serviceIds.length > 0),
    {
      message: "At least one service must be selected (provide services or serviceIds)",
      path: ["services"],
    }
  ),
});

export const upsellSubscriptionSchema = z.object({
  body: z.object({
    branchId: objectIdSchema.optional(),
    price: z.number().min(0, "Price must be non-negative"),
    entitlements: z
      .array(
        z.object({
          serviceId: objectIdSchema,
          quantity: z.number().int().min(1, "Quantity must be at least 1"),
        })
      )
      .min(1, "At least one entitlement is required"),
    permittedBranchIds: z.array(objectIdSchema).optional().default([]),
    startDate: z
      .string()
      .datetime("Invalid ISO date for startDate")
      .or(z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "Invalid date format (YYYY-MM-DD)"))
      .optional(),
    endDate: z
      .string()
      .datetime("Invalid ISO date for endDate")
      .or(z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "Invalid date format (YYYY-MM-DD)")),
    planId: objectIdSchema.optional().nullable(),
    notes: z.string().trim().max(1000).optional().default(""),
    billImmediately: z.boolean().optional().default(true),
  }),
});

