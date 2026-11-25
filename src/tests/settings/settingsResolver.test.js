import { describe, expect, it } from "@jest/globals";
import mongoose from "mongoose";
import {
  resolveSettingValue,
  SettingsResolverService,
  SYSTEM_SETTING_DEFAULTS,
} from "../../services/settings/settingsResolver.service.js";

describe("SettingsResolverService", () => {
  const resolver = new SettingsResolverService();
  const orgId = new mongoose.Types.ObjectId();
  const branchId = new mongoose.Types.ObjectId();

  it("uses system defaults when no organization or branch settings exist", () => {
    const resolved = resolver.resolveFromDocuments({
      organization: { _id: orgId },
      orgSettings: null,
      branch: { _id: branchId },
      branchSettings: null,
    });

    expect(resolved.regional.timezone).toEqual({
      value: SYSTEM_SETTING_DEFAULTS.regional.timezone,
      source: "system_default",
    });
    expect(resolved.attendance.graceMinutes).toEqual({
      value: 15,
      source: "system_default",
    });
    expect(resolved.leaves.weeklyOffDays).toEqual({
      value: [0],
      source: "system_default",
    });
  });

  it("inherits organization values when branch values are null or undefined", () => {
    const resolved = resolver.resolveFromDocuments({
      organization: { _id: orgId },
      orgSettings: {
        regional: { timezone: "Asia/Dubai", currency: "AED" },
        defaults: {
          appointmentBufferMinutes: 10,
          allowWalkIns: true,
          attendanceGraceMinutes: 20,
          defaultWeeklyOffDays: [5],
        },
      },
      branch: { _id: branchId },
      branchSettings: {
        weeklyOffDays: null,
        appointmentOverrides: { bufferMinutes: null, allowWalkIns: null },
        attendanceOverrides: { graceMinutes: undefined },
      },
    });

    expect(resolved.regional.timezone).toEqual({ value: "Asia/Dubai", source: "organization" });
    expect(resolved.appointments.bufferMinutes).toEqual({ value: 10, source: "organization" });
    expect(resolved.appointments.allowWalkIns).toEqual({ value: true, source: "organization" });
    expect(resolved.attendance.graceMinutes).toEqual({ value: 20, source: "organization" });
    expect(resolved.leaves.weeklyOffDays).toEqual({ value: [5], source: "organization" });
  });

  it("preserves explicit false, 0, and empty array [] branch overrides", () => {
    const resolved = resolver.resolveFromDocuments({
      organization: { _id: orgId },
      orgSettings: {
        defaults: {
          appointmentBufferMinutes: 15,
          allowWalkIns: true,
          allowAdvanceBookings: true,
          attendanceGraceMinutes: 10,
          defaultWeeklyOffDays: [0],
          defaultHalfDayEligible: true,
        },
      },
      branch: { _id: branchId, bufferMinutes: 15 },
      branchSettings: {
        weeklyOffDays: [],
        appointmentOverrides: {
          bufferMinutes: 0,
          allowWalkIns: false,
          allowAdvanceBookings: false,
        },
        attendanceOverrides: {
          graceMinutes: 0,
        },
        leaveOverrides: {
          allowHalfDay: false,
        },
      },
    });

    expect(resolved.appointments.bufferMinutes).toEqual({ value: 0, source: "branch_override" });
    expect(resolved.appointments.allowWalkIns).toEqual({ value: false, source: "branch_override" });
    expect(resolved.appointments.allowAdvanceBookings).toEqual({ value: false, source: "branch_override" });
    expect(resolved.attendance.graceMinutes).toEqual({ value: 0, source: "branch_override" });
    expect(resolved.leaves.weeklyOffDays).toEqual({ value: [], source: "branch_override" });
    expect(resolved.leaves.allowHalfDay).toEqual({ value: false, source: "branch_override" });
  });

  it("resolveSettingValue never uses truthiness fallback", () => {
    expect(resolveSettingValue(false, true, true)).toEqual({ value: false, source: "branch_override" });
    expect(resolveSettingValue(0, 30, 15)).toEqual({ value: 0, source: "branch_override" });
    expect(resolveSettingValue([], [0], [0])).toEqual({ value: [], source: "branch_override" });
  });
});
