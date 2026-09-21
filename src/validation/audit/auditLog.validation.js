import { z } from "zod";
import { AUDIT_ACTIONS } from "../../models/audit/auditLog.model.js";

const objectIdRegex = /^[0-9a-fA-F]{24}$/;
const objectIdSchema = z.string().regex(objectIdRegex, "Invalid ObjectId format");

const dateOnlyRegex = /^\d{4}-\d{2}-\d{2}$/;

const allowedSortFields = ["createdAt"];

export const queryAuditLogSchema = z.object({
  query: z
    .object({
      page: z.coerce.number().int().positive().default(1),
      limit: z.coerce.number().int().positive().max(100).default(10),
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
      branchId: objectIdSchema.optional(),
      entityType: z.string().trim().min(1).optional(),
      action: z.enum(Object.values(AUDIT_ACTIONS)).optional(),
      actorId: objectIdSchema.optional(),
      startDate: z
        .string()
        .regex(dateOnlyRegex, "Invalid date format (YYYY-MM-DD)")
        .optional(),
      endDate: z
        .string()
        .regex(dateOnlyRegex, "Invalid date format (YYYY-MM-DD)")
        .optional(),
    })
    .strict()
    .superRefine((data, ctx) => {
      if (data.startDate && data.endDate && data.startDate > data.endDate) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["endDate"],
          message: "endDate must be greater than or equal to startDate",
        });
      }
    }),
});
