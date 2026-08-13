import { AppointmentRepository } from "../../repositories/appointments/appointment.repository.js";
import { Customer } from "../../models/customers/customer.model.js";
import { Staff } from "../../models/staff/staff.model.js";
import { Service } from "../../models/services/service.model.js";
import { Branch } from "../../models/branches/branch.model.js";
import { Leave } from "../../models/leaves/leave.model.js";
import { AppError } from "../../utils/errors.js";
import { Sequence } from "../../models/sequence/sequence.model.js";
import { emailQueue, smsQueue } from "../../queues/client.js";
import mongoose from "mongoose";

const appointmentRepo = new AppointmentRepository();

/**
 * Resolves IANA timezone offset string or branch timezone, defaulting to 'Asia/Kolkata'
 */
const DEFAULT_TIMEZONE = "Asia/Kolkata";

/**
 * Helper to compute timezone offset in milliseconds for a target date and timezone
 */
const getTimezoneOffsetMs = (date, timezone = DEFAULT_TIMEZONE) => {
  const tz = timezone || DEFAULT_TIMEZONE;
  try {
    const utcDate = new Date(date.toLocaleString("en-US", { timeZone: "UTC" }));
    const tzDate = new Date(date.toLocaleString("en-US", { timeZone: tz }));
    return tzDate.getTime() - utcDate.getTime();
  } catch (err) {
    // Fallback to Asia/Kolkata offset (+05:30) if timezone is invalid
    return 5.5 * 60 * 60 * 1000;
  }
};

/**
 * Converts local date string ("YYYY-MM-DD") and time string ("HH:mm") to canonical UTC Date timestamp
 */
export const parseLocalToUTC = (dateStr, timeStr, timezone = DEFAULT_TIMEZONE) => {
  const tz = timezone || DEFAULT_TIMEZONE;
  const [year, month, day] = dateStr.split("-").map(Number);
  const [hours, minutes] = timeStr.split(":").map(Number);

  // Construct nominal UTC instant assuming input was UTC
  const nominalUtc = new Date(Date.UTC(year, month - 1, day, hours, minutes, 0, 0));
  const offsetMs = getTimezoneOffsetMs(nominalUtc, tz);
  return new Date(nominalUtc.getTime() - offsetMs);
};

/**
 * Formats canonical UTC Date timestamp to local date ("YYYY-MM-DD") and local time ("HH:mm") strings
 */
export const formatUTCToLocal = (utcDate, timezone = DEFAULT_TIMEZONE) => {
  const tz = timezone || DEFAULT_TIMEZONE;
  const offsetMs = getTimezoneOffsetMs(utcDate, tz);
  const localDate = new Date(utcDate.getTime() + offsetMs);
  const year = localDate.getUTCFullYear();
  const month = String(localDate.getUTCMonth() + 1).padStart(2, "0");
  const day = String(localDate.getUTCDate()).padStart(2, "0");
  const hours = String(localDate.getUTCHours()).padStart(2, "0");
  const minutes = String(localDate.getUTCMinutes()).padStart(2, "0");

  return {
    dateStr: `${year}-${month}-${day}`,
    timeStr: `${hours}:${minutes}`,
  };
};

/**
 * Generates minute-level covered bucket array for atomic concurrency index
 */
export const generateSlotMinutes = (startAt, endAt) => {
  const slots = [];
  const startMs = startAt.getTime();
  const endMs = endAt.getTime();

  for (let ms = startMs; ms < endMs; ms += 60000) {
    slots.push(new Date(ms).toISOString());
  }
  return slots;
};

