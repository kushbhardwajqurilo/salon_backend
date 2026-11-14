import { Attendance } from '../../models/attendance/attendance.model.js';
import { AttendancePunch } from '../../models/attendance/attendancePunch.model.js';
import { StaffDeviceMapping } from '../../models/attendance/StaffDeviceMapping.model.js';
import { ProviderConfiguration } from '../../models/attendance/ProviderConfiguration.model.js';
import { RawProviderEvent } from '../../models/attendance/RawProviderEvent.model.js';
import { ProviderSyncState } from '../../models/attendance/ProviderSyncState.model.js';
import { ProviderDeliveryLog } from '../../models/attendance/ProviderDeliveryLog.model.js';
import { AttendanceLeaveException } from '../../models/attendance/AttendanceLeaveException.model.js';
import {
  AttendanceBranchConflict,
  AttendanceLeaveAppointmentConflict,
} from '../../models/attendance/AttendanceLeaveAppointmentConflict.model.js';
import { Branch } from '../../models/branches/branch.model.js';
import { Staff } from '../../models/staff/staff.model.js';
import { StaffBranch } from '../../models/staff/staffBranch.model.js';
import { Leave } from '../../models/leaves/leave.model.js';
import { Appointment } from '../../models/appointments/appointment.model.js';
import { AuditLog } from '../../models/audit/auditLog.model.js';
import providerRegistry from '../../providers/attendance/provider.registry.js';
import { AppError } from '../../utils/errors.js';

const ATTENDANCE_STATUSES = ['present', 'late', 'early_departure', 'incomplete'];

function assertDateOnly(value) {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)) {
    throw new AppError('A valid attendance date in YYYY-MM-DD format is required.', 400);
  }
  const parsed = new Date(`${value}T00:00:00.000Z`);
  if (!Number.isFinite(parsed.getTime()) || parsed.toISOString().slice(0, 10) !== value) {
    throw new AppError('Attendance date is invalid.', 400);
  }
  return value;
}

function escapeRegex(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
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
      { dates: { $size: 0 }, startDate: { $lt: end }, endDate: { $gte: start } },
    ],
  };
}

async function getActiveBranch(organizationId, branchId) {
  const branch = await Branch.findOne({ _id: branchId, organizationId, isActive: true });
  if (!branch) throw new AppError('Active branch was not found.', 404);
  return branch;
}

async function listAttendanceRecords({ organizationId, branchId, date, search, status }) {
  const attendanceDate = assertDateOnly(date);
  const branch = await getActiveBranch(organizationId, branchId);
  const staffLinks = await StaffBranch.find({ organizationId, branchId, isActive: true }).select('staffId').lean();
  const staffIds = staffLinks.map(({ staffId }) => staffId);
  const staffFilter = {
    _id: { $in: staffIds },
    organizationId,
    isDeleted: { $ne: true },
    status: 'active',
  };
  if (search?.trim()) {
    const matcher = new RegExp(escapeRegex(search.trim()), 'i');
    staffFilter.$or = [{ name: matcher }, { email: matcher }, { staffCode: matcher }, { designation: matcher }];
  }
  const staff = await Staff.find(staffFilter)
    .select('name staffCode email designation status')
    .sort({ name: 1 })
    .lean();
  const staffById = new Map(staff.map((person) => [person._id.toString(), person]));
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
  const recordByStaff = new Map(records.map((record) => [record.staffId.toString(), record]));
  const { start, end } = dateWindow(attendanceDate);
  const punches = ids.length
    ? await AttendancePunch.find({
        organizationId,
        branchId,
        staffId: { $in: ids },
        punchAt: { $gte: new Date(start.getTime() - 24 * 60 * 60 * 1000), $lt: new Date(end.getTime() + 24 * 60 * 60 * 1000) },
        isDeleted: { $ne: true },
      }).select('staffId punchType punchAt mappingStatus externalEventId')
        .sort({ punchAt: 1 })
        .lean()
    : [];
  const punchesByStaff = new Map();
  for (const punch of punches) {
    if (deriveBusinessDate(punch.punchAt, branch.timezone) !== attendanceDate) continue;
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
      status: record?.status || (attendanceDate <= currentDate ? 'missing_punch' : 'not_started'),
    };
  });
  return {
    date: attendanceDate,
    timezone: branch.timezone,
    operatingHours: branch.operatingHours || null,
    data: status ? result.filter((item) => item.status === status) : result,
    total: status ? result.filter((item) => item.status === status).length : result.length,
  };
}

