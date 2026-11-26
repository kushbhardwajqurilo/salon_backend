import { asyncHandler, AppError } from "../../utils/errors.js";
import { sendResponse } from "../../utils/response.js";
import { HolidayCalendarService } from "../../services/holidays/holidayCalendar.service.js";
import { CalendarResolverService } from "../../services/holidays/calendarResolver.service.js";
import { AuditLogService } from "../../services/audit/auditLog.service.js";
import { AUDIT_ACTIONS } from "../../models/audit/auditLog.model.js";

const auditLogService = new AuditLogService();

const holidayService = new HolidayCalendarService();
const calendarResolver = new CalendarResolverService();

export const listHolidays = asyncHandler(async (req, res) => {
  const result = await holidayService.listHolidays(req.organizationId, req.query, req.user);
  return sendResponse(res, 200, "Calendar entries retrieved successfully", result);
});

export const createHoliday = asyncHandler(async (req, res) => {
  const result = await holidayService.createHoliday(req.organizationId, req.body, req.user);
  await auditLogService
    .createAuditLog(
      {
        action: AUDIT_ACTIONS.HOLIDAY_CREATED,
        entityType: "Holiday",
        entityId: result?._id || null,
        branchId: req.body?.branchId || req.branchId || null,
        description: `Created holiday ${result?.name || req.body?.name || ""}`,
        metadata: req.body,
      },
      req.organizationId,
      req.user.id
    )
    .catch(() => {});
  return sendResponse(res, 201, "Calendar entry created successfully", result);
});

export const updateHoliday = asyncHandler(async (req, res) => {
  const result = await holidayService.updateHoliday(
    req.organizationId,
    req.params.id,
    req.body,
    req.user
  );
  await auditLogService
    .createAuditLog(
      {
        action: AUDIT_ACTIONS.HOLIDAY_UPDATED,
        entityType: "Holiday",
        entityId: req.params.id,
        branchId: req.body?.branchId || req.branchId || null,
        description: `Updated holiday ${req.params.id}`,
        metadata: req.body,
      },
      req.organizationId,
      req.user.id
    )
    .catch(() => {});
  return sendResponse(res, 200, "Calendar entry updated successfully", result);
});

export const deleteHoliday = asyncHandler(async (req, res) => {
  const result = await holidayService.deleteHoliday(req.organizationId, req.params.id, req.user);
  await auditLogService
    .createAuditLog(
      {
        action: AUDIT_ACTIONS.HOLIDAY_DELETED,
        entityType: "Holiday",
        entityId: req.params.id,
        description: `Deactivated holiday ${req.params.id}`,
      },
      req.organizationId,
      req.user.id
    )
    .catch(() => {});
  return sendResponse(res, 200, "Calendar entry deactivated successfully", result);
});

export const resolveCalendar = asyncHandler(async (req, res) => {
  const branchId = req.branchId || req.query.branchId;
  if (!branchId) {
    throw new AppError("Branch context (X-Branch-Id or branchId) is required to resolve branch calendar", 400);
  }
  holidayService.assertBranchAuthorized(req.user, branchId);
  const result = await calendarResolver.resolveCalendarRange({
    organizationId: req.organizationId,
    branchId,
    startDate: req.query.startDate,
    endDate: req.query.endDate,
  });
  return sendResponse(res, 200, "Calendar resolved successfully", result);
});