export class AppointmentService {
  /**
   * Helper to recalculate aggregate reminder status based on channel configuration and sub-document states
   */
  recalculateAggregateReminderStatus(reminder) {
    const channel = reminder.channel || "sms";
    const emailStatus = reminder.email?.status || "pending";
    const smsStatus = reminder.sms?.status || "pending";

    if (channel === "email") {
      reminder.status = emailStatus;
      reminder.sentAt = reminder.email?.sentAt || null;
      reminder.failedAt = reminder.email?.failedAt || null;
      reminder.failureReason = reminder.email?.failureReason || null;
    } else if (channel === "sms") {
      reminder.status = smsStatus;
      reminder.sentAt = reminder.sms?.sentAt || null;
      reminder.failedAt = reminder.sms?.failedAt || null;
      reminder.failureReason = reminder.sms?.failureReason || null;
    } else if (channel === "both") {
      if (emailStatus === "sent" && smsStatus === "sent") {
        reminder.status = "sent";
        reminder.sentAt = reminder.email.sentAt > reminder.sms.sentAt ? reminder.email.sentAt : reminder.sms.sentAt;
        reminder.failureReason = null;
      } else if (emailStatus === "sent" || smsStatus === "sent") {
        reminder.status = "partial_delivery";
        reminder.sentAt = reminder.email.sentAt || reminder.sms.sentAt;
        const failedReason = reminder.email.failureReason || reminder.sms.failureReason;
        reminder.failureReason = failedReason ? `Partial delivery: ${failedReason}` : null;
      } else if (emailStatus === "failed" && smsStatus === "failed") {
        reminder.status = "failed";
        reminder.failedAt = reminder.email.failedAt || reminder.sms.failedAt;
        reminder.failureReason = `Both channels failed. Email: ${reminder.email.failureReason}; SMS: ${reminder.sms.failureReason}`;
      } else if (emailStatus === "cancelled" && smsStatus === "cancelled") {
        reminder.status = "cancelled";
      } else {
        reminder.status = "scheduled";
      }
    }
  }

  /**
   * Helper to schedule reminders on BullMQ
   */
  async scheduleReminders(appointment) {
    if (!appointment.reminder?.enabled || appointment.status !== "scheduled") {
      if (appointment.reminder?.enabled === false) {
        await appointmentRepo.update(appointment._id, {
          "reminder.status": "cancelled",
          "reminder.sendAt": null,
          "reminder.failureReason": "Reminder disabled by configuration",
          "reminder.email.status": "cancelled",
          "reminder.sms.status": "cancelled",
        }, appointment.organizationId);
      }
      return;
    }

    const startMs = appointment.startAt.getTime();
    const offsetMinutes = appointment.reminder.offsetMinutes || 60;
    const offsetMs = offsetMinutes * 60 * 1000;
    const triggerMs = startMs - offsetMs;
    const sendAt = new Date(triggerMs);

    const aptIdStr = appointment._id.toString();
    const channel = appointment.reminder.channel || "sms";

    // If sendAt is in the past, mark non-delivery state without queueing
    if (triggerMs <= Date.now()) {
      await appointmentRepo.update(appointment._id, {
        "reminder.sendAt": sendAt,
        "reminder.status": "cancelled",
        "reminder.failureReason": "sendAt is in the past",
        "reminder.email.status": "cancelled",
        "reminder.email.failureReason": "sendAt is in the past",
        "reminder.sms.status": "cancelled",
        "reminder.sms.failureReason": "sendAt is in the past",
      }, appointment.organizationId);
      return;
    }

    const delay = triggerMs - Date.now();

    const jobPayload = {
      appointmentId: aptIdStr,
      appointmentCode: appointment.appointmentCode,
      customerId: appointment.customerId.toString(),
      startAt: appointment.startAt,
      branchId: appointment.branchId.toString(),
      organizationId: appointment.organizationId.toString(),
    };

    const updates = {
      "reminder.sendAt": sendAt,
      "reminder.status": "scheduled",
      "reminder.failureReason": null,
    };

    try {
      if (channel === "email" || channel === "both") {
        const jobId = `apt_reminder_${aptIdStr}_email_${offsetMinutes}`;
        await emailQueue.add("sendAppointmentReminderEmail", jobPayload, {
          jobId,
          delay,
          removeOnComplete: true,
        });
        updates["reminder.email.status"] = "scheduled";
        updates["reminder.email.failureReason"] = null;
      }
      if (channel === "sms" || channel === "both") {
        const jobId = `apt_reminder_${aptIdStr}_sms_${offsetMinutes}`;
        await smsQueue.add("sendAppointmentReminderSMS", jobPayload, {
          jobId,
          delay,
          removeOnComplete: true,
        });
        updates["reminder.sms.status"] = "scheduled";
        updates["reminder.sms.failureReason"] = null;
      }

      await appointmentRepo.update(appointment._id, updates, appointment.organizationId);
    } catch (err) {
      console.error("Failed to enqueue reminder job:", err.message);
      await appointmentRepo.update(appointment._id, {
        "reminder.sendAt": sendAt,
        "reminder.status": "failed",
        "reminder.failedAt": new Date(),
        "reminder.failureReason": `Enqueue error: ${err.message}`,
      }, appointment.organizationId);
    }
  }

