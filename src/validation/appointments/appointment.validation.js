import { z } from "zod";

const objectIdRegex = /^[0-9a-fA-F]{24}$/;
const objectIdSchema = z.string().refine((val) => objectIdRegex.test(val), {
  message: "Invalid ObjectId format",
});

const dateStringRegex = /^\d{4}-\d{2}-\d{2}$/;
const timeStringRegex = /^([01]\d|2[0-3]):[0-5]\d$/;

export const createAppointmentSchema = z.object({
  body: z.object({
    branchId: objectIdSchema,
    customerId: objectIdSchema,
    staffId: objectIdSchema.optional().nullable(),
    serviceIds: z.array(objectIdSchema).min(1, "At least one service must be selected"),
    appointmentDate: z.string().regex(dateStringRegex, "Invalid date format (YYYY-MM-DD)").optional(),
    date: z.string().regex(dateStringRegex, "Invalid date format (YYYY-MM-DD)").optional(),
    startTime: z.string().regex(timeStringRegex, "Invalid time format (HH:mm 24-hr)"),
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
  }),
});

export const updateAppointmentSchema = z.object({
  body: z.object({
    branchId: objectIdSchema,
    serviceIds: z.array(objectIdSchema).min(1).optional(),
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
  }),
});

export const rescheduleAppointmentSchema = z.object({
  body: z.object({
    branchId: objectIdSchema,
    appointmentDate: z.string().regex(dateStringRegex, "Invalid date format (YYYY-MM-DD)").optional(),
    date: z.string().regex(dateStringRegex, "Invalid date format (YYYY-MM-DD)").optional(),
    startTime: z.string().regex(timeStringRegex, "Invalid time format (HH:mm 24-hr)"),
  }),
});

export const updateAppointmentStatusSchema = z.object({
  body: z.object({
    branchId: objectIdSchema,
    status: z.enum(["in_progress", "completed", "cancelled", "no_show"]),
    reason: z.string().max(1000).optional(),
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
