import { createHash } from "node:crypto";
import mongoose from "mongoose";
import { AppError } from "../../utils/errors.js";
import { SalaryStructure } from "../../models/payroll/salaryStructure.model.js";
import { PayrollPeriod } from "../../models/payroll/payrollPeriod.model.js";
import { PayrollRecord } from "../../models/payroll/payrollRecord.model.js";
import { PayrollPayment } from "../../models/payroll/payrollPayment.model.js";
import { PayrollIncentiveAllocation } from "../../models/payroll/payrollIncentiveAllocation.model.js";
import { Staff } from "../../models/staff/staff.model.js";
import { StaffBranch } from "../../models/staff/staffBranch.model.js";
import { Attendance } from "../../models/attendance/attendance.model.js";
import { AttendanceBranchConflict } from "../../models/attendance/AttendanceLeaveAppointmentConflict.model.js";
import { IncentiveEvaluation } from "../../models/incentives/incentiveEvaluation.model.js";
import { IncentiveLedger } from "../../models/incentives/incentiveLedger.model.js";
import { Leave } from "../../models/leaves/leave.model.js";
import { runInTransaction } from "../../utils/transaction.js";

/**
 * Helper to calculate calendar days in a month
 */
export function getDaysInMonth(year, month) {
  return new Date(year, month, 0).getDate();
}

/**
 * Helper to format monthYear "YYYY-MM"
 */
export function formatMonthYear(year, month) {
  const paddedMonth = month.toString().padStart(2, "0");
  return `${year}-${paddedMonth}`;
}

const branchCondition = (branchId) => branchId ? { branchId } : {};

const assertStaffBranchAssignment = async ({ organizationId, staffId, branchId }) => {
  if (!branchId) return;
  const assignment = await StaffBranch.findOne({
    organizationId,
    staffId,
    branchId,
    isActive: true,
  }).select("_id");
  if (!assignment) throw new AppError("Staff member not found in the selected branch", 404);
};

const getNetPayableInPaise = (record) => {
  const payable = Number(record.calculations?.netPayable);
  if (!Number.isFinite(payable) || payable < 0) {
    throw new AppError("Payroll payable amount is invalid", 409);
  }
  const amountInPaise = Math.round(payable * 100);
  if (!Number.isSafeInteger(amountInPaise) || Math.abs(payable * 100 - amountInPaise) > 0.000001) {
    throw new AppError("Payroll payable amount cannot be represented in integer paise", 409);
  }
  return amountInPaise;
};

const hashPaymentRequest = ({ amountInPaise, paymentMethod, paymentReference, paymentDate }) =>
  createHash("sha256")
    .update(JSON.stringify({
      amountInPaise,
      paymentMethod,
      paymentReference: paymentReference.trim(),
      paymentDate: new Date(paymentDate).toISOString(),
    }))
    .digest("hex");

const COMMISSION_LEDGER_SOURCE_TYPES = [
  "service_commission",
  "subscription_sale_commission",
  "membership_sale_commission",
  "retail_sale_commission",
];

const getCommissionLedgerSnapshot = async ({
  organizationId,
  staffId,
  branchId,
  startDate,
  endDate,
  session,
}) => {
  const query = IncentiveLedger.find({
    organizationId,
    staffId,
    sourceType: { $in: COMMISSION_LEDGER_SOURCE_TYPES },
    entryType: "ACCRUAL",
    fulfillmentStatus: { $in: ["confirmed", "not_applicable"] },
    amountInPaise: { $gt: 0 },
    createdAt: { $gte: startDate, $lte: endDate },
    ...(branchId ? { branchId } : {}),
  }).sort({ _id: 1 });
  if (session) query.session(session);
  const accruals = await query.lean();
  if (accruals.length === 0) {
    return {
      entries: [],
      ledgerEntryIds: [],
      clawbackEntryIds: [],
      grossAmountInPaise: 0,
      clawbackAmountInPaise: 0,
      payableAmountInPaise: 0,
    };
  }

  const clawbackQuery = IncentiveLedger.find({
    organizationId,
    entryType: "CLAWBACK",
    reversesLedgerId: { $in: accruals.map((entry) => entry._id) },
  }).sort({ _id: 1 });
  if (session) clawbackQuery.session(session);
  const clawbacks = await clawbackQuery.lean();
  const clawbacksByAccrual = new Map();
  for (const clawback of clawbacks) {
    const key = clawback.reversesLedgerId.toString();
    clawbacksByAccrual.set(key, [
      ...(clawbacksByAccrual.get(key) || []),
      clawback,
    ]);
  }

  const entries = accruals.map((accrual) => {
    const relatedClawbacks = clawbacksByAccrual.get(accrual._id.toString()) || [];
    const clawbackAmountInPaise = relatedClawbacks.reduce(
      (total, clawback) => total + clawback.amountInPaise,
      0,
    );
    if (!Number.isSafeInteger(clawbackAmountInPaise)
      || clawbackAmountInPaise > accrual.amountInPaise) {
      throw new AppError("Commission ledger clawbacks exceed the source accrual", 409);
    }
    return {
      ledgerEntryId: accrual._id,
      sourceBranchId: accrual.branchId,
      sourceType: accrual.sourceType,
      sourceAmountInPaise: accrual.amountInPaise,
      clawbackAmountInPaise,
      payableAmountInPaise: accrual.amountInPaise - clawbackAmountInPaise,
      clawbackLedgerEntryIds: relatedClawbacks.map((entry) => entry._id),
    };
  });
  const grossAmountInPaise = entries.reduce(
    (total, entry) => total + entry.sourceAmountInPaise,
    0,
  );
  const clawbackAmountInPaise = entries.reduce(
    (total, entry) => total + entry.clawbackAmountInPaise,
    0,
  );
  const payableAmountInPaise = entries.reduce(
    (total, entry) => total + entry.payableAmountInPaise,
    0,
  );
  if (![grossAmountInPaise, clawbackAmountInPaise, payableAmountInPaise]
    .every(Number.isSafeInteger)) {
    throw new AppError("Commission ledger total exceeds the safe paise limit", 409);
  }
  return {
    entries,
    ledgerEntryIds: accruals.map((entry) => entry._id),
    clawbackEntryIds: clawbacks.map((entry) => entry._id),
    grossAmountInPaise,
    clawbackAmountInPaise,
    payableAmountInPaise,
  };
};

const hasSameCommissionSnapshot = (record, current) => {
  const recordedEntries = (record.incentiveLedgerEntries || []).map((entry) => ({
    ledgerEntryId: entry.ledgerEntryId.toString(),
    sourceBranchId: entry.sourceBranchId.toString(),
    sourceType: entry.sourceType,
    sourceAmountInPaise: entry.sourceAmountInPaise,
    clawbackAmountInPaise: entry.clawbackAmountInPaise,
    payableAmountInPaise: entry.payableAmountInPaise,
    clawbackLedgerEntryIds: (entry.clawbackLedgerEntryIds || []).map((id) => id.toString()).sort(),
  }));
  const currentEntries = current.entries.map((entry) => ({
    ...entry,
    ledgerEntryId: entry.ledgerEntryId.toString(),
    sourceBranchId: entry.sourceBranchId.toString(),
    clawbackLedgerEntryIds: entry.clawbackLedgerEntryIds.map((id) => id.toString()).sort(),
  }));
  return record.incentiveLedgerGrossInPaise === current.grossAmountInPaise
    && record.incentiveLedgerClawbackInPaise === current.clawbackAmountInPaise
    && record.incentiveLedgerAmountInPaise === current.payableAmountInPaise
    && JSON.stringify((record.incentiveLedgerEntryIds || []).map((id) => id.toString()).sort())
      === JSON.stringify(current.ledgerEntryIds.map((id) => id.toString()).sort())
    && JSON.stringify((record.incentiveLedgerClawbackEntryIds || []).map((id) => id.toString()).sort())
      === JSON.stringify(current.clawbackEntryIds.map((id) => id.toString()).sort())
    && JSON.stringify(recordedEntries) === JSON.stringify(currentEntries);
};