  /**
   * Helper to cancel scheduled reminders on BullMQ
   */
  async cancelReminders(appointment) {
    const aptIdStr = appointment._id.toString();
    const offset = appointment.reminder?.offsetMinutes || 60;

    const emailJobId = `apt_reminder_${aptIdStr}_email_${offset}`;
    const smsJobId = `apt_reminder_${aptIdStr}_sms_${offset}`;

    try {
      const emailJob = emailQueue?.getJob ? await emailQueue.getJob(emailJobId) : null;
      if (emailJob) await emailJob.remove();

      const smsJob = smsQueue?.getJob ? await smsQueue.getJob(smsJobId) : null;
      if (smsJob) await smsJob.remove();
    } catch (err) {
      console.error("Failed to remove reminder job:", err.message);
    }
  }

  /**
   * MANUAL REMINDER TRIGGER API
   */
  async triggerReminder(id, branchId, organizationId) {
    const appointment = await appointmentRepo.findById(id, organizationId);
    if (!appointment) {
      throw new AppError("Appointment not found", 404);
    }

    const aptBranchId = appointment.branchId?._id ? appointment.branchId._id.toString() : appointment.branchId.toString();
    if (aptBranchId !== branchId.toString()) {
      throw new AppError("Target branchId does not match appointment branch", 400);
    }

    if (["completed", "cancelled", "no_show"].includes(appointment.status)) {
      throw new AppError(`Cannot trigger reminder for appointment with status '${appointment.status}'`, 400);
    }

    if (appointment.reminder?.status === "sent") {
      throw new AppError("Reminder has already been delivered across all configured channels", 400);
    }

    const customer = await Customer.findOne({ _id: appointment.customerId, organizationId, isDeleted: false });
    if (!customer) {
      throw new AppError("Customer record not found", 404);
    }

    const channel = appointment.reminder?.channel || "sms";
    const { EmailService } = await import("../notifications/email.service.js");
    const { SmsService } = await import("../notifications/sms.service.js");

    const emailService = new EmailService();
    const smsService = new SmsService();

    const branch = await Branch.findOne({ _id: branchId, organizationId });
    const tz = branch?.timezone || "Asia/Kolkata";
    const formattedStart = formatUTCToLocal(appointment.startAt, tz);

    const now = new Date();
    const channelResults = {};

    // 1. Process Email Channel if requested and not already sent
    if (channel === "email" || channel === "both") {
      if (appointment.reminder?.email?.status === "sent") {
        channelResults.email = { status: "sent", sentAt: appointment.reminder.email.sentAt };
      } else if (!customer.email) {
        channelResults.email = { status: "failed", failedAt: now, failureReason: "Customer has no email address configured" };
      } else {
        try {
          await emailService.sendMail({
            to: customer.email,
            subject: `Appointment Reminder — ${appointment.appointmentCode}`,
            text: `Hello ${customer.name}, this is a reminder for your upcoming salon appointment on ${formattedStart.dateStr} at ${formattedStart.timeStr}.`,
            html: `<p>Hello <strong>${customer.name}</strong>,</p><p>This is a reminder for your upcoming salon appointment (Code: <code>${appointment.appointmentCode}</code>) scheduled on <strong>${formattedStart.dateStr}</strong> at <strong>${formattedStart.timeStr}</strong>.</p>`,
          });
          channelResults.email = { status: "sent", sentAt: now, failureReason: null };
        } catch (err) {
          channelResults.email = { status: "failed", failedAt: now, failureReason: `Email dispatch failed: ${err.message}` };
        }
      }
    }

    // 2. Process SMS Channel if requested and not already sent
    if (channel === "sms" || channel === "both") {
      if (appointment.reminder?.sms?.status === "sent") {
        channelResults.sms = { status: "sent", sentAt: appointment.reminder.sms.sentAt };
      } else if (!customer.phone) {
        channelResults.sms = { status: "failed", failedAt: now, failureReason: "Customer has no phone number configured" };
      } else {
        try {
          await smsService.sendSms({
            phone: customer.phone,
            message: `Reminder: Your appointment ${appointment.appointmentCode} is scheduled for ${formattedStart.dateStr} at ${formattedStart.timeStr}.`,
          });
          channelResults.sms = { status: "sent", sentAt: now, failureReason: null };
        } catch (err) {
          channelResults.sms = { status: "failed", failedAt: now, failureReason: `SMS dispatch failed: ${err.message}` };
        }
      }
    }

    // Build update object
    const updateObj = {};
    if (channelResults.email) {
      updateObj["reminder.email.status"] = channelResults.email.status;
      if (channelResults.email.status === "sent") updateObj["reminder.email.sentAt"] = channelResults.email.sentAt;
      if (channelResults.email.status === "failed") {
        updateObj["reminder.email.failedAt"] = channelResults.email.failedAt;
        updateObj["reminder.email.failureReason"] = channelResults.email.failureReason;
      }
    }
    if (channelResults.sms) {
      updateObj["reminder.sms.status"] = channelResults.sms.status;
      if (channelResults.sms.status === "sent") updateObj["reminder.sms.sentAt"] = channelResults.sms.sentAt;
      if (channelResults.sms.status === "failed") {
        updateObj["reminder.sms.failedAt"] = channelResults.sms.failedAt;
        updateObj["reminder.sms.failureReason"] = channelResults.sms.failureReason;
      }
    }

    // Determine aggregate state
    let aggregateStatus = "failed";
    if (channel === "email") {
      aggregateStatus = channelResults.email.status;
    } else if (channel === "sms") {
      aggregateStatus = channelResults.sms.status;
    } else if (channel === "both") {
      const eSent = channelResults.email.status === "sent";
      const sSent = channelResults.sms.status === "sent";
      if (eSent && sSent) aggregateStatus = "sent";
      else if (eSent || sSent) aggregateStatus = "partial_delivery";
      else aggregateStatus = "failed";
    }

    updateObj["reminder.status"] = aggregateStatus;
    if (aggregateStatus === "sent") updateObj["reminder.sentAt"] = now;

    const updated = await appointmentRepo.update(id, updateObj, organizationId);
    if (aggregateStatus === "failed") {
      const errDetail = channelResults.email?.failureReason || channelResults.sms?.failureReason || "Provider delivery failed";
      throw new AppError(`Reminder delivery failed: ${errDetail}`, 400);
    }

    return updated;
  }

