import { Attendance } from "../../models/attendance/attendance.model.js";
import { AttendancePunch } from "../../models/attendance/attendancePunch.model.js";
import { StaffDeviceMapping } from "../../models/attendance/StaffDeviceMapping.model.js";
import { ProviderConfiguration } from "../../models/attendance/ProviderConfiguration.model.js";
import { encryptCredentials, decryptCredentials } from "../../utils/encryption.js";
import { RawProviderEvent } from "../../models/attendance/RawProviderEvent.model.js";
import { ProviderSyncState } from "../../models/attendance/ProviderSyncState.model.js";
import { ProviderDeliveryLog } from "../../models/attendance/ProviderDeliveryLog.model.js";
import { AttendanceLeaveException } from "../../models/attendance/AttendanceLeaveException.model.js";
import {
  AttendanceBranchConflict,
  AttendanceLeaveAppointmentConflict,
} from "../../models/attendance/AttendanceLeaveAppointmentConflict.model.js";
import { Branch } from "../../models/branches/branch.model.js";
import { Staff } from "../../models/staff/staff.model.js";
import { StaffBranch } from "../../models/staff/staffBranch.model.js";
import { Leave } from "../../models/leaves/leave.model.js";
import { StaffRoster } from "../../models/staff/staffRoster.model.js";
import { CalendarResolverService } from "../holidays/calendarResolver.service.js";
import { SettingsResolverService } from "../settings/settingsResolver.service.js";
import { Appointment } from "../../models/appointments/appointment.model.js";
import { AuditLog } from "../../models/audit/auditLog.model.js";
import providerRegistry from "../../providers/attendance/provider.registry.js";
import { AppError } from "../../utils/errors.js";
import { emitAttendanceOutboxEvent } from "./attendanceNotificationOutbox.service.js";
import { logger } from "../../utils/logger.js";
import {
  runInTransaction,
  isTransactionSupported,
} from "../../utils/transaction.js";

const ATTENDANCE_STATUSES = [
  "present",
  "late",
  "early_departure",
  "incomplete",
  "absent",
];

function assertDateOnly(value) {
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(value)) {
    throw new AppError(
      "A valid attendance date in YYYY-MM-DD format is required.",
      400,
    );
  }
  const parsed = new Date(`${value}T00:00:00.000Z`);
  if (
    !Number.isFinite(parsed.getTime()) ||
    parsed.toISOString().slice(0, 10) !== value
  ) {
    throw new AppError("Attendance date is invalid.", 400);
  }
  return value;
}

