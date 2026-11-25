import { describe, expect, it } from "@jest/globals";
import mongoose from "mongoose";
import { CalendarResolverService } from "../../services/holidays/calendarResolver.service.js";

describe("CalendarResolverService", () => {
  const resolver = new CalendarResolverService();
  const branchId = new mongoose.Types.ObjectId();

  it("gives branch special_working_day precedence over org holiday and weekly off", () => {
    const result = resolver.resolveDateFromData({
      dateStr: "2026-12-25",
      branch: { _id: branchId },
      orgSettings: { defaults: { defaultWeeklyOffDays: [5] } },
      entries: [
        { _id: "1", branchId: null, date: "2026-12-25", eventType: "public_holiday", name: "Christmas", isPaid: true, isWorkingDay: false, isActive: true },
        { _id: "2", branchId, date: "2026-12-25", eventType: "special_working_day", name: "Christmas Special", isWorkingDay: true, isActive: true, operatingHoursOverride: { isOpen: true, openTime: "10:00", closeTime: "18:00" } },
      ],
    });

    expect(result.status).toBe("special_working_day");
    expect(result.isWorkingDay).toBe(true);
    expect(result.source).toBe("branch_special_working_day");
    expect(result.operatingHoursOverride.openTime).toBe("10:00");
  });

  it("gives org special_working_day precedence over weekly off", () => {
    // 2026-11-29 is Sunday (0)
    const result = resolver.resolveDateFromData({
      dateStr: "2026-11-29",
      branch: { _id: branchId },
      orgSettings: { defaults: { defaultWeeklyOffDays: [0] } },
      entries: [
        { _id: "1", branchId: null, date: "2026-11-29", eventType: "special_working_day", name: "Festive Sunday", isWorkingDay: true, isActive: true },
      ],
    });

    expect(result.status).toBe("special_working_day");
    expect(result.isWorkingDay).toBe(true);
    expect(result.source).toBe("org_special_working_day");
  });

  it("gives branch_closure precedence over branch_holiday and org_holiday", () => {
    const result = resolver.resolveDateFromData({
      dateStr: "2026-12-01",
      branch: { _id: branchId },
      entries: [
        { _id: "1", branchId: null, date: "2026-12-01", eventType: "org_holiday", name: "Org Day", isWorkingDay: false, isActive: true },
        { _id: "2", branchId, date: "2026-12-01", eventType: "branch_holiday", name: "Local Holiday", isWorkingDay: false, isActive: true },
        { _id: "3", branchId, date: "2026-12-01", eventType: "branch_closure", name: "Renovation", isWorkingDay: false, isActive: true },
      ],
    });

    expect(result.status).toBe("branch_closure");
    expect(result.isWorkingDay).toBe(false);
    expect(result.source).toBe("branch_closure");
  });

  it("gives branch_holiday precedence over org_holiday and ignores inactive entries", () => {
    const result = resolver.resolveDateFromData({
      dateStr: "2026-12-02",
      branch: { _id: branchId },
      entries: [
        { _id: "1", branchId: null, date: "2026-12-02", eventType: "org_holiday", name: "Org Holiday", isWorkingDay: false, isActive: true },
        { _id: "2", branchId, date: "2026-12-02", eventType: "branch_holiday", name: "Inactive Branch Holiday", isWorkingDay: false, isActive: false },
      ],
    });

    expect(result.status).toBe("holiday");
    expect(result.source).toBe("org_holiday");
  });

  it("respects explicit empty branch weeklyOffDays [] over org default", () => {
    // 2026-11-29 is Sunday (0)
    const result = resolver.resolveDateFromData({
      dateStr: "2026-11-29",
      branch: { _id: branchId },
      orgSettings: { defaults: { defaultWeeklyOffDays: [0] } },
      branchSettings: { weeklyOffDays: [] },
      entries: [],
    });

    expect(result.status).toBe("working_day");
    expect(result.isWorkingDay).toBe(true);
    expect(result.source).toBe("default");
  });

  it("falls back to Branch.operatingHours closed day when weeklyOffDays does not include the day", () => {
    // 2026-11-30 is Monday (1)
    const result = resolver.resolveDateFromData({
      dateStr: "2026-11-30",
      branch: {
        _id: branchId,
        operatingHours: {
          monday: { isOpen: false, openTime: null, closeTime: null },
        },
      },
      orgSettings: { defaults: { defaultWeeklyOffDays: [0] } },
      entries: [],
    });

    expect(result.status).toBe("weekly_off");
    expect(result.isWorkingDay).toBe(false);
    expect(result.source).toBe("operating_hours");
  });

  it("resolves multi-day range entries on every covered date", () => {
    const entry = {
      _id: "range-1",
      branchId,
      date: "2026-12-10",
      endDate: "2026-12-12",
      eventType: "branch_closure",
      name: "Maintenance",
      isWorkingDay: false,
      isActive: true,
    };

    expect(
      resolver.resolveDateFromData({ dateStr: "2026-12-11", branch: { _id: branchId }, entries: [entry] }).status
    ).toBe("branch_closure");
    expect(
      resolver.resolveDateFromData({ dateStr: "2026-12-14", branch: { _id: branchId }, entries: [entry] }).status
    ).toBe("working_day");
  });
});
