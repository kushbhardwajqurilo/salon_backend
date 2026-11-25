import { beforeEach, describe, expect, it, jest } from "@jest/globals";
import mongoose from "mongoose";
import { PayrollService } from "../../services/payroll/payroll.service.js";
import { PayrollPeriod } from "../../models/payroll/payrollPeriod.model.js";
import { PayrollRecord } from "../../models/payroll/payrollRecord.model.js";
import { Staff } from "../../models/staff/staff.model.js";
import { StaffBranch } from "../../models/staff/staffBranch.model.js";
import { Attendance } from "../../models/attendance/attendance.model.js";
import { AttendanceBranchConflict } from "../../models/attendance/AttendanceLeaveAppointmentConflict.model.js";
import { Leave } from "../../models/leaves/leave.model.js";
import { LeaveBalance } from "../../models/leavePolicies/leaveBalance.model.js";
import { LeaveBalanceLedger } from "../../models/leavePolicies/leaveBalanceLedger.model.js";
import { IncentiveEvaluation } from "../../models/incentives/incentiveEvaluation.model.js";
import { IncentiveLedger } from "../../models/incentives/incentiveLedger.model.js";
import { CalendarResolverService } from "../../services/holidays/calendarResolver.service.js";

describe("Phase 5 Payroll Policy, Calendar & Snapshot Integration", () => {
  const orgId = new mongoose.Types.ObjectId();
  const branchId = new mongoose.Types.ObjectId();
  const staffId = new mongoose.Types.ObjectId();
  const periodId = new mongoose.Types.ObjectId();
  const userId = new mongoose.Types.ObjectId();

  beforeEach(() => {
    jest.restoreAllMocks();
    jest.spyOn(PayrollPeriod, "findOne").mockResolvedValue({
      _id: periodId,
      organizationId: orgId,
      year: 2026,
      month: 11,
      monthYear: "2026-11",
      startDate: new Date("2026-11-01T00:00:00.000Z"),
      endDate: new Date("2026-11-30T23:59:59.999Z"),
      totalDays: 30,
      status: "open",
    });
    jest.spyOn(Staff, "find").mockResolvedValue([
      { _id: staffId, name: "Asha", joiningDate: new Date("2026-01-01T00:00:00Z") },
    ]);
    jest.spyOn(StaffBranch, "findOne").mockReturnValue({
      sort: jest.fn().mockResolvedValue({ branchId }),
    });
    jest.spyOn(IncentiveEvaluation, "find").mockReturnValue({
      select: jest.fn().mockReturnThis(),
      lean: jest.fn().mockResolvedValue([]),
    });
    jest.spyOn(IncentiveLedger, "find").mockReturnValue({
      sort: jest.fn().mockReturnThis(),
      lean: jest.fn().mockResolvedValue([]),
    });
    jest.spyOn(AttendanceBranchConflict, "find").mockReturnValue({
      select: jest.fn().mockReturnThis(),
      lean: jest.fn().mockResolvedValue([]),
    });
    jest.spyOn(PayrollService, "getEffectiveSalaryStructure").mockResolvedValue({
      _id: new mongoose.Types.ObjectId(),
      payType: "fixed_monthly",
      baseSalary: 30000,
      hourlyRate: 0,
      paidLeavePolicy: { annualEntitlement: 12, carryForwardDays: 0 },
      allowances: [],
      deductions: [],
    });
  });

  it("consumes persisted central LeavePolicy paidDays/unpaidDays without mutating LeaveBalance or LeaveBalanceLedger", async () => {
    jest.spyOn(PayrollRecord, "findOne").mockResolvedValue(null);
    jest.spyOn(Attendance, "find").mockResolvedValue([
      { _id: new mongoose.Types.ObjectId(), attendanceDate: new Date("2026-11-02T00:00:00Z"), status: "present" },
    ]);
    // 1st call: priorApprovedLeaves; 2nd call: leaveRecords in period
    jest
      .spyOn(Leave, "find")
      .mockReturnValueOnce({ sort: jest.fn().mockResolvedValue([]) })
      .mockReturnValueOnce({
        sort: jest.fn().mockResolvedValue([
          {
            _id: new mongoose.Types.ObjectId(),
            leavePolicyId: new mongoose.Types.ObjectId(),
            startDate: new Date("2026-11-03T00:00:00Z"),
            endDate: new Date("2026-11-05T00:00:00Z"),
            paidDays: 1,
            unpaidDays: 2,
          },
        ]),
      });

    const days = [];
    for (let d = 1; d <= 30; d++) {
      const dateStr = `2026-11-${String(d).padStart(2, "0")}`;
      if (d === 1) days.push({ date: dateStr, status: "weekly_off", isWorkingDay: false });
      else if (d === 10) days.push({ date: dateStr, status: "holiday", isWorkingDay: false });
      else if (d === 11) days.push({ date: dateStr, status: "branch_closure", isWorkingDay: false });
      else days.push({ date: dateStr, status: "working_day", isWorkingDay: true });
    }
    jest.spyOn(CalendarResolverService.prototype, "resolveCalendarRange").mockResolvedValue({ days });

    const balanceSpy = jest.spyOn(LeaveBalance, "findOneAndUpdate");
    const ledgerSpy = jest.spyOn(LeaveBalanceLedger, "create");
    const upsertSpy = jest.spyOn(PayrollRecord, "findOneAndUpdate").mockImplementation(async (_f, u) => u.$set);

    const results = await PayrollService.calculatePayroll({
      organizationId: orgId,
      payrollPeriodId: periodId,
      userId,
    });

    expect(results).toHaveLength(1);
    const snap = results[0].attendanceSummarySnapshot;
    expect(snap.presentDays).toBe(1);
    expect(snap.paidLeaveDays).toBe(1);
    expect(snap.unpaidLeaveDays).toBe(2);
    expect(snap.holidayDays).toBe(1);
    expect(snap.weeklyOffDays).toBe(1);
    expect(snap.branchClosureDays).toBe(1);
    expect(snap.payableDays).toBe(2);
    expect(balanceSpy).not.toHaveBeenCalled();
    expect(ledgerSpy).not.toHaveBeenCalled();
    expect(upsertSpy).toHaveBeenCalled();
  });

  it("protects paid payroll records from silent recalculation", async () => {
    jest.spyOn(PayrollRecord, "findOne").mockResolvedValue({
      _id: new mongoose.Types.ObjectId(),
      status: "paid",
    });
    const upsertSpy = jest.spyOn(PayrollRecord, "findOneAndUpdate");

    const results = await PayrollService.calculatePayroll({
      organizationId: orgId,
      payrollPeriodId: periodId,
      userId,
    });

    expect(results).toEqual([]);
    expect(upsertSpy).not.toHaveBeenCalled();
  });

  it("protects payroll records with manualPaymentStatus === 'recorded' from recalculation", async () => {
    jest.spyOn(PayrollRecord, "findOne").mockResolvedValue({
      _id: new mongoose.Types.ObjectId(),
      status: "approved",
      manualPaymentStatus: "recorded",
    });
    const upsertSpy = jest.spyOn(PayrollRecord, "findOneAndUpdate");

    const results = await PayrollService.calculatePayroll({
      organizationId: orgId,
      payrollPeriodId: periodId,
      userId,
    });

    expect(results).toEqual([]);
    expect(upsertSpy).not.toHaveBeenCalled();
  });
});
