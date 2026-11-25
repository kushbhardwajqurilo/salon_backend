import mongoose from "mongoose";
import { Appointment } from "../../models/appointments/appointment.model.js";
import { Attendance } from "../../models/attendance/attendance.model.js";
import { AttendancePunch } from "../../models/attendance/attendancePunch.model.js";
import { Leave } from "../../models/leaves/leave.model.js";
import { Staff } from "../../models/staff/staff.model.js";
import { StaffBranch } from "../../models/staff/staffBranch.model.js";
import { Branch } from "../../models/branches/branch.model.js";
import { resolveTimezone, getUTCDayRange } from "../reports/reportCalculations.js";
import { logger } from "../../utils/logger.js";

export class DashboardOperationsService {
  /**
   * Retrieves today's operational data for command centre.
   */
  async getOperations(organizationId, branchId) {
    const timezone = await resolveTimezone(organizationId, branchId);

    // Get current local date in the branch's timezone
    const now = new Date();
    const formatter = new Intl.DateTimeFormat("en-CA", {
      timeZone: timezone,
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
    });
    const todayDateStr = formatter.format(now); // "YYYY-MM-DD"
    const { startUtc, endUtc } = getUTCDayRange(todayDateStr, timezone);

    let branchName = "All Branches";
    if (branchId) {
      const b = await Branch.findOne({ _id: branchId, organizationId }).select("name");
      if (b?.name) branchName = b.name;
    }

    const apptScope = {
      organizationId: new mongoose.Types.ObjectId(organizationId),
      isDeleted: { $ne: true },
      startAt: { $gte: startUtc, $lte: endUtc },
    };
    if (branchId) {
      apptScope.branchId = new mongoose.Types.ObjectId(branchId);
    }

    // 1. Fetch Today's Upcoming & In-Progress Appointments Timeline
    const appointmentsTimeline = await Appointment.find(apptScope)
      .sort({ startAt: 1 })
      .limit(20)
      .populate("customerId", "name phone email")
      .populate("staffId", "name designation")
      .lean();

    const formattedTimeline = appointmentsTimeline.map((appt) => ({
      id: appt._id.toString(),
      appointmentCode: appt.appointmentCode,
      customerName: appt.customerId?.name || "Walk-in Guest",
      customerPhone: appt.customerId?.phone || "",
      staffName: appt.staffId?.name || "Unassigned",
      staffId: appt.staffId?._id?.toString() || null,
      services: (appt.services || []).map((s) => ({
        name: s.name,
        duration: s.duration,
        price: s.price,
      })),
      startTime: appt.startTime,
      endTime: appt.endTime,
      startAt: appt.startAt,
      endAt: appt.endAt,
      status: appt.status,
      bookingType: appt.bookingType,
      pricing: appt.pricing,
    }));

    // 2. Staff Attendance, Leave & Roster Today
    // Determine active staff list for branch or organization
    let staffFilter = {
      organizationId: new mongoose.Types.ObjectId(organizationId),
      isActive: true,
    };
    if (branchId) {
      staffFilter.branchId = new mongoose.Types.ObjectId(branchId);
    }

    const activeStaffBranches = await StaffBranch.find(staffFilter)
      .populate("staffId", "name staffCode designation status")
      .lean();

    const branchStaff = activeStaffBranches
      .map((sb) => sb.staffId)
      .filter((s) => s && s.status === "active");

    const staffIds = branchStaff.map((s) => s._id);

    // Fetch today's attendance records
    const attendanceScope = {
      organizationId: new mongoose.Types.ObjectId(organizationId),
      staffId: { $in: staffIds },
      attendanceDate: { $gte: startUtc, $lte: endUtc },
      isDeleted: { $ne: true },
    };
    if (branchId) {
      attendanceScope.branchId = new mongoose.Types.ObjectId(branchId);
    }

    const todayAttendances = await Attendance.find(attendanceScope).lean();

    // Fetch today's approved leaves
    const todayLeaves = await Leave.find({
      organizationId: new mongoose.Types.ObjectId(organizationId),
      staffId: { $in: staffIds },
      status: "approved",
      isDeleted: { $ne: true },
      dates: todayDateStr,
    }).lean();

    // Fetch today's raw punches to detect live clock-in status
    const todayPunches = await AttendancePunch.find({
      organizationId: new mongoose.Types.ObjectId(organizationId),
      staffId: { $in: staffIds },
      punchAt: { $gte: startUtc, $lte: endUtc },
      isDeleted: { $ne: true },
    })
      .sort({ punchAt: 1 })
      .lean();

    // Group punches by staffId to find latest punch
    const latestPunchByStaff = {};
    todayPunches.forEach((p) => {
      latestPunchByStaff[p.staffId.toString()] = p.punchType; // 'in' or 'out'
    });

    const attendanceByStaff = {};
    todayAttendances.forEach((a) => {
      attendanceByStaff[a.staffId.toString()] = a;
    });

    const leaveByStaff = {};
    todayLeaves.forEach((l) => {
      leaveByStaff[l.staffId.toString()] = l;
    });

    // Detect currently ongoing appointments to map in-service staff
    const ongoingApptScope = {
      organizationId: new mongoose.Types.ObjectId(organizationId),
      staffId: { $in: staffIds },
      status: { $in: ["in_progress", "scheduled"] },
      startAt: { $lte: now },
      endAt: { $gte: now },
      isDeleted: { $ne: true },
    };
    if (branchId) {
      ongoingApptScope.branchId = new mongoose.Types.ObjectId(branchId);
    }
    const ongoingAppts = await Appointment.find(ongoingApptScope).lean();

    const ongoingApptByStaff = {};
    ongoingAppts.forEach((oa) => {
      if (oa.staffId) {
        ongoingApptByStaff[oa.staffId.toString()] = oa;
      }
    });

    let presentCount = 0;
    let lateCount = 0;
    let onLeaveCount = 0;
    let clockedInNowCount = 0;

    const roster = branchStaff.map((staff) => {
      const sId = staff._id.toString();
      const att = attendanceByStaff[sId];
      const leave = leaveByStaff[sId];
      const latestPunch = latestPunchByStaff[sId];
      const isClockedIn = latestPunch === "in";
      const ongoing = ongoingApptByStaff[sId];

      let operationalStatus = "absent";
      if (leave) {
        operationalStatus = "on_leave";
        onLeaveCount++;
      } else if (att) {
        operationalStatus = att.status; // 'present', 'late', 'early_departure', 'incomplete'
        if (att.status === "late") lateCount++;
        if (["present", "late", "early_departure"].includes(att.status)) {
          presentCount++;
        }
      }

      if (isClockedIn) {
        clockedInNowCount++;
      }

      return {
        staffId: sId,
        staffName: staff.name,
        staffCode: staff.staffCode,
        designation: staff.designation,
        statusToday: operationalStatus,
        isClockedIn,
        currentAppointment: ongoing
          ? {
              appointmentCode: ongoing.appointmentCode,
              startTime: ongoing.startTime,
              endTime: ongoing.endTime,
              status: ongoing.status,
            }
          : null,
      };
    });

    const totalStaff = branchStaff.length;
    // Floor Available: Active staff present today, not on approved leave, clocked in (if branch records punches), and not currently in-service
    const availableStaffCount = roster.filter((staff) => {
      if (staff.statusToday === "on_leave" || staff.statusToday === "absent") return false;
      if (staff.currentAppointment) return false;
      if (todayPunches.length > 0 && !staff.isClockedIn) return false;
      return ["present", "late", "early_departure"].includes(staff.statusToday);
    }).length;

    // 3. Pending Operational Tasks
    const [pendingLeavesCount, unreconciledAttendanceCount] = await Promise.all([
      Leave.countDocuments({
        organizationId: new mongoose.Types.ObjectId(organizationId),
        ...(branchId ? { staffId: { $in: staffIds } } : {}),
        status: "pending",
        isDeleted: { $ne: true },
      }),
      Attendance.countDocuments({
        organizationId: new mongoose.Types.ObjectId(organizationId),
        ...(branchId ? { branchId: new mongoose.Types.ObjectId(branchId) } : {}),
        attendanceDate: { $lte: endUtc },
        isReconciled: false,
        conflictType: { $ne: "none" },
        isDeleted: { $ne: true },
      }),
    ]);

    return {
      success: true,
      meta: {
        organizationId: organizationId.toString(),
        branchId: branchId ? branchId.toString() : null,
        branchName,
        timezone,
        date: todayDateStr,
        generatedAt: now.toISOString(),
      },
      summary: {
        todayAppointmentsCount: formattedTimeline.length,
        totalBranchStaff: totalStaff,
        presentStaffCount: presentCount,
        lateStaffCount: lateCount,
        onLeaveStaffCount: onLeaveCount,
        clockedInNowCount,
        availableStaffCount,
      },
      appointmentsTimeline: formattedTimeline,
      staffRoster: roster,
      pendingTasks: {
        pendingLeavesCount,
        unreconciledAttendanceCount,
      },
    };
  }
}
