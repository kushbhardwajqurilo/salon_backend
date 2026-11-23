import { Branch } from "../../models/branches/branch.model.js";

const DEFAULT_TIMEZONE = "Asia/Kolkata";

/**
 * Computes offset in milliseconds for a specific date in an IANA timezone.
 */
const getTimezoneOffsetMs = (date, timezone = DEFAULT_TIMEZONE) => {
  const tz = timezone || DEFAULT_TIMEZONE;
  try {
    const utcDate = new Date(date.toLocaleString("en-US", { timeZone: "UTC" }));
    const tzDate = new Date(date.toLocaleString("en-US", { timeZone: tz }));
    return tzDate.getTime() - utcDate.getTime();
  } catch {
    return 5.5 * 60 * 60 * 1000;
  }
};

/**
 * Resolves the operational timezone for a branch or organization fallback.
 */
export async function resolveTimezone(organizationId, branchId) {
  if (branchId) {
    const branch = await Branch.findOne({
      _id: branchId,
      organizationId,
      isActive: true,
    }).select("timezone");
    if (branch?.timezone) return branch.timezone;
  }
  const defaultBranch = await Branch.findOne({
    organizationId,
    isActive: true,
  }).select("timezone");
  return defaultBranch?.timezone || DEFAULT_TIMEZONE;
}

/**
 * Converts a calendar date string (YYYY-MM-DD) into full UTC boundary Instants.
 */
export function getUTCDayRange(dateStr, timezone = DEFAULT_TIMEZONE) {
  const [year, month, day] = dateStr.split("-").map(Number);
  const nominalStartUtc = new Date(Date.UTC(year, month - 1, day, 0, 0, 0, 0));
  const nominalEndUtc = new Date(Date.UTC(year, month - 1, day, 23, 59, 59, 999));

  const startOffset = getTimezoneOffsetMs(nominalStartUtc, timezone);
  const endOffset = getTimezoneOffsetMs(nominalEndUtc, timezone);

  const startUtc = new Date(nominalStartUtc.getTime() - startOffset);
  const endUtc = new Date(nominalEndUtc.getTime() - endOffset);

  return { startUtc, endUtc };
}

/**
 * Computes consecutive comparison period dates matching exact duration.
 */
export function getComparisonDates(startDateStr, endDateStr, compareWith) {
  if (compareWith === "none") {
    return { comparisonStartDate: null, comparisonEndDate: null };
  }

  const start = new Date(`${startDateStr}T00:00:00.000Z`);
  const end = new Date(`${endDateStr}T00:00:00.000Z`);
  const dayMs = 24 * 60 * 60 * 1000;
  const durationDays = Math.round((end.getTime() - start.getTime()) / dayMs) + 1;

  if (compareWith === "previous_year") {
    const prevYearStart = new Date(start);
    prevYearStart.setUTCFullYear(prevYearStart.getUTCFullYear() - 1);
    const prevYearEnd = new Date(end);
    prevYearEnd.setUTCFullYear(prevYearEnd.getUTCFullYear() - 1);
    return {
      comparisonStartDate: prevYearStart.toISOString().split("T")[0],
      comparisonEndDate: prevYearEnd.toISOString().split("T")[0],
    };
  }

  // Default: previous_period (consecutive immediately preceding interval)
  const prevEnd = new Date(start.getTime() - dayMs);
  const prevStart = new Date(prevEnd.getTime() - (durationDays - 1) * dayMs);

  return {
    comparisonStartDate: prevStart.toISOString().split("T")[0],
    comparisonEndDate: prevEnd.toISOString().split("T")[0],
  };
}

/**
 * Calculates percentage change and trend descriptor with zero-handling.
 */
export function calculateMetricDelta(current, previous) {
  const cur = Number(current || 0);
  if (previous === null || previous === undefined) {
    return {
      current: cur,
      previous: null,
      percentageChange: null,
      trend: "neutral",
    };
  }

  const prev = Number(previous || 0);
  if (prev === 0) {
    if (cur === 0) {
      return {
        current: cur,
        previous: 0,
        percentageChange: 0,
        trend: "neutral",
      };
    }
    return {
      current: cur,
      previous: 0,
      percentageChange: null,
      trend: cur > 0 ? "up" : "down",
    };
  }

  const change = Number((((cur - prev) / prev) * 100).toFixed(2));
  let trend = "neutral";
  if (change > 0) trend = "up";
  else if (change < 0) trend = "down";

  return {
    current: cur,
    previous: prev,
    percentageChange: change,
    trend,
  };
}

/**
 * Calculates rate change in percentage points (pp).
 */
export function calculateRateDelta(currentRate, previousRate) {
  const cur = currentRate !== null && currentRate !== undefined ? Number(currentRate) : null;
  const prev = previousRate !== null && previousRate !== undefined ? Number(previousRate) : null;

  if (cur === null) {
    return {
      current: null,
      previous: prev,
      percentagePointsChange: null,
      trend: "neutral",
    };
  }

  if (prev === null) {
    return {
      current: cur,
      previous: null,
      percentagePointsChange: null,
      trend: "neutral",
    };
  }

  const ppChange = Number((cur - prev).toFixed(2));
  let trend = "neutral";
  if (ppChange > 0) trend = "up";
  else if (ppChange < 0) trend = "down";

  return {
    current: cur,
    previous: prev,
    percentagePointsChange: ppChange,
    trend,
  };
}

/**
 * Masks phone numbers for non-privileged viewers.
 */
export function maskPhoneNumber(phone) {
  if (!phone || typeof phone !== "string") return "";
  const cleaned = phone.trim();
  if (cleaned.length <= 4) return "****";
  const last4 = cleaned.slice(-4);
  const prefix = cleaned.slice(0, Math.min(4, cleaned.length - 4));
  return `${prefix}****${last4}`;
}
