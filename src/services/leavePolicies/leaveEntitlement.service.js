import { LeavePolicy } from "../../models/leavePolicies/leavePolicy.model.js";
import { LeaveBalance } from "../../models/leavePolicies/leaveBalance.model.js";
import { LeaveBalanceLedger } from "../../models/leavePolicies/leaveBalanceLedger.model.js";
import { SalaryStructure } from "../../models/payroll/salaryStructure.model.js";
import { CalendarResolverService } from "../holidays/calendarResolver.service.js";
import { SettingsResolverService } from "../settings/settingsResolver.service.js";
import { AppError } from "../../utils/errors.js";

export class LeaveEntitlementService {
  constructor(deps = {}) {
    this.calendarResolver = deps.calendarResolver || new CalendarResolverService();
    this.settingsResolver = deps.settingsResolver || new SettingsResolverService();
  }

  /**
   * Resolves an applicable central LeavePolicy for (organizationId, branchId, leaveType, asOfDate).
   * Precedence: branch-specific policy -> organization-wide policy -> null.
   */
  async resolveApplicablePolicy({ organizationId, branchId, leaveType, asOfDate = new Date(), session = null }) {
    if (!leaveType || typeof leaveType !== "string") return null;
    const normalized = leaveType.trim();
    const upper = normalized.toUpperCase();

    const query = LeavePolicy.find({
      organizationId,
      isActive: true,
      branchId: { $in: [branchId || null, null] },
      effectiveFrom: { $lte: asOfDate },
      $or: [{ effectiveTo: null }, { effectiveTo: { $gte: asOfDate } }],
    });
    if (session) query.session(session);
    const candidates = await query.lean().exec();

    const matchesType = (p) =>
      p.code?.toUpperCase() === upper || p.name?.trim().toLowerCase() === normalized.toLowerCase();

    const branchMatch = branchId
      ? candidates.find((p) => p.branchId && p.branchId.toString() === branchId.toString() && matchesType(p))
      : null;
    if (branchMatch) return branchMatch;

    return candidates.find((p) => !p.branchId && matchesType(p)) || null;
  }

  /**
   * Pure day-by-day chargeable-days calculation using resolved calendar days.
   * Branch closures never consume employee leave entitlement.
   */
  calculateChargeableDaysFromCalendar({ dates = [], isPartialDay = false, policy = null, resolvedDays = [] }) {
    const dayMap = new Map(resolvedDays.map((d) => [d.date, d]));
    const excludeHolidays = policy ? Boolean(policy.excludeHolidays) : false;
    const excludeWeeklyOffs = policy ? Boolean(policy.excludeWeeklyOffs) : false;

    let chargeableDays = 0;
    const breakdown = [];

    for (const dateStr of dates) {
      const cal = dayMap.get(dateStr);
      if (cal?.status === "branch_closure") {
        breakdown.push({ date: dateStr, chargeable: 0, reason: "branch_closure" });
        continue;
      }
      if (cal?.status === "holiday" && excludeHolidays) {
        breakdown.push({ date: dateStr, chargeable: 0, reason: "holiday_excluded" });
        continue;
      }
      if (cal?.status === "weekly_off" && excludeWeeklyOffs) {
        breakdown.push({ date: dateStr, chargeable: 0, reason: "weekly_off_excluded" });
        continue;
      }

      const weight = isPartialDay ? 0.5 : 1.0;
      chargeableDays += weight;
      breakdown.push({ date: dateStr, chargeable: weight, reason: "chargeable" });
    }

    return { chargeableDays, breakdown };
  }

  /**
   * Ensures a LeaveBalance record exists for (org, staff, policy, year) and returns it.
   */
  async getOrCreateBalance({ organizationId, staffId, policy, periodYear, actorId = null, session = null }) {
    let balance = await LeaveBalance.findOne({
      organizationId,
      staffId,
      leavePolicyId: policy._id,
      periodYear,
    }).session(session);

    if (!balance) {
      const grantAmount = policy.isPaid ? Number(policy.annualEntitlement || 0) : 0;
      const created = await LeaveBalance.create(
        [
          {
            organizationId,
            staffId,
            leavePolicyId: policy._id,
            periodYear,
            openingBalance: grantAmount,
            credits: 0,
            debits: 0,
            adjustments: 0,
            availableBalance: grantAmount,
          },
        ],
        { session }
      );
      balance = created[0];

      await LeaveBalanceLedger.create(
        [
          {
            organizationId,
            staffId,
            leavePolicyId: policy._id,
            periodYear,
            entryType: "grant",
            deltaDays: grantAmount,
            balanceAfter: grantAmount,
            idempotencyKey: `grant:${staffId}:${policy._id}:${periodYear}`,
            reason: `Annual entitlement grant for ${periodYear}`,
            actorId,
          },
        ],
        { session }
      );
    }

    return balance;
  }

