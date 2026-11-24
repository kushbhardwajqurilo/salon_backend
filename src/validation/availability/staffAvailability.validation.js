import { z } from "zod";

const objectIdRegex = /^[0-9a-fA-F]{24}$/;

export const getStaffAvailabilityQuerySchema = z.object({
  query: z.object({
    branchId: z.string().optional(),
    date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "Date must be YYYY-MM-DD"),
    startTime: z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/, "Time must be HH:mm").optional(),
    endTime: z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/, "Time must be HH:mm").optional(),
    duration: z.string().optional().transform((val) => (val ? Number(val) : 30)),
    serviceIds: z.union([z.string(), z.array(z.string())]).optional(),
    staffId: z.string().regex(objectIdRegex, "Invalid staffId").optional(),
    excludeAppointmentId: z.string().regex(objectIdRegex, "Invalid excludeAppointmentId").optional(),
  }),
});

export const getCalendarAvailabilityQuerySchema = z.object({
  query: z.object({
    branchId: z.string().optional(),
    date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "Date must be YYYY-MM-DD").optional(),
    startDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "Date must be YYYY-MM-DD").optional(),
    endDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "Date must be YYYY-MM-DD").optional(),
    staffId: z.string().regex(objectIdRegex, "Invalid staffId").optional(),
  }),
});

export const updateStaffRosterSchema = z.object({
  body: z.object({
    branchId: z.string().regex(objectIdRegex, "Invalid branchId"),
    effectiveFrom: z.string().optional(),
    effectiveTo: z.string().nullable().optional(),
    weeklySchedule: z.array(
      z.object({
        dayOfWeek: z.number().min(0).max(6),
        isWorkingDay: z.boolean(),
        shifts: z.array(
          z.object({
            startTime: z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/, "Time must be HH:mm"),
            endTime: z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/, "Time must be HH:mm"),
          }),
        ).optional().default([]),
      }),
    ).optional(),
    overrides: z.array(
      z.object({
        date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "Date must be YYYY-MM-DD"),
        isWorkingDay: z.boolean(),
        reason: z.string().optional().default(""),
        shifts: z.array(
          z.object({
            startTime: z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/, "Time must be HH:mm"),
            endTime: z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/, "Time must be HH:mm"),
          }),
        ).optional().default([]),
      }),
    ).optional(),
  }),
});
