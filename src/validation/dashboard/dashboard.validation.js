import { z } from "zod";

/**
 * Validates that a string is a real calendar date (rejects 2026-02-31, 2026-04-31, etc.)
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
 * Zod validation schema for Dashboard Overview query parameters.
 */
export const dashboardOverviewQuerySchema = z.object({
  query: z
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
    })
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
        message: "Date range cannot exceed 366 days",
        path: ["endDate"],
      }
    ),
});
