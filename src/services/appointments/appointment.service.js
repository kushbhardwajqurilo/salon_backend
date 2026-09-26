import { AppointmentRepository } from "../../repositories/appointments/appointment.repository.js";
import { Appointment } from "../../models/appointments/appointment.model.js";
import { Customer } from "../../models/customers/customer.model.js";
import { Staff } from "../../models/staff/staff.model.js";
import { Service } from "../../models/services/service.model.js";
import { Branch } from "../../models/branches/branch.model.js";
import { Leave } from "../../models/leaves/leave.model.js";
import { Subscription } from "../../models/subscriptions/subscription.model.js";
import { SubscriptionUsage } from "../../models/subscriptions/subscriptionUsage.model.js";
import { SubscriptionConsumptionChallenge } from "../../models/subscriptions/subscriptionConsumptionChallenge.model.js";
import { AuditLog, AUDIT_ACTIONS } from "../../models/audit/auditLog.model.js";
import { AppError } from "../../utils/errors.js";
import { Sequence } from "../../models/sequence/sequence.model.js";
import { emailQueue, smsQueue } from "../../queues/client.js";
import { logger } from "../../utils/logger.js";
import mongoose from "mongoose";
import crypto from "crypto";

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
export const parseLocalToUTC = (
  dateStr,
  timeStr,
  timezone = DEFAULT_TIMEZONE,
) => {
  const tz = timezone || DEFAULT_TIMEZONE;
  const [year, month, day] = dateStr.split("-").map(Number);
  const [hours, minutes] = timeStr.split(":").map(Number);

  // Construct nominal UTC instant assuming input was UTC
  const nominalUtc = new Date(
    Date.UTC(year, month - 1, day, hours, minutes, 0, 0),
  );
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
        reminder.sentAt =
          reminder.email.sentAt > reminder.sms.sentAt
            ? reminder.email.sentAt
            : reminder.sms.sentAt;
        reminder.failureReason = null;
      } else if (emailStatus === "sent" || smsStatus === "sent") {
        reminder.status = "partial_delivery";
        reminder.sentAt = reminder.email.sentAt || reminder.sms.sentAt;
        const failedReason =
          reminder.email.failureReason || reminder.sms.failureReason;
        reminder.failureReason = failedReason
          ? `Partial delivery: ${failedReason}`
          : null;
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
        await appointmentRepo.update(
          appointment._id,
          {
            "reminder.status": "cancelled",
            "reminder.sendAt": null,
            "reminder.failureReason": "Reminder disabled by configuration",
            "reminder.email.status": "cancelled",
            "reminder.sms.status": "cancelled",
          },
          appointment.organizationId,
        );
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
      await appointmentRepo.update(
        appointment._id,
        {
          "reminder.sendAt": sendAt,
          "reminder.status": "cancelled",
          "reminder.failureReason": "sendAt is in the past",
          "reminder.email.status": "cancelled",
          "reminder.email.failureReason": "sendAt is in the past",
          "reminder.sms.status": "cancelled",
          "reminder.sms.failureReason": "sendAt is in the past",
        },
        appointment.organizationId,
      );
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

      await appointmentRepo.update(
        appointment._id,
        updates,
        appointment.organizationId,
      );
    } catch (err) {
      console.error("Failed to enqueue reminder job:", err.message);
      await appointmentRepo.update(
        appointment._id,
        {
          "reminder.sendAt": sendAt,
          "reminder.status": "failed",
          "reminder.failedAt": new Date(),
          "reminder.failureReason": `Enqueue error: ${err.message}`,
        },
        appointment.organizationId,
      );
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
      const emailJob = emailQueue?.getJob
        ? await emailQueue.getJob(emailJobId)
        : null;
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

    const aptBranchId = appointment.branchId?._id
      ? appointment.branchId._id.toString()
      : appointment.branchId.toString();
    if (aptBranchId !== branchId.toString()) {
      throw new AppError(
        "Target branchId does not match appointment branch",
        400,
      );
    }

    if (["completed", "cancelled", "no_show"].includes(appointment.status)) {
      throw new AppError(
        `Cannot trigger reminder for appointment with status '${appointment.status}'`,
        400,
      );
    }

    if (appointment.reminder?.status === "sent") {
      throw new AppError(
        "Reminder has already been delivered across all configured channels",
        400,
      );
    }

    const customer = await Customer.findOne({
      _id: appointment.customerId,
      organizationId,
      isDeleted: false,
    });
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
        channelResults.email = {
          status: "sent",
          sentAt: appointment.reminder.email.sentAt,
        };
      } else if (!customer.email) {
        channelResults.email = {
          status: "failed",
          failedAt: now,
          failureReason: "Customer has no email address configured",
        };
      } else {
        try {
          await emailService.sendMail({
            to: customer.email,
            subject: `Appointment Reminder — ${appointment.appointmentCode}`,
            text: `Hello ${customer.name}, this is a reminder for your upcoming salon appointment on ${formattedStart.dateStr} at ${formattedStart.timeStr}.`,
            html: `<p>Hello <strong>${customer.name}</strong>,</p><p>This is a reminder for your upcoming salon appointment (Code: <code>${appointment.appointmentCode}</code>) scheduled on <strong>${formattedStart.dateStr}</strong> at <strong>${formattedStart.timeStr}</strong>.</p>`,
          });
          channelResults.email = {
            status: "sent",
            sentAt: now,
            failureReason: null,
          };
        } catch (err) {
          channelResults.email = {
            status: "failed",
            failedAt: now,
            failureReason: `Email dispatch failed: ${err.message}`,
          };
        }
      }
    }

    // 2. Process SMS Channel if requested and not already sent
    if (channel === "sms" || channel === "both") {
      if (appointment.reminder?.sms?.status === "sent") {
        channelResults.sms = {
          status: "sent",
          sentAt: appointment.reminder.sms.sentAt,
        };
      } else if (!customer.phone) {
        channelResults.sms = {
          status: "failed",
          failedAt: now,
          failureReason: "Customer has no phone number configured",
        };
      } else {
        try {
          await smsService.sendSms({
            phone: customer.phone,
            message: `Reminder: Your appointment ${appointment.appointmentCode} is scheduled for ${formattedStart.dateStr} at ${formattedStart.timeStr}.`,
          });
          channelResults.sms = {
            status: "sent",
            sentAt: now,
            failureReason: null,
          };
        } catch (err) {
          channelResults.sms = {
            status: "failed",
            failedAt: now,
            failureReason: `SMS dispatch failed: ${err.message}`,
          };
        }
      }
    }

    // Build update object
    const updateObj = {};
    if (channelResults.email) {
      updateObj["reminder.email.status"] = channelResults.email.status;
      if (channelResults.email.status === "sent")
        updateObj["reminder.email.sentAt"] = channelResults.email.sentAt;
      if (channelResults.email.status === "failed") {
        updateObj["reminder.email.failedAt"] = channelResults.email.failedAt;
        updateObj["reminder.email.failureReason"] =
          channelResults.email.failureReason;
      }
    }
    if (channelResults.sms) {
      updateObj["reminder.sms.status"] = channelResults.sms.status;
      if (channelResults.sms.status === "sent")
        updateObj["reminder.sms.sentAt"] = channelResults.sms.sentAt;
      if (channelResults.sms.status === "failed") {
        updateObj["reminder.sms.failedAt"] = channelResults.sms.failedAt;
        updateObj["reminder.sms.failureReason"] =
          channelResults.sms.failureReason;
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
      const errDetail =
        channelResults.email?.failureReason ||
        channelResults.sms?.failureReason ||
        "Provider delivery failed";
      throw new AppError(`Reminder delivery failed: ${errDetail}`, 400);
    }

    return updated;
  }

  /**
   * Helper to check staff availability and leave status
   */
  async validateStaffAvailability(
    staffId,
    organizationId,
    branchId,
    dateStr,
    startAt,
    endAt,
    excludeAppointmentId = null,
  ) {
    if (!staffId) return;
    // 1. Verify staff exists, belongs to organization, and is active
    const staff = await Staff.findOne({
      _id: staffId,
      organizationId,
      isDeleted: false,
    });

    if (!staff) {
      throw new AppError("Staff member not found", 404);
    }

    if (staff.status !== "active") {
      throw new AppError(
        `Cannot assign staff with status '${staff.status}'`,
        400,
      );
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
   * Helper to validate subscription entitlement eligibility at booking or update
   */
  async validateSubscriptionEntitlement(
    subscriptionId,
    serviceId,
    customerId,
    branchId,
    organizationId,
    session = null
  ) {
    if (!subscriptionId) return null;

    let query = Subscription.findOne({
      _id: subscriptionId,
      organizationId,
      isDeleted: false,
    });
    if (session) query = query.session(session);
    const subscription = await query;

    if (!subscription) {
      throw new AppError("Applied subscription not found in this organization", 404);
    }

    if (subscription.customerId.toString() !== customerId.toString()) {
      throw new AppError("Applied subscription does not belong to this customer", 400);
    }

    if (subscription.status !== "active") {
      throw new AppError(
        `Applied subscription is not active (current status: '${subscription.status}')`,
        400
      );
    }

    const now = new Date();
    if (subscription.endDate && new Date(subscription.endDate) < now) {
      throw new AppError("Applied subscription has expired", 400);
    }
    if (subscription.startDate && new Date(subscription.startDate) > now) {
      throw new AppError("Applied subscription is not yet active", 400);
    }

    // Branch eligibility check
    if (
      Array.isArray(subscription.permittedBranchIds) &&
      subscription.permittedBranchIds.length > 0
    ) {
      const isPermitted = subscription.permittedBranchIds.some(
        (b) => b.toString() === branchId.toString()
      );
      if (!isPermitted) {
        throw new AppError("Applied subscription is not valid at this branch", 403);
      }
    }

    // Service entitlement check
    const entitlement = subscription.entitlements.find(
      (e) => e.serviceId.toString() === serviceId.toString()
    );
    if (!entitlement) {
      throw new AppError(
        "Applied subscription does not contain an entitlement for this service",
        400
      );
    }

    if (entitlement.remainingQuantity <= 0) {
      throw new AppError(
        `Applied subscription has no remaining quantity for service '${entitlement.serviceName}'`,
        409
      );
    }

    return subscription;
  }

  /**
   * Generates next unique appointment code
   */
  async generateAppointmentCode(organizationId) {
    const sequenceKey = `APT_${organizationId.toString()}`;
    const seq = await Sequence.findOneAndUpdate(
      { key: sequenceKey },
      { $inc: { seq: 1 } },
      { new: true, upsert: true },
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
      services,
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
      throw new AppError(
        "Appointment date is required (appointmentDate or date)",
        400,
      );
    }

    // 1. Validate Target Branch
    const branch = await Branch.findOne({
      _id: branchId,
      organizationId,
      isActive: true,
    });
    if (!branch) {
      throw new AppError("Target branch not found or inactive", 404);
    }

    // 2. Validate Customer
    const customer = await Customer.findOne({
      _id: customerId,
      organizationId,
      isDeleted: false,
    });
    if (!customer) {
      throw new AppError(
        "Customer not found or belongs to another organization",
        404,
      );
    }

    if (customer.status !== "active") {
      throw new AppError(
        `Cannot book appointment for customer with status '${customer.status}'`,
        400,
      );
    }

    // Normalize incoming service selections (supporting services array with customPrice/appliedSubscriptionId or serviceIds array)
    let normalizedServiceInputs = [];
    if (Array.isArray(services) && services.length > 0) {
      normalizedServiceInputs = services.map((item) => {
        if (typeof item === "string") {
          return { serviceId: item, customPrice: undefined, appliedSubscriptionId: null };
        }
        return {
          serviceId: item.serviceId
            ? item.serviceId.toString()
            : item.toString(),
          customPrice:
            item.customPrice !== undefined && item.customPrice !== null
              ? Number(item.customPrice)
              : undefined,
          appliedSubscriptionId: item.appliedSubscriptionId
            ? item.appliedSubscriptionId.toString()
            : null,
        };
      });
    } else if (Array.isArray(serviceIds) && serviceIds.length > 0) {
      normalizedServiceInputs = serviceIds.map((id) => ({
        serviceId: id.toString(),
        customPrice: undefined,
        appliedSubscriptionId: null,
      }));
    }

    const extractedIds = normalizedServiceInputs.map((item) => item.serviceId);

    // 3. Validate & Snapshot Services
    const dbServices = await Service.find({
      _id: { $in: extractedIds },
      organizationId,
      isDeleted: false,
      status: "active",
    });

    if (dbServices.length !== extractedIds.length) {
      throw new AppError(
        "One or more selected services are invalid, inactive, or belong to a different organization",
        400,
      );
    }

    // Validate any appliedSubscriptionId
    for (const item of normalizedServiceInputs) {
      if (item.appliedSubscriptionId) {
        await this.validateSubscriptionEntitlement(
          item.appliedSubscriptionId,
          item.serviceId,
          customerId,
          branchId,
          organizationId
        );
      }
    }

    let totalDuration = 0;
    let subtotal = 0;

    const serviceSnapshots = normalizedServiceInputs.map((item) => {
      const s = dbServices.find(
        (serv) => serv._id.toString() === item.serviceId.toString(),
      );
      const resolvedPrice =
        item.customPrice !== undefined
          ? item.customPrice
          : (s.pricing?.basePrice ?? 0);

      totalDuration += s.duration;
      subtotal += resolvedPrice;

      return {
        serviceId: s._id,
        name: s.name,
        duration: s.duration,
        price: resolvedPrice,
        appliedSubscriptionId: item.appliedSubscriptionId || null,
        isRedeemedViaSubscription: false,
        subscriptionUsageId: null,
      };
    });

    const tz = branch.timezone || "Asia/Kolkata";
    const currentBranchTime = formatUTCToLocal(new Date(), tz);

    // 1. Walk-in Date/Time Locking: Walk-ins strictly belong to today's date in branch timezone
    if (bookingType === "walk_in" && targetDate !== currentBranchTime.dateStr) {
      throw new AppError(
        "Walk-in appointments must be scheduled for today's date",
        400,
      );
    }

    // 4. Calculate Time & Canonical Instants
    const startAt = parseLocalToUTC(targetDate, startTime, tz);
    const endAt = new Date(startAt.getTime() + totalDuration * 60000);

    const formattedStart = formatUTCToLocal(startAt, tz);
    const formattedEnd = formatUTCToLocal(endAt, tz);

    // Same-day operating window enforcement
    if (formattedStart.dateStr !== formattedEnd.dateStr) {
      throw new AppError(
        "Overnight appointments across calendar midnight boundaries are not supported",
        400,
      );
    }

    // Past booking check for advance bookings
    if (bookingType === "advance" && startAt.getTime() < Date.now()) {
      throw new AppError(
        "Cannot schedule advance appointments in the past",
        400,
      );
    }

    // 5. Staff Availability & Leave Validation
    if (staffId) {
      await this.validateStaffAvailability(
        staffId,
        organizationId,
        branchId,
        targetDate,
        startAt,
        endAt,
      );
    }

    // 6. Calculate Pricing
    const total = Math.max(0, Number((subtotal - discount).toFixed(2)));

    // 7. Generate Code & Minute Buckets
    const appointmentCode = await this.generateAppointmentCode(organizationId);
    const slotMinutes = staffId ? generateSlotMinutes(startAt, endAt) : [];

    // Floor Queue & Status: If walk-in without staff (floor queue), status is 'scheduled'. Only if staff is assigned does it start as 'in_progress'.
    const initialStatus =
      bookingType === "walk_in"
        ? staffId
          ? "in_progress"
          : "scheduled"
        : "scheduled";

    // Reminders: Walk-in clients are physically at the parlour today, skip automated reminders.
    const isWalkIn = bookingType === "walk_in";
    const reminderConfig = {
      enabled: isWalkIn ? false : (reminder.enabled ?? true),
      channel: reminder.channel || "sms",
      offsetMinutes: reminder.offsetMinutes || 60,
      status: isWalkIn ? "cancelled" : "pending",
    };

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
          total,
        },
        notes,
        reminder: reminderConfig,
      });

      // Schedule reminders for scheduled advance appointments
      if (initialStatus === "scheduled" && reminderConfig.enabled) {
        await this.scheduleReminders(appointment);
      }

      // Record interaction: automatically track visited branch for the customer
      await Customer.updateOne(
        { _id: customerId, organizationId },
        { $addToSet: { visitedBranchIds: branchId } },
      );

      return appointment;
    } catch (err) {
      if (err.code === 11000 && err.keyPattern?.slotMinutes) {
        throw new AppError(
          "The assigned staff member already has an overlapping appointment during this time slot.",
          409,
        );
      }
      throw err;
    }
  }

  /**
   * LIST APPOINTMENTS
   */
  async listAppointments(
    filter = {},
    pagination = {},
    organizationId,
    branchId = null,
  ) {
    return await appointmentRepo.find(
      filter,
      pagination,
      organizationId,
      branchId,
    );
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
    const {
      branchId,
      serviceIds,
      services,
      staffId,
      notes,
      discount,
      reminder,
    } = data;

    const appointment = await appointmentRepo.findById(id, organizationId);
    if (!appointment) {
      throw new AppError("Appointment not found", 404);
    }

    const aptBranchId = appointment.branchId?._id
      ? appointment.branchId._id.toString()
      : appointment.branchId.toString();
    if (aptBranchId !== branchId.toString()) {
      throw new AppError(
        "Target branchId does not match the appointment branch",
        400,
      );
    }

    if (["completed", "cancelled", "no_show"].includes(appointment.status)) {
      throw new AppError(
        `Cannot modify appointment with terminal status '${appointment.status}'`,
        400,
      );
    }

    const updates = {};

    if (notes !== undefined) updates.notes = notes;
    if (reminder !== undefined)
      updates.reminder = { ...appointment.reminder.toObject(), ...reminder };

    // Normalize incoming service selections if provided
    let normalizedServiceInputs = null;
    if (Array.isArray(services) && services.length > 0) {
      normalizedServiceInputs = services.map((item) => {
        if (typeof item === "string") {
          return { serviceId: item, customPrice: undefined, appliedSubscriptionId: null };
        }
        return {
          serviceId: item.serviceId
            ? item.serviceId.toString()
            : item.toString(),
          customPrice:
            item.customPrice !== undefined && item.customPrice !== null
              ? Number(item.customPrice)
              : undefined,
          appliedSubscriptionId: item.appliedSubscriptionId
            ? item.appliedSubscriptionId.toString()
            : null,
        };
      });
    } else if (Array.isArray(serviceIds) && serviceIds.length > 0) {
      normalizedServiceInputs = serviceIds.map((id) => ({
        serviceId: id.toString(),
        customPrice: undefined,
        appliedSubscriptionId: null,
      }));
    }

    // If services changed, recalculate snapshot, duration, endAt, and pricing
    if (normalizedServiceInputs && normalizedServiceInputs.length > 0) {
      const extractedIds = normalizedServiceInputs.map(
        (item) => item.serviceId,
      );
      const dbServices = await Service.find({
        _id: { $in: extractedIds },
        organizationId,
        isDeleted: false,
        status: "active",
      });

      if (dbServices.length !== extractedIds.length) {
        throw new AppError(
          "One or more selected services are invalid or inactive for this organization",
          400,
        );
      }

      // Validate any appliedSubscriptionId
      const customerId = appointment.customerId?._id || appointment.customerId;
      for (const item of normalizedServiceInputs) {
        if (item.appliedSubscriptionId) {
          await this.validateSubscriptionEntitlement(
            item.appliedSubscriptionId,
            item.serviceId,
            customerId,
            branchId,
            organizationId
          );
        }
      }

      let totalDuration = 0;
      let subtotal = 0;

      const serviceSnapshots = normalizedServiceInputs.map((item) => {
        const s = dbServices.find(
          (serv) => serv._id.toString() === item.serviceId.toString(),
        );
        const resolvedPrice =
          item.customPrice !== undefined
            ? item.customPrice
            : (s.pricing?.basePrice ?? 0);

        totalDuration += s.duration;
        subtotal += resolvedPrice;

        return {
          serviceId: s._id,
          name: s.name,
          duration: s.duration,
          price: resolvedPrice,
          appliedSubscriptionId: item.appliedSubscriptionId || null,
          isRedeemedViaSubscription: false,
          subscriptionUsageId: null,
        };
      });

      const startAt = appointment.startAt;
      const endAt = new Date(startAt.getTime() + totalDuration * 60000);
      const formattedEnd = formatUTCToLocal(endAt);

      const effectiveDiscount =
        discount !== undefined ? discount : appointment.pricing.discount;
      const total = Math.max(
        0,
        Number((subtotal - effectiveDiscount).toFixed(2)),
      );

      updates.services = serviceSnapshots;
      updates.totalDuration = totalDuration;
      updates.endAt = endAt;
      updates.endTime = formattedEnd.timeStr;
      updates.pricing = {
        subtotal: Number(subtotal.toFixed(2)),
        discount: Number(effectiveDiscount.toFixed(2)),
        total,
      };

      const targetStaffId =
        staffId !== undefined ? staffId : appointment.staffId;
      if (targetStaffId) {
        updates.slotMinutes = generateSlotMinutes(startAt, endAt);
      }
    } else if (discount !== undefined) {
      const subtotal = appointment.pricing.subtotal;
      const total = Math.max(0, Number((subtotal - discount).toFixed(2)));
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
          id,
        );
        updates.staffId = staffId;
        updates.slotMinutes = generateSlotMinutes(
          appointment.startAt,
          updates.endAt || appointment.endAt,
        );
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
        throw new AppError(
          "The assigned staff member already has an overlapping appointment during this time slot.",
          409,
        );
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
      throw new AppError(
        "Reschedule date is required (appointmentDate or date)",
        400,
      );
    }

    const appointment = await appointmentRepo.findById(id, organizationId);
    if (!appointment) {
      throw new AppError("Appointment not found", 404);
    }

    // Helper to get branch ID string safely regardless of whether branchId is populated
    const getAptBranchId = (apt) =>
      apt.branchId?._id ? apt.branchId._id.toString() : apt.branchId.toString();

    // Invariant 5: Same-branch rescheduling only
    if (getAptBranchId(appointment) !== branchId.toString()) {
      throw new AppError(
        "Cross-branch rescheduling is not supported. Target branch must match existing appointment branch.",
        400,
      );
    }

    if (["completed", "cancelled", "no_show"].includes(appointment.status)) {
      throw new AppError(
        `Cannot reschedule appointment with terminal status '${appointment.status}'`,
        400,
      );
    }

    const branch = await Branch.findOne({ _id: branchId, organizationId });
    const tz = branch?.timezone || "Asia/Kolkata";

    const startAt = parseLocalToUTC(targetDate, startTime, tz);
    const endAt = new Date(
      startAt.getTime() + appointment.totalDuration * 60000,
    );

    const formattedStart = formatUTCToLocal(startAt, tz);
    const formattedEnd = formatUTCToLocal(endAt, tz);

    if (formattedStart.dateStr !== formattedEnd.dateStr) {
      throw new AppError(
        "Overnight appointments across calendar midnight boundaries are not supported",
        400,
      );
    }

    const GRACE_PERIOD_MS = 5 * 60 * 1000; // 5-minute buffer
    if (startAt.getTime() < Date.now() - GRACE_PERIOD_MS) {
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
        id,
      );
    }

    const slotMinutes = appointment.staffId
      ? generateSlotMinutes(startAt, endAt)
      : [];

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
        organizationId,
      );

      // Schedule new reminders
      if (updated.status === "scheduled") {
        await this.scheduleReminders(updated);
      }

      return updated;
    } catch (err) {
      if (err.code === 11000 && err.keyPattern?.slotMinutes) {
        throw new AppError(
          "The assigned staff member already has an overlapping appointment during this time slot.",
          409,
        );
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

    const getAptBranchId = (apt) =>
      apt.branchId?._id ? apt.branchId._id.toString() : apt.branchId.toString();
    if (getAptBranchId(appointment) !== branchId.toString()) {
      throw new AppError(
        "Target branchId does not match appointment branch",
        400,
      );
    }

    if (["completed", "cancelled", "no_show"].includes(appointment.status)) {
      throw new AppError(
        `Cannot assign staff on appointment with terminal status '${appointment.status}'`,
        400,
      );
    }

    let slotMinutes = [];
    let updatedStartAt = appointment.startAt;
    let updatedEndAt = appointment.endAt;
    let updatedAppointmentDate = appointment.appointmentDate;
    let updatedStartTime = appointment.startTime;
    let updatedEndTime = appointment.endTime;

    // Fetch branch to get timezone
    const branch = await Branch.findOne({
      _id: branchId,
      organizationId,
      isActive: true,
    });
    const tz = branch?.timezone || DEFAULT_TIMEZONE;

    // Check if walk-in appointment on today whose startTime is in the past needs time advance
    const currentBranchTime = formatUTCToLocal(new Date(), tz);
    const isToday = appointment.appointmentDate === currentBranchTime.dateStr;
    const isElapsed = appointment.startTime < currentBranchTime.timeStr;
    const isUnassignedOrElapsedWalkIn =
      appointment.bookingType === "walk_in" && isToday && isElapsed;

    if (isUnassignedOrElapsedWalkIn) {
      updatedStartTime = currentBranchTime.timeStr;
      updatedStartAt = parseLocalToUTC(
        updatedAppointmentDate,
        updatedStartTime,
        tz,
      );
      const totalDuration =
        appointment.totalDuration ||
        (appointment.services || []).reduce(
          (acc, s) => acc + (s.duration || 0),
          0,
        ) ||
        15;
      updatedEndAt = new Date(updatedStartAt.getTime() + totalDuration * 60000);
      const formattedEnd = formatUTCToLocal(updatedEndAt, tz);
      updatedEndTime = formattedEnd.timeStr;
    }

    if (staffId) {
      await this.validateStaffAvailability(
        staffId,
        organizationId,
        branchId,
        updatedAppointmentDate,
        updatedStartAt,
        updatedEndAt,
        id,
      );
      slotMinutes = generateSlotMinutes(updatedStartAt, updatedEndAt);
    }

    try {
      const updatedAppointment = await appointmentRepo.update(
        id,
        {
          staffId,
          slotMinutes,
          startAt: updatedStartAt,
          endAt: updatedEndAt,
          appointmentDate: updatedAppointmentDate,
          startTime: updatedStartTime,
          endTime: updatedEndTime,
          status: "in_progress",
        },
        organizationId,
      );

      // Return fully populated appointment (including staff)
      return await appointmentRepo.findById(id, organizationId);
    } catch (err) {
      if (err.code === 11000 && err.keyPattern?.slotMinutes) {
        throw new AppError(
          "The assigned staff member already has an overlapping appointment during this time slot.",
          409,
        );
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

    const getAptBranchId = (apt) =>
      apt.branchId?._id ? apt.branchId._id.toString() : apt.branchId.toString();
    if (getAptBranchId(appointment) !== branchId.toString()) {
      throw new AppError(
        "Target branchId does not match appointment branch",
        400,
      );
    }

    const currentStatus = appointment.status;

    // Terminal state checks
    if (["completed", "cancelled", "no_show"].includes(currentStatus)) {
      throw new AppError(
        `Appointment is in terminal status '${currentStatus}' and cannot be modified`,
        400,
      );
    }

    // Status transition rules
    if (status === "in_progress") {
      if (!appointment.staffId) {
        throw new AppError(
          "Cannot start service without an assigned staff member",
          400,
        );
      }
      if (currentStatus !== "scheduled") {
        throw new AppError(
          `Invalid status transition from '${currentStatus}' to 'in_progress'`,
          400,
        );
      }
    } else if (status === "completed") {
      if (currentStatus !== "in_progress") {
        throw new AppError(
          `Invalid status transition from '${currentStatus}' to 'completed'`,
          400,
        );
      }
      // Ensure appointments with subscription-associated service lines cannot bypass OTP consumption
      const hasSubscriptionService = (appointment.services || []).some(
        (s) => s.appliedSubscriptionId && !s.isRedeemedViaSubscription
      );
      if (hasSubscriptionService) {
        throw new AppError(
          "This appointment contains subscription-associated services. It must be completed via OTP verification at /api/v1/appointments/:id/complete-with-subscription",
          400
        );
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
   * Helper to execute a sequence of operations in a MongoDB transaction with controlled enforcement
   */
  async executeTransaction(callback, { requireTransaction = false } = {}) {
    let session = null;
    try {
      // Multi-document ACID transactions in MongoDB require a replica set or sharded cluster
      const topologyType = mongoose.connection.client?.topology?.description?.type;
      const isReplicaSetOrSharded = ["ReplicaSetWithPrimary", "ReplicaSetNoPrimary", "Sharded"].includes(topologyType);
      const isStandaloneFallbackAllowed = process.env.ALLOW_STANDALONE_TRANSACTION_FALLBACK === "true";

      // If in a non-replica environment (e.g. local standalone test) and standalone fallback is allowed:
      if (!isReplicaSetOrSharded && isStandaloneFallbackAllowed) {
        return await callback(null);
      }

      if (!isReplicaSetOrSharded && !isStandaloneFallbackAllowed) {
        if (requireTransaction) {
          throw new AppError(
            "ACID transaction support is required for this operation but unavailable in the database environment (MongoDB replica set required)",
            500
          );
        }
        return await callback(null);
      }

      if (
        mongoose.connection.db &&
        typeof mongoose.connection.startSession === "function"
      ) {
        session = await mongoose.connection.startSession();
        session.startTransaction();

        const result = await callback(session);

        await session.commitTransaction();
        session.endSession();
        return result;
      }
    } catch (err) {
      if (session) {
        try {
          await session.abortTransaction();
          session.endSession();
        } catch (_) {}
      }

      const isSessionError =
        err.message &&
        (err.message.includes("Transaction numbers") ||
          err.message.includes("does not support retryable writes") ||
          err.message.includes("replica set") ||
          err.message.includes("IllegalOperation"));

      if (!isSessionError) {
        throw err;
      }

      if (requireTransaction && process.env.ALLOW_STANDALONE_TRANSACTION_FALLBACK !== "true") {
        throw new AppError(
          "ACID transaction support is required for this operation but unavailable in the database environment",
          500
        );
      }
    }

    if (requireTransaction && process.env.ALLOW_STANDALONE_TRANSACTION_FALLBACK !== "true") {
      throw new AppError(
        "ACID transaction support is required for this operation but unavailable in the database environment",
        500
      );
    }

    // Fallback: run without transaction only when allowed for non-critical/fallback paths
    return await callback(null);
  }

  /**
   * REQUEST CONSUMPTION OTP FOR SUBSCRIPTION-COVERED APPOINTMENT
   */
  async requestConsumptionOTP(id, branchId, organizationId, userId) {
    const appointment = await appointmentRepo.findById(id, organizationId);
    if (!appointment) {
      throw new AppError("Appointment not found", 404);
    }

    const getAptBranchId = (apt) =>
      apt.branchId?._id ? apt.branchId._id.toString() : apt.branchId.toString();
    if (getAptBranchId(appointment) !== branchId.toString()) {
      throw new AppError("Target branchId does not match appointment branch", 400);
    }

    if (appointment.status !== "in_progress") {
      throw new AppError(
        `Consumption OTP can only be requested for appointments in 'in_progress' status (current status: '${appointment.status}')`,
        400
      );
    }

    // Identify unredeemed subscription-associated service lines
    const subscriptionLines = (appointment.services || []).filter(
      (s) => s.appliedSubscriptionId && !s.isRedeemedViaSubscription
    );

    if (subscriptionLines.length === 0) {
      throw new AppError(
        "Appointment does not contain any unredeemed subscription-associated services",
        400
      );
    }

    // Collect all unique applied subscription IDs for this appointment
    const uniqueSubscriptionIds = [
      ...new Set(
        subscriptionLines
          .map((l) => l.appliedSubscriptionId?.toString())
          .filter(Boolean)
      ),
    ];

    // Validate customer and phone number
    const customer = await Customer.findOne({
      _id: appointment.customerId?._id || appointment.customerId,
      organizationId,
      isDeleted: false,
    });

    if (!customer || customer.status !== "active") {
      throw new AppError("Customer record is inactive or not found", 400);
    }

    if (!customer.phone) {
      throw new AppError("Customer does not have a registered phone number for OTP delivery", 400);
    }

    // Revalidate subscription eligibility for every subscription-backed line
    for (const line of subscriptionLines) {
      await this.validateSubscriptionEntitlement(
        line.appliedSubscriptionId,
        line.serviceId,
        customer._id,
        branchId,
        organizationId
      );
    }

    // Check existing challenge and enforce 60s resend cooldown (scoped strictly to appointment)
    const existingChallenge = await SubscriptionConsumptionChallenge.findOne({
      appointmentId: appointment._id,
      status: "pending",
    });

    const now = new Date();
    if (existingChallenge && existingChallenge.resendAvailableAt > now) {
      const waitSeconds = Math.ceil((existingChallenge.resendAvailableAt - now) / 1000);
      throw new AppError(
        `Too many OTP requests. Please wait ${waitSeconds} seconds before requesting a new OTP.`,
        429
      );
    }

    // Generate 6-digit OTP and SHA-256 hash
    const rawOtp = Math.floor(100000 + Math.random() * 900000).toString();
    const otpHash = crypto.createHash("sha256").update(rawOtp).digest("hex");
    const expiresAt = new Date(Date.now() + 5 * 60 * 1000); // 5 min expiry
    const resendAvailableAt = new Date(Date.now() + 60 * 1000); // 60s cooldown

    const serviceIds = subscriptionLines.map((l) => l.serviceId);

    // Upsert or create appointment-scoped challenge
    if (existingChallenge) {
      existingChallenge.otpHash = otpHash;
      existingChallenge.attempts = 0;
      existingChallenge.subscriptionIds = uniqueSubscriptionIds;
      existingChallenge.serviceIds = serviceIds;
      existingChallenge.expiresAt = expiresAt;
      existingChallenge.resendAvailableAt = resendAvailableAt;
      existingChallenge.status = "pending";
      await existingChallenge.save();
    } else {
      await SubscriptionConsumptionChallenge.create({
        organizationId,
        branchId,
        appointmentId: appointment._id,
        subscriptionIds: uniqueSubscriptionIds,
        customerId: customer._id,
        serviceIds,
        otpHash,
        attempts: 0,
        resendAvailableAt,
        expiresAt,
        status: "pending",
      });
    }

    // Dispatch SMS via BullMQ queue (never logs or returns rawOtp)
    try {
      await smsQueue.add("sendOtpSMS", {
        phone: customer.phone,
        otp: rawOtp,
      });
    } catch (queueErr) {
      logger.warn(`Failed to enqueue consumption OTP SMS: ${queueErr.message}`);
    }

    logger.info(`[SECURITY] CONSUMPTION_OTP_SENT for appointment ${appointment._id}`);

    return {
      success: true,
      message: "Consumption authorization OTP sent to customer phone",
      data: {
        expiresIn: 300,
        resendAfter: 60,
      },
    };
  }

  /**
   * COMPLETE APPOINTMENT AND CONSUME SUBSCRIPTION ENTITLEMENTS ATOMICALLY
   */
  async completeWithSubscription(id, data, organizationId, userId) {
    const { branchId, otp } = data;

    if (!otp) {
      throw new AppError("OTP is required to complete subscription-associated appointment", 400);
    }

    const appointment = await appointmentRepo.findById(id, organizationId);
    if (!appointment) {
      throw new AppError("Appointment not found", 404);
    }

    const getAptBranchId = (apt) =>
      apt.branchId?._id ? apt.branchId._id.toString() : apt.branchId.toString();
    if (getAptBranchId(appointment) !== branchId.toString()) {
      throw new AppError("Target branchId does not match appointment branch", 400);
    }

    if (appointment.status !== "in_progress") {
      throw new AppError(
        `Cannot complete appointment with status '${appointment.status}'. Must be 'in_progress'`,
        400
      );
    }

    const subscriptionLines = (appointment.services || []).filter(
      (s) => s.appliedSubscriptionId && !s.isRedeemedViaSubscription
    );

    if (subscriptionLines.length === 0) {
      throw new AppError(
        "Appointment does not contain any unredeemed subscription-associated services",
        400
      );
    }

    // Load active challenge bound specifically to this appointment
    const challenge = await SubscriptionConsumptionChallenge.findOne({
      appointmentId: appointment._id,
      organizationId,
    });

    if (!challenge) {
      throw new AppError(
        "No OTP challenge found. Please request an OTP first.",
        400
      );
    }

    if (challenge.status === "exhausted" || challenge.attempts >= 5) {
      throw new AppError("Too many incorrect OTP attempts. Please request a new OTP.", 429);
    }

    if (challenge.status !== "pending") {
      throw new AppError(
        "No pending OTP challenge found. Please request a new OTP first.",
        400
      );
    }

    const now = new Date();
    if (challenge.expiresAt < now) {
      challenge.status = "expired";
      await challenge.save();
      throw new AppError("OTP has expired. Please request a new OTP.", 400);
    }

    if (challenge.attempts >= 5) {
      challenge.status = "exhausted";
      await challenge.save();
      throw new AppError("Too many incorrect OTP attempts. Please request a new OTP.", 429);
    }

    // Verify OTP hash
    const inputHash = crypto.createHash("sha256").update(otp.toString().trim()).digest("hex");
    if (inputHash !== challenge.otpHash) {
      challenge.attempts = (challenge.attempts || 0) + 1;
      if (challenge.attempts >= 5) {
        challenge.status = "exhausted";
      }
      await challenge.save();
      const remaining = Math.max(0, 5 - challenge.attempts);
      throw new AppError(`Invalid OTP. ${remaining} attempt(s) remaining.`, 400);
    }

    // OTP matches! Execute atomic transaction with mandatory ACID guarantee
    const customer = await Customer.findOne({
      _id: appointment.customerId?._id || appointment.customerId,
      organizationId,
      isDeleted: false,
    });

    const completionResult = await this.executeTransaction(async (session) => {
      // Pre-validation pass: Verify all subscription lines are eligible and have remaining balance before mutating anything
      for (const line of subscriptionLines) {
        await this.validateSubscriptionEntitlement(
          line.appliedSubscriptionId,
          line.serviceId,
          customer._id,
          branchId,
          organizationId,
          session
        );
      }

      // 1. Mark challenge verified (replay protection)
      challenge.status = "verified";
      await challenge.save({ session });

      const createdUsageRecords = [];
      const updatedServiceLines = appointment.services.map((s) => s.toObject ? s.toObject() : { ...s });
      const latestSubMap = new Map();

      // Group consumption by subscription to handle multiple services under same or distinct subscriptions
      for (const line of subscriptionLines) {
        const subId = line.appliedSubscriptionId;
        const sId = line.serviceId;

        // Revalidate subscription eligibility at completion inside transaction
        await this.validateSubscriptionEntitlement(
          subId,
          sId,
          customer._id,
          branchId,
          organizationId,
          session
        );

        // Atomic decrement using $elemMatch guard
        let query = {
          _id: subId,
          organizationId,
          status: "active",
          isDeleted: false,
          entitlements: {
            $elemMatch: {
              serviceId: sId,
              remainingQuantity: { $gte: 1 },
            },
          },
        };
        const update = {
          $inc: {
            "entitlements.$.usedQuantity": 1,
            "entitlements.$.remainingQuantity": -1,
          },
        };
        const options = { new: true };
        if (session) options.session = session;

        const updatedSub = await Subscription.findOneAndUpdate(query, update, options);
        if (!updatedSub) {
          throw new AppError(
            `Concurrent modification or insufficient entitlement balance for service ${line.name}`,
            409
          );
        }

        // Create SubscriptionUsage record
        const usageData = {
          organizationId,
          subscriptionId: subId,
          customerId: customer._id,
          serviceId: sId,
          serviceName: line.name,
          quantity: 1,
          branchId,
          verifiedBy: userId,
          verificationMethod: "otp",
          appointmentId: appointment._id,
        };

        const usageRecord = new SubscriptionUsage(usageData);
        await usageRecord.save({ session });
        createdUsageRecords.push(usageRecord);

        // Mark corresponding service line as redeemed
        const targetLine = updatedServiceLines.find(
          (sl) => sl._id?.toString() === line._id?.toString() ||
            (sl.serviceId.toString() === sId.toString() && sl.appliedSubscriptionId?.toString() === subId.toString())
        );
        if (targetLine) {
          targetLine.isRedeemedViaSubscription = true;
          targetLine.subscriptionUsageId = usageRecord._id;
        }

        latestSubMap.set(subId.toString(), updatedSub);

        // Create subscription redemption audit log
        const subAudit = new AuditLog({
          organizationId,
          branchId,
          actorId: userId,
          action: AUDIT_ACTIONS.SUBSCRIPTION_REDEEMED,
          entityType: "Subscription",
          entityId: subId,
          description: `Subscription ${updatedSub.subscriptionCode} redeemed for appointment ${appointment.appointmentCode}`,
          metadata: {
            subscriptionCode: updatedSub.subscriptionCode,
            appointmentId: appointment._id,
            serviceId: sId,
            verifiedBy: userId,
          },
        });
        await subAudit.save({ session });
      }

      // Check exhaustion for all affected subscriptions
      for (const [subIdKey] of latestSubMap.entries()) {
        const freshSub = await Subscription.findById(subIdKey).session(session);
        if (freshSub && freshSub.entitlements.every((e) => e.remainingQuantity === 0)) {
          freshSub.status = "exhausted";
          await freshSub.save({ session });
        }
      }

      // Update Appointment document: completed, clear slotMinutes, update services
      const completedAt = new Date();
      let aptUpdateQuery = {
        _id: appointment._id,
        organizationId,
        status: "in_progress", // Concurrency guard: must still be in_progress
      };

      const aptUpdateDoc = {
        $set: {
          status: "completed",
          completedAt,
          slotMinutes: [],
          services: updatedServiceLines,
        },
      };

      const aptOptions = { new: true };
      if (session) aptOptions.session = session;

      const finalAppointment = await appointmentRepo.model
        ? await appointmentRepo.model.findOneAndUpdate(aptUpdateQuery, aptUpdateDoc, aptOptions)
        : await Appointment.findOneAndUpdate(aptUpdateQuery, aptUpdateDoc, aptOptions);

      if (!finalAppointment) {
        throw new AppError("Appointment status conflict during completion", 409);
      }

      // Create Appointment Completion Audit Log
      const aptAudit = new AuditLog({
        organizationId,
        branchId,
        actorId: userId,
        action: AUDIT_ACTIONS.APPOINTMENT_COMPLETED,
        entityType: "Appointment",
        entityId: appointment._id,
        description: `Appointment ${appointment.appointmentCode} completed with subscription entitlement redemption`,
        metadata: {
          appointmentCode: appointment.appointmentCode,
          redeemedViaSubscription: true,
          subscriptionCount: subscriptionLines.length,
        },
      });
      await aptAudit.save({ session });

      return {
        appointment: finalAppointment,
        usages: createdUsageRecords,
      };
    }, { requireTransaction: true });

    // Enqueue service completion notification strictly AFTER transaction commit
    try {
      if (customer?.phone) {
        await smsQueue.add("sendServiceCompletionSMS", {
          phone: customer.phone,
          customerName: customer.name,
          appointmentCode: appointment.appointmentCode,
        });
      }
    } catch (queueErr) {
      logger.warn(`Failed to enqueue service completion SMS: ${queueErr.message}`);
    }

    return completionResult.appointment;
  }

  /**
   * ADMINISTRATIVE SOFT DELETE
   */
  async deleteAppointment(id, branchId, organizationId) {
    const appointment = await appointmentRepo.findById(id, organizationId);
    if (!appointment) {
      throw new AppError("Appointment not found", 404);
    }

    const getAptBranchId = (apt) =>
      apt.branchId?._id ? apt.branchId._id.toString() : apt.branchId.toString();
    if (getAptBranchId(appointment) !== branchId.toString()) {
      throw new AppError(
        "Target branchId does not match appointment branch",
        400,
      );
    }

    await this.cancelReminders(appointment);

    return await appointmentRepo.softDelete(id, organizationId);
  }
}
