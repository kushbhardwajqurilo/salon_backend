import {
  staffAvailabilityService,
  AVAILABILITY_STATUS,
} from "../../services/availability/staffAvailability.service.js";
import { StaffRoster } from "../../models/staff/staffRoster.model.js";
import { Branch } from "../../models/branches/branch.model.js";
import { Staff } from "../../models/staff/staff.model.js";
import { StaffBranch } from "../../models/staff/staffBranch.model.js";
import { sendResponse } from "../../utils/response.js";
import { asyncHandler, AppError } from "../../utils/errors.js";
import { AuditLogService } from "../../services/audit/auditLog.service.js";
import { AUDIT_ACTIONS } from "../../models/audit/auditLog.model.js";

const auditLogService = new AuditLogService();

/**
 * Parses serviceIds parameter from query (can be array or comma-separated string)
 */
const parseServiceIds = (param) => {
  if (!param) return [];
  if (Array.isArray(param)) return param.filter(Boolean);
  if (typeof param === "string") {
    return param
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean);
  }
  return [];
};

/**
 * GET /api/v1/appointments/availability/staff
 * Lookup staff availability for appointment booking/rescheduling
 */
export const getStaffAvailability = asyncHandler(async (req, res) => {
  const {
    branchId: queryBranchId,
    date,
    startTime = "09:00",
    endTime,
    duration = 30,
    serviceIds,
    staffId,
    excludeAppointmentId,
  } = req.query;

  const branchId =
    queryBranchId ||
    req.headers["x-branch-id"] ||
    req.headers["X-Branch-Id"] ||
    req.branchId;

  if (!branchId || branchId === "all") {
    // If "all" and org-wide access, can find available staff across all branches
    if (!req.user?.hasOrgWideAccess) {
      throw new AppError("Please select a specific Branch to check availability", 400);
    }
  } else {
    // Verify branch authorization
    const { hasOrgWideAccess, branchAccess } = req.user || {};
    const isAuthorized =
      hasOrgWideAccess === true ||
      (branchAccess || []).some(
        (b) => b.branchId.toString() === branchId.toString() && b.isActive,
      );
    if (!isAuthorized) {
      throw new AppError("Access denied to the specified branch", 403);
    }
  }

  const parsedServiceIds = parseServiceIds(serviceIds);

  if (staffId) {
    // Single staff evaluation
    const result = await staffAvailabilityService.checkStaffSlotAvailability({
      organizationId: req.organizationId,
      branchId,
      staffId,
      date,
      startTime,
      endTime,
      duration: Number(duration),
      serviceIds: parsedServiceIds,
      excludeAppointmentId,
    });

    return sendResponse(res, 200, "Staff availability evaluated", result);
  }

  // Batch evaluation for all assigned staff in target branch
  const result = await staffAvailabilityService.findAvailableStaffForSlot({
    organizationId: req.organizationId,
    branchId,
    date,
    startTime,
    endTime,
    duration: Number(duration),
    serviceIds: parsedServiceIds,
    excludeAppointmentId,
  });

  return sendResponse(res, 200, "Available staff retrieved successfully", result);
});

/**
 * GET /api/v1/appointments/calendar/staff-availability
 * Resource lane availability evaluation for calendar
 */
export const getCalendarAvailability = asyncHandler(async (req, res) => {
  const {
    branchId: queryBranchId,
    date,
    startDate,
    endDate,
    staffId,
  } = req.query;

  const branchId =
    queryBranchId ||
    req.headers["x-branch-id"] ||
    req.headers["X-Branch-Id"] ||
    req.branchId;

  // Authorization check
  if (branchId && branchId !== "all") {
    const { hasOrgWideAccess, branchAccess } = req.user || {};
    const isAuthorized =
      hasOrgWideAccess === true ||
      (branchAccess || []).some(
        (b) => b.branchId.toString() === branchId.toString() && b.isActive,
      );
    if (!isAuthorized) {
      throw new AppError("Access denied to the specified branch", 403);
    }
  }

  const result = await staffAvailabilityService.getStaffCalendarAvailability({
    organizationId: req.organizationId,
    branchId: branchId === "all" ? null : branchId,
    date,
    startDate,
    endDate,
    staffId,
  });

  return sendResponse(res, 200, "Calendar staff availability retrieved", result);
});

/**
 * GET /api/v1/staff/:id/roster
 * Retrieve a staff member's active roster/shift schedule
 */
export const getStaffRoster = asyncHandler(async (req, res) => {
  const { id: staffId } = req.params;
  const branchId =
    req.query.branchId ||
    req.headers["x-branch-id"] ||
    req.headers["X-Branch-Id"] ||
    req.branchId;

  if (!branchId || branchId === "all") {
    throw new AppError("Branch ID is required to retrieve roster", 400);
  }

  const roster = await StaffRoster.findOne({
    organizationId: req.organizationId,
    staffId,
    branchId,
    isActive: true,
  }).lean();

  return sendResponse(
    res,
    200,
    roster ? "Staff roster retrieved" : "No roster configured (using branch hours)",
    roster || null,
  );
});

/**
 * PUT /api/v1/staff/:id/roster
 * Create or update a staff member's roster/shift schedule
 */
export const updateStaffRoster = asyncHandler(async (req, res) => {
  const { id: staffId } = req.params;
  const { branchId, weeklySchedule, overrides, effectiveFrom, effectiveTo } = req.body;

  // Verify staff exists and belongs to org
  const staff = await Staff.findOne({
    _id: staffId,
    organizationId: req.organizationId,
    isDeleted: false,
  });
  if (!staff) {
    throw new AppError("Staff member not found", 404);
  }

  // Verify staff assigned to branch
  const staffBranch = await StaffBranch.findOne({
    organizationId: req.organizationId,
    staffId,
    branchId,
    isActive: true,
  });
  if (!staffBranch) {
    throw new AppError("Staff member is not assigned to this branch", 400);
  }

  const roster = await StaffRoster.findOneAndUpdate(
    {
      organizationId: req.organizationId,
      staffId,
      branchId,
      isActive: true,
    },
    {
      $set: {
        ...(weeklySchedule ? { weeklySchedule } : {}),
        ...(overrides ? { overrides } : {}),
        ...(effectiveFrom ? { effectiveFrom: new Date(effectiveFrom) } : {}),
        ...(effectiveTo !== undefined ? { effectiveTo: effectiveTo ? new Date(effectiveTo) : null } : {}),
      },
      $setOnInsert: {
        organizationId: req.organizationId,
        staffId,
        branchId,
        isActive: true,
      },
    },
    {
      upsert: true,
      new: true,
      runValidators: true,
    },
  );

  void auditLogService
    .createAuditLog(
      {
        action: AUDIT_ACTIONS.STAFF_UPDATED,
        entityType: "StaffRoster",
        entityId: staffId,
        branchId,
        description: `Updated roster for staff ${staffId}`,
        metadata: { rosterUpdated: true, branchId, effectiveFrom, effectiveTo },
      },
      req.organizationId,
      req.user.id
    )
    .catch(() => {});

  return sendResponse(res, 200, "Staff roster updated successfully", roster);
});