async function getStaffAttendanceDetail({ organizationId, branchId, staffId, date }) {
  const attendanceDate = assertDateOnly(date);
  const branch = await getActiveBranch(organizationId, branchId);
  const staffLink = await StaffBranch.findOne({ organizationId, branchId, staffId, isActive: true });
  const staff = staffLink && await Staff.findOne({
    _id: staffId,
    organizationId,
    isDeleted: { $ne: true },
  }).select('name staffCode email designation status').lean();
  if (!staff) throw new AppError('Staff member was not found in this branch.', 404);

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
      punchAt: { $gte: new Date(start.getTime() - 24 * 60 * 60 * 1000), $lt: new Date(end.getTime() + 24 * 60 * 60 * 1000) },
      isDeleted: { $ne: true },
    }).sort({ punchAt: 1 }).lean(),
    Leave.find({
      organizationId,
      branchId,
      staffId,
      status: 'approved',
      isDeleted: { $ne: true },
      ...leaveDateCondition(attendanceDate),
    }).select('leaveCode leaveType startDate endDate dates status').lean(),
  ]);
  const punches = rawPunches.filter((punch) => deriveBusinessDate(punch.punchAt, branch.timezone) === attendanceDate);
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
        entityType: 'Attendance',
        entityId: record._id,
      }).sort({ createdAt: -1 }).lean()
    : [];
  return {
    date: attendanceDate,
    timezone: branch.timezone,
    operatingHours: branch.operatingHours || null,
    staff,
    record,
    status: record?.status || 'missing_punch',
    punches,
    approvedLeaves,
    exceptions,
    appointmentConflicts,
    auditHistory,
  };
}

async function adjustAttendanceRecord({ organizationId, branchId, actorId, staffId, date, status, reason }) {
  const attendanceDate = assertDateOnly(date);
  if (!ATTENDANCE_STATUSES.includes(status)) throw new AppError('Attendance status is invalid.', 400);
  const cleanReason = typeof reason === 'string' ? reason.trim() : '';
  if (cleanReason.length < 3 || cleanReason.length > 1000) {
    throw new AppError('A reason between 3 and 1000 characters is required.', 400);
  }
  const branch = await getActiveBranch(organizationId, branchId);
  const staffLink = await StaffBranch.findOne({ organizationId, branchId, staffId, isActive: true });
  const staff = staffLink && await Staff.findOne({
    _id: staffId,
    organizationId,
    isDeleted: { $ne: true },
    status: 'active',
  });
  if (!staff) throw new AppError('Active staff member was not found in this branch.', 404);

  const claim = await Attendance.claimAttendanceRecord({
    organizationId,
    staffId,
    branchId,
    attendanceDate,
    punchType: 'manual_adjustment',
  });
  await ensureAttendanceClaimDurable(claim, {
    organizationId,
    staffId,
    branchId,
    attendanceDate,
    punchAt: new Date(),
    punchType: 'manual_adjustment',
  });
  if (!claim.success) throw new AppError('Attendance record is claimed by another branch.', 409);

  const record = await Attendance.findOne({
    organizationId,
    branchId,
    staffId,
    attendanceDate: new Date(`${attendanceDate}T00:00:00.000Z`),
    isDeleted: { $ne: true },
  });
  if (!record) throw new AppError('Attendance claim could not be loaded.', 500);
  const previousStatus = record.status;
  const changedAt = new Date();
  const updated = await Attendance.findOneAndUpdate(
    { _id: record._id, organizationId, branchId, isDeleted: { $ne: true } },
    {
      $set: { status, isReconciled: true, reconciliationReason: cleanReason, reconciledBy: actorId, reconciledAt: changedAt },
      $push: { adjustmentHistory: { previousStatus, newStatus: status, reason: cleanReason, actorId, changedAt } },
    },
    { new: true, runValidators: true },
  ).lean();
  if (!updated) throw new AppError('Attendance record could not be updated.', 409);
  return updated;
}

