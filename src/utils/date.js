/**
 * Canonical date utilities for the Leaves and Appointments modules.
 *
 * Conventions (per LEAVES_BACKEND_ARCHITECTURE_AND_IMPLEMENTATION_PLAN v1.0 FINAL §9):
 * - API accepts "YYYY-MM-DD" strings only.
 * - Mongo stores Date at UTC midnight.
 * - Conversion is explicit — never `new Date(input)` (timezone-ambiguous).
 * - Internal `dates[]` arrays hold "YYYY-MM-DD" strings.
 */

const DATE_ONLY_REGEX = /^\d{4}-\d{2}-\d{2}$/;

/** Maximum number of calendar days a single leave may cover (v1). */
export const MAX_LEAVE_DAYS = 365;

export const DEFAULT_TIMEZONE = "Asia/Kolkata";

/**
 * Validates a "YYYY-MM-DD" string and returns true if it is a real calendar date.
 * Rejects impossible dates like "2026-02-30" or "2026-13-01".
 * @param {string} dateOnlyStr
 * @returns {boolean}
 */
export const isValidDateOnly = (dateOnlyStr) => {
    if (typeof dateOnlyStr !== "string" || !DATE_ONLY_REGEX.test(dateOnlyStr)) {
        return false;
    }
    const [year, month, day] = dateOnlyStr.split("-").map(Number);
    const date = new Date(Date.UTC(year, month - 1, day));
    return (
        date.getUTCFullYear() === year &&
        date.getUTCMonth() === month - 1 &&
        date.getUTCDate() === day
    );
};

/**
 * Converts a "YYYY-MM-DD" string to a Date at UTC midnight.
 * Throws on invalid calendar dates.
 * @param {string} dateOnlyStr
 * @returns {Date}
 */
export const toUTCDate = (dateOnlyStr) => {
    if (!isValidDateOnly(dateOnlyStr)) {
        throw new Error(`Invalid date format, expected YYYY-MM-DD: ${dateOnlyStr}`);
    }
    return new Date(`${dateOnlyStr}T00:00:00.000Z`);
};

/**
 * Converts a Date to a "YYYY-MM-DD" string in UTC (timezone-stable).
 * @param {Date} date
 * @returns {string}
 */
export const toDateOnlyStr = (date) => {
    if (!(date instanceof Date) || Number.isNaN(date.getTime())) {
        throw new Error("Invalid Date object");
    }
    return date.toISOString().slice(0, 10);
};

/**
 * Enumerates the inclusive list of "YYYY-MM-DD" strings between startDate and endDate.
 * Throws if the range exceeds MAX_LEAVE_DAYS.
 * @param {string} startDate - "YYYY-MM-DD"
 * @param {string} endDate - "YYYY-MM-DD"
 * @returns {string[]}
 */
export const enumerateDates = (startDate, endDate) => {
    const start = toUTCDate(startDate);
    const end = toUTCDate(endDate);

    if (end < start) {
        throw new Error("endDate must be greater than or equal to startDate");
    }

    const out = [];
    let cur = start;
    while (cur <= end) {
        out.push(toDateOnlyStr(cur));
        cur = new Date(cur.getTime() + 24 * 60 * 60 * 1000);
    }

    if (out.length > MAX_LEAVE_DAYS) {
        throw new Error(
            `Leave range exceeds MAX_LEAVE_DAYS (${MAX_LEAVE_DAYS} calendar days)`
        );
    }

    return out;
};

/**
 * Helper to compute timezone offset in milliseconds for a target date and timezone
 */
export const getTimezoneOffsetMs = (date, timezone = DEFAULT_TIMEZONE) => {
  const tz = timezone || DEFAULT_TIMEZONE;
  try {
    const utcDate = new Date(date.toLocaleString("en-US", { timeZone: "UTC" }));
    const tzDate = new Date(date.toLocaleString("en-US", { timeZone: tz }));
    return tzDate.getTime() - utcDate.getTime();
  } catch (err) {
    // Fallback to Asia/Kolkata offset (+05:30) if timezone is invalid
    return 5.5 * 60 * 60 * 1000;
  }
};

/**
 * Converts local date string ("YYYY-MM-DD") and time string ("HH:mm") to canonical UTC Date timestamp
 */
export const parseLocalToUTC = (
  dateStr,
  timeStr,
  timezone = DEFAULT_TIMEZONE,
) => {
  const tz = timezone || DEFAULT_TIMEZONE;
  const [year, month, day] = dateStr.split("-").map(Number);
  const [hours, minutes] = timeStr.split(":").map(Number);

  // Construct nominal UTC instant assuming input was UTC
  const nominalUtc = new Date(
    Date.UTC(year, month - 1, day, hours, minutes, 0, 0),
  );
  const offsetMs = getTimezoneOffsetMs(nominalUtc, tz);
  return new Date(nominalUtc.getTime() - offsetMs);
};

/**
 * Formats canonical UTC Date timestamp to local date ("YYYY-MM-DD") and local time ("HH:mm") strings
 */
export const formatUTCToLocal = (utcDate, timezone = DEFAULT_TIMEZONE) => {
  const tz = timezone || DEFAULT_TIMEZONE;
  const offsetMs = getTimezoneOffsetMs(utcDate, tz);
  const localDate = new Date(utcDate.getTime() + offsetMs);
  const year = localDate.getUTCFullYear();
  const month = String(localDate.getUTCMonth() + 1).padStart(2, "0");
  const day = String(localDate.getUTCDate()).padStart(2, "0");
  const hours = String(localDate.getUTCHours()).padStart(2, "0");
  const minutes = String(localDate.getUTCMinutes()).padStart(2, "0");

  return {
    dateStr: `${year}-${month}-${day}`,
    timeStr: `${hours}:${minutes}`,
  };
};
