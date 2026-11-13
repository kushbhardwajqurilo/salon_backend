import { z } from "zod";
import { isValidDateOnly, enumerateDates, MAX_LEAVE_DAYS } from "../../utils/date.js";

const objectIdRegex = /^[0-9a-fA-F]{24}$/;
const objectIdSchema = z.string().regex(objectIdRegex, "Invalid ObjectId format");
const timeStringSchema = z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/, "Invalid time format (HH:mm)");

/**
 * YYYY-MM-DD date-only string.
 * Rejects datetime strings and impossible calendar dates (e.g. 2026-02-30).
 */
const dateOnlySchema = z
    .string()
    .regex(/^\d{4}-\d{2}-\d{2}$/, "Invalid date format (YYYY-MM-DD)")
    .refine((val) => isValidDateOnly(val), {
        message: "Invalid calendar date",
    });

/**
 * Cross-field leave interval validation:
 * For partial-day leaves: single calendar day (startDate === endDate), required dayPart, custom times, and startTime < endTime.
 * For full-day leaves: startDate <= endDate and range <= MAX_LEAVE_DAYS.
 */
const validateLeaveInterval = (body, ctx) => {
    if (body.isPartialDay) {
        // Rule 1: Partial-day leave must start and end on the same calendar date if both are provided
        if (body.startDate && body.endDate && body.startDate !== body.endDate) {
            ctx.addIssue({
                code: z.ZodIssueCode.custom,
                path: ["endDate"],
                message: "Partial-day leave must start and end on the same calendar date",
            });
        }

        // Rule 2: dayPart is required when isPartialDay is true
        if (!body.dayPart) {
            ctx.addIssue({
                code: z.ZodIssueCode.custom,
                path: ["dayPart"],
                message: "dayPart is required when isPartialDay is true",
            });
        }

        // Rule 3: Custom partial-day leave requires both startTime and endTime
        if (body.dayPart === "custom") {
            if (!body.startTime) {
                ctx.addIssue({
                    code: z.ZodIssueCode.custom,
                    path: ["startTime"],
                    message: "startTime is required for custom partial-day leave",
                });
            }
            if (!body.endTime) {
                ctx.addIssue({
                    code: z.ZodIssueCode.custom,
                    path: ["endTime"],
                    message: "endTime is required for custom partial-day leave",
                });
            }
        }

        // Rule 4: If both startTime and endTime are provided, startTime must be strictly less than endTime
        if (body.startTime && body.endTime) {
            if (body.startTime >= body.endTime) {
                ctx.addIssue({
                    code: z.ZodIssueCode.custom,
                    path: ["endTime"],
                    message: "endTime must be greater than startTime",
                });
            }
        }
    } else {
        // Full-day leave range validation
        if (!body.startDate || !body.endDate) return;
        try {
            const dates = enumerateDates(body.startDate, body.endDate);
            if (dates.length > MAX_LEAVE_DAYS) {
                ctx.addIssue({
                    code: z.ZodIssueCode.custom,
                    path: ["endDate"],
                    message: `Leave range exceeds MAX_LEAVE_DAYS (${MAX_LEAVE_DAYS} calendar days)`,
                });
            }
        } catch (err) {
            // enumerateDates throws if endDate < startDate
            ctx.addIssue({
                code: z.ZodIssueCode.custom,
                path: ["endDate"],
                message: "endDate must be greater than or equal to startDate",
            });
        }
    }
};

export const createLeaveSchema = z.object({
    body: z
        .object({
            staffId: objectIdSchema.optional(), // omitted = self-service; on-behalf handled by middleware/service
            leaveType: z.string().min(1, "Leave type is required").trim().max(50),
            startDate: dateOnlySchema,
            endDate: dateOnlySchema,
            reason: z.string().min(1, "Reason is required").trim().max(1000),
            isPartialDay: z.boolean().default(false),
            dayPart: z.enum(["first_half", "second_half", "custom"]).optional(),
            startTime: timeStringSchema.optional(),
            endTime: timeStringSchema.optional(),
        })
        .strict() // strips organizationId/branchId/leaveCode/status/dates/submittedBy/submittedFor/reviewedBy/reviewedAt/reviewNote/cancelledBy/cancelledAt/cancelReason
        .superRefine(validateLeaveInterval),
});

export const updateLeaveSchema = z.object({
    body: z
        .object({
            leaveType: z.string().min(1, "Leave type is required").trim().max(50).optional(),
            startDate: dateOnlySchema.optional(),
            endDate: dateOnlySchema.optional(),
            reason: z.string().min(1, "Reason is required").trim().max(1000).optional(),
            isPartialDay: z.boolean().optional(),
            dayPart: z.enum(["first_half", "second_half", "custom"]).optional(),
            startTime: timeStringSchema.optional(),
            endTime: timeStringSchema.optional(),
        })
        .strict() // no status, no staffId, no server-owned fields
        .superRefine(validateLeaveInterval),
});

const allowedSortFields = ["leaveCode", "startDate", "endDate", "status", "createdAt", "updatedAt"];

export const queryLeaveSchema = z.object({
    query: z
        .object({
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
            status: z.enum(["pending", "approved", "rejected", "cancelled"]).optional(),
            staffId: objectIdSchema.optional(),
            startDate: dateOnlySchema.optional(),
            endDate: dateOnlySchema.optional(),
            // branchId deliberately NOT accepted — branch scope comes from X-Branch-Id → req.branchId
        })
        .strict(),
});

export const approveLeaveSchema = z.object({
    body: z
        .object({
            reviewNote: z.string().trim().max(1000).optional(),
        })
        .strict(),
});

export const rejectLeaveSchema = z.object({
    body: z
        .object({
            reviewNote: z.string().min(1, "Review note is required").trim().max(1000),
        })
        .strict(),
});

export const cancelLeaveSchema = z.object({
    body: z
        .object({
            cancelReason: z.string().min(1, "Cancel reason is required").trim().max(1000),
        })
        .strict(),
});