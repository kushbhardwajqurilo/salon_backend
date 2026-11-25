import { beforeEach, describe, expect, it, jest } from "@jest/globals";
import mongoose from "mongoose";
import { LeaveEntitlementService } from "../../services/leavePolicies/leaveEntitlement.service.js";
import { LeavePolicy } from "../../models/leavePolicies/leavePolicy.model.js";
import { LeaveBalance } from "../../models/leavePolicies/leaveBalance.model.js";
import { LeaveBalanceLedger } from "../../models/leavePolicies/leaveBalanceLedger.model.js";
import { SalaryStructure } from "../../models/payroll/salaryStructure.model.js";

describe("LeaveEntitlementService", () => {
  const orgId = new mongoose.Types.ObjectId();
  const branchId = new mongoose.Types.ObjectId();
  const staffId = new mongoose.Types.ObjectId();
  const actorId = new mongoose.Types.ObjectId();
  const policyId = new mongoose.Types.ObjectId();

  let calendarResolver;
  let service;

  beforeEach(() => {
    jest.restoreAllMocks();
    calendarResolver = {
      resolveCalendarRange: jest.fn(),
    };
    service = new LeaveEntitlementService({ calendarResolver });
  });

  it("calculates chargeable days day-by-day excluding branch closures, holidays, and weekly offs", () => {
    const result = service.calculateChargeableDaysFromCalendar({
      dates: ["2026-12-11", "2026-12-12", "2026-12-13", "2026-12-14"],
      isPartialDay: false,
      policy: { excludeHolidays: true, excludeWeeklyOffs: true },
      resolvedDays: [
        { date: "2026-12-11", status: "working_day" },
        { date: "2026-12-12", status: "holiday" },
        { date: "2026-12-13", status: "weekly_off" },
        { date: "2026-12-14", status: "branch_closure" },
      ],
    });

    expect(result.chargeableDays).toBe(1);
    expect(result.breakdown.map((b) => b.reason)).toEqual([
      "chargeable",
      "holiday_excluded",
      "weekly_off_excluded",
      "branch_closure",
    ]);
  });

  it("falls back to SalaryStructure.paidLeavePolicy when no central LeavePolicy applies", async () => {
    jest.spyOn(LeavePolicy, "find").mockReturnValue({
      session: jest.fn().mockReturnThis(),
      lean: jest.fn().mockReturnThis(),
      exec: jest.fn().mockResolvedValue([]),
    });
    jest.spyOn(SalaryStructure, "findOne").mockReturnValue({
      sort: jest.fn().mockReturnThis(),
      session: jest.fn().mockReturnThis(),
      lean: jest.fn().mockResolvedValue({
        paidLeavePolicy: { annualEntitlement: 12, carryForwardDays: 2 },
      }),
    });

    const result = await service.evaluateLeaveEntitlement({
      organizationId: orgId,
      branchId,
      staffId,
      leaveType: "Casual",
      dates: ["2026-12-10", "2026-12-11"],
    });

    expect(result.source).toBe("salary_structure_fallback");
    expect(result.salaryStructureEntitlement).toEqual({ annualEntitlement: 12, carryForwardDays: 2 });
  });

  it("returns legacy source when neither central LeavePolicy nor SalaryStructure applies", async () => {
    jest.spyOn(LeavePolicy, "find").mockReturnValue({
      session: jest.fn().mockReturnThis(),
      lean: jest.fn().mockReturnThis(),
      exec: jest.fn().mockResolvedValue([]),
    });
    jest.spyOn(SalaryStructure, "findOne").mockReturnValue({
      sort: jest.fn().mockReturnThis(),
      session: jest.fn().mockReturnThis(),
      lean: jest.fn().mockResolvedValue(null),
    });

    const result = await service.evaluateLeaveEntitlement({
      organizationId: orgId,
      branchId,
      staffId,
      leaveType: "Unpaid",
      dates: ["2026-12-10"],
    });

    expect(result.source).toBe("legacy");
  });

  it("flags requiresManagerSplitConfirmation when excessBehavior is convert_to_unpaid and balance is insufficient", async () => {
    const policy = {
      _id: policyId,
      code: "CASUAL",
      name: "Casual",
      isPaid: true,
      annualEntitlement: 5,
      allowHalfDay: true,
      excludeHolidays: true,
      excludeWeeklyOffs: true,
      excessBehavior: "convert_to_unpaid",
      allowNegativeBalance: false,
    };
    jest.spyOn(LeavePolicy, "find").mockReturnValue({
      session: jest.fn().mockReturnThis(),
      lean: jest.fn().mockReturnThis(),
      exec: jest.fn().mockResolvedValue([policy]),
    });
    calendarResolver.resolveCalendarRange.mockResolvedValue({
      days: [
        { date: "2026-12-10", status: "working_day" },
        { date: "2026-12-11", status: "working_day" },
        { date: "2026-12-14", status: "working_day" },
      ],
    });
    jest.spyOn(LeaveBalance, "findOne").mockReturnValue({
      session: jest.fn().mockResolvedValue({ availableBalance: 1 }),
    });

    const result = await service.evaluateLeaveEntitlement({
      organizationId: orgId,
      branchId,
      staffId,
      leaveType: "CASUAL",
      dates: ["2026-12-10", "2026-12-11", "2026-12-14"],
    });

    expect(result.source).toBe("central_policy");
    expect(result.requiresManagerSplitConfirmation).toBe(true);
    expect(result.paidDays).toBe(1);
    expect(result.unpaidDays).toBe(2);
  });

  it("flags insufficientBalance when excessBehavior is reject", async () => {
    const policy = {
      _id: policyId,
      code: "CASUAL",
      name: "Casual",
      isPaid: true,
      annualEntitlement: 5,
      allowHalfDay: true,
      excludeHolidays: true,
      excludeWeeklyOffs: true,
      excessBehavior: "reject",
      allowNegativeBalance: false,
    };
    jest.spyOn(LeavePolicy, "find").mockReturnValue({
      session: jest.fn().mockReturnThis(),
      lean: jest.fn().mockReturnThis(),
      exec: jest.fn().mockResolvedValue([policy]),
    });
    calendarResolver.resolveCalendarRange.mockResolvedValue({
      days: [
        { date: "2026-12-10", status: "working_day" },
        { date: "2026-12-11", status: "working_day" },
      ],
    });
    jest.spyOn(LeaveBalance, "findOne").mockReturnValue({
      session: jest.fn().mockResolvedValue({ availableBalance: 1 }),
    });

    const result = await service.evaluateLeaveEntitlement({
      organizationId: orgId,
      branchId,
      staffId,
      leaveType: "CASUAL",
      dates: ["2026-12-10", "2026-12-11"],
    });

    expect(result.insufficientBalance).toBe(true);
  });

  it("makes applyApprovalDeduction idempotent via LeaveBalanceLedger idempotencyKey", async () => {
    const existingEntry = { _id: new mongoose.Types.ObjectId(), idempotencyKey: "leave_approve:123" };
    jest.spyOn(LeaveBalanceLedger, "findOne").mockReturnValue({
      session: jest.fn().mockResolvedValue(existingEntry),
    });
    const balanceSpy = jest.spyOn(LeaveBalance, "findOne");

    const res = await service.applyApprovalDeduction({
      organizationId: orgId,
      staffId,
      leaveId: "123",
      policy: { _id: policyId, isPaid: true },
      paidDays: 2,
      periodYear: 2026,
      actorId,
      session: null,
    });

    expect(res).toBe(existingEntry);
    expect(balanceSpy).not.toHaveBeenCalled();
  });

  it("makes reverseApprovalDeduction idempotent via LeaveBalanceLedger idempotencyKey", async () => {
    const existingEntry = { _id: new mongoose.Types.ObjectId(), idempotencyKey: "leave_cancel:123" };
    jest.spyOn(LeaveBalanceLedger, "findOne").mockReturnValue({
      session: jest.fn().mockResolvedValue(existingEntry),
    });
    const balanceSpy = jest.spyOn(LeaveBalance, "findOne");

    const res = await service.reverseApprovalDeduction({
      organizationId: orgId,
      staffId,
      leaveId: "123",
      leavePolicyId: policyId,
      paidDays: 2,
      periodYear: 2026,
      actorId,
      session: null,
    });

    expect(res).toBe(existingEntry);
    expect(balanceSpy).not.toHaveBeenCalled();
  });

  it("permits negative balance only when allowNegativeBalance is true", async () => {
    const policy = {
      _id: policyId,
      code: "CASUAL",
      name: "Casual",
      isPaid: true,
      annualEntitlement: 5,
      allowHalfDay: true,
      excludeHolidays: true,
      excludeWeeklyOffs: true,
      excessBehavior: "reject",
      allowNegativeBalance: true,
      negativeBalancePayrollTreatment: "unpaid_deduction",
    };
    jest.spyOn(LeavePolicy, "find").mockReturnValue({
      session: jest.fn().mockReturnThis(),
      lean: jest.fn().mockReturnThis(),
      exec: jest.fn().mockResolvedValue([policy]),
    });
    calendarResolver.resolveCalendarRange.mockResolvedValue({
      days: [
        { date: "2026-12-10", status: "working_day" },
        { date: "2026-12-11", status: "working_day" },
      ],
    });
    jest.spyOn(LeaveBalance, "findOne").mockReturnValue({
      session: jest.fn().mockResolvedValue({ availableBalance: 1 }),
    });

    const result = await service.evaluateLeaveEntitlement({
      organizationId: orgId,
      branchId,
      staffId,
      leaveType: "CASUAL",
      dates: ["2026-12-10", "2026-12-11"],
    });

    expect(result.insufficientBalance).toBe(false);
    expect(result.willGoNegative).toBe(true);
    expect(result.paidDays).toBe(2);
  });
});
