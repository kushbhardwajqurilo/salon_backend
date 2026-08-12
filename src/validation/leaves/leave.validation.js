import { z } from "zod";
import { isValidDateOnly, enumerateDates, MAX_LEAVE_DAYS } from "../../utils/date.js";

const objectIdRegex = /^[0-9a-fA-F]{24}$/;
const objectIdSchema = z.string().regex(objectIdRegex, "Invalid ObjectId format");

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
 * Cross-field date-range validation: startDate <= endDate and range <= MAX_LEAVE_DAYS.
 * Applied to the body object after individual field validation.
 */
const validateDateRange = (body, ctx) => {
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
};

export const createLeaveSchema = z.object({
    body: z
        .object({
            staffId: objectIdSchema.optional(), // omitted = self-service; on-behalf handled by middleware/service
            leaveType: z.string().min(1, "Leave type is required").trim().max(50),
            startDate: dateOnlySchema,
            endDate: dateOnlySchema,
            reason: z.string().min(1, "Reason is required").trim().max(1000),
        })
        .strict() // strips organizationId/branchId/leaveCode/status/dates/submittedBy/submittedFor/reviewedBy/reviewedAt/reviewNote/cancelledBy/cancelledAt/cancelReason
        .superRefine(validateDateRange),
});

export const updateLeaveSchema = z.object({
    body: z
        .object({
            leaveType: z.string().min(1, "Leave type is required").trim().max(50).optional(),
            startDate: dateOnlySchema.optional(),
            endDate: dateOnlySchema.optional(),
            reason: z.string().min(1, "Reason is required").trim().max(1000).optional(),
        })
        .strict() // no status, no staffId, no server-owned fields
        .superRefine(validateDateRange),
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