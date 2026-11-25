import { z } from "zod";
import { CALENDAR_EVENT_TYPES } from "../../models/holidays/holidayCalendar.model.js";
import { isValidDateOnly, enumerateDates } from "../../utils/date.js";
import { isValidTimeHHmm } from "../../utils/operatingHours.js";

const objectIdSchema = z.string().regex(/^[0-9a-fA-F]{24}$/, "Invalid ObjectId format");
const dateOnlySchema = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}$/, "Date must be YYYY-MM-DD")
  .refine(isValidDateOnly, "Invalid calendar date");

const timeSchema = z.string().refine(isValidTimeHHmm, "Invalid time format (HH:mm)");

const operatingHoursOverrideSchema = z
  .object({
    isOpen: z.boolean().default(true),
    openTime: timeSchema.nullable().optional(),
    closeTime: timeSchema.nullable().optional(),
  })
  .superRefine((val, ctx) => {
    if (val.isOpen && (!val.openTime || !val.closeTime || val.openTime >= val.closeTime)) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: "Valid openTime < closeTime required when isOpen is true",
      });
    }
  });

export const holidayIdParamSchema = z.object({
  params: z.object({
    id: objectIdSchema,
  }),
});

export const listHolidaysQuerySchema = z.object({
  query: z
    .object({
      branchId: objectIdSchema.optional(),
      eventType: z.enum(CALENDAR_EVENT_TYPES).optional(),
      startDate: dateOnlySchema.optional(),
      endDate: dateOnlySchema.optional(),
      includeInactive: z.enum(["true", "false"]).optional(),
    })
    .strict()
    .superRefine((q, ctx) => {
      if ((q.startDate && !q.endDate) || (!q.startDate && q.endDate)) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["endDate"],
          message: "Both startDate and endDate are required when filtering by date range",
        });
      }
      if (q.startDate && q.endDate && q.endDate < q.startDate) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["endDate"],
          message: "endDate must be greater than or equal to startDate",
        });
      }
    }),
});

export const createHolidaySchema = z.object({
  body: z
    .object({
      branchId: objectIdSchema.nullable().optional(),
      date: dateOnlySchema,
      endDate: dateOnlySchema.nullable().optional(),
      eventType: z.enum(CALENDAR_EVENT_TYPES),
      name: z.string().trim().min(1, "Name is required").max(120),
      description: z.string().trim().max(500).nullable().optional(),
      isPaid: z.boolean().optional().default(false),
      operatingHoursOverride: operatingHoursOverrideSchema.nullable().optional(),
    })
    .strict()
    .superRefine((body, ctx) => {
      if (body.endDate && body.endDate < body.date) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["endDate"],
          message: "endDate must be greater than or equal to date",
        });
      }
      if (body.endDate) {
        const days = enumerateDates(body.date, body.endDate);
        if (days.length > 90) {
          ctx.addIssue({
            code: z.ZodIssueCode.custom,
            path: ["endDate"],
            message: "Calendar entry range cannot exceed 90 days",
          });
        }
      }
    }),
});

export const updateHolidaySchema = z.object({
  params: z.object({
    id: objectIdSchema,
  }),
  body: z
    .object({
      date: dateOnlySchema.optional(),
      endDate: dateOnlySchema.nullable().optional(),
      eventType: z.enum(CALENDAR_EVENT_TYPES).optional(),
      name: z.string().trim().min(1).max(120).optional(),
      description: z.string().trim().max(500).nullable().optional(),
      isPaid: z.boolean().optional(),
      operatingHoursOverride: operatingHoursOverrideSchema.nullable().optional(),
    })
    .strict()
    .superRefine((body, ctx) => {
      if (body.date && body.endDate && body.endDate < body.date) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["endDate"],
          message: "endDate must be greater than or equal to date",
        });
      }
    }),
});

export const resolveCalendarQuerySchema = z.object({
  query: z
    .object({
      branchId: objectIdSchema.optional(),
      startDate: dateOnlySchema,
      endDate: dateOnlySchema,
    })
    .strict()
    .superRefine((q, ctx) => {
      if (q.endDate < q.startDate) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["endDate"],
          message: "endDate must be greater than or equal to startDate",
        });
      } else {
        const days = enumerateDates(q.startDate, q.endDate);
        if (days.length > 90) {
          ctx.addIssue({
            code: z.ZodIssueCode.custom,
            path: ["endDate"],
            message: "Calendar resolution range cannot exceed 90 days",
          });
        }
      }
    }),
});