  /**
   * Helper to check staff availability and leave status
   */
  async validateStaffAvailability(staffId, organizationId, branchId, dateStr, startAt, endAt, excludeAppointmentId = null) {
    if (!staffId) return;
    console.log("staffId", { staffId, organizationId })
    // 1. Verify staff exists, belongs to organization, and is active
    const staff = await Staff.findOne({
      _id: staffId,
      organizationId,
      isDeleted: false,
    });

    console.log("staff", staff)
    if (!staff) {
      throw new AppError("Staff member not found", 404);
    }

    if (staff.status !== "active") {
      throw new AppError(`Cannot assign staff with status '${staff.status}'`, 400);
    }

    // 2. Leave check (using existing Leave model rules)
    const leaveExists = await Leave.findOne({
      organizationId,
      staffId,
      dates: dateStr,
      status: { $in: ["pending", "approved"] },
    });

    if (leaveExists) {
      throw new AppError(`Staff member is on leave on date ${dateStr}`, 400);
    }
  }

  /**
   * Generates next unique appointment code
   */
  async generateAppointmentCode(organizationId) {
    const sequenceKey = `APT_${organizationId.toString()}`;
    const seq = await Sequence.findOneAndUpdate(
      { key: sequenceKey },
      { $inc: { seq: 1 } },
      { new: true, upsert: true }
    );
    const today = new Date();
    const yyyy = today.getFullYear();
    const mm = String(today.getMonth() + 1).padStart(2, "0");
    const dd = String(today.getDate()).padStart(2, "0");
    const num = String(seq.seq).padStart(4, "0");
    return `APT-${yyyy}${mm}${dd}-${num}`;
  }

