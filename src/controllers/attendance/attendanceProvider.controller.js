import { asyncHandler, AppError } from '../../utils/errors.js';
import { Staff } from '../../models/staff/staff.model.js';
import {
  adjustAttendanceRecord,
  recordStaffPunch,
  getMonthlyMusterRoll,
  getProviderStatus,
  getStaffAttendanceDetail,
  ingestProviderEvents,
  listAttendanceRecords,
  listBranchAttendanceConflicts,
  listLeaveAppointmentConflicts,
  recordLeaveException,
  resolveBranchAttendanceConflict,
  resolveLeaveAppointmentConflict,
  listStaffDeviceMappings,
  getStaffDeviceMappingById,
  createStaffDeviceMapping,
  updateStaffDeviceMapping,
  deactivateStaffDeviceMapping,
} from '../../services/attendance/attendance.service.js';

const trustedContext = (req) => ({
  organizationId: req.user.organizationId,
  branchId: req.currentBranch._id,
});

export const listAttendanceRecordsController = asyncHandler(async (req, res) => {
  const data = await listAttendanceRecords({ ...req.query, ...trustedContext(req) });
  res.status(200).json({ success: true, data });
});

export const getStaffAttendanceDetailController = asyncHandler(async (req, res) => {
  const data = await getStaffAttendanceDetail({
    ...trustedContext(req),
    staffId: req.params.staffId,
    date: req.query.date,
  });
  res.status(200).json({ success: true, data });
});

export const adjustAttendanceRecordController = asyncHandler(async (req, res) => {
  const data = await adjustAttendanceRecord({
    ...trustedContext(req),
    actorId: req.user.id,
    staffId: req.body?.staffId,
    date: req.body?.date,
    status: req.body?.status,
    reason: req.body?.reason,
  });
  res.status(200).json({ success: true, data });
});

export const listLeaveAppointmentConflictsController = asyncHandler(async (req, res) => {
  const data = await listLeaveAppointmentConflicts({ ...trustedContext(req), date: req.query.date });
  res.status(200).json({ success: true, data });
});

export const resolveLeaveAppointmentConflictController = asyncHandler(async (req, res) => {
  const data = await resolveLeaveAppointmentConflict({
    ...trustedContext(req),
    actorId: req.user.id,
    leaveId: req.params.leaveId,
    appointmentId: req.params.appointmentId,
    date: req.body?.date,
    reason: req.body?.reason,
  });
  res.status(200).json({ success: true, data });
});

export const recordLeaveExceptionController = asyncHandler(async (req, res) => {
  const data = await recordLeaveException({
    ...trustedContext(req),
    actorId: req.user.id,
    leaveId: req.body?.leaveId,
    date: req.body?.date,
    decision: req.body?.decision,
    reason: req.body?.reason,
  });
  res.status(200).json({ success: true, data });
});

export const listBranchAttendanceConflictsController = asyncHandler(async (req, res) => {
  const data = await listBranchAttendanceConflicts(trustedContext(req));
  res.status(200).json({ success: true, data });
});

export const resolveBranchAttendanceConflictController = asyncHandler(async (req, res) => {
  const data = await resolveBranchAttendanceConflict({
    ...trustedContext(req),
    actorId: req.user.id,
    conflictId: req.params.conflictId,
    reason: req.body?.reason,
  });
  res.status(200).json({ success: true, data });
});

export const getProviderStatusController = asyncHandler(async (req, res) => {
  const data = await getProviderStatus(trustedContext(req));
  res.status(200).json({ success: true, data });
});

export const ingestProviderEventsController = asyncHandler(async (req, res) => {
  const result = await ingestProviderEvents({
    providerName: req.params.providerName,
    organizationId: req.user.organizationId,
    branchId: req.currentBranch._id,
    actorId: req.user.id,
    events: req.body?.events,
    checkpoint: req.body?.checkpoint,
    streamIdentifier: req.body?.streamIdentifier,
    request: req,
  });

  res.status(200).json({ success: true, data: result });
});