const withPaymentHistory = async (records, organizationId) => {
  if (records.length === 0) return records;
  const recordIds = records.map((record) => record._id);
  const payments = await PayrollPayment.find({
    organizationId,
    payrollRecordId: { $in: recordIds },
  })
    .populate("recordedBy", "name email")
    .populate("confirmedBy", "name email")
    .populate("failedBy", "name email")
    .populate("reversedBy", "name email")
    .sort({ createdAt: -1 })
    .lean();
  const paymentsByRecordId = new Map();
  for (const payment of payments) {
    const key = payment.payrollRecordId.toString();
    paymentsByRecordId.set(key, [...(paymentsByRecordId.get(key) || []), payment]);
  }
  return records.map((record) => {
    const document = record.toObject ? record.toObject() : record;
    const paymentHistory = paymentsByRecordId.get(record._id.toString()) || [];
    return {
      ...document,
      paymentHistory,
      latestPaymentAttempt: paymentHistory[0] || null,
    };
  });
};

export class PayrollService {
  /**
   * Create or update salary structure for a staff member
   */
  static async setSalaryStructure({
    organizationId,
    branchId,
    staffId,
    payType,
    baseSalary,
    hourlyRate,
    paidLeavePolicy,
    allowances,
    deductions,
    effectiveFrom,
    effectiveTo,
    userId,
  }) {
    const staff = await Staff.findOne({
      _id: staffId,
      organizationId,
      isDeleted: false,
    });
    if (!staff) {
      throw new AppError("Staff member not found", 404);
    }
    await assertStaffBranchAssignment({ organizationId, staffId, branchId });

    // Validate against conflicting future overlapping structures
    const fromDate = new Date(effectiveFrom);
    const toDate = effectiveTo ? new Date(effectiveTo) : null;

    if (toDate && toDate <= fromDate) {
      throw new AppError("Effective-to date must be strictly after effective-from date", 400);
    }

    // Check if there is an overlapping record with a later effectiveFrom that would conflict
    const overlapping = await SalaryStructure.findOne({
      organizationId,
      staffId,
      isDeleted: false,
      effectiveFrom: { $gt: fromDate },
      ...(toDate ? { effectiveFrom: { $lt: toDate } } : {}),
    });

    if (overlapping) {
      throw new AppError(
        `Salary structure overlaps with an existing future revision starting on ${overlapping.effectiveFrom.toISOString().slice(0, 10)}`,
        400
      );
    }

    // Deactivate previous active configurations that overlap or are superseded
    await SalaryStructure.updateMany(
      {
        organizationId,
        staffId,
        isActive: true,
        effectiveFrom: { $lte: fromDate },
      },
      {
        $set: { isActive: false, effectiveTo: fromDate },
      }
    );

    const salaryStructure = await SalaryStructure.create({
      organizationId,
      staffId,
      payType,
      baseSalary,
      hourlyRate: hourlyRate || 0,
      paidLeavePolicy: {
        annualEntitlement: Number(paidLeavePolicy?.annualEntitlement || 0),
        carryForwardDays: Number(paidLeavePolicy?.carryForwardDays || 0),
      },
      allowances: allowances || [],
      deductions: deductions || [],
      effectiveFrom: fromDate,
      effectiveTo: toDate,
      isActive: true,
      createdBy: userId,
      updatedBy: userId,
    });

    return salaryStructure;
  }

  /**
   * Get effective salary structure for a staff member at a specific date
   */
  static async getEffectiveSalaryStructure({ organizationId, branchId, staffId, date }) {
    await assertStaffBranchAssignment({ organizationId, staffId, branchId });
    const targetDate = date ? new Date(date) : new Date();

    const structure = await SalaryStructure.findOne({
      organizationId,
      staffId,
      isDeleted: false,
      effectiveFrom: { $lte: targetDate },
      $or: [{ effectiveTo: null }, { effectiveTo: { $gte: targetDate } }],
    }).sort({ effectiveFrom: -1 });

    return structure;
  }

  /**
   * Get complete salary structure history for a staff member
   */
  static async getSalaryStructureHistory({ organizationId, branchId, staffId }) {
    await assertStaffBranchAssignment({ organizationId, staffId, branchId });
    return SalaryStructure.find({
      organizationId,
      staffId,
      isDeleted: false,
    }).sort({ effectiveFrom: -1, createdAt: -1 });
  }

  /**
   * Create a payroll period for an organization
   */
  static async createPayrollPeriod({ organizationId, year, month, userId }) {
    const totalDays = getDaysInMonth(year, month);
    const monthYear = formatMonthYear(year, month);

    const existingPeriod = await PayrollPeriod.findOne({
      organizationId,
      monthYear,
      isDeleted: false,
    });

    if (existingPeriod) {
      throw new AppError(`Payroll period ${monthYear} already exists`, 409);
    }

    const startDate = new Date(Date.UTC(year, month - 1, 1, 0, 0, 0));
    const endDate = new Date(Date.UTC(year, month - 1, totalDays, 23, 59, 59, 999));

    const period = await PayrollPeriod.create({
      organizationId,
      year,
      month,
      monthYear,
      startDate,
      endDate,
      totalDays,
      status: "open",
      createdBy: userId,
      updatedBy: userId,
    });

    return period;
  }

  /**
   * List payroll periods
   */
  static async listPayrollPeriods({ organizationId }) {
    return PayrollPeriod.find({ organizationId, isDeleted: false }).sort({
      year: -1,
      month: -1,
    });
  }

