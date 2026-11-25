import { describe, expect, it } from "@jest/globals";
import {
  CANONICAL_WEEKDAYS,
  isValidTimeHHmm,
  toCanonicalWeekday,
  normalizeOperatingHours,
  getOperatingHoursForDay,
} from "../../utils/operatingHours.js";

describe("operatingHours utility", () => {
  it("validates HH:mm 24-hour time formats", () => {
    expect(isValidTimeHHmm("09:00")).toBe(true);
    expect(isValidTimeHHmm("23:59")).toBe(true);
    expect(isValidTimeHHmm("00:00")).toBe(true);
    expect(isValidTimeHHmm("24:00")).toBe(false);
    expect(isValidTimeHHmm("9:00")).toBe(false);
    expect(isValidTimeHHmm("09:60")).toBe(false);
    expect(isValidTimeHHmm(null)).toBe(false);
  });

  it("maps numeric and string weekday inputs to canonical lowercase weekday names", () => {
    expect(toCanonicalWeekday(0)).toBe("sunday");
    expect(toCanonicalWeekday("0")).toBe("sunday");
    expect(toCanonicalWeekday("6")).toBe("saturday");
    expect(toCanonicalWeekday("Friday")).toBe("friday");
    expect(toCanonicalWeekday("7")).toBeNull();
    expect(toCanonicalWeekday("funday")).toBeNull();
  });

  it("distinguishes null/unconfigured legacy schedule from configured schedule", () => {
    expect(normalizeOperatingHours(null)).toEqual({ isConfigured: false, schedule: null });
    expect(normalizeOperatingHours({})).toEqual({ isConfigured: false, schedule: null });
    expect(getOperatingHoursForDay(null, "monday")).toEqual({
      isConfigured: false,
      day: "monday",
      isOpen: null,
      openTime: null,
      closeTime: null,
    });
  });

  it("reads legacy numeric weekday keys and normalizes to canonical weekday names", () => {
    const legacyHours = new Map([
      ["0", { isOpen: false, openTime: null, closeTime: null }],
      ["1", { isOpen: true, openTime: "09:00", closeTime: "20:00" }],
    ]);

    const normalized = normalizeOperatingHours(legacyHours);
    expect(normalized.isConfigured).toBe(true);
    expect(Object.keys(normalized.schedule)).toEqual(CANONICAL_WEEKDAYS);
    expect(normalized.schedule.sunday).toEqual({ isOpen: false, openTime: null, closeTime: null });
    expect(normalized.schedule.monday).toEqual({ isOpen: true, openTime: "09:00", closeTime: "20:00" });
    // Missing days on a configured schedule are explicitly closed
    expect(normalized.schedule.tuesday).toEqual({ isOpen: false, openTime: null, closeTime: null });
  });

  it("reads canonical weekday-name keys and preserves explicit closed days", () => {
    const canonicalHours = {
      sunday: { isOpen: false, openTime: "09:00", closeTime: "18:00" },
      monday: { isOpen: true, openTime: "10:00", closeTime: "21:00" },
    };

    expect(getOperatingHoursForDay(canonicalHours, 0)).toEqual({
      isConfigured: true,
      day: "sunday",
      isOpen: false,
      openTime: null,
      closeTime: null,
    });
    expect(getOperatingHoursForDay(canonicalHours, "monday")).toEqual({
      isConfigured: true,
      day: "monday",
      isOpen: true,
      openTime: "10:00",
      closeTime: "21:00",
    });
  });
});
