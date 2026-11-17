import mongoose from "mongoose";
import { Attendance } from "../../models/attendance/attendance.model.js";
import { AttendanceLeaveException } from "../../models/attendance/AttendanceLeaveException.model.js";
import {
  AttendanceBranchConflict,
  AttendanceLeaveAppointmentConflict,
} from "../../models/attendance/AttendanceLeaveAppointmentConflict.model.js";
import { AttendancePunch } from "../../models/attendance/attendancePunch.model.js";
import { Branch } from "../../models/branches/branch.model.js";
import { IncentiveEvaluation } from "../../models/incentives/incentiveEvaluation.model.js";
import { IncentiveLedger } from "../../models/incentives/incentiveLedger.model.js";
import { IncentiveScheme } from "../../models/incentives/incentiveScheme.model.js";
import { Leave } from "../../models/leaves/leave.model.js";
import { Staff } from "../../models/staff/staff.model.js";
import { StaffBranch } from "../../models/staff/staffBranch.model.js";
import { appendOnlyWriteBoundaryService } from "./appendOnlyWriteBoundary.service.js";
import { IncentiveCalculationEngine } from "./incentiveCalculation.engine.js";
import { schemeAssignmentService } from "./schemeAssignment.service.js";
import { deriveBusinessDate, deriveStatus } from "../attendance/attendance.service.js";
import { AppError } from "../../utils/errors.js";
import { runInTransaction } from "../../utils/transaction.js";

const isValidMonthYear = (value) => /^\d{4}-(0[1-9]|1[0-2])$/.test(value);

const getMonthWindow = (monthYear) => {
  const [year, month] = monthYear.split("-").map(Number);
  const start = new Date(Date.UTC(year, month - 1, 1));
  const end = new Date(Date.UTC(year, month, 1));
  return { start, end, lastDay: new Date(end.getTime() - 1) };
};

const dayKey = (date) => new Date(date).toISOString().slice(0, 10);

const isLeaveDate = (leave, date) => {
  if (Array.isArray(leave.dates) && leave.dates.length > 0) {
    return leave.dates.includes(date);
  }
  const dayStart = new Date(`${date}T00:00:00.000Z`);
  const dayEnd = new Date(`${date}T23:59:59.999Z`);
  return leave.startDate <= dayEnd && leave.endDate >= dayStart;
};

const hasManagerReconciliation = (attendance) =>
  attendance.isReconciled === true &&
  typeof attendance.reconciliationReason === "string" &&
  attendance.reconciliationReason.trim().length >= 3 &&
  Boolean(attendance.reconciledBy) &&
  attendance.reconciledAt instanceof Date;

const verifiedAttendanceStatus = (attendance, punches) => {
  if (!["present", "late", "early_departure"].includes(attendance.status)) {
    return false;
  }
  if (hasManagerReconciliation(attendance)) return true;
  return attendance.status === "present" && deriveStatus(punches) === "present";
};