  /**
   * Calculate payroll for a given period
   */
  static async calculatePayroll({
    organizationId,
    payrollPeriodId,
    staffIds,
    branchId,
    userId,
  }) {
    const period = await PayrollPeriod.findOne({
      _id: payrollPeriodId,
      organizationId,
      isDeleted: false,
    });

    if (!period) {
      throw new AppError("Payroll period not found", 404);
    }

    // Filter staff
    const staffQuery = {
      organizationId,
      isDeleted: false,
      status: "active",
    };

    if (staffIds && staffIds.length > 0) {
      staffQuery._id = { $in: staffIds };
    }

    const staffList = await Staff.find(staffQuery);
    if (!staffList || staffList.length === 0) {
      throw new AppError("No active staff found for calculation", 404);
    }

    const calculatedRecords = [];

    for (const staff of staffList) {
      // 1. Determine staff's primary branch
      const staffBranch = await StaffBranch.findOne({
        organizationId,
        staffId: staff._id,
        isActive: true,
      }).sort({ isPrimary: -1 });

      const assignedBranchId = staffBranch ? staffBranch.branchId : null;

      // Filter by branchId if specified
      if (branchId && assignedBranchId && assignedBranchId.toString() !== branchId.toString()) {
        continue;
      }

      if (!assignedBranchId) {
        // Cannot process payroll without branch cost-center ownership
        continue;
      }

      // Check if existing record is approved or paid
      const existingRecord = await PayrollRecord.findOne({
        organizationId,
        staffId: staff._id,
        monthYear: period.monthYear,
        isDeleted: false,
        ...branchCondition(branchId),
      });

      if (existingRecord) {
        if (existingRecord.status === "paid"
          || existingRecord.manualPaymentStatus === "recorded") {
          continue;
        }
        if (existingRecord.status === "approved") {
          await runInTransaction(async (session) => {
            const options = session ? { session } : {};
            const approvedAllocations = await PayrollIncentiveAllocation.find({
              organizationId,
              payrollRecordId: existingRecord._id,
              status: "approved",
            }).session(session);
            for (const allocation of approvedAllocations) {
              const releasedAt = new Date();
              await PayrollIncentiveAllocation.updateOne(
                { _id: allocation._id, organizationId, status: "approved" },
                {
                  $set: { status: "released", paymentId: null },
                  $push: {
                    history: {
                      action: "released",
                      actorId: userId,
                      occurredAt: releasedAt,
                      payrollRecordId: existingRecord._id,
                    },
                  },
                },
                options,
              );
            }
            const reopened = await PayrollRecord.findOneAndUpdate(
              {
                _id: existingRecord._id,
                organizationId,
                status: "approved",
                manualPaymentStatus: { $in: ["none", "failed"] },
              },
              {
                $set: {
                  status: "draft",
                  manualPaymentStatus: "none",
                  manualPaymentId: null,
                  manualPaymentAmountInPaise: null,
                  paymentMethod: null,
                  paymentReference: null,
                  approvedBy: null,
                  approvedAt: null,
                  updatedBy: userId,
                },
              },
              { new: true, ...options },
            );
            if (!reopened) {
              throw new AppError("Approved payroll changed before recalculation", 409);
            }
          });
        }
      }

      const approvedIncentiveEvaluations = await IncentiveEvaluation.find({
        organizationId,
        staffId: staff._id,
        monthYear: period.monthYear,
        evaluationType: "ATTENDANCE_BONUS",
        status: "finalized",
        bonusAwardedInPaise: { $gt: 0 },
        ...branchCondition(branchId),
      }).select("_id bonusAwardedInPaise").lean();
      const attendanceIncentiveAmountInPaise = approvedIncentiveEvaluations.reduce(
        (total, evaluation) => total + evaluation.bonusAwardedInPaise,
        0,
      );
      if (!Number.isSafeInteger(attendanceIncentiveAmountInPaise)) {
        throw new AppError("Finalized incentive total exceeds the safe paise limit", 400);
      }
      const incentiveEvaluationIds = approvedIncentiveEvaluations.map(
        (evaluation) => evaluation._id,
      );
      const commissionLedger = await getCommissionLedgerSnapshot({
        organizationId,
        staffId: staff._id,
        branchId,
        startDate: period.startDate,
        endDate: period.endDate,
      });
      const incentiveLedgerAmountInPaise = commissionLedger.payableAmountInPaise;
      const incentiveAmountInPaise =
        attendanceIncentiveAmountInPaise + incentiveLedgerAmountInPaise;
      if (!Number.isSafeInteger(incentiveAmountInPaise)) {
        throw new AppError("Finalized incentive total exceeds the safe paise limit", 400);
      }

      // 2. Fetch Effective Salary Structure
      const salaryStructure = await this.getEffectiveSalaryStructure({
        organizationId,
        staffId: staff._id,
        date: period.endDate,
      });

      if (!salaryStructure) {
        // Staff has no salary structure configured; skip or flag
        continue;
      }

      // 3. Calendar Proration: check joiningDate
      const joiningDate = new Date(staff.joiningDate);
      let eligibleDays = period.totalDays;

      if (joiningDate > period.startDate && joiningDate <= period.endDate) {
        // Joined mid-month: calendar days from joining date to end of month
        const joiningDay = joiningDate.getUTCDate();
        eligibleDays = period.totalDays - joiningDay + 1;
      } else if (joiningDate > period.endDate) {
        // Not yet joined in this period
        eligibleDays = 0;
      }

      const prorationFactor = Number((eligibleDays / period.totalDays).toFixed(6));

      // 4. Ingest Attendance for Period
      const attendanceRecords = await Attendance.find({
        organizationId,
        staffId: staff._id,
        attendanceDate: { $gte: period.startDate, $lte: period.endDate },
        isDeleted: false,
      });
      const branchAttendanceConflicts = await AttendanceBranchConflict.find({
        organizationId,
        staffId: staff._id,
        date: { $gte: period.startDate, $lte: period.endDate },
        conflictStatus: { $in: ["pending", "disputed"] },
        isActive: { $ne: false },
      }).select("_id").lean();

      let presentDays = 0;
      let lateDays = 0;
      let earlyDepartureDays = 0;
      let incompleteDays = 0;
      let unresolvedConflicts = branchAttendanceConflicts.length;

      // Map of attendance by YYYY-MM-DD
      const attendanceMap = new Map();

      for (const att of attendanceRecords) {
        const attDateKey = new Date(att.attendanceDate).toISOString().slice(0, 10);
        attendanceMap.set(attDateKey, att);

        if (att.status === "present") presentDays++;
        else if (att.status === "late") {
          presentDays++;
          lateDays++;
        } else if (att.status === "early_departure") {
          presentDays++;
          earlyDepartureDays++;
        } else if (att.status === "incomplete") {
          incompleteDays++;
        }

        if (att.conflictType && att.conflictType !== "none" && !att.isReconciled) {
          unresolvedConflicts++;
        }
      }

      // 5. Ingest Leaves for Period & Entitlement Consumption
      // Fetch leave entitlement from effective salary structure
      const annualEntitlement = Number(salaryStructure.paidLeavePolicy?.annualEntitlement || 0);
      const carryForwardDays = Number(salaryStructure.paidLeavePolicy?.carryForwardDays || 0);
      const totalEntitlement = annualEntitlement + carryForwardDays;

      // Determine Leave Year boundary (Calendar year of the period: Jan 1 to Dec 31)
      const periodYear = period.year;
      const leaveYearStart = new Date(Date.UTC(periodYear, 0, 1, 0, 0, 0, 0));
      const leaveYearEnd = new Date(Date.UTC(periodYear, 11, 31, 23, 59, 59, 999));

      // Fetch all approved leaves for this staff in this leave year prior to the current period's start date
      const priorApprovedLeaves = await Leave.find({
        organizationId,
        staffId: staff._id,
        status: "approved",
        isDeleted: false,
        startDate: { $gte: leaveYearStart, $lt: period.startDate },
      }).sort({ startDate: 1 });

      let previouslyConsumedPaidLeave = 0;
      for (const priorLeave of priorApprovedLeaves) {
        const isExplicitUnpaid =
          priorLeave.isUnpaid === true ||
          (typeof priorLeave.leaveType === "string" &&
            (priorLeave.leaveType.toLowerCase().includes("unpaid") ||
              priorLeave.leaveType.toLowerCase().includes("lop")));

        if (!isExplicitUnpaid) {
          let count = priorLeave.dates?.length || 0;
          if (count === 0) {
            const startMidnight = Date.UTC(
              new Date(priorLeave.startDate).getUTCFullYear(),
              new Date(priorLeave.startDate).getUTCMonth(),
              new Date(priorLeave.startDate).getUTCDate()
            );
            const endMidnight = Date.UTC(
              new Date(priorLeave.endDate).getUTCFullYear(),
              new Date(priorLeave.endDate).getUTCMonth(),
              new Date(priorLeave.endDate).getUTCDate()
            );
            count = Math.floor((endMidnight - startMidnight) / (1000 * 60 * 60 * 24)) + 1;
          }
          if (priorLeave.isPartialDay === true) {
            count = 0.5;
          }

          // Consume up to total entitlement
          const allocatable = Math.min(count, Math.max(0, totalEntitlement - previouslyConsumedPaidLeave));
          previouslyConsumedPaidLeave += allocatable;
        }
      }

      // Remaining entitlement available for current period
      let remainingEntitlement = Math.max(0, totalEntitlement - previouslyConsumedPaidLeave);

      const leaveRecords = await Leave.find({
        organizationId,
        staffId: staff._id,
        status: "approved",
        startDate: { $lte: period.endDate },
        endDate: { $gte: period.startDate },
        isDeleted: false,
      }).sort({ startDate: 1 });

      let paidLeaveDays = 0;
      let unpaidLeaveDays = 0;

      for (const leave of leaveRecords) {
        // Enumerate discrete dates within this payroll period
        const lStart = new Date(Math.max(new Date(leave.startDate).getTime(), period.startDate.getTime()));
        const lEnd = new Date(Math.min(new Date(leave.endDate).getTime(), period.endDate.getTime()));

        const discreteDates = [];
        const curDate = new Date(Date.UTC(lStart.getUTCFullYear(), lStart.getUTCMonth(), lStart.getUTCDate()));
        const endDateUtc = new Date(Date.UTC(lEnd.getUTCFullYear(), lEnd.getUTCMonth(), lEnd.getUTCDate()));

        while (curDate <= endDateUtc) {
          discreteDates.push(curDate.toISOString().slice(0, 10));
          curDate.setUTCDate(curDate.getUTCDate() + 1);
        }

        const isExplicitUnpaid =
          leave.isUnpaid === true ||
          (typeof leave.leaveType === "string" &&
            (leave.leaveType.toLowerCase().includes("unpaid") ||
              leave.leaveType.toLowerCase().includes("lop")));

        for (const dateKey of discreteDates) {
          // Check if employee has attendance on the same date to avoid double counting
          const attOnDate = attendanceMap.get(dateKey);
          let leaveDayWeight = leave.isPartialDay === true ? 0.5 : 1.0;

          if (attOnDate && ["present", "late", "early_departure"].includes(attOnDate.status)) {
            // Already counted present for full day; cannot double-claim full day as paid leave
            // If leave is half-day and present is half-day, capped at 1.0 total
            if (leaveDayWeight >= 1.0) {
              continue; // Skip double counting full presence + full leave on same day
            }
          }

          if (isExplicitUnpaid) {
            unpaidLeaveDays += leaveDayWeight;
          } else {
            // Check remaining paid entitlement
            if (remainingEntitlement >= leaveDayWeight) {
              paidLeaveDays += leaveDayWeight;
              remainingEntitlement -= leaveDayWeight;
            } else if (remainingEntitlement > 0) {
              // Partial exhaustion (e.g. 0.5 paid, 0.5 unpaid)
              const paidPart = remainingEntitlement;
              const unpaidPart = leaveDayWeight - remainingEntitlement;
              paidLeaveDays += paidPart;
              unpaidLeaveDays += unpaidPart;
              remainingEntitlement = 0;
            } else {
              // Entitlement exhausted -> becomes unpaid leave
              unpaidLeaveDays += leaveDayWeight;
            }
          }
        }
      }

      // 6. Blockers verification
      const approvalBlockReasons = [];
      if (incompleteDays > 0) {
        approvalBlockReasons.push(
          `Staff has ${incompleteDays} incomplete attendance record(s)`
        );
      }
      if (unresolvedConflicts > 0) {
        approvalBlockReasons.push(
          `Staff has ${unresolvedConflicts} unresolved attendance conflict(s)`
        );
      }

      const approvalBlocked = approvalBlockReasons.length > 0;

      // 7. Financial Calculations (Attendance-driven salary calculation)
      // Daily Rate = Monthly Base Salary / Authoritative Payroll Period Denominator (period.totalDays)
      const dailyBaseRate = salaryStructure.baseSalary / period.totalDays;

      // Payable Days = Verified Present Days + Eligible Approved Paid Leave Days
      const payableDays = Number((presentDays + paidLeaveDays).toFixed(2));
      const proratedBaseSalary = Number((dailyBaseRate * payableDays).toFixed(2));

      // For backward compatibility and historical snapshots, grossBaseSalary represents payable base
      const grossBaseSalary = proratedBaseSalary;

      const totalAllowances = Number(
        salaryStructure.allowances
          .reduce((sum, item) => sum + item.amount, 0)
          .toFixed(2)
      );

      const totalGrossPay = Number((grossBaseSalary + totalAllowances).toFixed(2));

      // Unpaid leave deduction (informational audit figure)
      const unpaidLeaveDeduction = Number(
        (dailyBaseRate * unpaidLeaveDays).toFixed(2)
      );

      const fixedDeductions = Number(
        salaryStructure.deductions
          .reduce((sum, item) => sum + item.amount, 0)
          .toFixed(2)
      );

      const totalDeductions = Number(fixedDeductions.toFixed(2));

      const netPayable = Math.max(0, Number((totalGrossPay - totalDeductions).toFixed(2)));

      // Check if existing record has adjustments to preserve across recalculation
      const existingDraftRecord = await PayrollRecord.findOne({
        organizationId,
        staffId: staff._id,
        monthYear: period.monthYear,
        status: { $in: ["draft", "pending_approval"] },
        isDeleted: false,
      });

      const existingAdjustments = existingDraftRecord?.adjustments || [];
      const totalAdjEarning = Number(
        existingAdjustments
          .filter((a) => a.type === "earning")
          .reduce((sum, a) => sum + a.amount, 0)
          .toFixed(2)
      );
      const totalAdjDeduction = Number(
        existingAdjustments
          .filter((a) => a.type === "deduction")
          .reduce((sum, a) => sum + a.amount, 0)
          .toFixed(2)
      );

      const finalTotalGrossPay = Number(
        (totalGrossPay + totalAdjEarning + incentiveAmountInPaise / 100).toFixed(2),
      );
      const finalTotalDeductions = Number((totalDeductions + totalAdjDeduction).toFixed(2));
      const finalNetPayable = Math.max(0, Number((finalTotalGrossPay - finalTotalDeductions).toFixed(2)));

      // 8. Upsert PayrollRecord atomically
      const recordData = {
        organizationId,
        branchId: assignedBranchId,
        payrollPeriodId: period._id,
        staffId: staff._id,
        monthYear: period.monthYear,
        status: "draft",
        salaryStructureSnapshot: {
          salaryStructureId: salaryStructure._id,
          payType: salaryStructure.payType,
          baseSalary: salaryStructure.baseSalary,
          hourlyRate: salaryStructure.hourlyRate,
          paidLeavePolicy: {
            annualEntitlement,
            carryForwardDays,
          },
          allowances: salaryStructure.allowances,
          deductions: salaryStructure.deductions,
        },
        attendanceSummarySnapshot: {
          totalDaysInMonth: period.totalDays,
          eligibleDays,
          presentDays,
          lateDays,
          earlyDepartureDays,
          incompleteDays,
          unresolvedConflicts,
          paidLeaveEntitlement: totalEntitlement,
          previouslyConsumedPaidLeave,
          paidLeaveDays,
          unpaidLeaveDays,
          absentDays: Math.max(
            0,
            eligibleDays - (presentDays + paidLeaveDays + unpaidLeaveDays)
          ),
          payableDays,
          sourceAttendanceRecordIds: attendanceRecords.map((a) => a._id),
          sourceLeaveRecordIds: leaveRecords.map((l) => l._id),
        },
        incentiveEvaluationIds,
        incentiveAmountInPaise,
        incentiveLedgerScopeBranchId: branchId || null,
        incentiveLedgerEntries: commissionLedger.entries,
        incentiveLedgerEntryIds: commissionLedger.ledgerEntryIds,
        incentiveLedgerClawbackEntryIds: commissionLedger.clawbackEntryIds,
        incentiveLedgerGrossInPaise: commissionLedger.grossAmountInPaise,
        incentiveLedgerClawbackInPaise: commissionLedger.clawbackAmountInPaise,
        incentiveLedgerAmountInPaise,
        calculations: {
          prorationFactor,
          dailySalaryRate: Number(dailyBaseRate.toFixed(4)),
          payableDays,
          proratedBaseSalary,
          grossBaseSalary,
          totalAllowances,
          totalGrossPay: finalTotalGrossPay,
          unpaidLeaveDeduction,
          fixedDeductions,
          totalAdjustmentsEarning: totalAdjEarning,
          totalAdjustmentsDeduction: totalAdjDeduction,
          totalIncentivesInPaise: incentiveAmountInPaise,
          totalDeductions: finalTotalDeductions,
          netPayable: finalNetPayable,
        },
        adjustments: existingAdjustments,
        approvalBlocked,
        approvalBlockReasons,
        updatedBy: userId,
      };

      const record = await PayrollRecord.findOneAndUpdate(
        {
          organizationId,
          staffId: staff._id,
          monthYear: period.monthYear,
          status: { $in: ["draft", "pending_approval"] },
          isDeleted: false,
        },
        {
          $set: recordData,
          $setOnInsert: { createdBy: userId },
        },
        { upsert: true, new: true }
      );

      calculatedRecords.push(record);
    }

    return calculatedRecords;
  }