export const listStaffDeviceMappingsController = asyncHandler(async (req, res) => {
  const result = await listStaffDeviceMappings({
    ...trustedContext(req),
    ...req.query,
  });
  res.status(200).json({ success: true, data: result.mappings, pagination: result.pagination });
});

export const getStaffDeviceMappingByIdController = asyncHandler(async (req, res) => {
  const data = await getStaffDeviceMappingById({
    ...trustedContext(req),
    id: req.params.id,
  });
  res.status(200).json({ success: true, data });
});

export const createStaffDeviceMappingController = asyncHandler(async (req, res) => {
  const data = await createStaffDeviceMapping({
    ...trustedContext(req),
    actorId: req.user.id,
    ...req.body,
  });
  res.status(201).json({ success: true, data, message: 'Staff device mapping created successfully.' });
});

export const updateStaffDeviceMappingController = asyncHandler(async (req, res) => {
  const data = await updateStaffDeviceMapping({
    ...trustedContext(req),
    id: req.params.id,
    actorId: req.user.id,
    ...req.body,
  });
  res.status(200).json({ success: true, data, message: 'Staff device mapping updated successfully.' });
});

export const deactivateStaffDeviceMappingController = asyncHandler(async (req, res) => {
  const data = await deactivateStaffDeviceMapping({
    ...trustedContext(req),
    id: req.params.id,
    actorId: req.user.id,
  });
  res.status(200).json({ success: true, data, message: 'Staff device mapping deactivated successfully.' });
});

export const recordStaffPunchController = asyncHandler(async (req, res) => {
  const organizationId = req.user.organizationId;
  const branchId = req.currentBranch._id;
  const actorId = req.user.id;
  let targetStaffId = req.body?.staffId;

  // If staffId not provided in body, or caller doesn't have manager adjust permissions,
  // derive staffId directly from req.user
  const canAdjust = req.user?.permissions?.includes('attendance.adjust') ||
    ['owner', 'admin', 'manager'].includes(req.user?.role?.toLowerCase?.());

  if (!targetStaffId || !canAdjust) {
    const ownStaff = await Staff.findOne({
      userId: actorId,
      organizationId,
      isDeleted: { $ne: true },
      status: 'active',
    }).select('_id');
    if (!ownStaff) {
      throw new AppError('No active staff profile linked to your user account.', 404);
    }
    targetStaffId = ownStaff._id.toString();
  }

  const result = await recordStaffPunch({
    organizationId,
    branchId,
    staffId: targetStaffId,
    punchType: req.body.punchType,
    actorId,
    notes: req.body?.notes,
  });

  res.status(200).json({
    success: true,
    data: result,
    message: `Successfully clocked ${req.body.punchType}.`,
  });
});

export const getMonthlyMusterRollController = asyncHandler(async (req, res) => {
  const organizationId = req.user.organizationId;
  const isOwner = req.user?.role?.toLowerCase?.() === 'owner' || req.user?.hasOrgWideAccess;
  const requestedBranchId = req.query.branchId;

  if (requestedBranchId === 'all' && !isOwner) {
    throw new AppError('branchId=all requires multi-branch access or owner permissions.', 403);
  }

  let branchId = req.currentBranch._id.toString();
  let accessibleBranchIds = null;

  if (isOwner) {
    if (requestedBranchId === 'all') {
      branchId = 'all';
      if (req.user?.branchAccess?.length > 0) {
        accessibleBranchIds = req.user.branchAccess
          .filter((b) => b.isActive)
          .map((b) => b.branchId);
      }
    } else if (requestedBranchId) {
      branchId = requestedBranchId;
    }
  }

  const data = await getMonthlyMusterRoll({
    organizationId,
    branchId,
    monthYear: req.query.monthYear,
    search: req.query.search,
    statusFilter: req.query.status,
    accessibleBranchIds,
  });

  res.status(200).json({ success: true, data });
});