export class AttendanceBonusService {
  async compute({ organizationId, branchId, staffId, schemeId, monthYear }) {
    if (!isValidMonthYear(monthYear)) {
      throw new AppError("monthYear must use YYYY-MM format", 400);
    }

    return runInTransaction(async (session) => {
      const { start, end, lastDay } = getMonthWindow(monthYear);
      const branch = await Branch.findOne({
        _id: branchId,
        organizationId,
        isActive: true,
      }).session(session).lean();
      const staff = await Staff.findOne({
          _id: staffId,
          organizationId,
          status: "active",
          isDeleted: { $ne: true },
        }).session(session).lean();
      const staffBranch = await StaffBranch.findOne({
          organizationId,
          branchId,
          staffId,
          isActive: true,
        }).session(session).lean();
      const scheme = await IncentiveScheme.findOne({
        _id: schemeId,
        organizationId,
      }).session(session);

      if (!branch) throw new AppError("Active branch not found", 404);
      if (!staff || !staffBranch) throw new AppError("Active staff member not found in this branch", 404);
      if (
        !scheme ||
        scheme.status !== "active" ||
        !IncentiveCalculationEngine.supportsAttendanceBonusScheme(scheme)
      ) {
        throw new AppError("An active, valid attendance bonus scheme is required", 400);
      }

      const assignment = await schemeAssignmentService.resolveActiveAssignment({
        organizationId,
        staffId,
        branchId,
        calculationBasis: "ATTENDANCE_DAYS",
        effectiveDate: lastDay,
        session,
      });
      if (!assignment || assignment.schemeId.toString() !== schemeId.toString()) {
        throw new AppError("No active attendance scheme assignment covers this staff member and period", 409);
      }

      const currentMonth = deriveBusinessDate(new Date(), branch.timezone).slice(0, 7);
      if (monthYear >= currentMonth) {
        throw new AppError("Attendance incentives can only be evaluated for a closed month", 400);
      }

      const attendanceRecords = await Attendance.find({
          organizationId,
          branchId,
          staffId,
          attendanceDate: { $gte: start, $lt: end },
          isDeleted: { $ne: true },
        }).session(session).lean();
      const punches = await AttendancePunch.find({
          organizationId,
          branchId,
          staffId,
          punchAt: {
            $gte: new Date(start.getTime() - 24 * 60 * 60 * 1000),
            $lt: new Date(end.getTime() + 24 * 60 * 60 * 1000),
          },
          mappingStatus: "mapped",
          isDuplicate: { $ne: true },
          isDeleted: { $ne: true },
        }).session(session).lean();
      const conflicts = await AttendanceBranchConflict.find({
          organizationId,
          staffId,
          date: { $gte: start, $lt: end },
          conflictStatus: { $in: ["pending", "disputed"] },
          isActive: { $ne: false },
        }).session(session).lean();
      const leaves = await Leave.find({
          organizationId,
          branchId,
          staffId,
          status: "approved",
          isDeleted: { $ne: true },
          startDate: { $lt: end },
          endDate: { $gte: start },
        }).session(session).lean();

      const leaveIds = leaves.map((leave) => leave._id);
      let exceptions = [];
      let leaveAppointmentConflicts = [];
      if (leaveIds.length > 0) {
        exceptions = await AttendanceLeaveException.find({
              organizationId,
              leaveId: { $in: leaveIds },
              resolvedDate: { $gte: `${monthYear}-01`, $lt: dayKey(end) },
              isActive: true,
            }).session(session).lean();
        leaveAppointmentConflicts = await AttendanceLeaveAppointmentConflict.find({
              organizationId,
              leaveId: { $in: leaveIds },
              status: "pending",
              isActive: { $ne: false },
            }).session(session).lean();
      }
      const exceptionByKey = new Map(
        exceptions.map((exception) => [`${exception.leaveId}:${exception.resolvedDate}`, exception]),
      );
      const punchesByDate = new Map();
      for (const punch of punches) {
        const date = deriveBusinessDate(punch.punchAt, branch.timezone);
        const current = punchesByDate.get(date) || [];
        current.push(punch);
        punchesByDate.set(date, current);
      }

      const blockReasons = [];
      if (conflicts.length > 0) {
        blockReasons.push(`${conflicts.length} pending or disputed cross-branch attendance conflict(s)`);
      }
      if (leaveAppointmentConflicts.length > 0) {
        blockReasons.push(`${leaveAppointmentConflicts.length} unresolved approved-leave appointment conflict(s)`);
      }
      const unresolvedAttendanceConflicts = attendanceRecords.filter(
        (attendance) =>
          attendance.conflictType &&
          attendance.conflictType !== "none" &&
          attendance.isReconciled !== true,
      );
      if (unresolvedAttendanceConflicts.length > 0) {
        blockReasons.push(`${unresolvedAttendanceConflicts.length} unresolved attendance record conflict(s)`);
      }
      const days = [];
      const verifiedPunchIds = new Set();
      let achievedDays = 0;
      for (const attendance of attendanceRecords) {
        const date = dayKey(attendance.attendanceDate);
        const dayPunches = (punchesByDate.get(date) || []).sort(
          (left, right) => new Date(left.punchAt) - new Date(right.punchAt),
        );
        const verified = verifiedAttendanceStatus(attendance, dayPunches);
        const leaveForDay = leaves.filter((leave) => isLeaveDate(leave, date));
        const dayExceptions = leaveForDay
          .map((leave) => exceptionByKey.get(`${leave._id}:${date}`))
          .filter(Boolean);

        if (attendance.status === "incomplete") {
          blockReasons.push(`Attendance for ${date} is incomplete and requires reconciliation`);
        } else if (
          ["late", "early_departure"].includes(attendance.status) &&
          !hasManagerReconciliation(attendance)
        ) {
          blockReasons.push(`Attendance for ${date} requires an audited manager reconciliation`);
        } else if (
          ["present", "late", "early_departure"].includes(attendance.status) &&
          !verified
        ) {
          blockReasons.push(`Attendance for ${date} has no verified biometric or audited correction evidence`);
        }
        if (verified) dayPunches.forEach((punch) => verifiedPunchIds.add(punch._id.toString()));

        let creditedDays = 0;
        if (verified && leaveForDay.length === 0) {
          creditedDays = 1;
        } else if (verified && leaveForDay.length > 0) {
          const workedException = dayExceptions.some((exception) => exception.decision === "worked");
          const halfDayException = dayExceptions.some((exception) => exception.decision === "half-day");
          const partialDayLeave = leaveForDay.some((leave) => leave.isPartialDay === true);
          if (workedException) creditedDays = 1;
          else if (halfDayException || partialDayLeave) creditedDays = 0.5;
        }

        if (creditedDays > 0) {
          achievedDays += creditedDays;
        }
        days.push({
          date,
          status: attendance.status,
          creditedDays,
          attendanceRecordId: attendance._id,
          punchIds: creditedDays > 0 ? dayPunches.map((punch) => punch._id) : [],
          leaveIds: leaveForDay.map((leave) => leave._id),
          leaveExceptionIds: dayExceptions.map((exception) => exception._id),
        });
      }
      if (blockReasons.length > 0) {
        achievedDays = 0;
      }

      const attendanceCalculation = IncentiveCalculationEngine.calculateAttendanceBonus(
        scheme,
        achievedDays,
      );
      const isTargetMet = blockReasons.length === 0 && attendanceCalculation.isTargetMet;
      const bonusAwardedInPaise = isTargetMet
        ? attendanceCalculation.bonusAwardedInPaise
        : 0;
      let evaluation = await IncentiveEvaluation.findOne({
        organizationId,
        staffId,
        schemeId,
        monthYear,
      }).session(session);
      if (evaluation?.status === "finalized") {
        return evaluation;
      }

      const evaluationData = {
        organizationId,
        branchId,
        staffId,
        schemeId,
        monthYear,
        evaluationType: "ATTENDANCE_BONUS",
        targetDays: scheme.rules.minimumAttendanceDays,
        achievedDays,
        isTargetMet,
        bonusAwardedInPaise,
        status: "computed",
        blockReasons,
        attendanceSnapshot: {
          timezone: branch.timezone,
          sourceAttendanceRecordIds: attendanceRecords.map((record) => record._id),
          sourcePunchIds: [...verifiedPunchIds].map((id) => new mongoose.Types.ObjectId(id)),
          sourceLeaveRecordIds: leaves.map((leave) => leave._id),
          sourceLeaveExceptionIds: exceptions.map((exception) => exception._id),
          days,
        },
      };
      if (evaluation) {
        Object.assign(evaluation, evaluationData);
        await evaluation.save({ session });
      } else {
        [evaluation] = await IncentiveEvaluation.create([evaluationData], { session });
      }
      return evaluation;
    });
  }