  /**
   * Add manual adjustment to a draft payroll record
   */
  static async addAdjustment({
    organizationId,
    branchId,
    recordId,
    type,
    amount,
    reason,
    reference,
    userId,
  }) {
    const record = await PayrollRecord.findOne({
      _id: recordId,
      organizationId,
      isDeleted: false,
      ...branchCondition(branchId),
    });

    if (!record) {
      throw new AppError("Payroll record not found", 404);
    }

    if (record.status !== "draft") {
      throw new AppError(
        `Adjustments can only be added to 'draft' payroll records. Current status: '${record.status}'.`,
        400
      );
    }

    const adjustmentEntry = {
      type,
      amount: Number(amount),
      reason,
      reference: reference || null,
      createdBy: userId,
      createdAt: new Date(),
    };

    record.adjustments.push(adjustmentEntry);

    // Recalculate authoritative totals
    const totalAdjEarning = Number(
      record.adjustments
        .filter((a) => a.type === "earning")
        .reduce((sum, a) => sum + a.amount, 0)
        .toFixed(2)
    );
    const totalAdjDeduction = Number(
      record.adjustments
        .filter((a) => a.type === "deduction")
        .reduce((sum, a) => sum + a.amount, 0)
        .toFixed(2)
    );

    const baseGross = Number(
      (
        record.calculations.grossBaseSalary +
        record.calculations.totalAllowances +
        (record.incentiveAmountInPaise || 0) / 100
      ).toFixed(2)
    );
    const baseDeductions = Number(
      (record.calculations.unpaidLeaveDeduction + record.calculations.fixedDeductions).toFixed(2)
    );

    const finalGross = Number((baseGross + totalAdjEarning).toFixed(2));
    const finalDeductions = Number((baseDeductions + totalAdjDeduction).toFixed(2));
    const finalNet = Math.max(0, Number((finalGross - finalDeductions).toFixed(2)));

    record.calculations.totalAdjustmentsEarning = totalAdjEarning;
    record.calculations.totalAdjustmentsDeduction = totalAdjDeduction;
    record.calculations.totalGrossPay = finalGross;
    record.calculations.totalDeductions = finalDeductions;
    record.calculations.netPayable = finalNet;
    record.updatedBy = userId;

    await record.save();
    return record;
  }