  /**
   * CREATE APPOINTMENT
   */
  async createAppointment(data, organizationId) {
    const {
      branchId,
      customerId,
      staffId = null,
      serviceIds,
      date,
      appointmentDate,
      startTime,
      bookingType,
      notes = "",
      discount = 0,
      reminder = {},
    } = data;

    const targetDate = date || appointmentDate;
    if (!targetDate) {
      throw new AppError("Appointment date is required (appointmentDate or date)", 400);
    }

    // 1. Validate Target Branch
    const branch = await Branch.findOne({ _id: branchId, organizationId, isActive: true });
    if (!branch) {
      throw new AppError("Target branch not found or inactive", 404);
    }

    // 2. Validate Customer
    const customer = await Customer.findOne({ _id: customerId, organizationId, isDeleted: false });
    if (!customer) {
      throw new AppError("Customer not found or belongs to another organization", 404);
    }

    if (customer.status !== "active") {
      throw new AppError(`Cannot book appointment for customer with status '${customer.status}'`, 400);
    }

    // 3. Validate & Snapshot Services
    const dbServices = await Service.find({
      _id: { $in: serviceIds },
      organizationId,
      branchId,
      isDeleted: false,
      status: "active",
    });

    if (dbServices.length !== serviceIds.length) {
      throw new AppError("One or more selected services are invalid, inactive, or belong to a different branch", 400);
    }

    let totalDuration = 0;
    let subtotal = 0;
    let totalTax = 0;

    const serviceSnapshots = serviceIds.map((id) => {
      const s = dbServices.find((serv) => serv._id.toString() === id.toString());
      const basePrice = s.pricing?.basePrice || 0;
      const taxRate = s.taxConfiguration?.taxable ? s.taxConfiguration.taxRate || 0 : 0;
      const taxAmount = Number(((basePrice * taxRate) / 100).toFixed(2));

      totalDuration += s.duration;
      subtotal += basePrice;
      totalTax += taxAmount;

      return {
        serviceId: s._id,
        name: s.name,
        duration: s.duration,
        price: basePrice,
        taxRate,
        taxAmount,
      };
    });

    const tz = branch.timezone || "Asia/Kolkata";

    // 4. Calculate Time & Canonical Instants
    const startAt = parseLocalToUTC(targetDate, startTime, tz);
    const endAt = new Date(startAt.getTime() + totalDuration * 60000);

    const formattedStart = formatUTCToLocal(startAt, tz);
    const formattedEnd = formatUTCToLocal(endAt, tz);

    // Same-day operating window enforcement
    if (formattedStart.dateStr !== formattedEnd.dateStr) {
      throw new AppError("Overnight appointments across calendar midnight boundaries are not supported", 400);
    }

    // Past booking check for advance bookings
    if (bookingType === "advance" && startAt.getTime() < Date.now()) {
      throw new AppError("Cannot schedule advance appointments in the past", 400);
    }

    // 5. Staff Availability & Leave Validation
    if (staffId) {
      await this.validateStaffAvailability(staffId, organizationId, branchId, targetDate, startAt, endAt);
    }

    // 6. Calculate Pricing
    const total = Math.max(0, Number((subtotal - discount + totalTax).toFixed(2)));

    // 7. Generate Code & Minute Buckets
    const appointmentCode = await this.generateAppointmentCode(organizationId);
    const slotMinutes = staffId ? generateSlotMinutes(startAt, endAt) : [];

    const initialStatus = bookingType === "walk_in" ? "in_progress" : "scheduled";

    try {
      const appointment = await appointmentRepo.create({
        organizationId,
        branchId,
        appointmentCode,
        customerId,
        staffId,
        services: serviceSnapshots,
        startAt,
        endAt,
        appointmentDate: formattedStart.dateStr,
        startTime: formattedStart.timeStr,
        endTime: formattedEnd.timeStr,
        totalDuration,
        slotMinutes,
        status: initialStatus,
        bookingType,
        pricing: {
          subtotal: Number(subtotal.toFixed(2)),
          discount: Number(discount.toFixed(2)),
          tax: Number(totalTax.toFixed(2)),
          total,
        },
        notes,
        reminder: {
          enabled: reminder.enabled ?? true,
          channel: reminder.channel || "sms",
          offsetMinutes: reminder.offsetMinutes || 60,
          status: "pending",
        },
      });

      // Schedule reminders
      if (initialStatus === "scheduled") {
        await this.scheduleReminders(appointment);
      }

      return appointment;
    } catch (err) {
      if (err.code === 11000 && err.keyPattern?.slotMinutes) {
        throw new AppError("The assigned staff member already has an overlapping appointment during this time slot.", 409);
      }
      throw err;
    }
  }