function escapeRegex(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function dateWindow(date) {
  const start = new Date(`${date}T00:00:00.000Z`);
  return { start, end: new Date(start.getTime() + 24 * 60 * 60 * 1000) };
}

function leaveDateCondition(date) {
  const { start, end } = dateWindow(date);
  return {
    $or: [
      { dates: date },
      {
        dates: { $size: 0 },
        startDate: { $lt: end },
        endDate: { $gte: start },
      },
    ],
  };
}

async function getActiveBranch(organizationId, branchId) {
  const branch = await Branch.findOne({
    _id: branchId,
    organizationId,
    isActive: true,
  });
  if (!branch) throw new AppError("Active branch was not found.", 404);
  return branch;
}

async function listAttendanceRecords({
  organizationId,
  branchId,
  date,
  search,
  status,
}) {
  const attendanceDate = assertDateOnly(date);
  const branch = await getActiveBranch(organizationId, branchId);
  const staffLinks = await StaffBranch.find({
    organizationId,
    branchId,
    isActive: true,
  })
    .select("staffId")
    .lean();
  const staffIds = staffLinks.map(({ staffId }) => staffId);
  const staffFilter = {
    _id: { $in: staffIds },
    organizationId,
    isDeleted: { $ne: true },
    status: "active",
  };
  if (search?.trim()) {
    const matcher = new RegExp(escapeRegex(search.trim()), "i");
    staffFilter.$or = [
      { name: matcher },
      { email: matcher },
      { staffCode: matcher },
      { designation: matcher },
    ];
  }
  const staff = await Staff.find(staffFilter)
    .select("name staffCode email designation status")
    .sort({ name: 1 })
    .lean();
  const staffById = new Map(
    staff.map((person) => [person._id.toString(), person]),
  );
  const ids = staff.map(({ _id }) => _id);
  const records = ids.length
    ? await Attendance.find({
        organizationId,
        branchId,
        staffId: { $in: ids },
        attendanceDate: new Date(`${attendanceDate}T00:00:00.000Z`),
        isDeleted: { $ne: true },
      }).lean()
    : [];
  const recordByStaff = new Map(
    records.map((record) => [record.staffId.toString(), record]),
  );
  const { start, end } = dateWindow(attendanceDate);
  const punches = ids.length
    ? await AttendancePunch.find({
        organizationId,
        branchId,
        staffId: { $in: ids },
        punchAt: {
          $gte: new Date(start.getTime() - 24 * 60 * 60 * 1000),
          $lt: new Date(end.getTime() + 24 * 60 * 60 * 1000),
        },
        isDeleted: { $ne: true },
      })
        .select("staffId punchType punchAt mappingStatus externalEventId")
        .sort({ punchAt: 1 })
        .lean()
    : [];
  const punchesByStaff = new Map();
  for (const punch of punches) {
    if (deriveBusinessDate(punch.punchAt, branch.timezone) !== attendanceDate)
      continue;
    const key = punch.staffId.toString();
    punchesByStaff.set(key, [...(punchesByStaff.get(key) || []), punch]);
  }
  const currentDate = deriveBusinessDate(new Date(), branch.timezone);
  const result = staff.map((person) => {
    const key = person._id.toString();
    const record = recordByStaff.get(key) || null;
    return {
      staff: person,
      record,
      punches: punchesByStaff.get(key) || [],
      status:
        record?.status ||
        (attendanceDate <= currentDate ? "missing_punch" : "not_started"),
    };
  });
  return {
    date: attendanceDate,
    timezone: branch.timezone,
    operatingHours: branch.operatingHours || null,
    data: status ? result.filter((item) => item.status === status) : result,
    total: status
      ? result.filter((item) => item.status === status).length
      : result.length,
  };
}

async function getStaffAttendanceDetail({
  organizationId,
  branchId,
  staffId,
  date,
}) {
  const attendanceDate = assertDateOnly(date);
  const branch = await getActiveBranch(organizationId, branchId);
  const staffLink = await StaffBranch.findOne({
    organizationId,
    branchId,
    staffId,
    isActive: true,
  });
  const staff =
    staffLink &&
    (await Staff.findOne({
      _id: staffId,
      organizationId,
      isDeleted: { $ne: true },
    })
      .select("name staffCode email designation status")
      .lean());
  if (!staff)
    throw new AppError("Staff member was not found in this branch.", 404);

  const { start, end } = dateWindow(attendanceDate);
  const [record, rawPunches, approvedLeaves] = await Promise.all([
    Attendance.findOne({
      organizationId,
      branchId,
      staffId,
      attendanceDate: start,
      isDeleted: { $ne: true },
    }).lean(),
    AttendancePunch.find({
      organizationId,
      branchId,
      staffId,
      punchAt: {
        $gte: new Date(start.getTime() - 24 * 60 * 60 * 1000),
        $lt: new Date(end.getTime() + 24 * 60 * 60 * 1000),
      },
      isDeleted: { $ne: true },
    })
      .sort({ punchAt: 1 })
      .lean(),
    Leave.find({
      organizationId,
      branchId,
      staffId,
      status: "approved",
      isDeleted: { $ne: true },
      ...leaveDateCondition(attendanceDate),
    })
      .select("leaveCode leaveType startDate endDate dates status")
      .lean(),
  ]);
  const punches = rawPunches.filter(
    (punch) =>
      deriveBusinessDate(punch.punchAt, branch.timezone) === attendanceDate,
  );
  const leaveIds = approvedLeaves.map(({ _id }) => _id);
  const exceptions = leaveIds.length
    ? await AttendanceLeaveException.find({
        organizationId,
        leaveId: { $in: leaveIds },
        resolvedDate: attendanceDate,
        isActive: true,
      }).lean()
    : [];
  const appointmentConflicts = await getAppointmentConflictsForStaff({
    organizationId,
    branchId,
    staffId,
    date: attendanceDate,
    leaves: approvedLeaves,
  });
  const auditHistory = record
    ? await AuditLog.find({
        organizationId,
        branchId,
        entityType: "Attendance",
        entityId: record._id,
      })
        .sort({ createdAt: -1 })
        .lean()
    : [];
  const deviceMappings = await StaffDeviceMapping.find({
    organizationId,
    branchId,
    staffId,
    isActive: true,
  })
    .select("provider deviceId externalEmployeeCode")
    .lean();

  return {
    date: attendanceDate,
    timezone: branch.timezone,
    operatingHours: branch.operatingHours || null,
    staff: {
      ...staff,
      deviceMappings,
    },
    record,
    status: record?.status || "missing_punch",
    punches,
    approvedLeaves,
    exceptions,
    appointmentConflicts,
    auditHistory,
  };
}

async function adjustAttendanceRecord({
  organizationId,
  branchId,
  actorId,
  staffId,
  date,
  status,
  reason,
}) {
  const attendanceDate = assertDateOnly(date);
  if (!ATTENDANCE_STATUSES.includes(status))
    throw new AppError("Attendance status is invalid.", 400);
  const cleanReason = typeof reason === "string" ? reason.trim() : "";
  if (cleanReason.length < 3 || cleanReason.length > 1000) {
    throw new AppError(
      "A reason between 3 and 1000 characters is required.",
      400,
    );
  }
  const branch = await getActiveBranch(organizationId, branchId);
  const staffLink = await StaffBranch.findOne({
    organizationId,
    branchId,
    staffId,
    isActive: true,
  });
  const staff =
    staffLink &&
    (await Staff.findOne({
      _id: staffId,
      organizationId,
      isDeleted: { $ne: true },
      status: "active",
    }));
  if (!staff)
    throw new AppError(
      "Active staff member was not found in this branch.",
      404,
    );

  const claim = await Attendance.claimAttendanceRecord({
    organizationId,
    staffId,
    branchId,
    attendanceDate,
    punchType: "manual_adjustment",
  });
  await ensureAttendanceClaimDurable(claim, {
    organizationId,
    staffId,
    branchId,
    attendanceDate,
    punchAt: new Date(),
    punchType: "manual_adjustment",
  });
  if (!claim.success)
    throw new AppError("Attendance record is claimed by another branch.", 409);

  const record = await Attendance.findOne({
    organizationId,
    branchId,
    staffId,
    attendanceDate: new Date(`${attendanceDate}T00:00:00.000Z`),
    isDeleted: { $ne: true },
  });
  if (!record) throw new AppError("Attendance claim could not be loaded.", 500);
  const previousStatus = record.status;
  const changedAt = new Date();
  const updated = await Attendance.findOneAndUpdate(
    { _id: record._id, organizationId, branchId, isDeleted: { $ne: true } },
    {
      $set: {
        status,
        isReconciled: true,
        reconciliationReason: cleanReason,
        reconciledBy: actorId,
        reconciledAt: changedAt,
      },
      $push: {
        adjustmentHistory: {
          previousStatus,
          newStatus: status,
          reason: cleanReason,
          actorId,
          changedAt,
        },
      },
    },
    { returnDocument: 'after', runValidators: true },
  ).lean();
  if (!updated)
    throw new AppError("Attendance record could not be updated.", 409);

  const staffDoc = await Staff.findOne({ _id: updated.staffId, organizationId })
    .select("userId")
    .lean();
  if (staffDoc?.userId) {
    const latestAdj = updated.adjustmentHistory?.[updated.adjustmentHistory.length - 1];
    if (latestAdj?._id) {
      await emitAttendanceOutboxEvent({
        eventType: "attendance.corrected",
        attendance: updated,
        employeeUserId: staffDoc.userId,
        organizationId,
        operationId: String(latestAdj._id),
      });
    }
  }

  return updated;
}

async function getAppointmentConflictsForStaff({
  organizationId,
  branchId,
  staffId,
  date,
  leaves,
}) {
  if (!leaves.length) return [];
  const appointments = await Appointment.find({
    organizationId,
    branchId,
    staffId,
    appointmentDate: date,
    status: { $in: ["scheduled", "in_progress"] },
    isDeleted: { $ne: true },
  })
    .select("appointmentCode appointmentDate startAt endAt status staffId")
    .lean();
  const leaveIds = leaves.map(({ _id }) => _id.toString());
  const resolved =
    leaveIds.length && appointments.length
      ? await AttendanceLeaveAppointmentConflict.find({
          organizationId,
          leaveId: { $in: leaves.map(({ _id }) => _id) },
          conflictAppointmentId: { $in: appointments.map(({ _id }) => _id) },
          status: "resolved",
        })
          .select("leaveId conflictAppointmentId reason resolvedAt")
          .lean()
      : [];
  const resolvedPairs = new Set(
    resolved.map((item) => `${item.leaveId}:${item.conflictAppointmentId}`),
  );
  return leaves.flatMap((leave) =>
    appointments.map((appointment) => ({
      leaveId: leave._id,
      leaveCode: leave.leaveCode,
      appointmentId: appointment._id,
      appointmentCode: appointment.appointmentCode,
      appointmentDate: appointment.appointmentDate,
      startAt: appointment.startAt,
      endAt: appointment.endAt,
      status: resolvedPairs.has(`${leave._id}:${appointment._id}`)
        ? "resolved"
        : "pending",
      resolution:
        resolved.find(
          (item) =>
            `${item.leaveId}:${item.conflictAppointmentId}` ===
            `${leave._id}:${appointment._id}`,
        ) || null,
    })),
  );
}

async function listLeaveAppointmentConflicts({
  organizationId,
  branchId,
  date,
}) {
  const attendanceDate = assertDateOnly(date);
  const { end } = dateWindow(attendanceDate);
  const leaves = await Leave.find({
    organizationId,
    branchId,
    status: "approved",
    isDeleted: { $ne: true },
    ...leaveDateCondition(attendanceDate),
  })
    .select("leaveCode staffId dates startDate endDate")
    .lean();
  const results = [];
  for (const leave of leaves) {
    const conflicts = await getAppointmentConflictsForStaff({
      organizationId,
      branchId,
      staffId: leave.staffId,
      date: attendanceDate,
      leaves: [leave],
    });
    const staff = await Staff.findOne({ _id: leave.staffId, organizationId })
      .select("name staffCode")
      .lean();
    results.push(...conflicts.map((conflict) => ({ ...conflict, staff })));
  }
  return { date: attendanceDate, data: results, total: results.length };
}

async function resolveLeaveAppointmentConflict({
  organizationId,
  branchId,
  actorId,
  leaveId,
  appointmentId,
  date,
  reason,
}) {
  const attendanceDate = assertDateOnly(date);
  const cleanReason = typeof reason === "string" ? reason.trim() : "";
  if (cleanReason.length < 3 || cleanReason.length > 1000) {
    throw new AppError(
      "A reason between 3 and 1000 characters is required.",
      400,
    );
  }
  const leave = await Leave.findOne({
    _id: leaveId,
    organizationId,
    branchId,
    status: "approved",
    isDeleted: { $ne: true },
    ...leaveDateCondition(attendanceDate),
  });
  const appointment = await Appointment.findOne({
    _id: appointmentId,
    organizationId,
    branchId,
    appointmentDate: attendanceDate,
    status: { $in: ["scheduled", "in_progress"] },
    isDeleted: { $ne: true },
  });
  if (
    !leave ||
    !appointment ||
    String(leave.staffId) !== String(appointment.staffId)
  ) {
    throw new AppError(
      "An active approved-leave appointment conflict was not found.",
      404,
    );
  }
  const conflict = await AttendanceLeaveAppointmentConflict.findOneAndUpdate(
    {
      organizationId,
      leaveId,
      conflictAppointmentId: appointmentId,
      status: "pending",
    },
    {
      $setOnInsert: {
        organizationId,
        leaveId,
        conflictAppointmentId: appointmentId,
        status: "pending",
        isActive: true,
      },
    },
    { returnDocument: 'after', upsert: true, setDefaultsOnInsert: true },
  );
  if (!conflict) throw new AppError("Conflict could not be recorded.", 500);
  conflict.status = "resolved";
  conflict.resolution = "retain";
  conflict.reason = cleanReason;
  conflict.resolvedBy = actorId;
  conflict.resolvedAt = new Date();
  await conflict.save();
  await AuditLog.create({
    organizationId,
    branchId,
    actorId,
    action: "ATTENDANCE_CONFLICT_RESOLVED",
    entityType: "AttendanceLeaveAppointmentConflict",
    entityId: conflict._id,
    description: `Approved-leave appointment conflict retained for ${attendanceDate}.`,
    metadata: {
      leaveId,
      appointmentId,
      date: attendanceDate,
      resolution: "retain",
      reason: cleanReason,
    },
  });
  return conflict;
}

async function recordLeaveException({
  organizationId,
  branchId,
  actorId,
  leaveId,
  date,
  decision,
  reason,
}) {
  const resolvedDate = assertDateOnly(date);
  const cleanReason = typeof reason === "string" ? reason.trim() : "";
  if (cleanReason.length < 3 || cleanReason.length > 1000) {
    throw new AppError(
      "A reason between 3 and 1000 characters is required.",
      400,
    );
  }
  if (!["worked", "absent", "half-day"].includes(decision)) {
    throw new AppError("Leave exception decision is invalid.", 400);
  }
  const leave = await Leave.findOne({
    _id: leaveId,
    organizationId,
    branchId,
    status: "approved",
    isDeleted: { $ne: true },
    ...leaveDateCondition(resolvedDate),
  });
  if (!leave)
    throw new AppError("Approved leave was not found for this date.", 404);
  const exception = await AttendanceLeaveException.findOneAndUpdate(
    { organizationId, leaveId, resolvedDate, isActive: true },
    {
      $set: {
        decision,
        reason: cleanReason,
        resolvedBy: actorId,
        resolvedAt: new Date(),
      },
      $setOnInsert: { organizationId, leaveId, resolvedDate, isActive: true },
    },
    { returnDocument: 'after', upsert: true, setDefaultsOnInsert: true, runValidators: true },
  );
  await AuditLog.create({
    organizationId,
    branchId,
    actorId,
    action: "ATTENDANCE_LEAVE_EXCEPTION_RECORDED",
    entityType: "AttendanceLeaveException",
    entityId: exception._id,
    description: `Attendance leave exception recorded for ${resolvedDate}.`,
    metadata: { leaveId, date: resolvedDate, decision, reason: cleanReason },
  });
  return exception;
}

async function listBranchAttendanceConflicts({ organizationId, branchId }) {
  return AttendanceBranchConflict.find({
    organizationId,
    conflictStatus: "pending",
    branchesInvolved: { $elemMatch: { branchId } },
  })
    .populate("staffId", "name staffCode")
    .populate("branchesInvolved.branchId", "name")
    .sort({ date: -1 })
    .lean();
}

async function resolveBranchAttendanceConflict({
  organizationId,
  branchId,
  actorId,
  conflictId,
  reason,
  forceStandalone = false,
}) {
  const cleanReason = typeof reason === "string" ? reason.trim() : "";
  if (cleanReason.length < 3 || cleanReason.length > 1000) {
    throw new AppError(
      "A reason between 3 and 1000 characters is required.",
      400,
    );
  }

  // Define the core reconciliation logic accepting an optional Mongoose session
  const performReconciliation = async (session = null) => {
    const sessionOption = session ? { session } : {};

    // 1. Validate pending conflict existence and branch authorization
    const conflict = await AttendanceBranchConflict.findOne(
      {
        _id: conflictId,
        organizationId,
        branchesInvolved: { $elemMatch: { branchId } },
      },
      null,
      sessionOption,
    );
    if (!conflict) {
      throw new AppError("Branch conflict was not found in this branch.", 404);
    }
    if (conflict.conflictStatus !== "pending") {
      throw new AppError(
        "Conflict was already resolved by another manager or is no longer pending.",
        409,
      );
    }

    const resolvedAt = new Date();
    const targetDate =
      conflict.date instanceof Date
        ? conflict.date
        : new Date(`${conflict.date}T00:00:00.000Z`);

    // 2. Step 1: Verify and update the corresponding daily Attendance record
    // Explicit Requirement: If no Attendance record exists, do not silently report success or resolve conflict.
    const attRecord = await Attendance.findOne(
      {
        organizationId,
        staffId: conflict.staffId,
        attendanceDate: targetDate,
        isDeleted: { $ne: true },
      },
      null,
      sessionOption,
    );

    if (!attRecord) {
      throw new AppError(
        "Required daily Attendance record for this staff and date does not exist. Reconciliation cannot proceed.",
        422,
      );
    }

    // Capture pre-reconciliation snapshots for safe rollback/recovery if non-transactional
    const previousAttendanceState = {
      isReconciled: attRecord.isReconciled,
      reconciliationReason: attRecord.reconciliationReason,
      reconciledBy: attRecord.reconciledBy,
      reconciledAt: attRecord.reconciledAt,
    };
    const previousConflictState = {
      conflictStatus: conflict.conflictStatus,
      resolution: conflict.resolution,
      reason: conflict.reason,
      resolvedBy: conflict.resolvedBy,
      resolvedAt: conflict.resolvedAt,
    };

    const updatedAtt = await Attendance.findOneAndUpdate(
      {
        _id: attRecord._id,
        organizationId,
        isDeleted: { $ne: true },
      },
      {
        $set: {
          isReconciled: true,
          reconciliationReason: cleanReason,
          reconciledBy: actorId,
          reconciledAt: resolvedAt,
        },
      },
      { returnDocument: 'after', ...sessionOption },
    );

    let updatedConflict;
    try {
      // 3. Step 2: Conditionally transition AttendanceBranchConflict from pending to resolved
      // Atomic findOneAndUpdate ensures duplicate concurrent manager reconciliations cannot both succeed
      updatedConflict = await AttendanceBranchConflict.findOneAndUpdate(
        {
          _id: conflictId,
          organizationId,
          conflictStatus: "pending",
          branchesInvolved: { $elemMatch: { branchId } },
        },
        {
          $set: {
            conflictStatus: "resolved",
            resolution: "retain",
            reason: cleanReason,
            resolvedBy: actorId,
            resolvedAt: resolvedAt,
          },
        },
        { returnDocument: 'after', ...sessionOption },
      );

      if (!updatedConflict) {
        throw new AppError(
          "Conflict was already resolved by another manager or is no longer pending.",
          409,
        );
      }

      // 4. Step 3: Create Audit Log record inside the transaction boundary or safe block
      await AuditLog.create(
        [
          {
            organizationId,
            branchId,
            actorId,
            action: "ATTENDANCE_CONFLICT_RESOLVED",
            entityType: "AttendanceBranchConflict",
            entityId: updatedConflict._id,
            description:
              "Cross-branch attendance evidence retained and conflict resolved.",
            metadata: {
              reason: cleanReason,
              resolution: "retain",
              date: conflict.date,
            },
          },
        ],
        sessionOption,
      );
    } catch (err) {
      // If we are not in a transaction session (e.g. standalone topology), conditionally roll back BOTH Attendance and AttendanceBranchConflict states
      // Ensure compensation is conditional on the exact state written by THIS reconciliation operation to avoid overwriting newer changes.
      if (!session) {
        const compensationErrors = [];

        try {
          const unsetFields = {};
          const setFields = {
            isReconciled: previousAttendanceState.isReconciled ?? false,
          };
          if (previousAttendanceState.reconciliationReason !== undefined) {
            setFields.reconciliationReason =
              previousAttendanceState.reconciliationReason;
          } else {
            unsetFields.reconciliationReason = 1;
          }
          if (previousAttendanceState.reconciledBy !== undefined) {
            setFields.reconciledBy = previousAttendanceState.reconciledBy;
          } else {
            unsetFields.reconciledBy = 1;
          }
          if (previousAttendanceState.reconciledAt !== undefined) {
            setFields.reconciledAt = previousAttendanceState.reconciledAt;
          } else {
            unsetFields.reconciledAt = 1;
          }

          const attUpdateDoc = { $set: setFields };
          if (Object.keys(unsetFields).length > 0) {
            attUpdateDoc.$unset = unsetFields;
          }

          const attUpdateResult = await Attendance.updateOne(
            {
              _id: attRecord._id,
              isReconciled: true,
              reconciledAt: resolvedAt,
              reconciledBy: actorId,
            },
            attUpdateDoc,
          );

          if (attUpdateResult.matchedCount !== 1) {
            compensationErrors.push({
              target: "Attendance",
              id: attRecord._id,
              error: `Compensation update failed: matchedCount ${attUpdateResult.matchedCount} !== 1. Record state may have changed concurrently.`,
              operationContext: {
                expectedReconciledAt: resolvedAt,
                expectedReconciledBy: actorId,
                matchedCount: attUpdateResult.matchedCount,
                modifiedCount: attUpdateResult.modifiedCount,
              },
            });
          }
        } catch (compensationErr) {
          compensationErrors.push({
            target: "Attendance",
            id: attRecord._id,
            error: compensationErr.message,
            operationContext: {
              expectedReconciledAt: resolvedAt,
              expectedReconciledBy: actorId,
            },
          });
        }

        // If the conflict was transitioned before an audit failure occurred, conditionally restore it back to its pending state
        if (updatedConflict) {
          try {
            const unsetConflictFields = {};
            const setConflictFields = {
              conflictStatus: previousConflictState.conflictStatus,
            };
            if (previousConflictState.resolution !== undefined) {
              setConflictFields.resolution = previousConflictState.resolution;
            } else {
              unsetConflictFields.resolution = 1;
            }
            if (previousConflictState.reason !== undefined) {
              setConflictFields.reason = previousConflictState.reason;
            } else {
              unsetConflictFields.reason = 1;
            }
            if (previousConflictState.resolvedBy !== undefined) {
              setConflictFields.resolvedBy = previousConflictState.resolvedBy;
            } else {
              unsetConflictFields.resolvedBy = 1;
            }
            if (previousConflictState.resolvedAt !== undefined) {
              setConflictFields.resolvedAt = previousConflictState.resolvedAt;
            } else {
              unsetConflictFields.resolvedAt = 1;
            }

            const conflictUpdateDoc = { $set: setConflictFields };
            if (Object.keys(unsetConflictFields).length > 0) {
              conflictUpdateDoc.$unset = unsetConflictFields;
            }

            const conflictUpdateResult =
              await AttendanceBranchConflict.updateOne(
                {
                  _id: conflictId,
                  conflictStatus: "resolved",
                  resolvedAt: resolvedAt,
                  resolvedBy: actorId,
                },
                conflictUpdateDoc,
              );

            if (conflictUpdateResult.matchedCount !== 1) {
              compensationErrors.push({
                target: "AttendanceBranchConflict",
                id: conflictId,
                error: `Compensation update failed: matchedCount ${conflictUpdateResult.matchedCount} !== 1. Conflict state may have changed concurrently.`,
                operationContext: {
                  expectedResolvedAt: resolvedAt,
                  expectedResolvedBy: actorId,
                  matchedCount: conflictUpdateResult.matchedCount,
                  modifiedCount: conflictUpdateResult.modifiedCount,
                },
              });
            }
          } catch (compensationConflictErr) {
            compensationErrors.push({
              target: "AttendanceBranchConflict",
              id: conflictId,
              error: compensationConflictErr.message,
              operationContext: {
                expectedResolvedAt: resolvedAt,
                expectedResolvedBy: actorId,
              },
            });
          }
        }

        if (compensationErrors.length > 0) {
          logger.error(
            `CRITICAL: Compensation failed during attendance conflict rollback. Manual reconciliation audit required. Context: ${JSON.stringify(
              {
                conflictId,
                organizationId,
                branchId,
                staffId: conflict.staffId,
                date: conflict.date,
                actorId,
                reconciliationError: err.message,
                compensationFailures: compensationErrors,
              },
            )}`,
          );

          // Attach structured compensation failure metadata directly to the error without overwriting the root cause
          err.compensationFailures = compensationErrors;
          err.isCompensationFailure = true;
          err.reconciliationContext = {
            conflictId,
            attendanceId: attRecord._id,
            staffId: conflict.staffId,
            date: conflict.date,
          };
        }
      }
      throw err;
    }

    return updatedConflict;
  };

  // If MongoDB topology supports transactions and standalone is not explicitly forced (e.g. during standalone test verification),
  // run within an ACID multi-document transaction
  if (!forceStandalone && isTransactionSupported()) {
    return await runInTransaction(
      async (session) => {
        return await performReconciliation(session);
      },
      { requireTransaction: true },
    );
  }

  // Standalone / non-replica-set execution with compensation recovery
  return await performReconciliation(null);
}

/**
 * Recovers an audit log entry for a successfully reconciled AttendanceBranchConflict
 * when the audit write was interrupted or failed after document state transitions.
 *
 * Guarantees:
 * - Validates document states (Attendance isReconciled: true and Conflict conflictStatus: 'resolved').
 * - Preserves original actor, organization, branch, conflict, and reconciliation context.
 * - Idempotent and concurrency-safe via atomic findOneAndUpdate with upsert: true.
 * - Concurrently executing recovery calls cannot create duplicate audit records.
 * - Surfaces unexpected database errors.
 */
async function recoverReconciliationAuditLog({
  organizationId,
  branchId,
  actorId,
  conflictId,
  expectedResolvedAt = null,
  expectedResolvedBy = null,
  session = null,
}) {
  const sessionOption = session ? { session } : {};

  // 1. Verify conflict exists and belongs to organization & branch
  const conflict = await AttendanceBranchConflict.findOne(
    {
      _id: conflictId,
      organizationId,
      branchesInvolved: { $elemMatch: { branchId } },
    },
    null,
    sessionOption,
  );

  if (!conflict) {
    throw new AppError(
      "Attendance branch conflict not found in this branch.",
      404,
    );
  }

  // 2. Document state validation: Conflict MUST be resolved
  if (conflict.conflictStatus !== "resolved") {
    throw new AppError(
      "Cannot recover audit log for an unresolved or pending branch conflict.",
      422,
    );
  }

  // Exact operation-identity validation at stored precision
  if (
    expectedResolvedBy &&
    conflict.resolvedBy?.toString() !== expectedResolvedBy.toString()
  ) {
    throw new AppError(
      "Conflict resolvedBy does not match the expected reconciliation actor. Recovery aborted.",
      409,
    );
  }
  if (expectedResolvedAt) {
    const conflictResolvedAtIso = new Date(conflict.resolvedAt).toISOString();
    const expectedResolvedAtIso = new Date(expectedResolvedAt).toISOString();
    if (conflictResolvedAtIso !== expectedResolvedAtIso) {
      throw new AppError(
        "Conflict resolvedAt timestamp does not match the expected reconciliation time. Recovery aborted.",
        409,
      );
    }
  }

  // 3. Document state validation: Corresponding Attendance MUST be reconciled and match conflict reconciliation identity
  const targetDate =
    conflict.date instanceof Date
      ? conflict.date
      : new Date(`${conflict.date}T00:00:00.000Z`);

  const attRecord = await Attendance.findOne(
    {
      organizationId,
      staffId: conflict.staffId,
      attendanceDate: targetDate,
      isDeleted: { $ne: true },
    },
    null,
    sessionOption,
  );

  if (!attRecord || !attRecord.isReconciled) {
    throw new AppError(
      "Cannot recover audit log because daily Attendance record is not reconciled.",
      422,
    );
  }

  // Validate that the Attendance reconciliation actor and timestamp correspond to the conflict being recovered
  if (attRecord.reconciledBy?.toString() !== conflict.resolvedBy?.toString()) {
    throw new AppError(
      "Attendance reconciledBy does not correspond to the conflict resolution actor. Recovery aborted.",
      409,
    );
  }

  const attReconciledAtIso = attRecord.reconciledAt
    ? new Date(attRecord.reconciledAt).toISOString()
    : null;
  const conflictResolvedAtIso = conflict.resolvedAt
    ? new Date(conflict.resolvedAt).toISOString()
    : null;
  if (attReconciledAtIso !== conflictResolvedAtIso) {
    throw new AppError(
      "Attendance reconciledAt timestamp does not correspond to the conflict resolution timestamp. Recovery aborted.",
      409,
    );
  }

  // 4. Pre-check: Ensure recovery cannot create a duplicate if an equivalent original audit event already exists without an idempotency key
  const existingOriginalAudit = await AuditLog.findOne(
    {
      organizationId,
      action: "ATTENDANCE_CONFLICT_RESOLVED",
      entityType: "AttendanceBranchConflict",
      entityId: conflict._id,
    },
    null,
    sessionOption,
  );

  if (existingOriginalAudit) {
    return existingOriginalAudit;
  }

  // 5. Atomic, idempotent audit creation using findOneAndUpdate with upsert: true
  // The stable idempotency key binds this specific conflict ID and its resolution timestamp
  const idempotencyKey = `RECON_AUDIT_${conflict._id}_${conflictResolvedAtIso}`;
  const effectiveActorId = actorId || conflict.resolvedBy;

  try {
    const auditRecord = await AuditLog.findOneAndUpdate(
      {
        organizationId,
        action: "ATTENDANCE_CONFLICT_RESOLVED",
        entityType: "AttendanceBranchConflict",
        entityId: conflict._id,
        "metadata.idempotencyKey": idempotencyKey,
      },
      {
        $setOnInsert: {
          organizationId,
          branchId,
          actorId: effectiveActorId,
          action: "ATTENDANCE_CONFLICT_RESOLVED",
          entityType: "AttendanceBranchConflict",
          entityId: conflict._id,
          description:
            "Cross-branch attendance evidence retained and conflict resolved (Audit Recovered).",
          metadata: {
            reason: conflict.reason || "Manual reconciliation audit recovery",
            resolution: conflict.resolution || "retain",
            date: conflict.date,
            idempotencyKey,
            recoveredAt: new Date(),
            originalResolvedAt: conflict.resolvedAt,
            originalResolvedBy: conflict.resolvedBy,
          },
        },
      },
      {
        upsert: true,
        returnDocument: 'after',
        setDefaultsOnInsert: true,
        ...sessionOption,
      },
    );

    return auditRecord;
  } catch (err) {
    // If a concurrent thread won the upsert race and Mongo threw duplicate key error (code 11000),
    // fetch and return the existing audit log idempotently
    if (err.code === 11000) {
      const existing = await AuditLog.findOne(
        {
          organizationId,
          action: "ATTENDANCE_CONFLICT_RESOLVED",
          entityType: "AttendanceBranchConflict",
          entityId: conflict._id,
          "metadata.idempotencyKey": idempotencyKey,
        },
        null,
        sessionOption,
      );
      if (existing) return existing;
    }
    // All other database failures are surfaced
    throw err;
  }
}

async function getProviderStatus({ organizationId, branchId }) {
  const [configurations, syncStates] = await Promise.all([
    ProviderConfiguration.find({ organizationId, branchId })
      .select(
        "providerName endpointUrl integrationMethod isActive syncStatus lastSync lastErrorAt",
      )
      .lean(),
    ProviderSyncState.find({ organizationId, branchId })
      .sort({ updatedAt: -1 })
      .lean(),
  ]);
  return {
    supportedProviders: providerRegistry.listAdapters(),
    configurations,
    syncStates: syncStates.map(
      ({
        _id,
        provider,
        deviceId,
        streamIdentifier,
        syncStatus,
        outcome,
        lastSuccessfulCheckpoint,
        lastError,
        lastAttemptedAt,
        lastSuccessfulAt,
        processedCount,
        eventCount,
      }) => ({
        id: _id,
        provider,
        deviceId,
        streamIdentifier,
        syncStatus,
        outcome,
        lastSuccessfulCheckpoint,
        hasError: Boolean(lastError),
        lastAttemptedAt,
        lastSuccessfulAt,
        processedCount,
        eventCount,
      }),
    ),
  };
}

async function listStaffDeviceMappings({
  organizationId,
  branchId,
  staffId,
  provider,
  deviceId,
  externalEmployeeCode,
  mappingStatus,
  isActive,
  search,
  page = 1,
  limit = 20,
}) {
  const query = { organizationId, branchId };

  if (staffId) {
    query.staffId = staffId;
  }
  if (provider) {
    query.provider = provider.trim();
  }
  if (deviceId) {
    query.deviceId = deviceId.trim();
  }
  if (externalEmployeeCode) {
    query.externalEmployeeCode = externalEmployeeCode.trim();
  }
  if (mappingStatus) {
    query.mappingStatus = mappingStatus;
  }
  if (typeof isActive === "boolean") {
    query.isActive = isActive;
  }

  // If a search query is provided, find matching staff IDs first or search externalEmployeeCode / deviceId
  if (search && search.trim()) {
    const searchRegex = new RegExp(search.trim(), "i");
    const matchedStaff = await Staff.find({
      organizationId,
      $or: [
        { name: searchRegex },
        { staffCode: searchRegex },
        { email: searchRegex },
        { phone: searchRegex },
      ],
    })
      .select("_id")
      .lean();

    const matchedStaffIds = matchedStaff.map((s) => s._id);

    query.$or = [
      { externalEmployeeCode: searchRegex },
      { deviceId: searchRegex },
      { provider: searchRegex },
      { notes: searchRegex },
      { staffId: { $in: matchedStaffIds } },
    ];
  }

  const numericPage = Math.max(1, parseInt(page, 10) || 1);
  const numericLimit = Math.min(100, Math.max(1, parseInt(limit, 10) || 20));
  const skip = (numericPage - 1) * numericLimit;

  const [mappings, total] = await Promise.all([
    StaffDeviceMapping.find(query)
      .populate("staffId", "name staffCode email phone avatar role isActive")
      .populate("createdBy", "name staffCode")
      .populate("updatedBy", "name staffCode")
      .sort({ createdAt: -1 })
      .skip(skip)
      .limit(numericLimit)
      .lean(),
    StaffDeviceMapping.countDocuments(query),
  ]);

  return {
    mappings,
    pagination: {
      total,
      page: numericPage,
      limit: numericLimit,
      totalPages: Math.ceil(total / numericLimit) || 1,
    },
  };
}

async function getStaffDeviceMappingById({ id, organizationId, branchId }) {
  const mapping = await StaffDeviceMapping.findOne({
    _id: id,
    organizationId,
    branchId,
  })
    .populate("staffId", "name staffCode email phone avatar role isActive")
    .populate("createdBy", "name staffCode")
    .populate("updatedBy", "name staffCode")
    .lean();

  if (!mapping) {
    throw new AppError("Staff device mapping not found.", 404);
  }
  return mapping;
}

async function createStaffDeviceMapping({
  organizationId,
  branchId,
  actorId,
  staffId,
  provider,
  deviceId,
  externalEmployeeCode,
  notes,
  effectiveFrom,
}) {
  const cleanProvider = (provider || "").trim();
  const cleanDeviceId = (deviceId || "").trim();
  const cleanExternalCode = (externalEmployeeCode || "").trim();

  if (!cleanProvider || !cleanDeviceId || !cleanExternalCode) {
    throw new AppError(
      "Provider, device ID, and external employee code are required.",
      400,
    );
  }

  // 1. Validate staff member belongs to the authenticated organization and is active
  const staff = await Staff.findOne({
    _id: staffId,
    organizationId,
    isDeleted: false,
  });

  if (!staff) {
    throw new AppError("Staff member not found in this organization.", 404);
  }
  if (staff.status !== "active") {
    throw new AppError(
      "Cannot create mapping for an inactive staff member.",
      400,
    );
  }

  // 2. Validate staff member is actively assigned to the active branch
  const staffBranch = await StaffBranch.findOne({
    staffId,
    branchId,
    organizationId,
    isActive: true,
  });

  if (!staffBranch) {
    throw new AppError(
      "Staff member is not actively assigned to the selected branch.",
      400,
    );
  }

  // 3. Validate provider configuration exists and is supported
  const supportedProviders = providerRegistry.listAdapters();
  if (!supportedProviders.includes(cleanProvider)) {
    throw new AppError(
      `Unsupported attendance provider: "${cleanProvider}".`,
      400,
    );
  }

  const providerConfig = await ProviderConfiguration.findOne({
    organizationId,
    branchId,
    providerName: cleanProvider,
    isActive: true,
  });

  if (!providerConfig) {
    throw new AppError(
      `No active configuration found for provider "${cleanProvider}" at this branch.`,
      400,
    );
  }

  // 4. Validate device identifier against provider configuration if deviceMappings are defined
  if (
    providerConfig.deviceMappings &&
    typeof providerConfig.deviceMappings === "object"
  ) {
    const configuredDevices = Object.keys(providerConfig.deviceMappings);
    if (
      configuredDevices.length > 0 &&
      !configuredDevices.includes(cleanDeviceId)
    ) {
      // In case deviceMappings stores values or keys, also check Object.values
      const isConfigured =
        configuredDevices.includes(cleanDeviceId) ||
        Object.values(providerConfig.deviceMappings).includes(cleanDeviceId);
      if (!isConfigured) {
        throw new AppError(
          `Device ID "${cleanDeviceId}" is not registered in the provider configuration for "${cleanProvider}".`,
          400,
        );
      }
    }
  }

  // 5. Pre-check for duplicate active mapping to provide friendly 409 conflict
  const existingActive = await StaffDeviceMapping.findOne({
    organizationId,
    branchId,
    provider: cleanProvider,
    deviceId: cleanDeviceId,
    externalEmployeeCode: cleanExternalCode,
    isActive: true,
  });

  if (existingActive) {
    throw new AppError(
      `An active mapping already exists for code "${cleanExternalCode}" on device "${cleanDeviceId}" with provider "${cleanProvider}". Deactivate the existing mapping before reassigning.`,
      409,
    );
  }

  // 6. Create mapping with mappingMethod: 'admin_overriden' and safeguard with unique index
  try {
    const newMapping = await StaffDeviceMapping.create({
      organizationId,
      branchId,
      provider: cleanProvider,
      deviceId: cleanDeviceId,
      externalEmployeeCode: cleanExternalCode,
      staffId,
      mappingStatus: "mapped",
      mappingMethod: "admin_overriden",
      isActive: true,
      effectiveFrom: effectiveFrom ? new Date(effectiveFrom) : new Date(),
      notes: notes ? notes.trim() : undefined,
      createdBy: actorId,
      updatedBy: actorId,
    });

    // 7. Durably record audit log
    await AuditLog.create({
      organizationId,
      branchId,
      actorId,
      action: "ATTENDANCE_DEVICE_MAPPING_CREATED",
      entityType: "StaffDeviceMapping",
      entityId: newMapping._id,
      description: `Staff device mapping created for staff ${staff.staffCode || staff.name} to external ID ${cleanExternalCode}.`,
      metadata: {
        staffId,
        provider: cleanProvider,
        deviceId: cleanDeviceId,
        externalEmployeeCode: cleanExternalCode,
        mappingMethod: "admin_overriden",
      },
    });

    return await StaffDeviceMapping.findById(newMapping._id)
      .populate("staffId", "name staffCode email phone avatar role isActive")
      .populate("createdBy", "name staffCode")
      .lean();
  } catch (error) {
    // Catch MongoDB duplicate key error code 11000
    if (
      error.code === 11000 ||
      (error.name === "MongoServerError" && error.code === 11000)
    ) {
      throw new AppError(
        `A mapping conflict occurred: an active mapping already exists for code "${cleanExternalCode}" on device "${cleanDeviceId}".`,
        409,
      );
    }
    throw error;
  }
}

async function updateStaffDeviceMapping({
  id,
  organizationId,
  branchId,
  actorId,
  provider,
  deviceId,
  externalEmployeeCode,
  notes,
  effectiveTo,
  mappingStatus,
}) {
  const mapping = await StaffDeviceMapping.findOne({
    _id: id,
    organizationId,
    branchId,
  });

  if (!mapping) {
    throw new AppError("Staff device mapping not found.", 404);
  }

  const nextProvider = provider !== undefined ? provider.trim() : mapping.provider;
  const nextDeviceId = deviceId !== undefined ? deviceId.trim() : mapping.deviceId;
  const nextExternalCode =
    externalEmployeeCode !== undefined
      ? externalEmployeeCode.trim()
      : mapping.externalEmployeeCode;

  if (
    provider !== undefined ||
    deviceId !== undefined ||
    externalEmployeeCode !== undefined
  ) {
    const conflict = await StaffDeviceMapping.findOne({
      _id: { $ne: id },
      organizationId,
      branchId,
      provider: nextProvider,
      deviceId: nextDeviceId,
      externalEmployeeCode: nextExternalCode,
      isActive: true,
    }).lean();
    if (conflict) {
      throw new AppError(
        `An active mapping already exists for ${nextProvider} / ${nextDeviceId} / ${nextExternalCode}.`,
        409,
      );
    }
  }

  const updates = { updatedBy: actorId };
  if (provider !== undefined) updates.provider = nextProvider;
  if (deviceId !== undefined) updates.deviceId = nextDeviceId;
  if (externalEmployeeCode !== undefined) {
    updates.externalEmployeeCode = nextExternalCode;
  }
  if (notes !== undefined) {
    updates.notes = notes ? notes.trim() : "";
  }
  if (effectiveTo !== undefined) {
    updates.effectiveTo = effectiveTo ? new Date(effectiveTo) : null;
  }
  if (mappingStatus !== undefined) {
    updates.mappingStatus = mappingStatus;
  }

  const updatedMapping = await StaffDeviceMapping.findByIdAndUpdate(
    id,
    { $set: updates },
    { returnDocument: 'after', runValidators: true },
  )
    .populate("staffId", "name staffCode email phone avatar role isActive")
    .populate("createdBy", "name staffCode")
    .populate("updatedBy", "name staffCode")
    .lean();

  await AuditLog.create({
    organizationId,
    branchId,
    actorId,
    action: "ATTENDANCE_DEVICE_MAPPING_UPDATED",
    entityType: "StaffDeviceMapping",
    entityId: mapping._id,
    description: `Staff device mapping updated for external ID ${mapping.externalEmployeeCode}.`,
    metadata: {
      updates,
      externalEmployeeCode: mapping.externalEmployeeCode,
      provider: mapping.provider,
      deviceId: mapping.deviceId,
    },
  });

  return updatedMapping;
}

async function deactivateStaffDeviceMapping({
  id,
  organizationId,
  branchId,
  actorId,
}) {
  const mapping = await StaffDeviceMapping.findOne({
    _id: id,
    organizationId,
    branchId,
  });

  if (!mapping) {
    throw new AppError("Staff device mapping not found.", 404);
  }

  if (!mapping.isActive) {
    throw new AppError("Staff device mapping is already inactive.", 400);
  }

  const deactivatedAt = new Date();
  mapping.isActive = false;
  mapping.effectiveTo = deactivatedAt;
  mapping.updatedBy = actorId;
  await mapping.save();

  await AuditLog.create({
    organizationId,
    branchId,
    actorId,
    action: "STAFF_DEVICE_MAPPING_DEACTIVATED",
    entityType: "StaffDeviceMapping",
    entityId: mapping._id,
    description: `Staff device mapping deactivated for external ID ${mapping.externalEmployeeCode}. Historical punches are preserved.`,
    metadata: {
      staffId: mapping.staffId,
      provider: mapping.provider,
      deviceId: mapping.deviceId,
      externalEmployeeCode: mapping.externalEmployeeCode,
      effectiveTo: deactivatedAt,
    },
  });

  return await StaffDeviceMapping.findById(mapping._id)
    .populate("staffId", "name staffCode email phone avatar role isActive")
    .populate("createdBy", "name staffCode")
    .populate("updatedBy", "name staffCode")
    .lean();
}

// Attendance Service placeholder
// Attendance Service — Salon Project Unisex Parlour ERP
// Helper: derive branch-local date from UTC date and branch timezone
// Provider event ingestion
// Attendance computation for a staff member on a given date
// Reconcile leave-attendance conflict
// Adjust attendance record
// List leave-attendance conflicts
// List appointment conflicts
// Resolve appointment conflict
// List audit history for attendance
async function listAudit(filters = {}) {
  const { entityType, entityId, action, startDate, endDate } = filters;
  const query = {};
  if (entityType) query.entityType = entityType;
  if (entityId) query.entityId = entityId;
  if (action) query.action = action;
  if (startDate) query.createdAt = { $gte: startDate };
  if (endDate) query.createdAt = { $lte: endDate };

  return await AuditLog.find(query).sort({ createdAt: -1 });
}

async function resolveAppointmentConflict(conflictId, resolutionData, actorId) {
  const conflict =
    await AttendanceLeaveAppointmentConflict.findById(conflictId);

  if (!conflict) throw new Error("Conflict not found");

  const { resolution, reason, staffId } = resolutionData;

  if (resolution === "retain") {
    conflict.status = "resolved";
    conflict.resolution = resolution;
    conflict.resolvedBy = actorId;
    conflict.resolvedAt = new Date();
    conflict.reason = reason;
    await conflict.save();
    return conflict;
  }

  if (resolution === "reassign") {
    const staff = await Staff.findById(staffId);
    if (!staff || !staff.isActive) throw new Error("Staff not active");

    conflict.appointment.conflictAppointmentId.staffId = staffId;
    conflict.appointment.version += 1;
    conflict.status = "resolved";
    conflict.resolution = resolution;
    conflict.resolvedBy = actorId;
    conflict.resolvedAt = new Date();
    conflict.reason = reason;
    await conflict.save();
    await conflict.appointment.save();
    return conflict;
  }

  if (resolution === "cancel") {
    conflict.appointment.status = "cancelled";
    conflict.appointment.cancellation = {
      cancelledBy: actorId,
      cancelledAt: new Date(),
      reason,
    };
    conflict.status = "resolved";
    conflict.resolution = resolution;
    conflict.resolvedBy = actorId;
    conflict.resolvedAt = new Date();
    conflict.reason = reason;
    await conflict.save();
    await conflict.appointment.save();
    return conflict;
  }
}
async function listAppointmentConflicts(filters = {}) {
  const { organizationId, dateFrom, dateTo } = filters;
  return await AttendanceLeaveAppointmentConflict.find({
    organizationId,
    status: "pending",
  }).populate("leaveId conflictAppointmentId");
}
async function listConflicts(filters = {}) {
  const { organizationId, branchId, dateFrom, dateTo } = filters;
  const query = { conflictType: "leave", isReconciled: false };
  if (organizationId) query.organizationId = organizationId;
  if (branchId) query.branchId = branchId;

  return await Attendance.find(query).populate("conflictLeaveId");
}
async function adjustAttendance(attendanceId, adjustmentData, actorId) {
  const { status, reason } = adjustmentData;
  const attendance = await Attendance.findById(attendanceId);

  if (!attendance) throw new Error("Attendance record not found");

  const previousStatus = attendance.status;
  attendance.status = status || attendance.status;
  attendance.adjustmentReason = reason;
  attendance.updatedBy = actorId;
  attendance.auditHistory = attendance.auditHistory || [];
  attendance.auditHistory.push({
    action: "attendance_adjustment",
    previousStatus,
    newStatus: attendance.status,
    reason,
    adjustedBy: actorId,
    adjustedAt: new Date(),
  });
  attendance.save();
  return attendance;
}
async function reconcileConflict(conflictData) {
  const { attendanceId, resolution, reason, resolvedDate } = conflictData;
  const attendance = await Attendance.findById(attendanceId);

  if (!attendance) throw new Error("Attendance record not found");
  if (attendance.isReconciled) throw new Error("Attendance already reconciled");

  const leave = await Leave.findById(attendance.conflictLeaveId);
  if (!leave) throw new Error("Leave record not found");

  if (resolution === "accept_punch") {
    if (leave.dates) {
      leave.dates = leave.dates.filter((d) => d !== resolvedDate);
    }
    if (leave.dates && leave.dates.length === 0) {
      leave.status = "cancelled";
    }
    await leave.save();

    await AttendanceLeaveException.findOneAndUpdate(
      { leaveId: conflictData.leaveId, resolvedDate },
      {
        decision: "worked",
        reason,
        isActive: true,
        resolvedBy: conflictData.actorId,
        resolvedAt: new Date(),
      },
      { upsert: true, returnDocument: 'after' },
    );

    attendance.status = "present";
    attendance.isReconciled = true;
    attendance.reconciliationReason = reason;
    attendance.reconciledBy = conflictData.actorId;
    attendance.reconciledAt = new Date();
  } else if (resolution === "reject_punch") {
    attendance.status = "absent";
    attendance.isReconciled = true;
    attendance.reconciliationReason = reason;
    attendance.reconciledBy = conflictData.actorId;
    attendance.reconciledAt = new Date();
  } else if (resolution === "mark_absent") {
    attendance.status = "absent";
    attendance.isReconciled = true;
    attendance.reconciliationReason = reason;
    attendance.reconciledBy = conflictData.actorId;
    attendance.reconciledAt = new Date();
  }

  attendance.conflictType = "leave";
  attendance.conflictLeaveId = conflictData.leaveId;
  attendance.leaveDayResolved = true;

  await attendance.save();
  return attendance;
}
async function ingestProviderPunch(
  punchData,
  organizationId,
  branchId,
  branchTimezone,
) {
  const { externalEmployeeCode, deviceId, punchType, punchAt, rawPayload } =
    punchData;
  const provider = punchData.provider;
  const externalEventId = normalizeExternalEventId(punchData.externalEventId);
  const isValidMappingKey =
    typeof externalEmployeeCode === "string" && externalEmployeeCode.trim();

  if (
    !provider ||
    !deviceId ||
    !punchAt ||
    (punchType !== null &&
      punchType !== undefined &&
      !["in", "out"].includes(punchType))
  ) {
    throw new AppError(
      "Provider event is missing required canonical punch fields.",
      400,
    );
  }

  if (externalEventId) {
    const existingPunch = await AttendancePunch.findOne({
      organizationId,
      provider,
      deviceId,
      externalEventId,
      isDeleted: false,
    });

    if (existingPunch) {
      const originalBranch = await Branch.findOne({
        _id: existingPunch.branchId,
        organizationId,
        isActive: true,
      });
      if (!originalBranch) {
        throw new Error(
          "Original attendance branch is unavailable for duplicate recovery.",
        );
      }

      const attendanceDate = deriveBusinessDate(
        existingPunch.punchAt,
        originalBranch.timezone,
      );
      const claimResult = await Attendance.claimAttendanceRecord({
        organizationId,
        staffId: existingPunch.staffId,
        branchId: existingPunch.branchId,
        attendanceDate,
        punchType: existingPunch.punchType,
      });
      await ensureAttendanceClaimDurable(claimResult, {
        organizationId,
        staffId: existingPunch.staffId,
        attendanceDate,
        punchAt: existingPunch.punchAt,
        punchType: existingPunch.punchType,
        externalEventId,
        punchId: existingPunch._id,
      });
      if (claimResult.success) {
        await reconcileAttendanceStatusFromPunches({
          organizationId,
          branchId: existingPunch.branchId,
          staffId: existingPunch.staffId,
          attendanceDate,
          branchTimezone: originalBranch.timezone,
          attendanceRecord: claimResult.attendanceRecord,
        });
      }
      return {
        punch: existingPunch,
        isDuplicate: true,
        mappingStatus: existingPunch.mappingStatus,
        attendanceClaim: claimResult.success ? "recovered" : "cross_branch",
      };
    }
  }

  const mapping = isValidMappingKey
    ? await StaffDeviceMapping.findOne({
        organizationId,
        branchId,
        provider,
        deviceId,
        externalEmployeeCode: externalEmployeeCode.trim(),
        isActive: true,
      })
    : null;
  const staffId = mapping?.staffId || null;
  const mappingStatus = staffId ? "mapped" : "unmapped";
  const { rawEvent, isDuplicateRawEvent } = await persistRawProviderEvent({
    organizationId,
    provider,
    deviceId,
    externalEventId,
    rawPayload,
    mappingStatus,
  });
  if (mappingStatus === "mapped" && rawEvent.mappingStatus !== "mapped") {
    rawEvent.mappingStatus = "mapped";
    await rawEvent.save();
  }

  if (!staffId) {
    return {
      punch: null,
      mappingStatus,
      rawEventId: rawEvent._id,
      isDuplicate: isDuplicateRawEvent,
    };
  }

  const attendanceDate = deriveBusinessDate(punchAt, branchTimezone);

  let resolvedPunchType = punchType;
  if (!resolvedPunchType) {
    const punchDateObj = new Date(punchAt);
    const searchWindowStart = new Date(
      punchDateObj.getTime() - 24 * 60 * 60 * 1000,
    );
    const previousPunches = await AttendancePunch.find({
      organizationId,
      staffId,
      isDeleted: false,
      punchAt: { $gte: searchWindowStart, $lt: punchDateObj },
    })
      .sort({ punchAt: -1 })
      .limit(5)
      .select("punchType punchAt")
      .lean();

    const sameDayLastPunch = previousPunches.find(
      (p) =>
        String(deriveBusinessDate(p.punchAt, branchTimezone)) ===
        String(attendanceDate),
    );
    resolvedPunchType =
      sameDayLastPunch && sameDayLastPunch.punchType === "in" ? "out" : "in";
  }

  const punch = new AttendancePunch({
    organizationId,
    branchId,
    staffId,
    punchType: resolvedPunchType,
    punchAt,
    provider,
    externalEventId,
    deviceId,
    deviceSource: punchData.deviceSource,
    mappingStatus,
    rawEvent: rawPayload,
  });
  await punch.save();

  const claimResult = await Attendance.claimAttendanceRecord({
    organizationId,
    staffId,
    branchId,
    attendanceDate,
    punchType: resolvedPunchType,
  });
  await ensureAttendanceClaimDurable(claimResult, {
    organizationId,
    staffId,
    branchId,
    attendanceDate,
    punchAt,
    punchType: resolvedPunchType,
    externalEventId,
    punchId: punch._id,
  });
  if (claimResult.success) {
    await reconcileAttendanceStatusFromPunches({
      organizationId,
      branchId,
      staffId,
      attendanceDate,
      branchTimezone,
      attendanceRecord: claimResult.attendanceRecord,
    });
  }

  return {
    punch,
    mappingStatus,
    rawEventId: rawEvent._id,
    isDuplicate: false,
    attendanceClaim: claimResult.success ? "claimed" : "cross_branch",
  };
}

async function ingestProviderEvents({
  providerName,
  organizationId,
  branchId,
  actorId,
  events,
  checkpoint,
  streamIdentifier,
  request,
}) {
  if (!Array.isArray(events) || events.length === 0) {
    throw new AppError("At least one provider event is required.", 400);
  }
  if (typeof checkpoint !== "string" || !checkpoint.trim()) {
    throw new AppError("A non-empty provider checkpoint is required.", 400);
  }
  if (!["daily", "realtime", "manual_import"].includes(streamIdentifier)) {
    throw new AppError("Invalid provider stream identifier.", 400);
  }

  const providerConfiguration = await ProviderConfiguration.findOne({
    organizationId,
    branchId,
    providerName,
    isActive: true,
  });
  if (
    !providerConfiguration ||
    !providerConfiguration.isActive ||
    providerConfiguration.providerName !== providerName ||
    String(providerConfiguration.organizationId) !== String(organizationId) ||
    String(providerConfiguration.branchId) !== String(branchId)
  ) {
    throw new AppError("Active provider configuration was not found.", 404);
  }

  const branch = await Branch.findOne({
    _id: branchId,
    organizationId,
    isActive: true,
  });
  if (!branch) throw new AppError("Active branch was not found.", 404);

  const adapter = providerRegistry.createAdapter(
    providerName,
    providerConfiguration,
  );
  const sourceError = await adapter.validateRequestSource(request);
  if (sourceError) throw sourceError;

  const normalizationResults = await Promise.allSettled(
    events.map((rawPayload) =>
      adapter.normalizePayload(rawPayload, organizationId, branchId, actorId),
    ),
  );
  const normalizationFailure = normalizationResults.find(
    (result) => result.status === "rejected",
  );
  if (normalizationFailure) {
    const error = normalizationFailure.reason;
    const errorMessage =
      error instanceof Error
        ? error.message
        : "Provider event normalization failed.";
    for (const rawPayload of events) {
      await new ProviderDeliveryLog({
        organizationId,
        branchId,
        provider: providerConfiguration.providerName,
        status: "failed",
        error: errorMessage,
        rawPayload,
      }).save();
    }
    throw error;
  }
  const normalizedEvents = normalizationResults.map((result) => result.value);
  const deviceIds = [
    ...new Set(
      normalizedEvents.map((event) => event?.deviceId).filter(Boolean),
    ),
  ];
  if (
    deviceIds.length !== 1 ||
    normalizedEvents.some((event) => !event?.deviceId)
  ) {
    throw new AppError(
      "A sync batch must contain events from exactly one device.",
      400,
    );
  }

  const results = [];
  for (let index = 0; index < events.length; index += 1) {
    const event = normalizedEvents[index];
    const canonicalEvent = {
      externalEmployeeCode: event.externalEmployeeCode,
      deviceId: event.deviceId,
      punchType: event.punchType,
      punchAt: event.punchAt,
      externalEventId: event.externalEventId,
      deviceSource: event.deviceSource,
      provider: providerConfiguration.providerName,
      rawPayload: event.rawEvent ?? events[index],
    };

    try {
      const result = await ingestProviderPunch(
        canonicalEvent,
        organizationId,
        branchId,
        branch.timezone,
      );
      const deliveryLog = new ProviderDeliveryLog({
        organizationId,
        branchId,
        provider: providerConfiguration.providerName,
        deviceId: event.deviceId,
        externalEventId: normalizeExternalEventId(event.externalEventId),
        punchType: event.punchType,
        punchAt: event.punchAt,
        status:
          result.mappingStatus === "unmapped"
            ? "unmapped"
            : result.isDuplicate
              ? "duplicate"
              : "success",
        duplicateOf: result.isDuplicate ? result.punch?._id : undefined,
        rawPayload: events[index],
      });
      await deliveryLog.save();
      results.push(result);
    } catch (error) {
      const failedDelivery = new ProviderDeliveryLog({
        organizationId,
        branchId,
        provider: providerConfiguration.providerName,
        deviceId: event.deviceId,
        externalEventId: normalizeExternalEventId(event.externalEventId),
        punchType: event.punchType,
        punchAt: event.punchAt,
        status: "failed",
        error: error.message,
        rawPayload: events[index],
      });
      await failedDelivery.save();
      await ProviderSyncState.findOneAndUpdate(
        {
          organizationId,
          provider: providerConfiguration.providerName,
          deviceId: deviceIds[0],
          streamIdentifier,
        },
        {
          $set: {
            branchId,
            outcome: index === 0 ? "failed" : "partial",
            eventCount: events.length,
            processedCount: index,
            syncStatus: "error",
            lastError: error.message,
            lastAttemptedAt: new Date(),
          },
          $inc: { retryCount: 1 },
        },
        {
          returnDocument: 'after',
          upsert: true,
          setDefaultsOnInsert: true,
          runValidators: true,
        },
      );
      throw error;
    }
  }

  const completedSync = await ProviderSyncState.findOneAndUpdate(
    {
      organizationId,
      provider: providerConfiguration.providerName,
      deviceId: deviceIds[0],
      streamIdentifier,
    },
    {
      $set: {
        branchId,
        lastSuccessfulCheckpoint: checkpoint,
        outcome: "completed",
        eventCount: events.length,
        processedCount: results.length,
        syncStatus: "idle",
        lastError: null,
        lastAttemptedAt: new Date(),
        lastSuccessfulAt: new Date(),
      },
    },
    { returnDocument: 'after', upsert: true, setDefaultsOnInsert: true, runValidators: true },
  );
  if (!completedSync) {
    throw new Error("Provider sync completion was not durably recorded.");
  }

  return { provider: providerConfiguration.providerName, checkpoint, results };
}

async function persistRawProviderEvent(details) {
  if (details.externalEventId) {
    const existing = await RawProviderEvent.findOne({
      organizationId: details.organizationId,
      provider: details.provider,
      deviceId: details.deviceId,
      externalEventId: details.externalEventId,
      isDeleted: false,
    });
    if (existing) return { rawEvent: existing, isDuplicateRawEvent: true };
  }

  try {
    const rawEvent = new RawProviderEvent(details);
    await rawEvent.save();
    return { rawEvent, isDuplicateRawEvent: false };
  } catch (error) {
    if (error.code !== 11000 || !details.externalEventId) throw error;
    const existing = await RawProviderEvent.findOne({
      organizationId: details.organizationId,
      provider: details.provider,
      deviceId: details.deviceId,
      externalEventId: details.externalEventId,
      isDeleted: false,
    });
    if (!existing) throw error;
    return { rawEvent: existing, isDuplicateRawEvent: true };
  }
}
async function ensureAttendanceClaimDurable(claimResult, details) {
  if (claimResult.success) return;
  if (claimResult.conflict?.type !== "cross_branch") {
    throw new Error(
      claimResult.conflict?.message || "Attendance claim did not complete.",
    );
  }
  await persistCrossBranchConflict(claimResult, details);
}

async function persistCrossBranchConflict(claimResult, details) {
  const conflict = claimResult.conflict;
  const filter = {
    organizationId: details.organizationId,
    staffId: details.staffId,
    date: details.attendanceDate,
    conflictStatus: "pending",
  };
  const branchIds = [conflict.existingBranch, conflict.attemptedBranch];
  const branchesInvolved = [
    ...new Map(
      branchIds.map((branchId) => [branchId.toString(), { branchId }]),
    ).values(),
  ];

  let persistedConflict;
  try {
    persistedConflict = await AttendanceBranchConflict.findOneAndUpdate(
      filter,
      {
        $setOnInsert: {
          ...filter,
          primaryBranchId: conflict.existingBranch,
          evidence: {
            ...conflict.evidence,
            attemptedPunchAt: details.punchAt,
            attemptedPunchType: details.punchType,
            attemptedExternalEventId: details.externalEventId,
            attemptedPunchId: details.punchId,
          },
          isActive: true,
        },
        $addToSet: { branchesInvolved: { $each: branchesInvolved } },
      },
      { returnDocument: 'after', upsert: true, setDefaultsOnInsert: true },
    );
  } catch (error) {
    if (error.code !== 11000) throw error;
    persistedConflict = await AttendanceBranchConflict.findOneAndUpdate(
      filter,
      { $addToSet: { branchesInvolved: { $each: branchesInvolved } } },
      { returnDocument: 'after' },
    );
    if (!persistedConflict) throw error;
  }

  if (!persistedConflict) {
    throw new Error("Cross-branch attendance conflict was not persisted");
  }
}
function deriveBusinessDate(punchAt, branchTimezone) {
  const date = new Date(punchAt);
  if (!Number.isFinite(date.getTime())) {
    throw new AppError("Punch timestamp is invalid.", 400);
  }

  if (typeof branchTimezone !== "string" || !branchTimezone.trim()) {
    throw new AppError("Branch timezone is not configured.", 400);
  }
  const timezone = branchTimezone.trim();
  let dateParts;
  try {
    dateParts = new Intl.DateTimeFormat("en-CA", {
      timeZone: timezone,
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
    }).formatToParts(date);
  } catch (error) {
    throw new AppError(`Branch timezone '${timezone}' is invalid.`, 400);
  }
  const parts = Object.fromEntries(
    dateParts.map(({ type, value }) => [type, value]),
  );
  return `${parts.year}-${parts.month}-${parts.day}`;
}

function normalizeExternalEventId(value) {
  if (typeof value !== "string") return undefined;
  return value.trim() || undefined;
}

async function reconcileAttendanceStatusFromPunches({
  organizationId,
  branchId,
  staffId,
  attendanceDate,
  branchTimezone,
  attendanceRecord,
}) {
  if (!attendanceRecord?._id || attendanceRecord.isReconciled) return;

  const dayStart = new Date(`${attendanceDate}T00:00:00.000Z`);
  const punches = await AttendancePunch.find({
    organizationId,
    branchId,
    staffId,
    mappingStatus: "mapped",
    punchAt: {
      $gte: new Date(dayStart.getTime() - 24 * 60 * 60 * 1000),
      $lt: new Date(dayStart.getTime() + 48 * 60 * 60 * 1000),
    },
    isDeleted: { $ne: true },
  })
    .select("punchType punchAt")
    .lean();
  const businessDayPunches = punches
    .filter(
      (punch) =>
        deriveBusinessDate(punch.punchAt, branchTimezone) === attendanceDate,
    )
    .sort((left, right) => new Date(left.punchAt) - new Date(right.punchAt));
  // Resolve schedule from StaffRoster (employee shifts) + SettingsResolverService (graceMinutes),
  // NOT from branch.operatingHours.
  let scheduleOptions = { timezone: branchTimezone };
  try {
    const settingsResolver = new SettingsResolverService();
    const [roster, effectiveSettings] = await Promise.all([
      StaffRoster.findOne({
        organizationId,
        branchId,
        staffId,
        isActive: true,
      }).lean(),
      settingsResolver.resolveEffectiveSettings(organizationId, branchId),
    ]);

    const tz = effectiveSettings?.regional?.timezone?.value || branchTimezone;
    const graceMinutes =
      effectiveSettings?.attendance?.graceMinutes?.value ?? 15;
    scheduleOptions = { timezone: tz, graceMinutes };

    if (roster) {
      const dateOverride = (roster.overrides || []).find(
        (o) => o.date === attendanceDate,
      );
      if (dateOverride) {
        if (dateOverride.isWorkingDay && dateOverride.shifts?.length > 0) {
          scheduleOptions.scheduledOpenTime = dateOverride.shifts[0].startTime;
          scheduleOptions.scheduledCloseTime =
            dateOverride.shifts[dateOverride.shifts.length - 1].endTime;
        }
      } else {
        const dayOfWeek = new Date(
          `${attendanceDate}T12:00:00.000Z`,
        ).getUTCDay();
        const weeklyDay = (roster.weeklySchedule || []).find(
          (d) => d.dayOfWeek === dayOfWeek,
        );
        if (
          weeklyDay &&
          weeklyDay.isWorkingDay &&
          weeklyDay.shifts?.length > 0
        ) {
          scheduleOptions.scheduledOpenTime = weeklyDay.shifts[0].startTime;
          scheduleOptions.scheduledCloseTime =
            weeklyDay.shifts[weeklyDay.shifts.length - 1].endTime;
        }
      }
    }
  } catch {
    // Graceful fallback to default derivation
  }

  const status = deriveStatus(businessDayPunches, scheduleOptions);

  const updated = await Attendance.findOneAndUpdate(
    {
      _id: attendanceRecord._id,
      organizationId,
      branchId,
      staffId,
      isDeleted: { $ne: true },
      isReconciled: { $ne: true },
      conflictType: { $in: ["none", null] },
      status: ["present", "late", "early_departure"].includes(status)
        ? { $in: ["incomplete", "present", "late", "early_departure"] }
        : "incomplete",
    },
    { $set: { status } },
    { returnDocument: 'after', runValidators: true },
  );
  if (updated) return updated;

  const current = await Attendance.findOne({
    _id: attendanceRecord._id,
    organizationId,
    branchId,
    staffId,
    isDeleted: { $ne: true },
  })
    .select("_id isReconciled conflictType status")
    .lean();
  const isConflicted =
    current?.conflictType != null && current.conflictType !== "none";
  if (
    current &&
    (current.isReconciled ||
      isConflicted ||
      !["incomplete", "present"].includes(current.status) ||
      (status === "incomplete" && current.status === "present"))
  ) {
    return current;
  }
  throw new Error(
    "Attendance status could not be durably reconciled from provider punches.",
  );
}

// Helper: get scheduled hours from branch operating hours
function getScheduledHours(branch) {
  if (!branch || !branch.operatingHours) return null;
  return branch.operatingHours;
}

// Derive attendance status considering optional schedule/operating hours and grace period
function deriveStatus(punches, options = {}) {
  if (!Array.isArray(punches)) {
    throw new AppError("Punches must be provided as an array.", 400);
  }
  let hasCheckIn = false;
  let firstIn = null;
  let lastOut = null;

  for (const punch of punches) {
    if (punch.punchType === "in") {
      hasCheckIn = true;
      if (!firstIn) firstIn = new Date(punch.punchAt);
    } else if (punch.punchType === "out" && hasCheckIn) {
      lastOut = new Date(punch.punchAt);
    }
  }

  if (!hasCheckIn || !lastOut) {
    return "incomplete";
  }

  // Check if schedule / operating hours comparison is applicable
  const {
    scheduledOpenTime,
    scheduledCloseTime,
    timezone = "Asia/Kolkata",
    graceMinutes = 15,
  } = options;
  if (scheduledOpenTime && firstIn) {
    try {
      const punchTimeStr = new Intl.DateTimeFormat("en-GB", {
        timeZone: timezone,
        hour: "2-digit",
        minute: "2-digit",
        hour12: false,
      }).format(firstIn);
      const [inH, inM] = punchTimeStr.split(":").map(Number);
      const [schH, schM] = scheduledOpenTime.split(":").map(Number);
      const punchMinutes = inH * 60 + inM;
      const scheduledMinutes = schH * 60 + schM;

      if (punchMinutes > scheduledMinutes + graceMinutes) {
        return "late";
      }
    } catch {
      // Fallback to present if timezone formatting encounters unexpected input
    }
  }

  if (scheduledCloseTime && lastOut) {
    try {
      const punchTimeStr = new Intl.DateTimeFormat("en-GB", {
        timeZone: timezone,
        hour: "2-digit",
        minute: "2-digit",
        hour12: false,
      }).format(lastOut);
      const [outH, outM] = punchTimeStr.split(":").map(Number);
      const [closeH, closeM] = scheduledCloseTime.split(":").map(Number);
      const punchMinutes = outH * 60 + outM;
      const scheduledMinutes = closeH * 60 + closeM;

      if (punchMinutes < scheduledMinutes - graceMinutes) {
        return "early_departure";
      }
    } catch {
      // Fallback
    }
  }

  return "present";
}

// Basic punch ingestion schema validation
function validatePunchPayload(payload) {
  const required = ["externalEmployeeCode", "deviceId", "punchType", "punchAt"];
  const missing = required.filter((field) => !payload[field]);
  if (missing.length > 0) {
    return {
      valid: false,
      message: "Missing required fields: " + missing.join(", "),
    };
  }
  return { valid: true };
}
// Provider-independent biometric attendance service
// Handles ingestion, computation, reconciliation and adjustment

/**
 * Record a direct web/mobile punch for staff member.
 * Validates staff identity, branch assignment, prevents consecutive duplicate punches,
 * and durably claims attendance via atomic findOneAndUpdate.
 */
async function recordStaffPunch({
  organizationId,
  branchId,
  staffId,
  punchType,
  actorId,
  notes,
}) {
  if (!["in", "out"].includes(punchType)) {
    throw new AppError('Punch type must be "in" or "out".', 400);
  }

  const branch = await getActiveBranch(organizationId, branchId);
  const branchTimezone = branch.timezone || "Asia/Kolkata";

  // Verify staff active and assigned to branch
  const staff = await Staff.findOne({
    _id: staffId,
    organizationId,
    isDeleted: { $ne: true },
    status: "active",
  });
  if (!staff) {
    throw new AppError("Active staff member was not found.", 404);
  }

  const staffBranch = await StaffBranch.findOne({
    organizationId,
    branchId,
    staffId,
    isActive: true,
  });
  if (!staffBranch) {
    throw new AppError("Staff member is not assigned to this branch.", 403);
  }

  const now = new Date();
  const attendanceDate = deriveBusinessDate(now, branchTimezone);
  const dayStart = new Date(`${attendanceDate}T00:00:00.000Z`);

  // Query recent punches for this staff member today
  const existingPunches = await AttendancePunch.find({
    organizationId,
    staffId,
    punchAt: {
      $gte: new Date(dayStart.getTime() - 24 * 60 * 60 * 1000),
      $lt: new Date(dayStart.getTime() + 48 * 60 * 60 * 1000),
    },
    isDeleted: { $ne: true },
  })
    .sort({ punchAt: 1 })
    .lean();

  const businessDayPunches = existingPunches.filter(
    (p) => deriveBusinessDate(p.punchAt, branchTimezone) === attendanceDate,
  );

  const lastPunch = businessDayPunches[businessDayPunches.length - 1];

  // Prevent consecutive duplicate punches
  if (punchType === "in") {
    if (lastPunch && lastPunch.punchType === "in") {
      throw new AppError(
        "Staff is already clocked in. Clock out before clocking in again.",
        400,
      );
    }
  } else if (punchType === "out") {
    if (!lastPunch || lastPunch.punchType !== "in") {
      throw new AppError("Cannot clock out without an active clock-in.", 400);
    }
  }

  // Create punch record
  const punch = new AttendancePunch({
    organizationId,
    branchId,
    staffId,
    punchType,
    punchAt: now,
    provider: "web_punch",
    deviceSource: "web_app",
    deviceId: "web_portal",
    mappingStatus: "mapped",
    rawPayload: { actorId, notes },
  });
  await punch.save();

  // Atomically claim attendance record
  const claimResult = await Attendance.claimAttendanceRecord({
    organizationId,
    staffId,
    branchId,
    attendanceDate,
    punchType,
  });

  await ensureAttendanceClaimDurable(claimResult, {
    organizationId,
    staffId,
    branchId,
    attendanceDate,
    punchAt: now,
    punchType,
    punchId: punch._id,
  });

  if (!claimResult.success) {
    throw new AppError("Attendance record is claimed by another branch.", 409);
  }

  if (claimResult.success) {
    await reconcileAttendanceStatusFromPunches({
      organizationId,
      branchId,
      staffId,
      attendanceDate,
      branchTimezone,
      attendanceRecord: claimResult.attendanceRecord,
    });
  }

  // Fetch updated record
  const updatedRecord = await Attendance.findOne({
    organizationId,
    staffId,
    attendanceDate: new Date(`${attendanceDate}T00:00:00.000Z`),
    isDeleted: { $ne: true },
  }).lean();

  await AuditLog.create({
    organizationId,
    branchId,
    actorId,
    action: punchType === "in" ? "STAFF_PUNCH_IN" : "STAFF_PUNCH_OUT",
    entityType: "Attendance",
    entityId: updatedRecord?._id || punch._id,
    description: `Staff member ${staff.name} clocked ${punchType} via web portal.`,
    metadata: { staffId, punchType, attendanceDate, punchId: punch._id, notes },
  });

  return {
    punch,
    attendanceRecord: updatedRecord,
    attendanceDate,
    status: updatedRecord?.status || "incomplete",
    attendanceClaim: claimResult.success ? "claimed" : "cross_branch",
  };
}

/**
 * Monthly Muster Roll Summary
 * Aggregates branch attendance by monthYear for all branch staff members.
 * Includes present, late, early_departure, incomplete, approved leaves, and absence.
 */
async function getMonthlyMusterRoll({
  organizationId,
  branchId,
  monthYear,
  search,
  statusFilter,
  accessibleBranchIds = null,
}) {
  if (!monthYear || !/^\d{4}-\d{2}$/.test(monthYear)) {
    throw new AppError("monthYear in YYYY-MM format is required.", 400);
  }

  const [yearStr, monthStr] = monthYear.split("-");
  const year = parseInt(yearStr, 10);
  const month = parseInt(monthStr, 10);

  const totalDaysInMonth = new Date(Date.UTC(year, month, 0)).getUTCDate();
  const startDateStr = `${monthYear}-01`;
  const endDateStr = `${monthYear}-${String(totalDaysInMonth).padStart(2, "0")}`;
  const startDate = new Date(`${startDateStr}T00:00:00.000Z`);
  const endDate = new Date(`${endDateStr}T23:59:59.999Z`);

  // Branch scoping & timezone resolution
  let branchFilter = {};
  let targetBranch = null;
  if (branchId && branchId !== "all") {
    branchFilter = { branchId };
    targetBranch = await Branch.findOne({ _id: branchId, organizationId })
      .select("timezone")
      .lean();
  } else if (
    Array.isArray(accessibleBranchIds) &&
    accessibleBranchIds.length > 0
  ) {
    branchFilter = { branchId: { $in: accessibleBranchIds } };
  }

  const branchTimezone = targetBranch?.timezone || "Asia/Kolkata";

  // Find staff assigned to targeted branches
  const staffBranchQuery = {
    organizationId,
    isActive: true,
    ...branchFilter,
  };
  const staffLinks = await StaffBranch.find(staffBranchQuery)
    .select("staffId branchId")
    .lean();
  const staffIds = [...new Set(staffLinks.map((l) => l.staffId.toString()))];

  const staffQuery = {
    _id: { $in: staffIds },
    organizationId,
    isDeleted: { $ne: true },
    status: "active",
  };

  if (search?.trim()) {
    const matcher = new RegExp(escapeRegex(search.trim()), "i");
    staffQuery.$or = [
      { name: matcher },
      { email: matcher },
      { staffCode: matcher },
      { designation: matcher },
    ];
  }

  const staffMembers = await Staff.find(staffQuery)
    .select("name staffCode email designation joiningDate")
    .sort({ name: 1 })
    .lean();

  const activeStaffIds = staffMembers.map((s) => s._id);

  // Fetch all attendance records in the month for these staff members
  const attendanceQuery = {
    organizationId,
    staffId: { $in: activeStaffIds },
    attendanceDate: { $gte: startDate, $lte: endDate },
    isDeleted: { $ne: true },
    ...branchFilter,
  };
  const attendanceRecords = await Attendance.find(attendanceQuery).lean();

  // Fetch approved leaves in this month
  const leaves = await Leave.find({
    organizationId,
    staffId: { $in: activeStaffIds },
    status: "approved",
    isDeleted: { $ne: true },
    startDate: { $lte: endDate },
    endDate: { $gte: startDate },
  }).lean();

  // Group attendance by staffId -> dateStr -> record
  const attByStaff = new Map();
  for (const att of attendanceRecords) {
    const sId = att.staffId.toString();
    if (!attByStaff.has(sId)) attByStaff.set(sId, new Map());
    const dateKey = new Date(att.attendanceDate).toISOString().slice(0, 10);
    attByStaff.get(sId).set(dateKey, att);
  }

  // Pre-generate list of dates in the month
  const datesInMonth = [];
  for (let d = 1; d <= totalDaysInMonth; d++) {
    datesInMonth.push(`${monthYear}-${String(d).padStart(2, "0")}`);
  }

  // Resolve branch calendar (holidays, closures, weekly offs, special working days)
  const calendarResolver = new CalendarResolverService();
  const resolvedCalendar = await calendarResolver.resolveCalendarRange({
    organizationId,
    branchId: branchId || null,
    startDate: datesInMonth[0],
    endDate: datesInMonth[datesInMonth.length - 1],
  });
  const calendarDayMap = new Map(resolvedCalendar.days.map((d) => [d.date, d]));

  // Fetch active StaffRosters for evaluated staff
  const staffRosters = activeStaffIds.length
    ? await StaffRoster.find({
        organizationId,
        staffId: { $in: activeStaffIds },
        ...(branchId ? { branchId } : {}),
        isActive: true,
      }).lean()
    : [];
  const rosterByStaff = new Map(
    staffRosters.map((r) => [r.staffId.toString(), r]),
  );

  // Today in branch timezone for accurate local absence bounding
  const currentBranchLocalToday = deriveBusinessDate(
    new Date(),
    branchTimezone,
  );

  const staffSummaries = [];
  const consolidatedTotals = {
    totalStaff: staffMembers.length,
    presentDays: 0,
    lateDays: 0,
    earlyDepartureDays: 0,
    incompleteDays: 0,
    approvedPaidLeaveDays: 0,
    approvedUnpaidLeaveDays: 0,
    absentDays: 0,
    totalWorkingDaysEvaluated: 0,
  };

  for (const staff of staffMembers) {
    const sId = staff._id.toString();
    const staffAttMap = attByStaff.get(sId) || new Map();
    const staffLeaves = leaves.filter((l) => l.staffId.toString() === sId);

    let presentCount = 0;
    let lateCount = 0;
    let earlyCount = 0;
    let incompleteCount = 0;
    let paidLeaveCount = 0;
    let unpaidLeaveCount = 0;
    let absentCount = 0;
    let eligibleDays = 0;

    const dailyBreakdown = {};

    for (const dateStr of datesInMonth) {
      // Check joining date
      const joiningDateStr = staff.joiningDate
        ? new Date(staff.joiningDate).toISOString().slice(0, 10)
        : "1970-01-01";
      if (dateStr < joiningDateStr) {
        dailyBreakdown[dateStr] = { status: "not_joined", date: dateStr };
        continue;
      }

      eligibleDays++;
      const att = staffAttMap.get(dateStr);

      // Check leave on this date
      const activeLeave = staffLeaves.find((l) => {
        if (Array.isArray(l.dates) && l.dates.length > 0) {
          return l.dates.includes(dateStr);
        }
        const s = new Date(l.startDate).toISOString().slice(0, 10);
        const e = new Date(l.endDate).toISOString().slice(0, 10);
        return dateStr >= s && dateStr <= e;
      });

      if (att) {
        dailyBreakdown[dateStr] = {
          status: att.status,
          date: dateStr,
          attendanceId: att._id,
          isReconciled: att.isReconciled,
        };
        if (att.status === "present") {
          presentCount++;
        } else if (att.status === "late") {
          presentCount++;
          lateCount++;
        } else if (att.status === "early_departure") {
          presentCount++;
          earlyCount++;
        } else if (att.status === "incomplete") {
          incompleteCount++;
        }
      } else if (activeLeave) {
        const isUnpaid =
          activeLeave.isUnpaid === true ||
          (typeof activeLeave.leaveType === "string" &&
            (activeLeave.leaveType.toLowerCase().includes("unpaid") ||
              activeLeave.leaveType.toLowerCase().includes("lop")));
        if (isUnpaid) {
          unpaidLeaveCount++;
          dailyBreakdown[dateStr] = {
            status: "unpaid_leave",
            date: dateStr,
            leaveId: activeLeave._id,
            isHalfDay: Boolean(activeLeave.isPartialDay),
          };
        } else {
          paidLeaveCount++;
          dailyBreakdown[dateStr] = {
            status: "paid_leave",
            date: dateStr,
            leaveId: activeLeave._id,
            isHalfDay: Boolean(activeLeave.isPartialDay),
          };
        }
      } else {
        const calDay = calendarDayMap.get(dateStr);
        const staffRoster = rosterByStaff.get(sId);
        let rosterOff = false;
        if (staffRoster && calDay?.status !== "special_working_day") {
          const override = (staffRoster.overrides || []).find(
            (o) => o.date === dateStr,
          );
          if (override) {
            rosterOff = !override.isWorkingDay;
          } else {
            const dow = new Date(`${dateStr}T12:00:00.000Z`).getUTCDay();
            const wd = (staffRoster.weeklySchedule || []).find(
              (w) => w.dayOfWeek === dow,
            );
            if (wd && !wd.isWorkingDay) rosterOff = true;
          }
        }

        if (calDay?.status === "branch_closure") {
          dailyBreakdown[dateStr] = {
            status: "branch_closure",
            date: dateStr,
            isWorkingDay: false,
          };
        } else if (calDay?.status === "holiday") {
          dailyBreakdown[dateStr] = {
            status: "holiday",
            date: dateStr,
            isWorkingDay: false,
            eventName: calDay.event?.name || null,
          };
        } else if (calDay?.status === "weekly_off" || rosterOff) {
          dailyBreakdown[dateStr] = {
            status: "weekly_off",
            date: dateStr,
            isWorkingDay: false,
          };
        } else if (dateStr < currentBranchLocalToday) {
          // Day has fully elapsed with no attendance, no leave, and is a working day -> absent
          absentCount++;
          dailyBreakdown[dateStr] = { status: "absent", date: dateStr };
        } else {
          // Today without attendance yet or future day -> scheduled (not absent)
          dailyBreakdown[dateStr] = { status: "scheduled", date: dateStr };
        }
      }
    }

    const summary = {
      staff: {
        _id: staff._id,
        name: staff.name,
        staffCode: staff.staffCode,
        designation: staff.designation,
      },
      metrics: {
        totalDaysInMonth,
        eligibleDays,
        presentDays: presentCount,
        lateDays: lateCount,
        earlyDepartureDays: earlyCount,
        incompleteDays: incompleteCount,
        approvedPaidLeaveDays: paidLeaveCount,
        approvedUnpaidLeaveDays: unpaidLeaveCount,
        absentDays: absentCount,
      },
      dailyBreakdown,
    };

    staffSummaries.push(summary);

    consolidatedTotals.presentDays += presentCount;
    consolidatedTotals.lateDays += lateCount;
    consolidatedTotals.earlyDepartureDays += earlyCount;
    consolidatedTotals.incompleteDays += incompleteCount;
    consolidatedTotals.approvedPaidLeaveDays += paidLeaveCount;
    consolidatedTotals.approvedUnpaidLeaveDays += unpaidLeaveCount;
    consolidatedTotals.absentDays += absentCount;
    consolidatedTotals.totalWorkingDaysEvaluated += eligibleDays;
  }

  // Filter if statusFilter applied
  const filteredSummaries =
    statusFilter && statusFilter !== "all"
      ? staffSummaries.filter((s) => {
          if (statusFilter === "present") return s.metrics.presentDays > 0;
          if (statusFilter === "late") return s.metrics.lateDays > 0;
          if (statusFilter === "early_departure")
            return s.metrics.earlyDepartureDays > 0;
          if (statusFilter === "incomplete")
            return s.metrics.incompleteDays > 0;
          if (statusFilter === "absent") return s.metrics.absentDays > 0;
          if (statusFilter === "leave")
            return (
              s.metrics.approvedPaidLeaveDays > 0 ||
              s.metrics.approvedUnpaidLeaveDays > 0
            );
          return true;
        })
      : staffSummaries;

  return {
    monthYear,
    branchId: branchId || "all",
    totalStaff: staffMembers.length,
    dates: datesInMonth,
    consolidatedTotals,
    musterRoll: filteredSummaries,
  };
}

async function upsertProviderConfiguration({
  organizationId,
  branchId,
  actorId,
  providerName,
  endpointUrl,
  integrationMethod,
  isActive = true,
  credentials,
  headers,
}) {
  const cleanProvider = (providerName || "").trim();
  const supportedProviders = providerRegistry.listAdapters();
  if (!supportedProviders.includes(cleanProvider)) {
    throw new AppError(
      `Unsupported attendance provider: "${cleanProvider}".`,
      400,
    );
  }

  const allowedMethods = ["webhook", "polling", "file"];
  if (integrationMethod && !allowedMethods.includes(integrationMethod)) {
    throw new AppError(
      `Invalid integrationMethod "${integrationMethod}". Must be one of: ${allowedMethods.join(", ")}.`,
      400,
    );
  }

  const updateFields = {
    isActive: Boolean(isActive),
    updatedBy: actorId,
  };
  if (endpointUrl !== undefined)
    updateFields.endpointUrl = endpointUrl?.trim() || "";
  if (integrationMethod !== undefined)
    updateFields.integrationMethod = integrationMethod;
  if (
    credentials !== undefined &&
    typeof credentials === "object" &&
    credentials !== null
  ) {
    updateFields.credentials = encryptCredentials(credentials);
  }
  if (
    headers !== undefined &&
    typeof headers === "object" &&
    headers !== null
  ) {
    updateFields.headers = headers;
  }

  const doc = await ProviderConfiguration.findOneAndUpdate(
    { organizationId, branchId, providerName: cleanProvider },
    {
      $set: updateFields,
      $setOnInsert: {
        organizationId,
        branchId,
        providerName: cleanProvider,
        createdBy: actorId,
      },
    },
    { returnDocument: 'after', upsert: true, runValidators: true },
  ).lean();

  return {
    _id: doc._id,
    providerName: doc.providerName,
    endpointUrl: doc.endpointUrl || "",
    integrationMethod: doc.integrationMethod || null,
    isActive: doc.isActive,
    syncStatus: doc.syncStatus,
    hasCredentials: Boolean(
      doc.credentials && Object.keys(doc.credentials).length > 0,
    ),
    updatedAt: doc.updatedAt,
  };
}

async function toggleProviderConfigurationStatus({
  organizationId,
  branchId,
  actorId,
  providerName,
  isActive,
}) {
  const cleanProvider = (providerName || "").trim();
  const doc = await ProviderConfiguration.findOneAndUpdate(
    { organizationId, branchId, providerName: cleanProvider },
    { $set: { isActive: Boolean(isActive), updatedBy: actorId } },
    { returnDocument: 'after' },
  ).lean();

  if (!doc) {
    throw new AppError(
      `No configuration found for provider "${cleanProvider}" at this branch.`,
      404,
    );
  }

  return {
    _id: doc._id,
    providerName: doc.providerName,
    endpointUrl: doc.endpointUrl || "",
    integrationMethod: doc.integrationMethod || null,
    isActive: doc.isActive,
    syncStatus: doc.syncStatus,
  };
}

async function adjustAttendancePunch({
  organizationId,
  branchId,
  actorId,
  punchId,
  action,
  reason,
}) {
  if (!["toggle_type", "mark_duplicate"].includes(action)) {
    throw new AppError("Invalid punch adjustment action.", 400);
  }
  const cleanReason = typeof reason === "string" ? reason.trim() : "";
  if (cleanReason.length < 3 || cleanReason.length > 1000) {
    throw new AppError(
      "A reason between 3 and 1000 characters is required.",
      400,
    );
  }

  const branch = await getActiveBranch(organizationId, branchId);
  const punch = await AttendancePunch.findOne({
    _id: punchId,
    organizationId,
    branchId,
    isDeleted: false,
  });
  if (!punch) {
    throw new AppError("Attendance punch not found.", 404);
  }

  const attendanceDate = deriveBusinessDate(punch.punchAt, branch.timezone);
  const dayPunches = await AttendancePunch.find({
    organizationId,
    branchId,
    staffId: punch.staffId,
    isDeleted: false,
  })
    .sort({ punchAt: 1 })
    .lean();

  const previousValue = {
    punchId: punch._id,
    punchType: punch.punchType,
    isDeleted: punch.isDeleted,
  };

  if (action === "toggle_type") {
    punch.punchType = punch.punchType === "in" ? "out" : "in";
  } else if (action === "mark_duplicate") {
    punch.isDeleted = true;
    punch.deletedAt = new Date();
    punch.deletedBy = actorId;
  }
  punch.updatedBy = actorId;
  await punch.save();

  const newValue = {
    punchId: punch._id,
    punchType: punch.punchType,
    isDeleted: punch.isDeleted,
  };

  const record = await Attendance.findOne({
    organizationId,
    branchId,
    staffId: punch.staffId,
    attendanceDate: new Date(`${attendanceDate}T00:00:00.000Z`),
    isDeleted: false,
  });

  if (record) {
    if (!record.originalPunchSnapshot) {
      record.originalPunchSnapshot = dayPunches.filter(
        (p) => deriveBusinessDate(p.punchAt, branch.timezone) === attendanceDate,
      );
    }
    record.adjustmentHistory = record.adjustmentHistory || [];
    record.adjustmentHistory.push({
      changedBy: actorId,
      changedAt: new Date(),
      reason: cleanReason,
      previousStatus: record.status,
      newStatus: record.status,
      action,
      previousValue,
      newValue,
    });
    record.updatedBy = actorId;
    await record.save();

    await AuditLog.create({
      organizationId,
      branchId,
      actorId,
      entityType: "Attendance",
      entityId: record._id,
      action: `PUNCH_${action.toUpperCase()}`,
      description: `Adjusted punch (${previousValue.punchType} -> ${action === "mark_duplicate" ? "deleted" : newValue.punchType}): ${cleanReason}`,
      metadata: { previousValue, newValue, reason: cleanReason },
    });
  }

  await reconcileAttendanceStatusFromPunches({
    organizationId,
    branchId,
    staffId: punch.staffId,
    attendanceDate,
  });

  return { punch, attendanceDate };
}

async function bulkAdjustAttendanceRecords({
  organizationId,
  branchId,
  actorId,
  items,
  status,
  reason,
}) {
  if (!Array.isArray(items) || items.length === 0) {
    throw new AppError("At least one attendance item is required.", 400);
  }
  if (!ATTENDANCE_STATUSES.includes(status)) {
    throw new AppError("Attendance status is invalid.", 400);
  }
  const cleanReason = typeof reason === "string" ? reason.trim() : "";
  if (cleanReason.length < 3 || cleanReason.length > 1000) {
    throw new AppError(
      "A reason between 3 and 1000 characters is required.",
      400,
    );
  }

  const results = await Promise.allSettled(
    items.map((item) =>
      adjustAttendanceRecord({
        organizationId,
        branchId,
        actorId,
        staffId: item.staffId,
        date: item.date,
        status,
        reason: cleanReason,
      }),
    ),
  );

  const failedItems = [];
  let updatedCount = 0;
  results.forEach((res, idx) => {
    if (res.status === "fulfilled") {
      updatedCount += 1;
    } else {
      failedItems.push({
        staffId: items[idx]?.staffId,
        date: items[idx]?.date,
        error: res.reason?.message || "Failed to adjust record",
      });
    }
  });

  return { updatedCount, failedItems };
}

export {
  deriveBusinessDate,
  getScheduledHours,
  deriveStatus,
  validatePunchPayload,
  ingestProviderEvents,
  listAttendanceRecords,
  getStaffAttendanceDetail,
  adjustAttendanceRecord,
  bulkAdjustAttendanceRecords,
  adjustAttendancePunch,
  recordStaffPunch,
  getMonthlyMusterRoll,
  listLeaveAppointmentConflicts,
  resolveLeaveAppointmentConflict,
  recordLeaveException,
  listBranchAttendanceConflicts,
  resolveBranchAttendanceConflict,
  recoverReconciliationAuditLog,
  getProviderStatus,
  upsertProviderConfiguration,
  toggleProviderConfigurationStatus,
  listStaffDeviceMappings,
  getStaffDeviceMappingById,
  createStaffDeviceMapping,
  updateStaffDeviceMapping,
  deactivateStaffDeviceMapping,
};
