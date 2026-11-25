/**
 * Shared Operating-Hours Compatibility Utility
 *
 * Bridges legacy numeric weekday keys ("0"-"6", where 0 = Sunday)
 * and canonical lowercase weekday-name keys ("sunday"-"saturday").
 */

export const CANONICAL_WEEKDAYS = Object.freeze([
  "sunday",
  "monday",
  "tuesday",
  "wednesday",
  "thursday",
  "friday",
  "saturday",
]);

export const NUMERIC_TO_WEEKDAY = Object.freeze({
  "0": "sunday",
  "1": "monday",
  "2": "tuesday",
  "3": "wednesday",
  "4": "thursday",
  "5": "friday",
  "6": "saturday",
});

export const WEEKDAY_TO_NUMERIC = Object.freeze({
  sunday: "0",
  monday: "1",
  tuesday: "2",
  wednesday: "3",
  thursday: "4",
  friday: "5",
  saturday: "6",
});

const TIME_HHMM_REGEX = /^([01]\d|2[0-3]):[0-5]\d$/;

/**
 * Validates an "HH:mm" 24-hour time string.
 */
export function isValidTimeHHmm(value) {
  return typeof value === "string" && TIME_HHMM_REGEX.test(value);
}

/**
 * Resolves a weekday input (0-6, "0"-"6", or "sunday"-"saturday") to canonical lowercase weekday name.
 */
export function toCanonicalWeekday(dayInput) {
  if (typeof dayInput === "number" && Number.isInteger(dayInput) && dayInput >= 0 && dayInput <= 6) {
    return CANONICAL_WEEKDAYS[dayInput];
  }
  if (typeof dayInput === "string") {
    const trimmed = dayInput.trim().toLowerCase();
    if (NUMERIC_TO_WEEKDAY[trimmed]) return NUMERIC_TO_WEEKDAY[trimmed];
    if (CANONICAL_WEEKDAYS.includes(trimmed)) return trimmed;
  }
  return null;
}

/**
 * Reads a raw entry from a Mongoose Map or plain object for a given canonical weekday.
 */
function readRawDayEntry(rawHours, canonicalDay) {
  if (!rawHours) return undefined;
  const numericKey = WEEKDAY_TO_NUMERIC[canonicalDay];
  if (rawHours instanceof Map) {
    if (rawHours.has(canonicalDay)) return rawHours.get(canonicalDay);
    if (rawHours.has(numericKey)) return rawHours.get(numericKey);
    return undefined;
  }
  if (Object.prototype.hasOwnProperty.call(rawHours, canonicalDay)) {
    return rawHours[canonicalDay];
  }
  if (Object.prototype.hasOwnProperty.call(rawHours, numericKey)) {
    return rawHours[numericKey];
  }
  return undefined;
}

/**
 * Normalizes a branch's operatingHours (Map or plain object, numeric or weekday-name keys)
 * into a canonical object keyed by "sunday".."saturday".
 *
 * Returns { isConfigured: false, schedule: null } when rawHours is null/undefined/empty.
 * When configured, any missing weekday is explicitly marked { isOpen: false, openTime: null, closeTime: null }.
 */
export function normalizeOperatingHours(rawHours) {
  if (!rawHours) {
    return { isConfigured: false, schedule: null };
  }

  const size = rawHours instanceof Map ? rawHours.size : Object.keys(rawHours).length;
  if (size === 0) {
    return { isConfigured: false, schedule: null };
  }

  const schedule = {};
  for (const day of CANONICAL_WEEKDAYS) {
    const entry = readRawDayEntry(rawHours, day);
    if (!entry) {
      // Configured schedule with a missing day -> explicitly closed
      schedule[day] = {
        isOpen: false,
        openTime: null,
        closeTime: null,
      };
      continue;
    }

    const isOpen = entry.isOpen !== false;
    const openTime = isOpen && isValidTimeHHmm(entry.openTime) ? entry.openTime : null;
    const closeTime = isOpen && isValidTimeHHmm(entry.closeTime) ? entry.closeTime : null;

    schedule[day] = {
      isOpen,
      openTime,
      closeTime,
    };
  }

  return { isConfigured: true, schedule };
}

/**
 * Looks up operating hours for a specific weekday (numeric 0-6 or weekday name)
 * from either numeric-keyed or weekday-name-keyed operatingHours.
 *
 * Returns:
 * - { isConfigured: false, isOpen: null, openTime: null, closeTime: null } if rawHours is unconfigured
 * - { isConfigured: true, isOpen: false, openTime: null, closeTime: null } if day is missing or closed
 * - { isConfigured: true, isOpen: true, openTime, closeTime } if open
 */
export function getOperatingHoursForDay(rawHours, dayInput) {
  const canonicalDay = toCanonicalWeekday(dayInput);
  if (!canonicalDay) {
    throw new Error(`Invalid weekday input: ${dayInput}`);
  }

  const { isConfigured, schedule } = normalizeOperatingHours(rawHours);
  if (!isConfigured || !schedule) {
    return {
      isConfigured: false,
      day: canonicalDay,
      isOpen: null,
      openTime: null,
      closeTime: null,
    };
  }

  const dayEntry = schedule[canonicalDay];
  return {
    isConfigured: true,
    day: canonicalDay,
    isOpen: dayEntry.isOpen,
    openTime: dayEntry.openTime,
    closeTime: dayEntry.closeTime,
  };
}