  /**
   * Evaluates entitlement for a leave request.
   * Precedence:
   * 1. Central LeavePolicy (authoritative when assigned)
   * 2. SalaryStructure.paidLeavePolicy fallback
   * 3. Legacy classification
   */
  async evaluateLeaveEntitlement({
    organizationId,
    branchId,
    staffId,
    leaveType,
    dates,
    isPartialDay = false,
    asOfDate = new Date(),
    actorId = null,
    session = null,
  }) {
    const policy = await this.resolveApplicablePolicy({
      organizationId,
      branchId,
      leaveType,
      asOfDate,
      session,
    });

    if (!policy) {
      // Fallback check: SalaryStructure.paidLeavePolicy
      const salaryStructure = await SalaryStructure.findOne({
        organizationId,
        staffId,
        isDeleted: false,
        effectiveFrom: { $lte: asOfDate },
        $or: [{ effectiveTo: null }, { effectiveTo: { $gte: asOfDate } }],
      })
        .sort({ effectiveFrom: -1 })
        .session(session)
        .lean();

      if (salaryStructure?.paidLeavePolicy) {
        return {
          source: "salary_structure_fallback",
          policy: null,
          chargeableDays: isPartialDay ? 0.5 : dates.length,
          paidDays: null,
          unpaidDays: null,
          isUnpaid: null,
          requiresManagerSplitConfirmation: false,
          insufficientBalance: false,
          salaryStructureEntitlement: salaryStructure.paidLeavePolicy,
        };
      }

      return {
        source: "legacy",
        policy: null,
        chargeableDays: isPartialDay ? 0.5 : dates.length,
        paidDays: null,
        unpaidDays: null,
        isUnpaid: null,
        requiresManagerSplitConfirmation: false,
        insufficientBalance: false,
      };
    }

    if (isPartialDay) {
      const effectiveSettings = await this.settingsResolver.resolveEffectiveSettings(
        organizationId,
        branchId
      );
      if (effectiveSettings?.leaves?.allowHalfDay?.value === false) {
        throw new AppError("Half-day leave is disabled for this branch", 400);
      }
      if (!policy.allowHalfDay) {
        throw new AppError(`Half-day leave is not permitted under policy '${policy.name}'`, 400);
      }
    }
    if (policy.maxConsecutiveDays && dates.length > policy.maxConsecutiveDays) {
      throw new AppError(
        `Leave exceeds maximum consecutive days (${policy.maxConsecutiveDays}) for policy '${policy.name}'`,
        400
      );
    }

    const startDate = dates[0];
    const endDate = dates[dates.length - 1];
    const calendar = await this.calendarResolver.resolveCalendarRange({
      organizationId,
      branchId,
      startDate,
      endDate,
    });

    const { chargeableDays, breakdown } = this.calculateChargeableDaysFromCalendar({
      dates,
      isPartialDay,
      policy,
      resolvedDays: calendar.days,
    });

    if (!policy.isPaid) {
      return {
        source: "central_policy",
        policy,
        chargeableDays,
        breakdown,
        paidDays: 0,
        unpaidDays: chargeableDays,
        isUnpaid: true,
        requiresManagerSplitConfirmation: false,
        insufficientBalance: false,
      };
    }

    const periodYear = Number(startDate.slice(0, 4));
    const balance = await this.getOrCreateBalance({
      organizationId,
      staffId,
      policy,
      periodYear,
      actorId,
      session,
    });

    const available = Number(balance.availableBalance || 0);
    if (chargeableDays <= available) {
      return {
        source: "central_policy",
        policy,
        periodYear,
        availableBalance: available,
        chargeableDays,
        breakdown,
        paidDays: chargeableDays,
        unpaidDays: 0,
        isUnpaid: false,
        requiresManagerSplitConfirmation: false,
        insufficientBalance: false,
      };
    }

    // Insufficient paid balance
    const excessDays = Number((chargeableDays - Math.max(0, available)).toFixed(2));
    if (policy.allowNegativeBalance) {
      return {
        source: "central_policy",
        policy,
        periodYear,
        availableBalance: available,
        chargeableDays,
        breakdown,
        paidDays: chargeableDays,
        unpaidDays: 0,
        isUnpaid: false,
        requiresManagerSplitConfirmation: false,
        insufficientBalance: false,
        willGoNegative: true,
      };
    }

    if (policy.excessBehavior === "convert_to_unpaid") {
      const paidDays = Math.max(0, available);
      return {
        source: "central_policy",
        policy,
        periodYear,
        availableBalance: available,
        chargeableDays,
        breakdown,
        paidDays,
        unpaidDays: excessDays,
        isUnpaid: paidDays === 0,
        requiresManagerSplitConfirmation: true,
        insufficientBalance: false,
      };
    }

    // excessBehavior === "reject"
    return {
      source: "central_policy",
      policy,
      periodYear,
      availableBalance: available,
      chargeableDays,
      breakdown,
      paidDays: 0,
      unpaidDays: 0,
      isUnpaid: false,
      requiresManagerSplitConfirmation: false,
      insufficientBalance: true,
    };
  }