  async finalize({ organizationId, branchId, evaluationId, userId }) {
    return runInTransaction(async (session) => {
      const evaluation = await IncentiveEvaluation.findOne({
        _id: evaluationId,
        organizationId,
        branchId,
      }).session(session);
      if (!evaluation) throw new AppError("Attendance incentive evaluation not found", 404);
      if (evaluation.status === "finalized") {
        const ledgerEntry = await IncentiveLedger.findOne({
          organizationId,
          evaluationId: evaluation._id,
          sourceType: "attendance_bonus",
          entryType: "ACCRUAL",
        }).session(session);
        return { evaluation, ledgerEntry };
      }
      if (evaluation.status !== "computed" || evaluation.blockReasons.length > 0) {
        throw new AppError("Attendance evaluation is blocked and cannot be finalized", 409);
      }

      const updated = await IncentiveEvaluation.findOneAndUpdate(
        { _id: evaluation._id, organizationId, branchId, status: "computed" },
        { $set: { status: "finalized", finalizedBy: userId, finalizedAt: new Date() } },
        { new: true, session, runValidators: true },
      );
      if (!updated) throw new AppError("Attendance evaluation changed concurrently", 409);

      let ledgerEntry = null;
      if (updated.bonusAwardedInPaise > 0) {
        ledgerEntry = await appendOnlyWriteBoundaryService.appendLedgerEntry(
          {
            branchId,
            staffId: updated.staffId,
            schemeId: updated.schemeId,
            entryType: "ACCRUAL",
            sourceType: "attendance_bonus",
            evaluationId: updated._id,
            fulfillmentStatus: "not_applicable",
            sourceRevenueInPaise: 0,
            attributedRevenueInPaise: 0,
            amountInPaise: updated.bonusAwardedInPaise,
            idempotencyKey: `ATTENDANCE_BONUS:${updated._id}`,
          },
          organizationId,
          { session },
        );
      }
      return { evaluation: updated, ledgerEntry };
    });
  }
}

export const attendanceBonusService = new AttendanceBonusService();