  /**
   * LIST APPOINTMENTS
   */
  async listAppointments(filter = {}, pagination = {}, organizationId, branchId = null) {
    return await appointmentRepo.find(filter, pagination, organizationId, branchId);
  }

  /**
   * GET SINGLE APPOINTMENT
   */
  async getAppointmentById(id, organizationId) {
    const appointment = await appointmentRepo.findById(id, organizationId);
    if (!appointment) {
      throw new AppError("Appointment not found", 404);
    }
    return appointment;
  }

  /**
   * UPDATE GENERAL METADATA / SERVICES / DISCOUNT
   */
  async updateAppointment(id, data, organizationId) {
    const { branchId, serviceIds, staffId, notes, discount, reminder } = data;

    const appointment = await appointmentRepo.findById(id, organizationId);
    if (!appointment) {
      throw new AppError("Appointment not found", 404);
    }

    const aptBranchId = appointment.branchId?._id ? appointment.branchId._id.toString() : appointment.branchId.toString();
    if (aptBranchId !== branchId.toString()) {
      throw new AppError("Target branchId does not match the appointment branch", 400);
    }

    if (["completed", "cancelled", "no_show"].includes(appointment.status)) {
      throw new AppError(`Cannot modify appointment with terminal status '${appointment.status}'`, 400);
    }

    const updates = {};

    if (notes !== undefined) updates.notes = notes;
    if (reminder !== undefined) updates.reminder = { ...appointment.reminder.toObject(), ...reminder };

    // If services changed, recalculate snapshot, duration, endAt, and pricing
    if (serviceIds && serviceIds.length > 0) {
      const dbServices = await Service.find({
        _id: { $in: serviceIds },
        organizationId,
        branchId,
        isDeleted: false,
        status: "active",
      });

      if (dbServices.length !== serviceIds.length) {
        throw new AppError("One or more selected services are invalid or inactive for this branch", 400);
      }

      let totalDuration = 0;
      let subtotal = 0;
      let totalTax = 0;

      const serviceSnapshots = serviceIds.map((sId) => {
        const s = dbServices.find((serv) => serv._id.toString() === sId.toString());
        const basePrice = s.pricing?.basePrice || 0;
        const taxRate = s.taxConfiguration?.taxable ? s.taxConfiguration.taxRate || 0 : 0;
        const taxAmount = Number(((basePrice * taxRate) / 100).toFixed(2));

        totalDuration += s.duration;
        subtotal += basePrice;
        totalTax += taxAmount;

        return {
          serviceId: s._id,
          name: s.name,
          duration: s.duration,
          price: basePrice,
          taxRate,
          taxAmount,
        };
      });

      const startAt = appointment.startAt;
      const endAt = new Date(startAt.getTime() + totalDuration * 60000);
      const formattedEnd = formatUTCToLocal(endAt);

      const effectiveDiscount = discount !== undefined ? discount : appointment.pricing.discount;
      const total = Math.max(0, Number((subtotal - effectiveDiscount + totalTax).toFixed(2)));

      updates.services = serviceSnapshots;
      updates.totalDuration = totalDuration;
      updates.endAt = endAt;
      updates.endTime = formattedEnd.timeStr;
      updates.pricing = {
        subtotal: Number(subtotal.toFixed(2)),
        discount: Number(effectiveDiscount.toFixed(2)),
        tax: Number(totalTax.toFixed(2)),
        total,
      };

      const targetStaffId = staffId !== undefined ? staffId : appointment.staffId;
      if (targetStaffId) {
        updates.slotMinutes = generateSlotMinutes(startAt, endAt);
      }
    } else if (discount !== undefined) {
      const subtotal = appointment.pricing.subtotal;
      const tax = appointment.pricing.tax;
      const total = Math.max(0, Number((subtotal - discount + tax).toFixed(2)));
      updates.pricing = {
        ...appointment.pricing.toObject(),
        discount: Number(discount.toFixed(2)),
        total,
      };
    }

    if (staffId !== undefined && staffId !== appointment.staffId?.toString()) {
      if (staffId) {
        await this.validateStaffAvailability(
          staffId,
          organizationId,
          branchId,
          appointment.appointmentDate,
          appointment.startAt,
          updates.endAt || appointment.endAt,
          id
        );
        updates.staffId = staffId;
        updates.slotMinutes = generateSlotMinutes(appointment.startAt, updates.endAt || appointment.endAt);
      } else {
        updates.staffId = null;
        updates.slotMinutes = [];
      }
    }

    try {
      const updated = await appointmentRepo.update(id, updates, organizationId);
      return updated;
    } catch (err) {
      if (err.code === 11000 && err.keyPattern?.slotMinutes) {
        throw new AppError("The assigned staff member already has an overlapping appointment during this time slot.", 409);
      }
      throw err;
    }
  }