  /**
   * Submit payroll for approval (moves draft -> pending_approval)
   */
  static async submitForApproval({ organizationId, branchId, recordId, userId }) {
    const record = await PayrollRecord.findOne({
      _id: recordId,
      organizationId,
      isDeleted: false,
      ...branchCondition(branchId),
    });

    if (!record) {
      throw new AppError("Payroll record not found", 404);
    }

    if (record.status !== "draft") {
      throw new AppError(
        `Cannot submit record with status '${record.status}'. Must be 'draft'.`,
        400
      );
    }

    record.status = "pending_approval";
    record.updatedBy = userId;
    await record.save();

    return record;
  }

  /**
   * Approve a payroll record
   */
  static async approvePayrollRecord({ organizationId, branchId, recordId, userId }) {
    try {
      return await runInTransaction(async (session) => {
        const options = session ? { session } : {};
        const record = await PayrollRecord.findOne({
          _id: recordId,
          organizationId,
          isDeleted: false,
          ...branchCondition(branchId),
        }).session(session);
        if (!record) throw new AppError("Payroll record not found", 404);
        if (record.status !== "pending_approval" && record.status !== "draft") {
          throw new AppError(
            `Cannot approve record with status '${record.status}'. Record is already ${record.status}.`,
            400,
          );
        }
        if (record.approvalBlocked) {
          throw new AppError(
            `Cannot approve payroll: ${record.approvalBlockReasons.join("; ")}`,
            400,
          );
        }

        const finalizedIncentives = await IncentiveEvaluation.find({
          organizationId,
          staffId: record.staffId,
          monthYear: record.monthYear,
          evaluationType: "ATTENDANCE_BONUS",
          status: "finalized",
          bonusAwardedInPaise: { $gt: 0 },
          ...branchCondition(record.incentiveLedgerScopeBranchId),
        }).select("_id bonusAwardedInPaise").session(session).lean();
        const expectedEvaluationIds = finalizedIncentives
          .map((evaluation) => evaluation._id.toString())
          .sort();
        const recordedEvaluationIds = (record.incentiveEvaluationIds || [])
          .map((id) => id.toString())
          .sort();
        const attendanceAmountInPaise = finalizedIncentives.reduce(
          (total, evaluation) => total + evaluation.bonusAwardedInPaise,
          0,
        );
        const period = await PayrollPeriod.findOne({
          _id: record.payrollPeriodId,
          organizationId,
          isDeleted: false,
        }).session(session);
        if (!period) throw new AppError("Payroll period not found", 404);
        const commissionLedger = await getCommissionLedgerSnapshot({
          organizationId,
          staffId: record.staffId,
          branchId: record.incentiveLedgerScopeBranchId,
          startDate: period.startDate,
          endDate: period.endDate,
          session,
        });
        const expectedIncentiveAmount =
          attendanceAmountInPaise + commissionLedger.payableAmountInPaise;
        if (!Number.isSafeInteger(expectedIncentiveAmount)
          || expectedIncentiveAmount !== (record.incentiveAmountInPaise || 0)
          || expectedEvaluationIds.length !== recordedEvaluationIds.length
          || expectedEvaluationIds.some((id, index) => id !== recordedEvaluationIds[index])
          || !hasSameCommissionSnapshot(record, commissionLedger)) {
          throw new AppError(
            "Finalized incentives changed after payroll calculation. Recalculate payroll before approval.",
            409,
          );
        }

        for (const entry of commissionLedger.entries.filter(
          (snapshot) => snapshot.payableAmountInPaise > 0,
        )) {
          const existingAllocation = await PayrollIncentiveAllocation.findOne({
            organizationId,
            incentiveLedgerId: entry.ledgerEntryId,
          }).session(session);
          const occurredAt = new Date();
          if (existingAllocation) {
            if (existingAllocation.status !== "released") {
              throw new AppError("Commission ledger entry is already allocated to payroll", 409);
            }
            const reallocated = await PayrollIncentiveAllocation.findOneAndUpdate(
              { _id: existingAllocation._id, organizationId, status: "released" },
              {
                $set: {
                  staffId: record.staffId,
                  sourceBranchId: entry.sourceBranchId,
                  payrollBranchId: record.branchId,
                  payrollPeriodId: record.payrollPeriodId,
                  payrollRecordId: record._id,
                  sourceType: entry.sourceType,
                  sourceAmountInPaise: entry.sourceAmountInPaise,
                  reversedAmountInPaise: entry.clawbackAmountInPaise,
                  payableAmountInPaise: entry.payableAmountInPaise,
                  coveredClawbackLedgerIds: entry.clawbackLedgerEntryIds,
                  status: "approved",
                  paymentId: null,
                },
                $push: {
                  history: {
                    action: "approved",
                    actorId: userId,
                    occurredAt,
                    payrollRecordId: record._id,
                  },
                },
              },
              { new: true, ...options },
            );
            if (!reallocated) throw new AppError("Commission allocation changed concurrently", 409);
          } else {
            await PayrollIncentiveAllocation.create(
              [{
                organizationId,
                staffId: record.staffId,
                sourceBranchId: entry.sourceBranchId,
                payrollBranchId: record.branchId,
                payrollPeriodId: record.payrollPeriodId,
                payrollRecordId: record._id,
                incentiveLedgerId: entry.ledgerEntryId,
                sourceType: entry.sourceType,
                sourceAmountInPaise: entry.sourceAmountInPaise,
                reversedAmountInPaise: entry.clawbackAmountInPaise,
                payableAmountInPaise: entry.payableAmountInPaise,
                coveredClawbackLedgerIds: entry.clawbackLedgerEntryIds,
                status: "approved",
                history: [{
                  action: "approved",
                  actorId: userId,
                  occurredAt,
                  payrollRecordId: record._id,
                }],
              }],
              options,
            );
          }
        }

        const updated = await PayrollRecord.findOneAndUpdate(
          {
            _id: recordId,
            organizationId,
            status: { $in: ["draft", "pending_approval"] },
            approvalBlocked: false,
            ...branchCondition(branchId),
          },
          {
            $set: {
              status: "approved",
              approvedBy: userId,
              approvedAt: new Date(),
              updatedBy: userId,
            },
          },
          { new: true, ...options },
        );
        if (!updated) {
          throw new AppError("Approval failed: record was modified concurrently or is blocked", 409);
        }
        return updated;
      });
    } catch (error) {
      if (error?.code === 11000) {
        throw new AppError("Commission ledger entry is already allocated to another payroll record", 409);
      }
      throw error;
    }
  }

