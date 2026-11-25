import { z } from "zod";
import { CANONICAL_WEEKDAYS, isValidTimeHHmm } from "../../utils/operatingHours.js";

const objectIdSchema = z.string().regex(/^[0-9a-fA-F]{24}$/, "Invalid ObjectId format");
const timeSchema = z.string().refine(isValidTimeHHmm, "Invalid time format (HH:mm)");

const dayHoursSchema = z
  .object({
    isOpen: z.boolean(),
    openTime: timeSchema.nullable().optional(),
    closeTime: timeSchema.nullable().optional(),
  })
  .superRefine((val, ctx) => {
    if (val.isOpen) {
      if (!val.openTime || !val.closeTime) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: "openTime and closeTime are required when isOpen is true",
        });
      } else if (val.openTime >= val.closeTime) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: "closeTime must be strictly after openTime",
        });
      }
    }
  });

const breakWindowSchema = z
  .object({
    startTime: timeSchema,
    endTime: timeSchema,
    label: z.string().trim().max(60).optional(),
  })
  .refine((v) => v.startTime < v.endTime, {
    message: "Break endTime must be strictly after startTime",
  });

export const updateOrganizationSettingsSchema = z.object({
  body: z
    .object({
      organization: z
        .object({
          name: z.string().trim().min(1).max(120).optional(),
          logo: z.string().trim().nullable().optional(),
          expenseApprovalThreshold: z.number().min(0).optional(),
          allowedExpenseCategories: z.array(z.string().trim().min(1)).optional(),
        })
        .strict()
        .optional(),
      profile: z
        .object({
          displayName: z.string().trim().max(120).nullable().optional(),
          email: z.string().trim().email().nullable().optional(),
          phone: z.string().trim().max(30).nullable().optional(),
          address: z.string().trim().max(500).nullable().optional(),
          website: z.string().trim().max(200).nullable().optional(),
        })
        .strict()
        .optional(),
      regional: z
        .object({
          timezone: z.string().trim().min(1).max(60).optional(),
          currency: z.string().trim().min(3).max(5).optional(),
          locale: z.string().trim().min(2).max(20).optional(),
          dateFormat: z.enum(["YYYY-MM-DD", "DD/MM/YYYY", "MM/DD/YYYY", "DD-MM-YYYY"]).optional(),
          timeFormat: z.enum(["HH:mm", "hh:mm A"]).optional(),
          firstDayOfWeek: z.number().int().min(0).max(6).optional(),
        })
        .strict()
        .optional(),
      defaults: z
        .object({
          appointmentBufferMinutes: z.number().int().min(0).max(240).optional(),
          allowWalkIns: z.boolean().optional(),
          allowAdvanceBookings: z.boolean().optional(),
          reminderDefaultOffsetMinutes: z.number().int().min(0).max(10080).optional(),
          attendanceGraceMinutes: z.number().int().min(0).max(180).optional(),
          autoMarkAbsentAfterCutoff: z.boolean().optional(),
          defaultWeeklyOffDays: z.array(z.number().int().min(0).max(6)).optional(),
          defaultHalfDayEligible: z.boolean().optional(),
          exportRetentionHours: z.number().int().min(1).max(720).optional(),
        })
        .strict()
        .optional(),
    })
    .strict(),
});

export const branchIdParamSchema = z.object({
  params: z.object({
    branchId: objectIdSchema,
  }),
});

export const updateBranchSettingsSchema = z.object({
  params: z.object({
    branchId: objectIdSchema,
  }),
  body: z
    .object({
      branch: z
        .object({
          timezone: z.string().trim().min(1).max(60).optional(),
          bufferMinutes: z.number().int().min(0).max(240).optional(),
          address: z.string().trim().max(500).nullable().optional(),
          phone: z.string().trim().max(30).nullable().optional(),
          operatingHours: z.record(z.enum(CANONICAL_WEEKDAYS), dayHoursSchema).optional(),
        })
        .strict()
        .optional(),
      breakWindows: z.record(z.enum(CANONICAL_WEEKDAYS), z.array(breakWindowSchema)).optional(),
      weeklyOffDays: z.array(z.number().int().min(0).max(6)).nullable().optional(),
      appointmentOverrides: z
        .object({
          bufferMinutes: z.number().int().min(0).max(240).nullable().optional(),
          allowWalkIns: z.boolean().nullable().optional(),
          allowAdvanceBookings: z.boolean().nullable().optional(),
          reminderDefaultOffsetMinutes: z.number().int().min(0).max(10080).nullable().optional(),
        })
        .strict()
        .optional(),
      attendanceOverrides: z
        .object({
          graceMinutes: z.number().int().min(0).max(180).nullable().optional(),
          autoMarkAbsentAfterCutoff: z.boolean().nullable().optional(),
        })
        .strict()
        .optional(),
      leaveOverrides: z
        .object({
          allowHalfDay: z.boolean().nullable().optional(),
          allowBranchPolicyOverrides: z.boolean().nullable().optional(),
        })
        .strict()
        .optional(),
    })
    .strict(),
});

export const effectiveSettingsQuerySchema = z.object({
  query: z
    .object({
      branchId: objectIdSchema.optional(),
    })
    .strict(),
});
