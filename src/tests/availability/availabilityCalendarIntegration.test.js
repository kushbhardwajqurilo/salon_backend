import { beforeEach, describe, expect, it, jest } from "@jest/globals";
import mongoose from "mongoose";
import { StaffAvailabilityService } from "../../services/availability/staffAvailability.service.js";
import { Branch } from "../../models/branches/branch.model.js";
import { Staff } from "../../models/staff/staff.model.js";
import { StaffBranch } from "../../models/staff/staffBranch.model.js";
import { StaffRoster } from "../../models/staff/staffRoster.model.js";
import { Leave } from "../../models/leaves/leave.model.js";
import { Appointment } from "../../models/appointments/appointment.model.js";
import { CalendarResolverService } from "../../services/holidays/calendarResolver.service.js";

describe("Phase 6 StaffAvailability Calendar & OperatingHours Integration", () => {
  const orgId = new mongoose.Types.ObjectId();
  const branchId = new mongoose.Types.ObjectId();
  const staffId = new mongoose.Types.ObjectId();
  const service = new StaffAvailabilityService();

  beforeEach(() => {
    jest.restoreAllMocks();
    jest.spyOn(Staff, "findOne").mockReturnValue({
      select: jest.fn().mockReturnThis(),
      lean: jest.fn().mockResolvedValue({ _id: staffId, name: "Asha", status: "active" }),
    });
    jest.spyOn(StaffBranch, "findOne").mockReturnValue({
      lean: jest.fn().mockResolvedValue({ isActive: true }),
    });
    jest.spyOn(StaffRoster, "findOne").mockReturnValue({
      lean: jest.fn().mockResolvedValue(null),
    });
    jest.spyOn(Leave, "find").mockReturnValue({
      lean: jest.fn().mockResolvedValue([]),
    });
    jest.spyOn(Appointment, "find").mockReturnValue({
      lean: jest.fn().mockResolvedValue([]),
    });
  });

  it("blocks availability with BRANCH_CLOSED when CalendarResolverService resolves branch_closure", async () => {
    jest.spyOn(Branch, "findOne").mockReturnValue({
      lean: jest.fn().mockResolvedValue({ _id: branchId, organizationId: orgId, isActive: true, timezone: "Asia/Kolkata" }),
    });
    jest.spyOn(CalendarResolverService.prototype, "resolveCalendarRange").mockResolvedValue({
      days: [{ date: "2026-12-15", status: "branch_closure", isWorkingDay: false }],
    });

    const res = await service.checkStaffSlotAvailability({
      organizationId: orgId,
      branchId,
      staffId,
      date: "2026-12-15",
      startTime: "11:00",
      endTime: "12:00",
    });

    expect(res.status).toBe("unavailable");
    expect(res.reasons).toContain("BRANCH_CLOSED");
  });

  it("allows availability on special_working_day within operatingHoursOverride and blocks outside it", async () => {
    jest.spyOn(Branch, "findOne").mockReturnValue({
      lean: jest.fn().mockResolvedValue({ _id: branchId, organizationId: orgId, isActive: true, timezone: "Asia/Kolkata" }),
    });
    jest.spyOn(CalendarResolverService.prototype, "resolveCalendarRange").mockResolvedValue({
      days: [
        {
          date: "2026-12-20",
          status: "special_working_day",
          isWorkingDay: true,
          operatingHoursOverride: { isOpen: true, openTime: "10:00", closeTime: "14:00" },
        },
      ],
    });

    const inside = await service.checkStaffSlotAvailability({
      organizationId: orgId,
      branchId,
      staffId,
      date: "2026-12-20",
      startTime: "11:00",
      endTime: "12:00",
    });
    expect({ status: inside.status, reasons: inside.reasons }).toEqual({ status: "available", reasons: [] });

    const outside = await service.checkStaffSlotAvailability({
      organizationId: orgId,
      branchId,
      staffId,
      date: "2026-12-20",
      startTime: "16:00",
      endTime: "17:00",
    });
    expect(outside.status).toBe("unavailable");
    expect(outside.reasons).toContain("BRANCH_CLOSED");
  });

  it("supports both numeric and canonical weekday-name operatingHours keys", async () => {
    jest.spyOn(CalendarResolverService.prototype, "resolveCalendarRange").mockResolvedValue({
      days: [{ date: "2026-12-14", status: "working_day", isWorkingDay: true }],
    });

    // 2026-12-14 is Monday (1)
    jest.spyOn(Branch, "findOne").mockReturnValue({
      lean: jest.fn().mockResolvedValue({
        _id: branchId,
        organizationId: orgId,
        isActive: true,
        timezone: "Asia/Kolkata",
        operatingHours: { "1": { isOpen: true, openTime: "09:00", closeTime: "20:00" } },
      }),
    });

    const numericRes = await service.checkStaffSlotAvailability({
      organizationId: orgId,
      branchId,
      staffId,
      date: "2026-12-14",
      startTime: "11:00",
      endTime: "12:00",
    });
    expect(numericRes.status).toBe("available");
  });
});
