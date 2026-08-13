import { AppointmentService } from "../../services/appointments/appointment.service.js";
import { sendResponse } from "../../utils/response.js";
import { asyncHandler } from "../../utils/errors.js";

const appointmentService = new AppointmentService();

export const createAppointment = asyncHandler(async (req, res) => {
  const appointment = await appointmentService.createAppointment(req.body, req.organizationId);
  return sendResponse(res, 201, "Appointment created successfully", appointment);
});

export const listAppointments = asyncHandler(async (req, res) => {
  const { page, limit, sortBy, sortOrder, status, search, customerId, staffId, date } = req.query;

  const filter = {};
  if (status) filter.status = status;
  if (customerId) filter.customerId = customerId;
  if (staffId) filter.staffId = staffId;
  if (date) filter.appointmentDate = date;
  if (search) {
    filter.appointmentCode = { $regex: search, $options: "i" };
  }

  const branchId = req.branchId || null;
  const result = await appointmentService.listAppointments(
    filter,
    { page, limit, sortBy, sortOrder },
    req.organizationId,
    branchId
  );

  return sendResponse(res, 200, "Appointments retrieved successfully", result.data, result.pagination);
});

export const getAppointmentById = asyncHandler(async (req, res) => {
  const appointment = await appointmentService.getAppointmentById(req.params.id, req.organizationId);
  return sendResponse(res, 200, "Appointment retrieved successfully", appointment);
});

export const updateAppointment = asyncHandler(async (req, res) => {
  const appointment = await appointmentService.updateAppointment(
    req.params.id,
    req.body,
    req.organizationId
  );
  return sendResponse(res, 200, "Appointment updated successfully", appointment);
});

export const rescheduleAppointment = asyncHandler(async (req, res) => {
  const appointment = await appointmentService.rescheduleAppointment(
    req.params.id,
    req.body,
    req.organizationId
  );
  return sendResponse(res, 200, "Appointment rescheduled successfully", appointment);
});

export const assignStaff = asyncHandler(async (req, res) => {
  const appointment = await appointmentService.assignStaff(
    req.params.id,
    req.body,
    req.organizationId
  );
  return sendResponse(res, 200, "Staff assigned successfully", appointment);
});

export const updateStatus = asyncHandler(async (req, res) => {
  const appointment = await appointmentService.updateStatus(
    req.params.id,
    req.body,
    req.organizationId,
    req.user.id
  );
  return sendResponse(res, 200, "Appointment status updated successfully", appointment);
});

export const deleteAppointment = asyncHandler(async (req, res) => {
  const { branchId } = req.body;
  await appointmentService.deleteAppointment(req.params.id, branchId, req.organizationId);
  return sendResponse(res, 200, "Appointment deleted successfully");
});

export const triggerReminder = asyncHandler(async (req, res) => {
  const { branchId } = req.body;
  const appointment = await appointmentService.triggerReminder(req.params.id, branchId, req.organizationId);
  return sendResponse(res, 200, "Reminder dispatched successfully", appointment);
});