  /**
   * Idempotently deducts paidDays from LeaveBalance and writes LeaveBalanceLedger.
   */
  async applyApprovalDeduction({
    organizationId,
    staffId,
    leaveId,
    policy,
    paidDays,
    periodYear,
    actorId,
    session,
  }) {
    if (!policy || !policy.isPaid || paidDays <= 0) return null;

    const idempotencyKey = `leave_approve:${leaveId}`;
    const existingLedger = await LeaveBalanceLedger.findOne({
      organizationId,
      idempotencyKey,
    }).session(session);
    if (existingLedger) {
      return existingLedger;
    }

    const balance = await this.getOrCreateBalance({
      organizationId,
      staffId,
      policy,
      periodYear,
      actorId,
      session,
    });

    const newAvailable = Number((balance.availableBalance - paidDays).toFixed(2));
    if (newAvailable < 0 && !policy.allowNegativeBalance) {
      throw new AppError("Insufficient paid leave balance", 400);
    }

    balance.debits = Number((balance.debits + paidDays).toFixed(2));
    balance.availableBalance = newAvailable;
    await balance.save({ session });

    const ledger = await LeaveBalanceLedger.create(
      [
        {
          organizationId,
          staffId,
          leavePolicyId: policy._id,
          leaveId,
          periodYear,
          entryType: "deduction",
          deltaDays: -paidDays,
          balanceAfter: newAvailable,
          idempotencyKey,
          reason: `Leave approved (${paidDays} paid day(s))`,
          actorId,
        },
      ],
      { session }
    );
    return ledger[0];
  }

  /**
   * Idempotently restores paidDays on leave cancellation.
   */
  async reverseApprovalDeduction({
    organizationId,
    staffId,
    leaveId,
    leavePolicyId,
    paidDays,
    periodYear,
    actorId,
    session,
  }) {
    if (!leavePolicyId || !paidDays || paidDays <= 0) return null;

    const idempotencyKey = `leave_cancel:${leaveId}`;
    const existingLedger = await LeaveBalanceLedger.findOne({
      organizationId,
      idempotencyKey,
    }).session(session);
    if (existingLedger) {
      return existingLedger;
    }

    const balance = await LeaveBalance.findOne({
      organizationId,
      staffId,
      leavePolicyId,
      periodYear,
    }).session(session);
    if (!balance) return null;

    const newAvailable = Number((balance.availableBalance + paidDays).toFixed(2));
    balance.credits = Number((balance.credits + paidDays).toFixed(2));
    balance.availableBalance = newAvailable;
    await balance.save({ session });

    const ledger = await LeaveBalanceLedger.create(
      [
        {
          organizationId,
          staffId,
          leavePolicyId,
          leaveId,
          periodYear,
          entryType: "restoration",
          deltaDays: paidDays,
          balanceAfter: newAvailable,
          idempotencyKey,
          reason: `Leave cancelled (${paidDays} paid day(s) restored)`,
          actorId,
        },
      ],
      { session }
    );
    return ledger[0];
  }
}
