import { Router } from 'express';
import { authenticate } from '../../middleware/auth.js';
import { requireActiveBranch } from '../../middleware/branchScope.js';
import { authorize } from '../../middleware/rbac.js';
import {
  adjustAttendanceRecordController,
  getProviderStatusController,
  getStaffAttendanceDetailController,
  ingestProviderEventsController,
  listAttendanceRecordsController,
  listBranchAttendanceConflictsController,
  listLeaveAppointmentConflictsController,
  recordLeaveExceptionController,
  resolveBranchAttendanceConflictController,
  resolveLeaveAppointmentConflictController,
} from '../../controllers/attendance/attendanceProvider.controller.js';

const router = Router();

router.use(authenticate);
router.get('/records', requireActiveBranch, authorize('attendance.view'), listAttendanceRecordsController);
router.get('/staff/:staffId', requireActiveBranch, authorize('attendance.view'), getStaffAttendanceDetailController);
router.get('/branch-conflicts', requireActiveBranch, authorize('attendance.view'), listBranchAttendanceConflictsController);
router.get('/leave-appointment-conflicts', requireActiveBranch, authorize('attendance.view'), listLeaveAppointmentConflictsController);
router.get('/providers/status', requireActiveBranch, authorize('attendance.view'), getProviderStatusController);
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
