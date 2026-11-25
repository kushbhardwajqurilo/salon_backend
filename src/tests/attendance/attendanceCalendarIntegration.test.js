import { beforeEach, describe, expect, it, jest } from "@jest/globals";
import mongoose from "mongoose";
import { deriveStatus, getMonthlyMusterRoll } from "../../services/attendance/attendance.service.js";
import { Branch } from "../../models/branches/branch.model.js";
import { StaffBranch } from "../../models/staff/staffBranch.model.js";
import { Staff } from "../../models/staff/staff.model.js";
import { Attendance } from "../../models/attendance/attendance.model.js";
import { Leave } from "../../models/leaves/leave.model.js";
import { StaffRoster } from "../../models/staff/staffRoster.model.js";
import { CalendarResolverService } from "../../services/holidays/calendarResolver.service.js";

describe("Phase 4 Attendance Calendar & Roster Integration", () => {
  const orgId = new mongoose.Types.ObjectId();
  const branchId = new mongoose.Types.ObjectId();
  const staffId = new mongoose.Types.ObjectId();

  beforeEach(() => {
    jest.restoreAllMocks();
  });

  it("derives late/present from employee StaffRoster shift and graceMinutes", () => {
    const punches = [
      { punchType: "in", punchAt: new Date("2026-11-10T04:50:00.000Z") }, // 10:20 IST
      { punchType: "out", punchAt: new Date("2026-11-10T13:30:00.000Z") }, // 19:00 IST
    ];
    // Shift starts 10:00 IST, grace 15 min -> 10:20 is late
    expect(
      deriveStatus(punches, {
        scheduledOpenTime: "10:00",
        scheduledCloseTime: "19:00",
        timezone: "Asia/Kolkata",
        graceMinutes: 15,
      })
    ).toBe("late");

    // No roster configured -> no false lateness from branch hours
    expect(deriveStatus(punches, { timezone: "Asia/Kolkata", graceMinutes: 15 })).toBe("present");
  });

  it("distinguishes holiday, weekly_off, branch_closure, special_working_day, paid_leave, unpaid_leave, and absent in muster roll", async () => {
    jest.spyOn(Branch, "findOne").mockReturnValue({
      select: jest.fn().mockReturnThis(),
      lean: jest.fn().mockResolvedValue({ _id: branchId, organizationId: orgId, timezone: "Asia/Kolkata", isActive: true }),
    });
    jest.spyOn(StaffBranch, "find").mockReturnValue({
      select: jest.fn().mockReturnThis(),
      lean: jest.fn().mockResolvedValue([{ staffId }]),
    });
    jest.spyOn(Staff, "find").mockReturnValue({
      select: jest.fn().mockReturnThis(),
      sort: jest.fn().mockReturnThis(),
      lean: jest.fn().mockResolvedValue([
        { _id: staffId, name: "Asha", staffCode: "STF-001", designation: "Stylist", joiningDate: new Date("2026-01-01T00:00:00Z") },
      ]),
    });
    jest.spyOn(Attendance, "find").mockReturnValue({
      lean: jest.fn().mockResolvedValue([
        { _id: new mongoose.Types.ObjectId(), staffId, attendanceDate: new Date("2026-11-02T00:00:00Z"), status: "present", isReconciled: false },
      ]),
    });
    jest.spyOn(Leave, "find").mockReturnValue({
      lean: jest.fn().mockResolvedValue([
        {
          _id: new mongoose.Types.ObjectId(),
          staffId,
          status: "approved",
          isUnpaid: false,
          dates: ["2026-11-03"],
          startDate: new Date("2026-11-03T00:00:00Z"),
          endDate: new Date("2026-11-03T00:00:00Z"),
        },
        {
          _id: new mongoose.Types.ObjectId(),
          staffId,
          status: "approved",
          isUnpaid: true,
          dates: ["2026-11-04"],
          startDate: new Date("2026-11-04T00:00:00Z"),
          endDate: new Date("2026-11-04T00:00:00Z"),
        },
      ]),
    });
    jest.spyOn(StaffRoster, "find").mockReturnValue({
      lean: jest.fn().mockResolvedValue([]),
    });

    const days = [];
    for (let d = 1; d <= 30; d++) {
      const dateStr = `2026-11-${String(d).padStart(2, "0")}`;
      if (d === 1) days.push({ date: dateStr, status: "weekly_off", isWorkingDay: false });
      else if (d === 5) days.push({ date: dateStr, status: "holiday", isWorkingDay: false, event: { name: "Diwali" } });
      else if (d === 6) days.push({ date: dateStr, status: "branch_closure", isWorkingDay: false });
      else if (d === 8) days.push({ date: dateStr, status: "special_working_day", isWorkingDay: true });
      else days.push({ date: dateStr, status: "working_day", isWorkingDay: true });
    }
    jest.spyOn(CalendarResolverService.prototype, "resolveCalendarRange").mockResolvedValue({
      days,
    });

    const res = await getMonthlyMusterRoll({
      organizationId: orgId,
      branchId: branchId.toString(),
      monthYear: "2026-11",
    });

    const breakdown = res.musterRoll[0].dailyBreakdown;
    expect(breakdown["2026-11-01"].status).toBe("weekly_off");
    expect(breakdown["2026-11-02"].status).toBe("present");
    expect(breakdown["2026-11-03"].status).toBe("paid_leave");
    expect(breakdown["2026-11-04"].status).toBe("unpaid_leave");
    expect(breakdown["2026-11-05"].status).toBe("holiday");
    expect(breakdown["2026-11-06"].status).toBe("branch_closure");
    // Special working day (Nov 8) with no punch and elapsed -> absent
    expect(breakdown["2026-11-08"].status).toBe("absent");
  });
});
