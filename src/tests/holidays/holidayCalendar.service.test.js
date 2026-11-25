import { beforeEach, describe, expect, it, jest } from "@jest/globals";
import mongoose from "mongoose";
import { HolidayCalendarService } from "../../services/holidays/holidayCalendar.service.js";
import { HolidayCalendar } from "../../models/holidays/holidayCalendar.model.js";
import { Branch } from "../../models/branches/branch.model.js";
import { Appointment } from "../../models/appointments/appointment.model.js";
import { AppError } from "../../utils/errors.js";

describe("HolidayCalendarService", () => {
  const orgId = new mongoose.Types.ObjectId();
  const branchId = new mongoose.Types.ObjectId();
  const otherBranchId = new mongoose.Types.ObjectId();
  const actorId = new mongoose.Types.ObjectId();

  let auditLogService;
  let service;

  beforeEach(() => {
    jest.restoreAllMocks();
    auditLogService = {
      createAuditLog: jest.fn().mockResolvedValue({}),
    };
    service = new HolidayCalendarService({ auditLogService });
    service.executeTx = jest.fn(async (op) => op(null));
  });

  it("creates a branch closure, surfaces conflicting appointments without modifying them, and emits HOLIDAY_CREATED", async () => {
    jest.spyOn(Branch, "findOne").mockReturnValue({
      lean: jest.fn().mockResolvedValue({ _id: branchId, organizationId: orgId, isActive: true }),
    });
    const createdId = new mongoose.Types.ObjectId();
    jest.spyOn(HolidayCalendar, "create").mockResolvedValue([
      {
        _id: createdId,
        organizationId: orgId,
        branchId,
        date: "2026-12-15",
        endDate: "2026-12-15",
        eventType: "branch_closure",
        name: "Deep Cleaning",
        isPaid: false,
        isWorkingDay: false,
        isActive: true,
        createdAt: new Date(),
        updatedAt: new Date(),
      },
    ]);
    const aptId = new mongoose.Types.ObjectId();
    const mockChain = {
      select: jest.fn().mockReturnThis(),
      sort: jest.fn().mockReturnThis(),
      lean: jest.fn().mockResolvedValue([
        {
          _id: aptId,
          appointmentCode: "APT-0010",
          branchId,
          appointmentDate: "2026-12-15",
          startTime: "11:00",
          endTime: "12:00",
          status: "scheduled",
        },
      ]),
    };
    jest.spyOn(Appointment, "find").mockReturnValue(mockChain);
    const updateSpy = jest.spyOn(Appointment, "updateMany");

    const user = { id: actorId, hasOrgWideAccess: true, branchAccess: [] };
    const result = await service.createHoliday(
      orgId,
      { branchId: branchId.toString(), date: "2026-12-15", eventType: "branch_closure", name: "Deep Cleaning" },
      user
    );

    expect(result.holiday.id).toBe(createdId.toString());
    expect(result.conflicts.count).toBe(1);
    expect(result.conflicts.appointments[0].appointmentCode).toBe("APT-0010");
    expect(updateSpy).not.toHaveBeenCalled();
    expect(auditLogService.createAuditLog).toHaveBeenCalledWith(
      expect.objectContaining({ action: "HOLIDAY_CREATED", entityType: "HolidayCalendar" }),
      orgId,
      actorId,
      null
    );
  });

  it("propagates conflict-detection failures instead of reporting zero conflicts", async () => {
    jest.spyOn(Branch, "findOne").mockReturnValue({
      lean: jest.fn().mockResolvedValue({ _id: branchId, organizationId: orgId, isActive: true }),
    });
    jest.spyOn(HolidayCalendar, "create").mockResolvedValue([
      {
        _id: new mongoose.Types.ObjectId(),
        organizationId: orgId,
        branchId,
        date: "2026-12-15",
        endDate: "2026-12-15",
        eventType: "branch_closure",
        name: "Deep Cleaning",
        isPaid: false,
        isWorkingDay: false,
        isActive: true,
      },
    ]);
    jest.spyOn(Appointment, "find").mockImplementation(() => {
      throw new Error("DB connection lost");
    });

    const user = { id: actorId, hasOrgWideAccess: true, branchAccess: [] };
    await expect(
      service.createHoliday(
        orgId,
        { branchId: branchId.toString(), date: "2026-12-15", eventType: "branch_closure", name: "Deep Cleaning" },
        user
      )
    ).rejects.toThrow("DB connection lost");
    expect(auditLogService.createAuditLog).not.toHaveBeenCalled();
  });

  it("rejects cross-branch creation for branch-limited users", async () => {
    const user = {
      id: actorId,
      hasOrgWideAccess: false,
      branchAccess: [{ branchId: otherBranchId, isActive: true }],
    };

    await expect(
      service.createHoliday(
        orgId,
        { branchId: branchId.toString(), date: "2026-12-15", eventType: "branch_holiday", name: "Local" },
        user
      )
    ).rejects.toThrow("Access denied");
  });

  it("rejects immutable organizationId/branchId updates", async () => {
    await expect(
      service.updateHoliday(
        orgId,
        new mongoose.Types.ObjectId().toString(),
        { branchId: otherBranchId.toString() },
        { id: actorId, hasOrgWideAccess: true }
      )
    ).rejects.toThrow(AppError);
  });

  it("maps duplicate key errors to 409 Conflict", async () => {
    jest.spyOn(Branch, "findOne").mockReturnValue({
      lean: jest.fn().mockResolvedValue({ _id: branchId, organizationId: orgId, isActive: true }),
    });
    jest.spyOn(HolidayCalendar, "create").mockRejectedValue({ code: 11000 });

    const user = { id: actorId, hasOrgWideAccess: true, branchAccess: [] };
    await expect(
      service.createHoliday(
        orgId,
        { branchId: branchId.toString(), date: "2026-12-15", eventType: "branch_holiday", name: "Dup" },
        user
      )
    ).rejects.toThrow("already exists");
  });
});