async function getAppointmentConflictsForStaff({ organizationId, branchId, staffId, date, leaves }) {
  if (!leaves.length) return [];
  const appointments = await Appointment.find({
    organizationId,
    branchId,
    staffId,
    appointmentDate: date,
    status: { $in: ['scheduled', 'in_progress'] },
    isDeleted: { $ne: true },
  }).select('appointmentCode appointmentDate startAt endAt status staffId').lean();
  const leaveIds = leaves.map(({ _id }) => _id.toString());
  const resolved = leaveIds.length && appointments.length
    ? await AttendanceLeaveAppointmentConflict.find({
        organizationId,
        leaveId: { $in: leaves.map(({ _id }) => _id) },
        conflictAppointmentId: { $in: appointments.map(({ _id }) => _id) },
        status: 'resolved',
      }).select('leaveId conflictAppointmentId reason resolvedAt').lean()
    : [];
  const resolvedPairs = new Set(resolved.map((item) => `${item.leaveId}:${item.conflictAppointmentId}`));
  return leaves.flatMap((leave) => appointments.map((appointment) => ({
    leaveId: leave._id,
    leaveCode: leave.leaveCode,
    appointmentId: appointment._id,
    appointmentCode: appointment.appointmentCode,
    appointmentDate: appointment.appointmentDate,
    startAt: appointment.startAt,
    endAt: appointment.endAt,
    status: resolvedPairs.has(`${leave._id}:${appointment._id}`) ? 'resolved' : 'pending',
    resolution: resolved.find((item) => `${item.leaveId}:${item.conflictAppointmentId}` === `${leave._id}:${appointment._id}`) || null,
  })));
}

async function listLeaveAppointmentConflicts({ organizationId, branchId, date }) {
  const attendanceDate = assertDateOnly(date);
  const { end } = dateWindow(attendanceDate);
  const leaves = await Leave.find({
    organizationId,
    branchId,
    status: 'approved',
    isDeleted: { $ne: true },
    ...leaveDateCondition(attendanceDate),
  }).select('leaveCode staffId dates startDate endDate').lean();
  const results = [];
  for (const leave of leaves) {
    const conflicts = await getAppointmentConflictsForStaff({
      organizationId,
      branchId,
      staffId: leave.staffId,
      date: attendanceDate,
      leaves: [leave],
    });
    const staff = await Staff.findOne({ _id: leave.staffId, organizationId }).select('name staffCode').lean();
    results.push(...conflicts.map((conflict) => ({ ...conflict, staff })));
  }
  return { date: attendanceDate, data: results, total: results.length };
}

async function resolveLeaveAppointmentConflict({ organizationId, branchId, actorId, leaveId, appointmentId, date, reason }) {
  const attendanceDate = assertDateOnly(date);
  const cleanReason = typeof reason === 'string' ? reason.trim() : '';
  if (cleanReason.length < 3 || cleanReason.length > 1000) {
    throw new AppError('A reason between 3 and 1000 characters is required.', 400);
  }
  const leave = await Leave.findOne({
    _id: leaveId,
    organizationId,
    branchId,
    status: 'approved',
    isDeleted: { $ne: true },
    ...leaveDateCondition(attendanceDate),
  });
  const appointment = await Appointment.findOne({
    _id: appointmentId,
    organizationId,
    branchId,
    appointmentDate: attendanceDate,
    status: { $in: ['scheduled', 'in_progress'] },
    isDeleted: { $ne: true },
  });
  if (!leave || !appointment || String(leave.staffId) !== String(appointment.staffId)) {
    throw new AppError('An active approved-leave appointment conflict was not found.', 404);
  }
  const conflict = await AttendanceLeaveAppointmentConflict.findOneAndUpdate(
    { organizationId, leaveId, conflictAppointmentId: appointmentId, status: 'pending' },
    {
      $setOnInsert: { organizationId, leaveId, conflictAppointmentId: appointmentId, status: 'pending', isActive: true },
    },
    { new: true, upsert: true, setDefaultsOnInsert: true },
  );
  if (!conflict) throw new AppError('Conflict could not be recorded.', 500);
  conflict.status = 'resolved';
  conflict.resolution = 'retain';
  conflict.reason = cleanReason;
  conflict.resolvedBy = actorId;
  conflict.resolvedAt = new Date();
  await conflict.save();
  await AuditLog.create({
    organizationId,
    branchId,
    actorId,
    action: 'ATTENDANCE_CONFLICT_RESOLVED',
    entityType: 'AttendanceLeaveAppointmentConflict',
    entityId: conflict._id,
    description: `Approved-leave appointment conflict retained for ${attendanceDate}.`,
    metadata: { leaveId, appointmentId, date: attendanceDate, resolution: 'retain', reason: cleanReason },
  });
  return conflict;
}

