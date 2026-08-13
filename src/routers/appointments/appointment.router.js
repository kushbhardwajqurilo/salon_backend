import express from "express";
import { authenticate } from "../../middleware/auth.js";
import { requireOrganizationScope, requireBranchScope } from "../../middleware/branchScope.js";
import { requirePermission } from "../../middleware/rbac.js";
import { validate } from "../../middleware/validate.js";
import {
  createAppointmentSchema,
  updateAppointmentSchema,
  rescheduleAppointmentSchema,
  updateAppointmentStatusSchema,
  assignStaffSchema,
  cancelAppointmentSchema,
  triggerReminderSchema,
} from "../../validation/appointments/appointment.validation.js";
import {
  createAppointment,
  listAppointments,
  getAppointmentById,
  updateAppointment,
  rescheduleAppointment,
  assignStaff,
  updateStatus,
  deleteAppointment,
  triggerReminder,
} from "../../controllers/appointments/appointment.controller.js";
import { asyncHandler } from "../../utils/errors.js";
import { AppError } from "../../utils/errors.js";

const router = express.Router();

const validateMutationBranch = asyncHandler(async (req, res, next) => {
  const branchId =
    req.body?.branchId ||
    req.headers["x-branch-id"] ||
    req.headers["X-Branch-Id"] ||
    req.branchId;

  if (!branchId || branchId === "all") {
    throw new AppError("branchId (body or X-Branch-Id header) is required for this mutation", 400);
  }

  // Populate req.body.branchId so validation schemas and controllers receive it consistently
  if (!req.body) req.body = {};
  req.body.branchId = branchId;

  // Verify branch access from req.user
  const { hasOrgWideAccess, branchAccess } = req.user;
  let isAuthorized = false;

  if (hasOrgWideAccess === true) {
    isAuthorized = true;
  } else {
    isAuthorized = (branchAccess || []).some(
      (b) => b.branchId.toString() === branchId.toString() && b.isActive
    );
  }

  if (!isAuthorized) {
    throw new AppError("Access denied. You do not have access to the target branch.", 403);
  }

  next();
});

// All routes require authentication & organization scope
router.use(authenticate);
router.use(requireOrganizationScope);

// READ Operations
router.get(
  "/",
  requireBranchScope,
  requirePermission("appointments.view"),
  listAppointments
);

router.get(
  "/:id",
  requireBranchScope,
  requirePermission("appointments.view"),
  getAppointmentById
);

// MUTATION Operations (Require body.branchId authorization)
router.post(
  "/",
  validateMutationBranch,
  validate(createAppointmentSchema),
  requirePermission("appointments.create"),
  createAppointment
);

router.put(
  "/:id",
  validateMutationBranch,
  validate(updateAppointmentSchema),
  requirePermission("appointments.create"),
  updateAppointment
);

router.patch(
  "/:id/reschedule",
  validate(rescheduleAppointmentSchema),
  validateMutationBranch,
  requirePermission("appointments.reschedule"),
  rescheduleAppointment
);

router.patch(
  "/:id/assign-staff",
  validate(assignStaffSchema),
  validateMutationBranch,
  requirePermission("appointments.assign_staff"),
  assignStaff
);

router.patch(
  "/:id/status",
  validate(updateAppointmentStatusSchema),
  validateMutationBranch,
  asyncHandler(async (req, res, next) => {
    // Dynamic permission check: status 'cancelled' requires appointments.cancel or update_status
    const requiredPermission = req.body.status === "cancelled" ? "appointments.cancel" : "appointments.update_status";
    return requirePermission(requiredPermission)(req, res, next);
  }),
  updateStatus
);

router.delete(
  "/:id",
  validateMutationBranch,
  validate(cancelAppointmentSchema),
  requirePermission("appointments.delete"),
  deleteAppointment
);

router.post(
  "/:id/reminder/trigger",
  validateMutationBranch,
  validate(triggerReminderSchema),
  requirePermission("appointments.reminders.send"),
  triggerReminder
);

export default router;
