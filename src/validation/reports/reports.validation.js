import { z } from "zod";

/**
 * Validates that a string is a real calendar date (rejecting 2026-02-31, 2026-04-31, etc.)
 */
function isValidCalendarDate(dateStr) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(dateStr)) return false;
  const [year, month, day] = dateStr.split("-").map(Number);
  if (month < 1 || month > 12) return false;
  const d = new Date(Date.UTC(year, month - 1, day));
  return (
    d.getUTCFullYear() === year &&
    d.getUTCMonth() === month - 1 &&
    d.getUTCDate() === day
  );
}

/**
 * Standard query schema for reporting endpoints.
 */
export const baseReportQuerySchema = z
  .object({
    startDate: z
      .string({ required_error: "startDate is required" })
      .refine(isValidCalendarDate, {
        message: "startDate must be a valid calendar date in YYYY-MM-DD format",
      }),
    endDate: z
      .string({ required_error: "endDate is required" })
      .refine(isValidCalendarDate, {
        message: "endDate must be a valid calendar date in YYYY-MM-DD format",
      }),
    compareWith: z
      .enum(["previous_period", "previous_year", "none"])
      .default("previous_period"),
    branchId: z
      .string()
      .regex(/^[0-9a-fA-F]{24}$/, "Invalid Mongo ObjectId format for branchId")
      .optional(),
  }).strict()
  .refine(
    (data) => {
      const start = new Date(`${data.startDate}T00:00:00.000Z`);
      const end = new Date(`${data.endDate}T00:00:00.000Z`);
      return start <= end;
    },
    {
      message: "startDate cannot be after endDate",
      path: ["startDate"],
    }
  )
  .refine(
    (data) => {
      const start = new Date(`${data.startDate}T00:00:00.000Z`);
      const end = new Date(`${data.endDate}T00:00:00.000Z`);
      const dayDiff = (end.getTime() - start.getTime()) / (24 * 60 * 60 * 1000) + 1;
      return dayDiff <= 366;
    },
    {
      message: "Date range cannot exceed 366 days (1 year)",
      path: ["endDate"],
    }
  );

export const reportQuerySchema = z.object({
  query: baseReportQuerySchema,
});

const pageFields = {
  page: z.coerce.number().int().min(1).default(1),
  limit: z.coerce.number().int().min(1).max(100).default(10),
};

const pageField = (name) => ({
  [`${name}Page`]: z.coerce.number().int().min(1).default(1),
  [`${name}Limit`]: z.coerce.number().int().min(1).max(100).default(10),
});

export const paginatedReportQuerySchema = z.object({
  query: baseReportQuerySchema.extend(pageFields),
});

export const serviceAnalyticsReportQuerySchema = z.object({
  query: baseReportQuerySchema.extend({
    ...pageFields,
    ...pageField("category"),
  }),
});

export const inventoryReportQuerySchema = z.object({
  query: baseReportQuerySchema.extend({
    ...pageField("lowStock"),
    ...pageField("movement"),
  }),
});

export const exportReportQuerySchema = z.object({
  query: baseReportQuerySchema.extend({
    format: z.enum(["csv"]).default("csv"),
  }),
});