async function recordLeaveException({ organizationId, branchId, actorId, leaveId, date, decision, reason }) {
  const resolvedDate = assertDateOnly(date);
  const cleanReason = typeof reason === 'string' ? reason.trim() : '';
  if (cleanReason.length < 3 || cleanReason.length > 1000) {
    throw new AppError('A reason between 3 and 1000 characters is required.', 400);
  }
  if (!['worked', 'absent', 'half-day'].includes(decision)) {
    throw new AppError('Leave exception decision is invalid.', 400);
  }
  const leave = await Leave.findOne({
    _id: leaveId,
    organizationId,
    branchId,
    status: 'approved',
    isDeleted: { $ne: true },
    ...leaveDateCondition(resolvedDate),
  });
  if (!leave) throw new AppError('Approved leave was not found for this date.', 404);
  const exception = await AttendanceLeaveException.findOneAndUpdate(
    { organizationId, leaveId, resolvedDate, isActive: true },
    {
      $set: { decision, reason: cleanReason, resolvedBy: actorId, resolvedAt: new Date() },
      $setOnInsert: { organizationId, leaveId, resolvedDate, isActive: true },
    },
    { new: true, upsert: true, setDefaultsOnInsert: true, runValidators: true },
  );
  await AuditLog.create({
    organizationId,
    branchId,
    actorId,
    action: 'ATTENDANCE_LEAVE_EXCEPTION_RECORDED',
    entityType: 'AttendanceLeaveException',
    entityId: exception._id,
    description: `Attendance leave exception recorded for ${resolvedDate}.`,
    metadata: { leaveId, date: resolvedDate, decision, reason: cleanReason },
  });
  return exception;
}

async function listBranchAttendanceConflicts({ organizationId, branchId }) {
  return AttendanceBranchConflict.find({
    organizationId,
    conflictStatus: 'pending',
    branchesInvolved: { $elemMatch: { branchId } },
  }).populate('staffId', 'name staffCode').populate('branchesInvolved.branchId', 'name').sort({ date: -1 }).lean();
}

async function resolveBranchAttendanceConflict({ organizationId, branchId, actorId, conflictId, reason }) {
  const cleanReason = typeof reason === 'string' ? reason.trim() : '';
  if (cleanReason.length < 3 || cleanReason.length > 1000) {
    throw new AppError('A reason between 3 and 1000 characters is required.', 400);
  }
  const conflict = await AttendanceBranchConflict.findOne({
    _id: conflictId,
    organizationId,
    conflictStatus: 'pending',
    branchesInvolved: { $elemMatch: { branchId } },
  });
  if (!conflict) throw new AppError('Pending branch conflict was not found in this branch.', 404);
  conflict.conflictStatus = 'resolved';
  conflict.resolution = 'retain';
  conflict.reason = cleanReason;
  conflict.resolvedBy = actorId;
  conflict.resolvedAt = new Date();
  await conflict.save();
  await AuditLog.create({
    organizationId,
    branchId,
    actorId,
    action: 'ATTENDANCE_CONFLICT_RESOLVED',
    entityType: 'AttendanceBranchConflict',
    entityId: conflict._id,
    description: 'Cross-branch attendance evidence retained and conflict resolved.',
    metadata: { reason: cleanReason, resolution: 'retain', date: conflict.date },
  });
  return conflict;
}