  /**
   * RESCHEDULE APPOINTMENT DATE/TIME (SAME BRANCH ONLY)
   */
  async rescheduleAppointment(id, data, organizationId) {
    const { branchId, date, appointmentDate, startTime } = data;

    const targetDate = date || appointmentDate;
    if (!targetDate) {
      throw new AppError("Reschedule date is required (appointmentDate or date)", 400);
    }

    const appointment = await appointmentRepo.findById(id, organizationId);
    if (!appointment) {
      throw new AppError("Appointment not found", 404);
    }

    // Helper to get branch ID string safely regardless of whether branchId is populated
    const getAptBranchId = (apt) => (apt.branchId?._id ? apt.branchId._id.toString() : apt.branchId.toString());

    // Invariant 5: Same-branch rescheduling only
    if (getAptBranchId(appointment) !== branchId.toString()) {
      throw new AppError("Cross-branch rescheduling is not supported. Target branch must match existing appointment branch.", 400);
    }

    if (["completed", "cancelled", "no_show"].includes(appointment.status)) {
      throw new AppError(`Cannot reschedule appointment with terminal status '${appointment.status}'`, 400);
    }

    const branch = await Branch.findOne({ _id: branchId, organizationId });
    const tz = branch?.timezone || "Asia/Kolkata";

    const startAt = parseLocalToUTC(targetDate, startTime, tz);
    const endAt = new Date(startAt.getTime() + appointment.totalDuration * 60000);

    const formattedStart = formatUTCToLocal(startAt, tz);
    const formattedEnd = formatUTCToLocal(endAt, tz);

    if (formattedStart.dateStr !== formattedEnd.dateStr) {
      throw new AppError("Overnight appointments across calendar midnight boundaries are not supported", 400);
    }

    if (startAt.getTime() < Date.now()) {
      throw new AppError("Cannot reschedule appointment to a past time", 400);
    }

    if (appointment.staffId) {
      await this.validateStaffAvailability(
        appointment.staffId,
        organizationId,
        branchId,
        targetDate,
        startAt,
        endAt,
        id
      );
    }

    const slotMinutes = appointment.staffId ? generateSlotMinutes(startAt, endAt) : [];

    // Cancel old reminders
    await this.cancelReminders(appointment);

    try {
      const updated = await appointmentRepo.update(
        id,
        {
          startAt,
          endAt,
          appointmentDate: formattedStart.dateStr,
          startTime: formattedStart.timeStr,
          endTime: formattedEnd.timeStr,
          slotMinutes,
        },
        organizationId
      );

      // Schedule new reminders
      if (updated.status === "scheduled") {
        await this.scheduleReminders(updated);
      }

      return updated;
    } catch (err) {
      if (err.code === 11000 && err.keyPattern?.slotMinutes) {
        throw new AppError("The assigned staff member already has an overlapping appointment during this time slot.", 409);
      }
      throw err;
    }
  }

