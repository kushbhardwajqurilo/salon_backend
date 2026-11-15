import mongoose from "mongoose";
import { AppError } from "../../utils/errors.js";
import { SalaryStructure } from "../../models/payroll/salaryStructure.model.js";
import { PayrollPeriod } from "../../models/payroll/payrollPeriod.model.js";
import { PayrollRecord } from "../../models/payroll/payrollRecord.model.js";
import { Staff } from "../../models/staff/staff.model.js";
import { StaffBranch } from "../../models/staff/staffBranch.model.js";
import { Attendance } from "../../models/attendance/attendance.model.js";
import { Leave } from "../../models/leaves/leave.model.js";

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

export class PayrollService {
  /**
   * Create or update salary structure for a staff member
   */
  static async setSalaryStructure({
    organizationId,
    staffId,
    payType,
    baseSalary,
    hourlyRate,
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
  static async getEffectiveSalaryStructure({ organizationId, staffId, date }) {
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
  static async getSalaryStructureHistory({ organizationId, staffId }) {
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
      });

      if (existingRecord) {
        if (existingRecord.status === "approved" || existingRecord.status === "paid") {
          // Cannot recalculate approved or paid records
          continue;
        }
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

      let presentDays = 0;
      let lateDays = 0;
      let earlyDepartureDays = 0;
      let incompleteDays = 0;
      let unresolvedConflicts = 0;

      for (const att of attendanceRecords) {
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

      // 5. Ingest Leaves for Period
      const leaveRecords = await Leave.find({
        organizationId,
        staffId: staff._id,
        status: "approved",
        startDate: { $lte: period.endDate },
        endDate: { $gte: period.startDate },
        isDeleted: false,
      });

      let paidLeaveDays = 0;
      let unpaidLeaveDays = 0;

      for (const leave of leaveRecords) {
        // Count overlapping calendar days within this month
        const leaveStart = new Date(Math.max(new Date(leave.startDate), period.startDate));
        const leaveEnd = new Date(Math.min(new Date(leave.endDate), period.endDate));
        const leaveStartMidnight = Date.UTC(leaveStart.getUTCFullYear(), leaveStart.getUTCMonth(), leaveStart.getUTCDate());
        const leaveEndMidnight = Date.UTC(leaveEnd.getUTCFullYear(), leaveEnd.getUTCMonth(), leaveEnd.getUTCDate());
        let dayCount = Math.floor((leaveEndMidnight - leaveStartMidnight) / (1000 * 60 * 60 * 24)) + 1;

        // Honor partial-day (half-day) leave semantics from Leave model
        if (leave.isPartialDay === true) {
          dayCount = 0.5;
        }

        const isUnpaid =
          leave.isUnpaid === true ||
          (typeof leave.leaveType === "string" &&
            (leave.leaveType.toLowerCase().includes("unpaid") ||
              leave.leaveType.toLowerCase().includes("lop")));

        if (isUnpaid) {
          unpaidLeaveDays += dayCount;
        } else {
          paidLeaveDays += dayCount;
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

      // 7. Financial Calculations (Calendar-day proration)
      const dailyBaseRate = salaryStructure.baseSalary / period.totalDays;
      const grossBaseSalary = Number((dailyBaseRate * eligibleDays).toFixed(2));

      const totalAllowances = Number(
        salaryStructure.allowances
          .reduce((sum, item) => sum + item.amount, 0)
          .toFixed(2)
      );

      const totalGrossPay = Number((grossBaseSalary + totalAllowances).toFixed(2));

      // Unpaid leave deduction
      const unpaidLeaveDeduction = Number(
        (dailyBaseRate * unpaidLeaveDays).toFixed(2)
      );

      const fixedDeductions = Number(
        salaryStructure.deductions
          .reduce((sum, item) => sum + item.amount, 0)
          .toFixed(2)
      );

      const totalDeductions = Number(
        (unpaidLeaveDeduction + fixedDeductions).toFixed(2)
      );

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

      const finalTotalGrossPay = Number((totalGrossPay + totalAdjEarning).toFixed(2));
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
          paidLeaveDays,
          unpaidLeaveDays,
          absentDays: Math.max(
            0,
            eligibleDays - (presentDays + paidLeaveDays + unpaidLeaveDays)
          ),
          sourceAttendanceRecordIds: attendanceRecords.map((a) => a._id),
          sourceLeaveRecordIds: leaveRecords.map((l) => l._id),
        },
        calculations: {
          prorationFactor,
          grossBaseSalary,
          totalAllowances,
          totalGrossPay: finalTotalGrossPay,
          unpaidLeaveDeduction,
          fixedDeductions,
          totalAdjustmentsEarning: totalAdjEarning,
          totalAdjustmentsDeduction: totalAdjDeduction,
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
      (record.calculations.grossBaseSalary + record.calculations.totalAllowances).toFixed(2)
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
  static async submitForApproval({ organizationId, recordId, userId }) {
    const record = await PayrollRecord.findOne({
      _id: recordId,
      organizationId,
      isDeleted: false,
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
  static async approvePayrollRecord({ organizationId, recordId, userId }) {
    const record = await PayrollRecord.findOne({
      _id: recordId,
      organizationId,
      isDeleted: false,
    });

    if (!record) {
      throw new AppError("Payroll record not found", 404);
    }

    if (record.status !== "pending_approval" && record.status !== "draft") {
      throw new AppError(
        `Cannot approve record with status '${record.status}'. Record is already ${record.status}.`,
        400
      );
    }

    // Attendance blocker enforcement
    if (record.approvalBlocked) {
      throw new AppError(
        `Cannot approve payroll: ${record.approvalBlockReasons.join("; ")}`,
        400
      );
    }

    // Atomic update to prevent race conditions
    const updated = await PayrollRecord.findOneAndUpdate(
      {
        _id: recordId,
        organizationId,
        status: { $in: ["draft", "pending_approval"] },
        approvalBlocked: false,
      },
      {
        $set: {
          status: "approved",
          approvedBy: userId,
          approvedAt: new Date(),
          updatedBy: userId,
        },
      },
      { new: true }
    );

    if (!updated) {
      throw new AppError(
        "Approval failed: record was modified concurrently or is blocked",
        409
      );
    }

    return updated;
  }

  /**
   * Record payment for an approved payroll record
   */
  static async recordPayment({
    organizationId,
    recordId,
    paymentMethod,
    paymentReference,
    userId,
  }) {
    const record = await PayrollRecord.findOne({
      _id: recordId,
      organizationId,
      isDeleted: false,
    });

    if (!record) {
      throw new AppError("Payroll record not found", 404);
    }

    if (record.status !== "approved") {
      throw new AppError(
        `Cannot record payment for record with status '${record.status}'. Record must be 'approved'.`,
        400
      );
    }

    // Atomic update to guarantee single execution (idempotency guard)
    const paidRecord = await PayrollRecord.findOneAndUpdate(
      {
        _id: recordId,
        organizationId,
        status: "approved",
      },
      {
        $set: {
          status: "paid",
          paymentMethod,
          paymentReference,
          disbursedAt: new Date(),
          disbursedBy: userId,
          updatedBy: userId,
        },
      },
      { new: true }
    );

    if (!paidRecord) {
      throw new AppError(
        "Payment recording failed: record is not in approved status or was already paid.",
        409
      );
    }

    return paidRecord;
  }

  /**
   * Reverse a paid payroll record (Audited reversal)
   */
  static async reversePayment({
    organizationId,
    recordId,
    reversalReason,
    userId,
  }) {
    const record = await PayrollRecord.findOne({
      _id: recordId,
      organizationId,
      isDeleted: false,
    });

    if (!record) {
      throw new AppError("Payroll record not found", 404);
    }

    if (record.status !== "paid") {
      throw new AppError(
        `Cannot reverse record with status '${record.status}'. Only 'paid' records can be reversed.`,
        400
      );
    }

    const reversedRecord = await PayrollRecord.findOneAndUpdate(
      {
        _id: recordId,
        organizationId,
        status: "paid",
      },
      {
        $set: {
          status: "cancelled",
          reversalReason,
          reversedAt: new Date(),
          reversedBy: userId,
          updatedBy: userId,
        },
      },
      { new: true }
    );

    return reversedRecord;
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

    const kpiSummary = summaryAgg[0] || {
      totalGrossPay: 0,
      totalDeductions: 0,
      totalNetPayable: 0,
      count: 0,
    };

    return {
      records,
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
  static async getPayrollRecordById({ organizationId, recordId }) {
    const record = await PayrollRecord.findOne({
      _id: recordId,
      organizationId,
      isDeleted: false,
    })
      .populate("staffId", "name email phone staffCode designation joiningDate")
      .populate("branchId", "name address code")
      .populate("approvedBy", "name email")
      .populate("disbursedBy", "name email");

    if (!record) {
      throw new AppError("Payroll record not found", 404);
    }

    return record;
  }
}