  /**
   * Record a manual payment attempt. Payroll stays approved until an authorized
   * user separately confirms that the settlement actually completed.
   */
  static async recordPayment({
    organizationId,
    branchId,
    recordId,
    userId,
    amountInPaise,
    paymentMethod,
    paymentReference,
    paymentDate,
    idempotencyKey,
  }) {
    if (!Number.isSafeInteger(amountInPaise) || amountInPaise <= 0) {
      throw new AppError("Payment amount must be a positive integer paise value", 400);
    }
    if (!["bank_transfer", "cash", "cheque", "upi"].includes(paymentMethod)) {
      throw new AppError("Unsupported payroll payment method", 400);
    }
    if (typeof paymentReference !== "string" || !paymentReference.trim()) {
      throw new AppError("A payment reference is required", 400);
    }
    if (!idempotencyKey || idempotencyKey.length < 8 || idempotencyKey.length > 128) {
      throw new AppError("A valid idempotency key is required", 400);
    }
    const parsedPaymentDate = new Date(paymentDate);
    if (Number.isNaN(parsedPaymentDate.getTime())) {
      throw new AppError("A valid payment date is required", 400);
    }
    const requestPayloadHash = hashPaymentRequest({
      amountInPaise,
      paymentMethod,
      paymentReference,
      paymentDate: parsedPaymentDate,
    });
    const paymentScope = {
      organizationId,
      idempotencyKey,
      ...branchCondition(branchId),
    };
    const existing = await PayrollPayment.findOne(paymentScope);
    if (existing) {
      if (existing.requestPayloadHash !== requestPayloadHash) {
        throw new AppError("Idempotency key was already used with different payment details", 409);
      }
      const record = await this.getPayrollRecordById({ organizationId, branchId, recordId });
      if (existing.payrollRecordId.toString() !== record._id.toString()) {
        throw new AppError("Idempotency key is already associated with another payroll record", 409);
      }
      return { record, payment: existing, isIdempotentReplay: true };
    }

    try {
      return await runInTransaction(async (session) => {
        const options = session ? { session } : {};
        const repeatedRequest = await PayrollPayment.findOne(paymentScope).session(session);
        if (repeatedRequest) {
          if (repeatedRequest.requestPayloadHash !== requestPayloadHash
            || repeatedRequest.payrollRecordId.toString() !== recordId.toString()) {
            throw new AppError("Idempotency key was already used with different payment details", 409);
          }
          const record = await PayrollRecord.findOne({
            _id: recordId,
            organizationId,
            isDeleted: false,
            ...branchCondition(branchId),
          }).session(session);
          if (!record) throw new AppError("Payroll record not found", 404);
          return { record, payment: repeatedRequest, isIdempotentReplay: true };
        }

        const record = await PayrollRecord.findOne({
          _id: recordId,
          organizationId,
          isDeleted: false,
          ...branchCondition(branchId),
        }).session(session);
        if (!record) throw new AppError("Payroll record not found", 404);
        if (record.status !== "approved") {
          throw new AppError(
            `Cannot record payment for record with status '${record.status}'. Record must be 'approved'.`,
            400,
          );
        }
        if (!["none", "failed"].includes(record.manualPaymentStatus)) {
          throw new AppError("A payment attempt is already awaiting confirmation", 409);
        }
        const expectedAmountInPaise = getNetPayableInPaise(record);
        const period = await PayrollPeriod.findOne({
          _id: record.payrollPeriodId,
          organizationId,
          isDeleted: false,
        }).session(session);
        if (!period) throw new AppError("Payroll period not found", 404);
        const currentCommissionLedger = await getCommissionLedgerSnapshot({
          organizationId,
          staffId: record.staffId,
          branchId: record.incentiveLedgerScopeBranchId,
          startDate: period.startDate,
          endDate: period.endDate,
          session,
        });
        if (!hasSameCommissionSnapshot(record, currentCommissionLedger)) {
          throw new AppError(
            "Commission ledger changed after approval. Recalculate and reapprove payroll before recording payment.",
            409,
          );
        }
        if (amountInPaise !== expectedAmountInPaise) {
          throw new AppError("Payment amount must equal the exact payroll payable amount", 400);
        }

        const recordedAt = new Date();
        const payment = new PayrollPayment({
          organizationId,
          branchId: record.branchId,
          payrollRecordId: record._id,
          staffId: record.staffId,
          source: "MANUAL",
          amountInPaise,
          paymentMethod,
          paymentReference: paymentReference.trim(),
          paymentDate: parsedPaymentDate,
          status: "recorded",
          idempotencyKey,
          requestPayloadHash,
          recordedBy: userId,
          recordedAt,
          incentiveEvaluationIds: record.incentiveEvaluationIds || [],
          incentiveAmountInPaise: record.incentiveAmountInPaise || 0,
          incentiveLedgerEntryIds: record.incentiveLedgerEntryIds || [],
          incentiveLedgerAmountInPaise: record.incentiveLedgerAmountInPaise || 0,
          history: [{ action: "recorded", actorId: userId, occurredAt: recordedAt }],
        });
        await payment.save(options);

        const availablePaymentStatus = record.manualPaymentStatus === "failed"
          ? [{ manualPaymentStatus: "failed" }]
          : [
            { manualPaymentStatus: "none" },
            { manualPaymentStatus: { $exists: false } },
          ];
        const updatedRecord = await PayrollRecord.findOneAndUpdate(
          {
            _id: recordId,
            organizationId,
            isDeleted: false,
            status: "approved",
            $or: availablePaymentStatus,
            ...branchCondition(branchId),
          },
          {
            $set: {
              manualPaymentStatus: "recorded",
              manualPaymentId: payment._id,
              manualPaymentAmountInPaise: amountInPaise,
              paymentMethod,
              paymentReference: payment.paymentReference,
              updatedBy: userId,
            },
          },
          { new: true, ...options },
        );
        if (!updatedRecord) {
          throw new AppError("Payroll record changed while recording the payment", 409);
        }
        return { record: updatedRecord, payment, isIdempotentReplay: false };
      });
    } catch (error) {
      if (error.code !== 11000) throw error;
      const duplicate = await PayrollPayment.findOne(paymentScope);
      if (!duplicate) throw error;
      if (duplicate.requestPayloadHash !== requestPayloadHash
        || duplicate.payrollRecordId.toString() !== recordId.toString()) {
        throw new AppError("Idempotency key was already used with different payment details", 409);
      }
      const record = await this.getPayrollRecordById({ organizationId, branchId, recordId });
      return { record, payment: duplicate, isIdempotentReplay: true };
    }
  }