async function getProviderStatus({ organizationId, branchId }) {
  const [configurations, syncStates] = await Promise.all([
    ProviderConfiguration.find({ organizationId, branchId })
      .select('providerName integrationMethod isActive syncStatus lastSync lastErrorAt')
      .lean(),
    ProviderSyncState.find({ organizationId, branchId }).sort({ updatedAt: -1 }).lean(),
  ]);
  return {
    supportedProviders: providerRegistry.listAdapters(),
    configurations,
    syncStates: syncStates.map(({ _id, provider, deviceId, streamIdentifier, syncStatus, outcome, lastSuccessfulCheckpoint, lastError, lastAttemptedAt, lastSuccessfulAt, processedCount, eventCount }) => ({
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
    })),
  };
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
  const conflict = await AttendanceLeaveAppointmentConflict.findById(conflictId);

  if (!conflict) throw new Error('Conflict not found');

  const { resolution, reason, staffId } = resolutionData;

  if (resolution === 'retain') {
    conflict.status = 'resolved';
    conflict.resolution = resolution;
    conflict.resolvedBy = actorId;
    conflict.resolvedAt = new Date();
    conflict.reason = reason;
    await conflict.save();
    return conflict;
  }

  if (resolution === 'reassign') {
    const staff = await Staff.findById(staffId);
    if (!staff || !staff.isActive) throw new Error('Staff not active');

    conflict.appointment.conflictAppointmentId.staffId = staffId;
    conflict.appointment.version += 1;
    conflict.status = 'resolved';
    conflict.resolution = resolution;
    conflict.resolvedBy = actorId;
    conflict.resolvedAt = new Date();
    conflict.reason = reason;
    await conflict.save();
    await conflict.appointment.save();
    return conflict;
  }

  if (resolution === 'cancel') {
    conflict.appointment.status = 'cancelled';
    conflict.appointment.cancellation = {
      cancelledBy: actorId,
      cancelledAt: new Date(),
      reason,
    };
    conflict.status = 'resolved';
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
    status: 'pending',
  }).populate('leaveId conflictAppointmentId');
}
async function listConflicts(filters = {}) {
  const { organizationId, branchId, dateFrom, dateTo } = filters;
  const query = { conflictType: 'leave', isReconciled: false };
  if (organizationId) query.organizationId = organizationId;
  if (branchId) query.branchId = branchId;

  return await Attendance.find(query).populate('conflictLeaveId');
}
async function adjustAttendance(attendanceId, adjustmentData, actorId) {
  const { status, reason } = adjustmentData;
  const attendance = await Attendance.findById(attendanceId);

  if (!attendance) throw new Error('Attendance record not found');

  const previousStatus = attendance.status;
  attendance.status = status || attendance.status;
  attendance.adjustmentReason = reason;
  attendance.updatedBy = actorId;
  attendance.auditHistory = attendance.auditHistory || [];
  attendance.auditHistory.push({
    action: 'attendance_adjustment',
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

  if (!attendance) throw new Error('Attendance record not found');
  if (attendance.isReconciled) throw new Error('Attendance already reconciled');

  const leave = await Leave.findById(attendance.conflictLeaveId);
  if (!leave) throw new Error('Leave record not found');

  if (resolution === 'accept_punch') {
    if (leave.dates) {
      leave.dates = leave.dates.filter(d => d !== resolvedDate);
    }
    if (leave.dates && leave.dates.length === 0) {
      leave.status = 'cancelled';
    }
    await leave.save();

    await AttendanceLeaveException.findOneAndUpdate(
      { leaveId: conflictData.leaveId, resolvedDate },
      { decision: 'worked', reason, isActive: true, resolvedBy: conflictData.actorId, resolvedAt: new Date() },
      { upsert: true, new: true }
    );

    attendance.status = 'present';
    attendance.isReconciled = true;
    attendance.reconciliationReason = reason;
    attendance.reconciledBy = conflictData.actorId;
    attendance.reconciledAt = new Date();
  }
  else if (resolution === 'reject_punch') {
    attendance.status = 'absent';
    attendance.isReconciled = true;
    attendance.reconciliationReason = reason;
    attendance.reconciledBy = conflictData.actorId;
    attendance.reconciledAt = new Date();
  }
  else if (resolution === 'mark_absent') {
    attendance.status = 'absent';
    attendance.isReconciled = true;
    attendance.reconciliationReason = reason;
    attendance.reconciledBy = conflictData.actorId;
    attendance.reconciledAt = new Date();
  }

  attendance.conflictType = 'leave';
  attendance.conflictLeaveId = conflictData.leaveId;
  attendance.leaveDayResolved = true;

  await attendance.save();
  return attendance;
}
async function ingestProviderPunch(punchData, organizationId, branchId, branchTimezone) {
  const { externalEmployeeCode, deviceId, punchType, punchAt, rawPayload } = punchData;
  const provider = punchData.provider;
  const externalEventId = normalizeExternalEventId(punchData.externalEventId);
  const isValidMappingKey = typeof externalEmployeeCode === 'string' && externalEmployeeCode.trim();

  if (!provider || !deviceId || !punchAt || !['in', 'out'].includes(punchType)) {
    throw new AppError('Provider event is missing required canonical punch fields.', 400);
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
        throw new Error('Original attendance branch is unavailable for duplicate recovery.');
      }

      const attendanceDate = deriveBusinessDate(existingPunch.punchAt, originalBranch.timezone);
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
      return {
        punch: existingPunch,
        isDuplicate: true,
        mappingStatus: existingPunch.mappingStatus,
        attendanceClaim: claimResult.success ? 'recovered' : 'cross_branch',
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
  const mappingStatus = staffId ? 'mapped' : 'unmapped';
  const { rawEvent, isDuplicateRawEvent } = await persistRawProviderEvent({
    organizationId,
    provider,
    deviceId,
    externalEventId,
    rawPayload,
    mappingStatus,
  });
  if (mappingStatus === 'mapped' && rawEvent.mappingStatus !== 'mapped') {
    rawEvent.mappingStatus = 'mapped';
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

  const punch = new AttendancePunch({
    organizationId,
    branchId,
    staffId,
    punchType,
    punchAt,
    provider,
    externalEventId,
    deviceId,
    deviceSource: punchData.deviceSource,
    mappingStatus,
    rawEvent: rawPayload,
  });
  await punch.save();

  const attendanceDate = deriveBusinessDate(punchAt, branchTimezone);
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
    punchAt,
    punchType,
    externalEventId,
    punchId: punch._id,
  });

  return {
    punch,
    mappingStatus,
    rawEventId: rawEvent._id,
    isDuplicate: false,
    attendanceClaim: claimResult.success ? 'claimed' : 'cross_branch',
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
    throw new AppError('At least one provider event is required.', 400);
  }
  if (typeof checkpoint !== 'string' || !checkpoint.trim()) {
    throw new AppError('A non-empty provider checkpoint is required.', 400);
  }
  if (!['daily', 'realtime', 'manual_import'].includes(streamIdentifier)) {
    throw new AppError('Invalid provider stream identifier.', 400);
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
    throw new AppError('Active provider configuration was not found.', 404);
  }

  const branch = await Branch.findOne({
    _id: branchId,
    organizationId,
    isActive: true,
  });
  if (!branch) throw new AppError('Active branch was not found.', 404);

  const adapter = providerRegistry.createAdapter(providerName, providerConfiguration);
  const sourceError = await adapter.validateRequestSource(request);
  if (sourceError) throw sourceError;

  const normalizationResults = await Promise.allSettled(
    events.map((rawPayload) => adapter.normalizePayload(rawPayload, organizationId, branchId, actorId))
  );
  const normalizationFailure = normalizationResults.find((result) => result.status === 'rejected');
  if (normalizationFailure) {
    const error = normalizationFailure.reason;
    const errorMessage = error instanceof Error ? error.message : 'Provider event normalization failed.';
    for (const rawPayload of events) {
      await new ProviderDeliveryLog({
        organizationId,
        branchId,
        provider: providerConfiguration.providerName,
        status: 'failed',
        error: errorMessage,
        rawPayload,
      }).save();
    }
    throw error;
  }
  const normalizedEvents = normalizationResults.map((result) => result.value);
  const deviceIds = [...new Set(normalizedEvents.map((event) => event?.deviceId).filter(Boolean))];
  if (deviceIds.length !== 1 || normalizedEvents.some((event) => !event?.deviceId)) {
    throw new AppError('A sync batch must contain events from exactly one device.', 400);
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
      const result = await ingestProviderPunch(canonicalEvent, organizationId, branchId, branch.timezone);
      const deliveryLog = new ProviderDeliveryLog({
        organizationId,
        branchId,
        provider: providerConfiguration.providerName,
        deviceId: event.deviceId,
        externalEventId: normalizeExternalEventId(event.externalEventId),
        punchType: event.punchType,
        punchAt: event.punchAt,
        status: result.mappingStatus === 'unmapped'
          ? 'unmapped'
          : result.isDuplicate ? 'duplicate' : 'success',
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
        status: 'failed',
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
            outcome: index === 0 ? 'failed' : 'partial',
            eventCount: events.length,
            processedCount: index,
            syncStatus: 'error',
            lastError: error.message,
            lastAttemptedAt: new Date(),
          },
          $inc: { retryCount: 1 },
        },
        { new: true, upsert: true, setDefaultsOnInsert: true, runValidators: true }
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
        outcome: 'completed',
        eventCount: events.length,
        processedCount: results.length,
        syncStatus: 'idle',
        lastError: null,
        lastAttemptedAt: new Date(),
        lastSuccessfulAt: new Date(),
      },
    },
    { new: true, upsert: true, setDefaultsOnInsert: true, runValidators: true }
  );
  if (!completedSync) {
    throw new Error('Provider sync completion was not durably recorded.');
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
  if (claimResult.conflict?.type !== 'cross_branch') {
    throw new Error(claimResult.conflict?.message || 'Attendance claim did not complete.');
  }
  await persistCrossBranchConflict(claimResult, details);
}

async function persistCrossBranchConflict(claimResult, details) {
  const conflict = claimResult.conflict;
  const filter = {
    organizationId: details.organizationId,
    staffId: details.staffId,
    date: details.attendanceDate,
    conflictStatus: 'pending',
  };
  const branchIds = [conflict.existingBranch, conflict.attemptedBranch];
  const branchesInvolved = [...new Map(
    branchIds.map((branchId) => [branchId.toString(), { branchId }])
  ).values()];

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
      { new: true, upsert: true, setDefaultsOnInsert: true }
    );
  } catch (error) {
    if (error.code !== 11000) throw error;
    persistedConflict = await AttendanceBranchConflict.findOneAndUpdate(
      filter,
      { $addToSet: { branchesInvolved: { $each: branchesInvolved } } },
      { new: true }
    );
    if (!persistedConflict) throw error;
  }

  if (!persistedConflict) {
    throw new Error('Cross-branch attendance conflict was not persisted');
  }
}
function deriveBusinessDate(punchAt, branchTimezone) {
  const date = new Date(punchAt);
  if (!Number.isFinite(date.getTime())) {
    throw new AppError('Punch timestamp is invalid.', 400);
  }

  if (typeof branchTimezone !== 'string' || !branchTimezone.trim()) {
    throw new AppError('Branch timezone is not configured.', 400);
  }
  const timezone = branchTimezone.trim();
  let dateParts;
  try {
    dateParts = new Intl.DateTimeFormat('en-CA', {
      timeZone: timezone,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
    }).formatToParts(date);
  } catch (error) {
    throw new AppError(`Branch timezone '${timezone}' is invalid.`, 400);
  }
  const parts = Object.fromEntries(dateParts.map(({ type, value }) => [type, value]));
  return `${parts.year}-${parts.month}-${parts.day}`;
}

