import { Router } from 'express';
import { authenticate } from '../../middleware/auth.js';
import { requireActiveBranch } from '../../middleware/branchScope.js';
import { authorize } from '../../middleware/rbac.js';
import { validate } from '../../middleware/validate.js';
import {
  createStaffDeviceMappingSchema,
  queryStaffDeviceMappingSchema,
  staffDeviceMappingIdParamSchema,
  updateStaffDeviceMappingSchema,
} from '../../validation/attendance/staffDeviceMapping.validation.js';
import {
  recordStaffPunchSchema,
  monthlyMusterRollSchema,
} from '../../validation/attendance/attendance.validation.js';
import {
  adjustAttendanceRecordController,
  createStaffDeviceMappingController,
  deactivateStaffDeviceMappingController,
  getMonthlyMusterRollController,
  getProviderStatusController,
  getStaffAttendanceDetailController,
  getStaffDeviceMappingByIdController,
  ingestProviderEventsController,
  listAttendanceRecordsController,
  listBranchAttendanceConflictsController,
  listLeaveAppointmentConflictsController,
  listStaffDeviceMappingsController,
  recordLeaveExceptionController,
  recordStaffPunchController,
  resolveBranchAttendanceConflictController,
  resolveLeaveAppointmentConflictController,
  updateStaffDeviceMappingController,
} from '../../controllers/attendance/attendanceProvider.controller.js';

const router = Router();

router.use(authenticate);
router.post('/punch', requireActiveBranch, authorize('attendance.punch'), validate(recordStaffPunchSchema), recordStaffPunchController);
router.get('/monthly-summary', requireActiveBranch, authorize('attendance.view'), validate(monthlyMusterRollSchema), getMonthlyMusterRollController);
router.get('/records', requireActiveBranch, authorize('attendance.view'), listAttendanceRecordsController);
router.get('/staff/:staffId', requireActiveBranch, authorize('attendance.view'), getStaffAttendanceDetailController);
router.get('/branch-conflicts', requireActiveBranch, authorize('attendance.view'), listBranchAttendanceConflictsController);
router.get('/leave-appointment-conflicts', requireActiveBranch, authorize('attendance.view'), listLeaveAppointmentConflictsController);
router.get('/providers/status', requireActiveBranch, authorize('attendance.view'), getProviderStatusController);

// Staff Device Mapping endpoints
router.get(
  '/mappings',
  requireActiveBranch,
  authorize('attendance.view'),
  validate(queryStaffDeviceMappingSchema),
  listStaffDeviceMappingsController
);
router.get(
  '/mappings/:id',
  requireActiveBranch,
  authorize('attendance.view'),
  validate(staffDeviceMappingIdParamSchema),
  getStaffDeviceMappingByIdController
);
router.post(
  '/mappings',
  requireActiveBranch,
  authorize('attendance.adjust'),
  validate(createStaffDeviceMappingSchema),
  createStaffDeviceMappingController
);
router.patch(
  '/mappings/:id',
  requireActiveBranch,
  authorize('attendance.adjust'),
  validate(updateStaffDeviceMappingSchema),
  updateStaffDeviceMappingController
);
router.delete(
  '/mappings/:id',
  requireActiveBranch,
  authorize('attendance.adjust'),
  validate(staffDeviceMappingIdParamSchema),
  deactivateStaffDeviceMappingController
);

router.post('/records/adjust', requireActiveBranch, authorize('attendance.adjust'), adjustAttendanceRecordController);
router.post('/leave-exceptions', requireActiveBranch, authorize('attendance.adjust'), recordLeaveExceptionController);
router.post(
  '/leave-appointment-conflicts/:leaveId/:appointmentId/resolve',
  requireActiveBranch,
  authorize('attendance.adjust'),
  resolveLeaveAppointmentConflictController,
);
router.post(
  '/branch-conflicts/:conflictId/resolve',
  requireActiveBranch,
  authorize('attendance.adjust'),
  resolveBranchAttendanceConflictController,
);
router.post(
  '/providers/:providerName/events',
  requireActiveBranch,
  authorize('attendance.punch'),
  ingestProviderEventsController,
);

export default router;