  static async confirmPayment({ organizationId, branchId, recordId, paymentId, userId }) {
    return runInTransaction(async (session) => {
      const options = session ? { session } : {};
      const record = await PayrollRecord.findOne({
        _id: recordId,
        organizationId,
        isDeleted: false,
        ...branchCondition(branchId),
      }).session(session);
      if (!record) throw new AppError("Payroll record not found", 404);
      const payment = await PayrollPayment.findOne({
        _id: paymentId,
        organizationId,
        payrollRecordId: record._id,
        branchId: record.branchId,
      }).session(session);
      if (!payment) throw new AppError("Payroll payment attempt not found", 404);

      if (payment.status === "confirmed" && record.status === "paid"
        && record.manualPaymentId?.toString() === payment._id.toString()) {
        return { record, payment, isIdempotentReplay: true };
      }
      if (record.status !== "approved" || record.manualPaymentStatus !== "recorded"
        || record.manualPaymentId?.toString() !== payment._id.toString()
        || payment.status !== "recorded") {
        throw new AppError("Only the current recorded payment attempt can be confirmed", 409);
      }
      if (payment.amountInPaise !== getNetPayableInPaise(record)
        || record.manualPaymentAmountInPaise !== payment.amountInPaise) {
        throw new AppError("Recorded payment no longer matches the payroll payable amount", 409);
      }
      if (payment.incentiveLedgerAmountInPaise !== (record.incentiveLedgerAmountInPaise || 0)
        || JSON.stringify((payment.incentiveLedgerEntryIds || []).map((id) => id.toString()).sort())
          !== JSON.stringify((record.incentiveLedgerEntryIds || []).map((id) => id.toString()).sort())) {
        throw new AppError("Recorded payment incentive allocation no longer matches the approved payroll snapshot", 409);
      }

      const ledgerIds = record.incentiveLedgerEntries
        .filter((entry) => entry.payableAmountInPaise > 0)
        .map((entry) => entry.ledgerEntryId);
      const allocations = await PayrollIncentiveAllocation.find({
        organizationId,
        payrollRecordId: record._id,
        incentiveLedgerId: { $in: ledgerIds },
        status: "approved",
      }).session(session);
      if (allocations.length !== ledgerIds.length) {
        throw new AppError("Approved payroll is missing one or more commission allocations", 409);
      }

      const confirmedAt = new Date();
      const updatedPayment = await PayrollPayment.findOneAndUpdate(
        { _id: payment._id, organizationId, status: "recorded" },
        {
          $set: { status: "confirmed", confirmedBy: userId, confirmedAt },
          $push: { history: { action: "confirmed", actorId: userId, occurredAt: confirmedAt } },
        },
        { new: true, ...options },
      );
      if (!updatedPayment) throw new AppError("Payment attempt changed before confirmation", 409);

      const updatedRecord = await PayrollRecord.findOneAndUpdate(
        {
          _id: recordId,
          organizationId,
          status: "approved",
          manualPaymentStatus: "recorded",
          manualPaymentId: payment._id,
          ...branchCondition(branchId),
        },
        {
          $set: {
            status: "paid",
            manualPaymentStatus: "confirmed",
            disbursedAt: payment.paymentDate,
            disbursedBy: userId,
            updatedBy: userId,
          },
        },
        { new: true, ...options },
      );
      if (!updatedRecord) throw new AppError("Payroll record changed before payment confirmation", 409);
      for (const allocation of allocations) {
        const updatedAllocation = await PayrollIncentiveAllocation.findOneAndUpdate(
          {
            _id: allocation._id,
            organizationId,
            payrollRecordId: record._id,
            status: "approved",
          },
          {
            $set: { status: "paid", paymentId: payment._id },
            $push: {
              history: {
                action: "paid",
                actorId: userId,
                occurredAt: confirmedAt,
                payrollRecordId: record._id,
              },
            },
          },
          { new: true, ...options },
        );
        if (!updatedAllocation) {
          throw new AppError("Commission allocation changed before payment confirmation", 409);
        }
      }
      return { record: updatedRecord, payment: updatedPayment, isIdempotentReplay: false };
    });
  }

  static async failPayment({ organizationId, branchId, recordId, paymentId, userId, failureReason }) {
    const reason = typeof failureReason === "string" ? failureReason.trim() : "";
    if (reason.length < 3) throw new AppError("A failure reason of at least 3 characters is required", 400);
    return runInTransaction(async (session) => {
      const options = session ? { session } : {};
      const record = await PayrollRecord.findOne({
        _id: recordId,
        organizationId,
        isDeleted: false,
        ...branchCondition(branchId),
      }).session(session);
      if (!record) throw new AppError("Payroll record not found", 404);
      const payment = await PayrollPayment.findOne({
        _id: paymentId,
        organizationId,
        payrollRecordId: record._id,
        branchId: record.branchId,
      }).session(session);
      if (!payment) throw new AppError("Payroll payment attempt not found", 404);
      if (payment.status === "failed" && record.manualPaymentStatus === "failed") {
        return { record, payment, isIdempotentReplay: true };
      }
      if (record.status !== "approved" || record.manualPaymentStatus !== "recorded"
        || record.manualPaymentId?.toString() !== payment._id.toString()
        || payment.status !== "recorded") {
        throw new AppError("Only the current recorded payment attempt can be marked failed", 409);
      }

      const failedAt = new Date();
      const updatedPayment = await PayrollPayment.findOneAndUpdate(
        { _id: payment._id, organizationId, status: "recorded" },
        {
          $set: { status: "failed", failedBy: userId, failedAt, failureReason: reason },
          $push: { history: { action: "failed", actorId: userId, occurredAt: failedAt, reason } },
        },
        { new: true, ...options },
      );
      if (!updatedPayment) throw new AppError("Payment attempt changed before failure was recorded", 409);
      const updatedRecord = await PayrollRecord.findOneAndUpdate(
        {
          _id: recordId,
          organizationId,
          status: "approved",
          manualPaymentStatus: "recorded",
          manualPaymentId: payment._id,
          ...branchCondition(branchId),
        },
        { $set: { manualPaymentStatus: "failed", updatedBy: userId } },
        { new: true, ...options },
      );
      if (!updatedRecord) throw new AppError("Payroll record changed while recording payment failure", 409);
      return { record: updatedRecord, payment: updatedPayment, isIdempotentReplay: false };
    });
  }