function normalizeExternalEventId(value) {
  if (typeof value !== 'string') return undefined;
  return value.trim() || undefined;
}

// Helper: get scheduled hours from branch operating hours
function getScheduledHours(branch) {
  if (!branch || !branch.operatingHours) return null;
  return branch.operatingHours;
}

// Basic status derivation from punch count
function deriveStatus(punchCount) {
  if (punchCount === 0) return 'absent';
  if (punchCount === 1) return 'incomplete';
  return 'present';
}

// Basic punch ingestion schema validation
function validatePunchPayload(payload) {
  const required = ['externalEmployeeCode', 'deviceId', 'punchType', 'punchAt'];
  const missing = required.filter(field => !payload[field]);
  if (missing.length > 0) {
    return { valid: false, message: 'Missing required fields: ' + missing.join(', ') };
  }
  return { valid: true };
}
// Provider-independent biometric attendance service
// Handles ingestion, computation, reconciliation and adjustment

export {
  deriveBusinessDate,
  getScheduledHours,
  deriveStatus,
  validatePunchPayload,
  ingestProviderEvents,
  listAttendanceRecords,
  getStaffAttendanceDetail,
  adjustAttendanceRecord,
  listLeaveAppointmentConflicts,
  resolveLeaveAppointmentConflict,
  recordLeaveException,
  listBranchAttendanceConflicts,
  resolveBranchAttendanceConflict,
  getProviderStatus,
};