  /**
   * ASSIGN OR REASSIGN STAFF
   */
  async assignStaff(id, data, organizationId) {
    const { branchId, staffId } = data;

    const appointment = await appointmentRepo.findById(id, organizationId);
    if (!appointment) {
      throw new AppError("Appointment not found", 404);
    }

    const getAptBranchId = (apt) => (apt.branchId?._id ? apt.branchId._id.toString() : apt.branchId.toString());
    if (getAptBranchId(appointment) !== branchId.toString()) {
      throw new AppError("Target branchId does not match appointment branch", 400);
    }

    if (["completed", "cancelled", "no_show"].includes(appointment.status)) {
      throw new AppError(`Cannot assign staff on appointment with terminal status '${appointment.status}'`, 400);
    }

    let slotMinutes = [];
    if (staffId) {
      await this.validateStaffAvailability(
        staffId,
        organizationId,
        branchId,
        appointment.appointmentDate,
        appointment.startAt,
        appointment.endAt,
        id
      );
      slotMinutes = generateSlotMinutes(appointment.startAt, appointment.endAt);
    }

    try {
      return await appointmentRepo.update(
        id,
        { staffId, slotMinutes },
        organizationId
      );
    } catch (err) {
      if (err.code === 11000 && err.keyPattern?.slotMinutes) {
        throw new AppError("The assigned staff member already has an overlapping appointment during this time slot.", 409);
      }
      throw err;
    }
  }

  /**
   * UPDATE APPOINTMENT STATUS
   */
  async updateStatus(id, data, organizationId, userId) {
    const { branchId, status, reason = null } = data;

    const appointment = await appointmentRepo.findById(id, organizationId);
    if (!appointment) {
      throw new AppError("Appointment not found", 404);
    }

    const getAptBranchId = (apt) => (apt.branchId?._id ? apt.branchId._id.toString() : apt.branchId.toString());
    if (getAptBranchId(appointment) !== branchId.toString()) {
      throw new AppError("Target branchId does not match appointment branch", 400);
    }

    const currentStatus = appointment.status;

    // Terminal state checks
    if (["completed", "cancelled", "no_show"].includes(currentStatus)) {
      throw new AppError(`Appointment is in terminal status '${currentStatus}' and cannot be modified`, 400);
    }

    // Status transition rules
    if (status === "in_progress") {
      if (!appointment.staffId) {
        throw new AppError("Cannot start service without an assigned staff member", 400);
      }
      if (currentStatus !== "scheduled") {
        throw new AppError(`Invalid status transition from '${currentStatus}' to 'in_progress'`, 400);
      }
    } else if (status === "completed") {
      if (currentStatus !== "in_progress") {
        throw new AppError(`Invalid status transition from '${currentStatus}' to 'completed'`, 400);
      }
    }

    const updates = { status };

    if (status === "completed") {
      updates.completedAt = new Date();
      updates.slotMinutes = []; // Release slot minutes
    } else if (status === "cancelled" || status === "no_show") {
      updates.slotMinutes = []; // Release slot minutes
      if (status === "cancelled") {
        updates.cancellation = {
          cancelledBy: userId,
          cancelledAt: new Date(),
          reason,
        };
      }
      // Invalidate pending reminders
      await this.cancelReminders(appointment);
      updates["reminder.status"] = "cancelled";
    }

    return await appointmentRepo.update(id, updates, organizationId);
  }

  /**
   * ADMINISTRATIVE SOFT DELETE
   */
  async deleteAppointment(id, branchId, organizationId) {
    const appointment = await appointmentRepo.findById(id, organizationId);
    if (!appointment) {
      throw new AppError("Appointment not found", 404);
    }

    const getAptBranchId = (apt) => (apt.branchId?._id ? apt.branchId._id.toString() : apt.branchId.toString());
    if (getAptBranchId(appointment) !== branchId.toString()) {
      throw new AppError("Target branchId does not match appointment branch", 400);
    }

    await this.cancelReminders(appointment);

    return await appointmentRepo.softDelete(id, organizationId);
  }
}