  /**
   * Reverse a paid payroll record (Audited reversal)
   */
  static async reversePayment({
    organizationId,
    branchId,
    recordId,
    reversalReason,
    userId,
  }) {
    return runInTransaction(async (session) => {
      const options = session ? { session } : {};
      const record = await PayrollRecord.findOne({
        _id: recordId,
        organizationId,
        isDeleted: false,
        ...branchCondition(branchId),
      }).session(session);
      if (!record) throw new AppError("Payroll record not found", 404);
      if (record.status === "cancelled" && record.manualPaymentStatus === "reversed") {
        const payment = record.manualPaymentId
          ? await PayrollPayment.findOne({
            _id: record.manualPaymentId,
            organizationId,
            payrollRecordId: record._id,
          }).session(session)
          : null;
        if (payment?.reversalReason !== reversalReason) {
          throw new AppError("Payroll payment was already reversed with a different reason", 409);
        }
        return { record, payment, isIdempotentReplay: true };
      }
      if (record.status !== "paid") {
        throw new AppError(
          `Cannot reverse record with status '${record.status}'. Only 'paid' records can be reversed.`,
          400,
        );
      }

      const paidAllocations = await PayrollIncentiveAllocation.find({
        organizationId,
        payrollRecordId: record._id,
        status: "paid",
      }).session(session);
      if (paidAllocations.some(
        (allocation) => allocation.recoveredInPaise > 0 || allocation.reservedRecoveryInPaise > 0,
      )) {
        throw new AppError(
          "Reverse related manual recovery payments before reversing this payroll payment",
          409,
        );
      }

      let updatedPayment = null;
      if (record.manualPaymentId) {
        const payment = await PayrollPayment.findOne({
          _id: record.manualPaymentId,
          organizationId,
          payrollRecordId: record._id,
          status: "confirmed",
        }).session(session);
        if (!payment) throw new AppError("Confirmed payment audit record was not found", 409);
        const reversedAt = new Date();
        updatedPayment = await PayrollPayment.findOneAndUpdate(
          { _id: payment._id, organizationId, status: "confirmed" },
          {
            $set: {
              status: "reversed",
              reversedBy: userId,
              reversedAt,
              reversalReason,
            },
            $push: { history: { action: "reversed", actorId: userId, occurredAt: reversedAt, reason: reversalReason } },
          },
          { new: true, ...options },
        );
        if (!updatedPayment) throw new AppError("Payment attempt changed before reversal", 409);
      }

      const reversedRecord = await PayrollRecord.findOneAndUpdate(
        {
          _id: recordId,
          organizationId,
          status: "paid",
          ...branchCondition(branchId),
        },
        {
          $set: {
            status: "cancelled",
            reversalReason,
            reversedAt: new Date(),
            reversedBy: userId,
            ...(record.manualPaymentId ? { manualPaymentStatus: "reversed" } : {}),
            updatedBy: userId,
          },
        },
        { new: true, ...options },
      );
      if (!reversedRecord) throw new AppError("Payroll record changed before reversal", 409);
      for (const allocation of paidAllocations) {
        const releasedAt = new Date();
        const releasedAllocation = await PayrollIncentiveAllocation.findOneAndUpdate(
          {
            _id: allocation._id,
            organizationId,
            payrollRecordId: record._id,
            status: "paid",
            recoveredInPaise: 0,
            reservedRecoveryInPaise: 0,
          },
          {
            $set: { status: "released", paymentId: null },
            $push: {
              history: {
                action: "released",
                actorId: userId,
                occurredAt: releasedAt,
                payrollRecordId: record._id,
              },
            },
          },
          { new: true, ...options },
        );
        if (!releasedAllocation) {
          throw new AppError("Commission allocation changed before payroll reversal completed", 409);
        }
      }
      return { record: reversedRecord, payment: updatedPayment, isIdempotentReplay: false };
    });
  }

  /**
   * Query payroll records with branch and tenant filters, date range, search, and pagination
   */
  static async listPayrollRecords({
    organizationId,
    branchId,
    monthYear,
    startDate,
    endDate,
    status,
    staffId,
    search,
    page = 1,
    limit = 25,
    sortBy = "createdAt",
    sortOrder = "desc",
  }) {
    const query = { organizationId, isDeleted: false };

    if (branchId) query.branchId = branchId;
    if (monthYear) query.monthYear = monthYear;
    if (status && status !== "all") query.status = status;
    if (staffId) query.staffId = staffId;

    // Custom Date Range filter based on monthYear or createdAt boundaries
    if (startDate || endDate) {
      query.createdAt = {};
      if (startDate) query.createdAt.$gte = new Date(startDate);
      if (endDate) {
        const end = new Date(endDate);
        end.setUTCHours(23, 59, 59, 999);
        query.createdAt.$lte = end;
      }
    }

    // Search by staff name or staff code
    if (search && search.trim()) {
      const matchingStaff = await Staff.find({
        organizationId,
        $or: [
          { name: { $regex: search.trim(), $options: "i" } },
          { staffCode: { $regex: search.trim(), $options: "i" } },
        ],
      }).select("_id");

      const staffIds = matchingStaff.map((s) => s._id);
      query.staffId = { $in: staffIds };
    }

    const pageNum = Math.max(1, parseInt(page, 10) || 1);
    const limitNum = Math.min(100, Math.max(1, parseInt(limit, 10) || 25));
    const skip = (pageNum - 1) * limitNum;

    const sortObj = {};
    sortObj[sortBy] = sortOrder === "asc" ? 1 : -1;

    const [total, records, summaryAgg, blockedCount] = await Promise.all([
      PayrollRecord.countDocuments(query),
      PayrollRecord.find(query)
        .populate("staffId", "name email staffCode designation")
        .populate("branchId", "name code")
        .populate("adjustments.createdBy", "name email")
        .sort(sortObj)
        .skip(skip)
        .limit(limitNum),
      PayrollRecord.aggregate([
        { $match: query },
        {
          $group: {
            _id: null,
            totalGrossPay: { $sum: "$calculations.totalGrossPay" },
            totalDeductions: { $sum: "$calculations.totalDeductions" },
            totalNetPayable: { $sum: "$calculations.netPayable" },
            count: { $sum: 1 },
          },
        },
      ]),
      PayrollRecord.countDocuments({ ...query, approvalBlocked: true }),
    ]);

    const recordsWithPaymentHistory = await withPaymentHistory(records, organizationId);
    const kpiSummary = summaryAgg[0] || {
      totalGrossPay: 0,
      totalDeductions: 0,
      totalNetPayable: 0,
      count: 0,
    };

    return {
      records: recordsWithPaymentHistory,
      pagination: {
        page: pageNum,
        limit: limitNum,
        total,
        totalPages: Math.ceil(total / limitNum) || 1,
      },
      summary: {
        totalGrossPay: Number(kpiSummary.totalGrossPay.toFixed(2)),
        totalDeductions: Number(kpiSummary.totalDeductions.toFixed(2)),
        totalNetPayable: Number(kpiSummary.totalNetPayable.toFixed(2)),
        count: kpiSummary.count,
        blockedCount,
      },
    };
  }

  /**
   * Get single payslip / payroll record details
   */
  static async getPayrollRecordById({ organizationId, branchId, recordId }) {
    const record = await PayrollRecord.findOne({
      _id: recordId,
      organizationId,
      isDeleted: false,
      ...branchCondition(branchId),
    })
      .populate("staffId", "name email phone staffCode designation joiningDate")
      .populate("branchId", "name address code")
      .populate("approvedBy", "name email")
      .populate("disbursedBy", "name email");

    if (!record) {
      throw new AppError("Payroll record not found", 404);
    }

    const [recordWithPaymentHistory] = await withPaymentHistory([record], organizationId);
    return recordWithPaymentHistory;
  }
}
