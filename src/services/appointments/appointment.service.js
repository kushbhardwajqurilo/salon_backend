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
import { runInTransaction } from "../../utils/transaction.js";
import { env } from "../../config/env.js";

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

    // 1. Process Email Channel if requested
    if (channel === "email" || channel === "both") {
      if (!customer.email) {
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

    // 2. Process SMS Channel if requested
    if (channel === "sms" || channel === "both") {
      if (!customer.phone) {
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
      if (channelResults.email.status === "sent") {
        updateObj["reminder.email.sentAt"] = channelResults.email.sentAt;
        updateObj["reminder.email.failureReason"] = null;
      }
      if (channelResults.email.status === "failed") {
        updateObj["reminder.email.failedAt"] = channelResults.email.failedAt;
        updateObj["reminder.email.failureReason"] =
          channelResults.email.failureReason;
      }
    }
    if (channelResults.sms) {
      updateObj["reminder.sms.status"] = channelResults.sms.status;
      if (channelResults.sms.status === "sent") {
        updateObj["reminder.sms.sentAt"] = channelResults.sms.sentAt;
        updateObj["reminder.sms.failureReason"] = null;
      }
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
      const eSent = channelResults.email?.status === "sent";
      const sSent = channelResults.sms?.status === "sent";
      if (eSent && sSent) aggregateStatus = "sent";
      else if (eSent || sSent) aggregateStatus = "partial_delivery";
      else aggregateStatus = "failed";
    }

    updateObj["reminder.status"] = aggregateStatus;
    if (aggregateStatus === "sent") {
      updateObj["reminder.sentAt"] = now;
      updateObj["reminder.failureReason"] = null;
    }

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

    // 2. Leave check (only approved leaves block appointment booking)
    const leaveExists = await Leave.findOne({
      organizationId,
      staffId,
      dates: dateStr,
      status: "approved",
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

    const redeemableStatuses = ["active", "pending_payment"];
    if (!redeemableStatuses.includes(subscription.status)) {
      throw new AppError(
        `Applied subscription is not eligible for redemption (current status: '${subscription.status}')`,
        400
      );
    }

    // Beneficiary check: customer must be an active member or the legacy customerId
    let member = null;
    if (Array.isArray(subscription.members) && subscription.members.length > 0) {
      member = subscription.members.find(
        (m) => m.customerId.toString() === customerId.toString()
      );
      if (!member) {
        throw new AppError("Applied subscription does not belong to this customer", 400);
      }
      if (!["active", "pending_payment"].includes(member.status)) {
        throw new AppError(
          `Customer membership in applied subscription is not active (current status: '${member.status}')`,
          400
        );
      }
    } else {
      if (subscription.customerId.toString() !== customerId.toString()) {
        throw new AppError("Applied subscription does not belong to this customer", 400);
      }
    }

    const now = new Date();
    if (subscription.endDate && new Date(subscription.endDate) < now) {
      throw new AppError("Applied subscription has expired", 400);
    }
    if (subscription.startDate && new Date(subscription.startDate) > now) {
      throw new AppError("Applied subscription is not yet active", 400);
    }

    // Branch eligibility check (member override if specified, else subscription permittedBranchIds)
    const branchRestrictions = member && Array.isArray(member.permittedBranchIds) && member.permittedBranchIds.length > 0
      ? member.permittedBranchIds
      : subscription.permittedBranchIds;

    if (
      Array.isArray(branchRestrictions) &&
      branchRestrictions.length > 0
    ) {
      const isPermitted = branchRestrictions.some(
        (b) => b.toString() === branchId.toString()
      );
      if (!isPermitted) {
        throw new AppError("Applied subscription is not valid at this branch", 403);
      }
    }

    // Service entitlement check against member's allocation or legacy entitlements
    let entitlement = null;
    if (member && Array.isArray(member.entitlements)) {
      entitlement = member.entitlements.find(
        (e) => e.serviceId.toString() === serviceId.toString()
      );
    }
    // If member entitlement was not found or has remainingQuantity 0 while legacy array has remainingQuantity 0
    if (!entitlement && Array.isArray(subscription.entitlements)) {
      entitlement = subscription.entitlements.find(
        (e) => e.serviceId.toString() === serviceId.toString()
      );
    }
    // Also if legacy array exists and has remainingQuantity === 0 while member has > 0 (e.g. direct updateOne on legacy root in older tests)
    const legacyEnt = Array.isArray(subscription.entitlements)
      ? subscription.entitlements.find((e) => e.serviceId.toString() === serviceId.toString())
      : null;
    if (legacyEnt && legacyEnt.remainingQuantity === 0 && entitlement) {
      entitlement = legacyEnt;
    }

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
   * Deterministically find an eligible active subscription for a customer and service.
   * Selection rule (production-grade):
   * 1. Belongs to the same customer and organization.
   * 2. Status is "active", not deleted, and not expired (endDate >= now).
   * 3. Permitted branches include branchId (or empty array / non-existent means valid at all branches).
   * 4. Entitlements include serviceId with remainingQuantity >= 1.
   * 5. Deterministic sorting: earliest-expiring first (endDate: 1), then earliest-created (createdAt: 1).
   */
  async findEligibleSubscriptionForService(
    customerId,
    serviceId,
    branchId,
    organizationId,
    session = null
  ) {
    const now = new Date();
    const candidateQuery = {
      organizationId,
      customerId,
      status: { $in: ["active", "pending_payment"] },
      isDeleted: false,
      endDate: { $gte: now },
      entitlements: {
        $elemMatch: {
          serviceId: serviceId,
          remainingQuantity: { $gte: 1 },
        },
      },
      $or: [
        { permittedBranchIds: { $exists: false } },
        { permittedBranchIds: { $size: 0 } },
        { permittedBranchIds: branchId },
      ],
    };

    let query = Subscription.find(candidateQuery).sort({
      endDate: 1,
      createdAt: 1,
    });
    if (session) {
      query = query.session(session);
    }

    const subscriptions = await query.exec();
    return subscriptions.length > 0 ? subscriptions[0] : null;
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

    // Normalize incoming service selections (supporting registered lines and custom lines)
    let normalizedServiceInputs = [];
    if (Array.isArray(services) && services.length > 0) {
      normalizedServiceInputs = services.map((item) => {
        if (typeof item === "string") {
          return {
            serviceType: "registered",
            serviceId: item,
            customPrice: undefined,
            appliedSubscriptionId: null,
          };
        }
        const isCustom =
          item.serviceType === "custom" ||
          item.type === "custom" ||
          (!item.serviceId && item.name && item.duration !== undefined);

        if (isCustom) {
          if (item.appliedSubscriptionId) {
            throw new AppError(
              "Custom services cannot be assigned to or redeemed via subscriptions",
              400,
            );
          }
          return {
            serviceType: "custom",
            name: item.name ? String(item.name).trim() : "",
            duration: Number(item.duration),
            price: Number(item.price ?? item.customPrice ?? 0),
            appliedSubscriptionId: null,
          };
        }

        return {
          serviceType: "registered",
          serviceId: item.serviceId
            ? item.serviceId.toString()
            : item.toString(),
          customPrice:
            item.customPrice !== undefined && item.customPrice !== null
              ? Number(item.customPrice)
              : undefined,
          appliedSubscriptionId:
            item.appliedSubscriptionId === undefined
              ? undefined
              : item.appliedSubscriptionId === null
                ? null
                : item.appliedSubscriptionId.toString(),
        };
      });
    } else if (Array.isArray(serviceIds) && serviceIds.length > 0) {
      normalizedServiceInputs = serviceIds.map((id) => ({
        serviceType: "registered",
        serviceId: id.toString(),
        customPrice: undefined,
        appliedSubscriptionId: undefined, // omitted -> auto-apply eligible
      }));
    }

    if (!normalizedServiceInputs || normalizedServiceInputs.length === 0) {
      throw new AppError("At least one service must be selected", 400);
    }

    // 3. Validate & Snapshot Registered Services
    const registeredInputs = normalizedServiceInputs.filter(
      (item) => item.serviceType === "registered",
    );
    const extractedIds = registeredInputs.map((item) => item.serviceId);

    const dbServices = extractedIds.length > 0
      ? await Service.find({
          _id: { $in: extractedIds },
          organizationId,
          isDeleted: false,
          status: "active",
        })
      : [];

    if (dbServices.length !== extractedIds.length) {
      throw new AppError(
        "One or more selected services are invalid, inactive, or belong to a different organization",
        400,
      );
    }

    // Validate or auto-resolve appliedSubscriptionId deterministically for registered lines
    for (const item of registeredInputs) {
      if (item.appliedSubscriptionId && item.appliedSubscriptionId !== "auto") {
        await this.validateSubscriptionEntitlement(
          item.appliedSubscriptionId,
          item.serviceId,
          customerId,
          branchId,
          organizationId,
        );
      } else if (item.appliedSubscriptionId === "auto" || item.appliedSubscriptionId === undefined) {
        // Automatically check if customer has an eligible active subscription for this service
        const eligibleSub = await this.findEligibleSubscriptionForService(
          customerId,
          item.serviceId,
          branchId,
          organizationId,
        );
        if (eligibleSub) {
          item.appliedSubscriptionId = eligibleSub._id.toString();
        } else {
          item.appliedSubscriptionId = null;
        }
      } else {
        // Explicit opt-out (item.appliedSubscriptionId === null): do not auto-resolve
        item.appliedSubscriptionId = null;
      }
    }

    let totalDuration = 0;
    let subtotal = 0;

    const serviceSnapshots = normalizedServiceInputs.map((item) => {
      if (item.serviceType === "custom") {
        totalDuration += item.duration;
        subtotal += item.price;
        return {
          serviceType: "custom",
          serviceId: null,
          name: item.name,
          duration: item.duration,
          price: item.price,
          appliedSubscriptionId: null,
          isRedeemedViaSubscription: false,
          subscriptionUsageId: null,
        };
      }

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
        serviceType: "registered",
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

    // Floor Queue & Status: All new appointments start as 'scheduled'. Staff assignment does NOT imply service has started.
    // For walk-ins arriving at the salon, arrivedAt is recorded immediately to establish queue arrival order.
    const initialStatus = "scheduled";
    const arrivedAt = bookingType === "walk_in" ? new Date() : null;

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
        arrivedAt,
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
          return {
            serviceType: "registered",
            serviceId: item,
            customPrice: undefined,
            appliedSubscriptionId: null,
            _id: undefined,
          };
        }
        const isCustom =
          item.serviceType === "custom" ||
          item.type === "custom" ||
          (!item.serviceId && item.name && item.duration !== undefined);

        if (isCustom) {
          if (item.appliedSubscriptionId) {
            throw new AppError(
              "Custom services cannot be assigned to or redeemed via subscriptions",
              400,
            );
          }
          return {
            serviceType: "custom",
            _id: item._id || item.id || item.appointmentServiceId,
            name: item.name ? String(item.name).trim() : "",
            duration: item.duration !== undefined ? Number(item.duration) : undefined,
            price:
              item.price !== undefined
                ? Number(item.price)
                : item.customPrice !== undefined
                  ? Number(item.customPrice)
                  : undefined,
            appliedSubscriptionId: null,
          };
        }

        return {
          serviceType: "registered",
          _id: item._id || item.id || item.appointmentServiceId,
          serviceId: item.serviceId
            ? item.serviceId.toString()
            : item.toString(),
          customPrice:
            item.customPrice !== undefined && item.customPrice !== null
              ? Number(item.customPrice)
              : undefined,
          appliedSubscriptionId:
            item.appliedSubscriptionId === undefined
              ? undefined
              : item.appliedSubscriptionId === null
                ? null
                : item.appliedSubscriptionId.toString(),
        };
      });
    } else if (Array.isArray(serviceIds) && serviceIds.length > 0) {
      normalizedServiceInputs = serviceIds.map((id) => ({
        serviceType: "registered",
        serviceId: id.toString(),
        customPrice: undefined,
        appliedSubscriptionId: undefined, // omitted -> auto-apply eligible
      }));
    }

    // If services changed, recalculate snapshot, duration, endAt, and pricing
    if (normalizedServiceInputs && normalizedServiceInputs.length > 0) {
      const registeredInputs = normalizedServiceInputs.filter(
        (item) => item.serviceType === "registered",
      );
      const extractedIds = registeredInputs.map((item) => item.serviceId);

      const dbServices = extractedIds.length > 0
        ? await Service.find({
            _id: { $in: extractedIds },
            organizationId,
            isDeleted: false,
            status: "active",
          })
        : [];

      if (dbServices.length !== extractedIds.length) {
        throw new AppError(
          "One or more selected services are invalid or inactive for this organization",
          400,
        );
      }

      // Map existing services to preserve historical agreed price, isRedeemedViaSubscription, subscriptionUsageId
      const existingServices = appointment.services || [];

      // Validate or auto-resolve appliedSubscriptionId deterministically for registered lines
      const customerId = appointment.customerId?._id || appointment.customerId;
      for (const item of registeredInputs) {
        if (item.appliedSubscriptionId && item.appliedSubscriptionId !== "auto") {
          await this.validateSubscriptionEntitlement(
            item.appliedSubscriptionId,
            item.serviceId,
            customerId,
            branchId,
            organizationId,
          );
        } else if (item.appliedSubscriptionId === "auto" || item.appliedSubscriptionId === undefined) {
          // Automatically check if customer has an eligible active subscription for this service
          const eligibleSub = await this.findEligibleSubscriptionForService(
            customerId,
            item.serviceId,
            branchId,
            organizationId,
          );
          if (eligibleSub) {
            item.appliedSubscriptionId = eligibleSub._id.toString();
          } else {
            item.appliedSubscriptionId = null;
          }
        } else {
          // Explicit opt-out (item.appliedSubscriptionId === null): do not auto-resolve
          item.appliedSubscriptionId = null;
        }
      }

      let totalDuration = 0;
      let subtotal = 0;

      const serviceSnapshots = normalizedServiceInputs.map((item) => {
        if (item.serviceType === "custom") {
          // If existing custom line matched by _id, preserve its agreed price if item.price not specified
          const existingLine = item._id
            ? existingServices.find(
                (es) => es._id && es._id.toString() === item._id.toString(),
              )
            : null;

          const resolvedPrice =
            item.price !== undefined && !isNaN(item.price)
              ? item.price
              : (existingLine?.price ?? 0);

          const resolvedDuration =
            item.duration !== undefined && !isNaN(item.duration) && item.duration > 0
              ? item.duration
              : (existingLine?.duration ?? 1);

          const resolvedName = item.name || existingLine?.name || "Custom Service";

          totalDuration += resolvedDuration;
          subtotal += resolvedPrice;

          return {
            _id: existingLine?._id || undefined,
            serviceType: "custom",
            serviceId: null,
            name: resolvedName,
            duration: resolvedDuration,
            price: resolvedPrice,
            appliedSubscriptionId: null,
            isRedeemedViaSubscription: false,
            subscriptionUsageId: null,
          };
        }

        const s = dbServices.find(
          (serv) => serv._id.toString() === item.serviceId.toString(),
        );

        // Find existing matching service line to preserve agreed price and subscription redemption history
        const existingLine = existingServices.find((es) => {
          if (item._id && es._id && es._id.toString() === item._id.toString()) {
            return true;
          }
          return es.serviceId && es.serviceId.toString() === item.serviceId.toString();
        });

        let resolvedPrice;
        if (item.customPrice !== undefined && item.customPrice !== null) {
          resolvedPrice = Number(item.customPrice);
        } else if (existingLine && existingLine.price !== undefined && existingLine.price !== null) {
          resolvedPrice = existingLine.price;
        } else {
          resolvedPrice = s.pricing?.basePrice ?? 0;
        }

        totalDuration += s.duration;
        subtotal += resolvedPrice;

        return {
          _id: existingLine?._id || undefined,
          serviceType: "registered",
          serviceId: s._id,
          name: s.name,
          duration: s.duration,
          price: resolvedPrice,
          appliedSubscriptionId: item.appliedSubscriptionId || (existingLine?.appliedSubscriptionId ? existingLine.appliedSubscriptionId.toString() : null),
          isRedeemedViaSubscription: existingLine ? existingLine.isRedeemedViaSubscription : false,
          subscriptionUsageId: existingLine ? existingLine.subscriptionUsageId : null,
        };
      });

      // Calculate start and end times deterministically from scheduled startAt and totalDuration
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

      // Invalidate any pending OTP consumption challenge on service modifications
      await SubscriptionConsumptionChallenge.deleteMany({
        appointmentId: appointment._id,
        status: "pending",
      });

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

      // Future start rejection guard:
      // Allow early start within 15 minutes window; reject if appointment is scheduled further in the future unless forceEarlyStart is provided.
      const EARLY_START_WINDOW_MS = 15 * 60 * 1000;
      const scheduledStartMs = new Date(appointment.startAt).getTime();
      const nowMs = Date.now();
      if (scheduledStartMs - nowMs > EARLY_START_WINDOW_MS && !data.forceEarlyStart) {
        throw new AppError(
          `Cannot start future appointment early. Appointment is scheduled for ${appointment.startTime} on ${appointment.appointmentDate}. Use forceEarlyStart override with authorization to proceed.`,
          400,
        );
      }

      // Overdue assigned staff detection:
      // Check if the assigned staff member has another unfinished in_progress appointment on the same calendar operating day whose scheduled endAt has passed
      const overdueAppointment = await appointmentRepo.findOne(
        {
          _id: { $ne: appointment._id },
          branchId: appointment.branchId?._id || appointment.branchId,
          staffId: appointment.staffId?._id || appointment.staffId,
          status: "in_progress",
          appointmentDate: appointment.appointmentDate,
          endAt: { $lt: new Date(nowMs) },
        },
        organizationId,
      );

      if (overdueAppointment && !data.allowOverdueStaffOverride) {
        const overdueMinutes = Math.max(
          1,
          Math.round((nowMs - new Date(overdueAppointment.endAt).getTime()) / 60000),
        );
        throw new AppError(
          `Assigned staff member is currently working on an overdue appointment (${overdueAppointment.appointmentCode}) that was scheduled to end at ${overdueAppointment.endTime} (${overdueMinutes}m overdue). An explicit manager override is required to start this appointment.`,
          409,
          {
            conflictType: "STAFF_OVERDUE_APPOINTMENT",
            overdueAppointmentId: overdueAppointment._id.toString(),
            overdueAppointmentCode: overdueAppointment.appointmentCode,
            overdueScheduledEndTime: overdueAppointment.endTime,
            overdueMinutes,
            requiresOverride: true,
          },
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

    if (status === "in_progress") {
      updates.startedAt = new Date();
    } else if (status === "completed") {
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

    const updated = await appointmentRepo.update(id, updates, organizationId);

    // Audit log for appointment status changes
    if (userId) {
      try {
        await AuditLog.create({
          organizationId,
          branchId,
          actorId: userId,
          action: AUDIT_ACTIONS.APPOINTMENT_STATUS_UPDATED || "APPOINTMENT_STATUS_UPDATED",
          entityType: "Appointment",
          entityId: appointment._id,
          description: `Appointment ${appointment.appointmentCode} status transitioned from ${currentStatus} to ${status}`,
          metadata: {
            appointmentCode: appointment.appointmentCode,
            previousStatus: currentStatus,
            newStatus: status,
            reason,
            startedAt: updates.startedAt || null,
            completedAt: updates.completedAt || null,
            allowOverdueStaffOverride: data.allowOverdueStaffOverride || false,
          },
        });
      } catch (auditErr) {
        logger.warn(`Failed to create audit log for status change: ${auditErr.message}`);
      }
    }

    return updated;
  }

  /**
   * Helper to execute a sequence of operations in a MongoDB transaction with controlled enforcement
   */
  async executeTransaction(callback, { requireTransaction = false } = {}) {
    return await runInTransaction(callback, { requireTransaction });
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

    // Atomically claim the challenge by setting status: 'in_redemption'
    // This provides a strict concurrency guard in standalone mode where multi-document transactions cannot serialize
    const lockedChallenge = await SubscriptionConsumptionChallenge.findOneAndUpdate(
      {
        _id: challenge._id,
        status: "pending",
      },
      {
        $set: { status: "in_redemption" },
      },
      { returnDocument: "after" }
    );

    if (!lockedChallenge) {
      throw new AppError("Another completion request is currently being processed for this appointment. Please retry.", 409);
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

        if (!line._id) {
          line._id = new mongoose.Types.ObjectId();
        }
        const lineIdStr = line._id.toString();
        const decOpId = `${challenge._id.toString()}:${lineIdStr}:dec`;

        // 1. Ensure intent is durably saved in challenge ledger with isDecremented: false BEFORE mutating subscription
        let decEntry = (challenge.decrements || []).find(
          (d) => d.appointmentServiceId?.toString() === line._id?.toString()
        );
        if (!decEntry) {
          challenge.decrements = challenge.decrements || [];
          decEntry = {
            operationId: decOpId,
            subscriptionId: subId,
            memberCustomerId: customer._id,
            serviceId: sId,
            quantity: 1,
            appointmentServiceId: line._id,
            decrementedAt: null,
            isDecremented: false,
            isRestored: false,
            restorationState: "none",
          };
          challenge.decrements.push(decEntry);
          challenge.redemptionState = "in_redemption";
          await challenge.save({ session });
        } else if (!decEntry.operationId) {
          decEntry.operationId = decOpId;
          await challenge.save({ session });
        }

        // If this exact service line was already decremented in a previous attempt, do not double-decrement
        let updatedSub = latestSubMap.get(subId.toString()) || null;
        if (!decEntry.isDecremented) {
          // Check verifiable state on Subscription: did this operation already commit?
          const alreadyCommitted = await Subscription.exists({
            _id: subId,
            appliedOperations: decOpId,
          });

          if (alreadyCommitted) {
            // Acknowledgment was lost during previous attempt; decrement committed in MongoDB
            decEntry.isDecremented = true;
            decEntry.decrementedAt = decEntry.decrementedAt || new Date();
            challenge.redemptionState = "decremented";
            await challenge.save({ session });
            updatedSub = await Subscription.findById(subId).session(session);
            latestSubMap.set(subId.toString(), updatedSub);
          } else {
            // Atomic decrement using member-aware arrayFilter or legacy elemMatch with durable operation identity
            updatedSub = null;
            const subDoc = await Subscription.findById(subId).session(session);
            if (subDoc && Array.isArray(subDoc.members) && subDoc.members.length > 0) {
              const targetMember = subDoc.members.find((m) => m.customerId.toString() === customer._id.toString());
              if (targetMember) {
                const memberFilter = {
                  _id: subId,
                  organizationId,
                  status: { $in: ["active", "pending_payment"] },
                  isDeleted: false,
                  appliedOperations: { $nin: [decOpId, `fence:${decOpId}`] },
                  members: {
                    $elemMatch: {
                      customerId: customer._id,
                      status: { $in: ["active", "pending_payment"] },
                      entitlements: {
                        $elemMatch: {
                          serviceId: sId,
                          remainingQuantity: { $gte: 1 },
                        },
                      },
                    },
                  },
                };
                const memberUpdate = {
                  $inc: {
                    "members.$[mem].entitlements.$[ent].usedQuantity": 1,
                    "members.$[mem].entitlements.$[ent].remainingQuantity": -1,
                    "entitlements.$[legacyEnt].usedQuantity": 1,
                    "entitlements.$[legacyEnt].remainingQuantity": -1,
                  },
                  $push: {
                    appliedOperations: decOpId,
                  },
                };
                const memberOptions = {
                  arrayFilters: [
                    { "mem.customerId": customer._id, "mem.status": { $in: ["active", "pending_payment"] } },
                    { "ent.serviceId": sId, "ent.remainingQuantity": { $gte: 1 } },
                    { "legacyEnt.serviceId": sId },
                  ],
                  returnDocument: "after",
                };
                if (session) memberOptions.session = session;
                try {
                  updatedSub = await Subscription.findOneAndUpdate(memberFilter, memberUpdate, memberOptions);
                } catch (err) {
                  delete memberUpdate.$inc["entitlements.$[legacyEnt].usedQuantity"];
                  delete memberUpdate.$inc["entitlements.$[legacyEnt].remainingQuantity"];
                  memberOptions.arrayFilters = memberOptions.arrayFilters.slice(0, 2);
                  updatedSub = await Subscription.findOneAndUpdate(memberFilter, memberUpdate, memberOptions);
                }
              }
            }

            if (!updatedSub) {
              // Fallback to legacy single-customer document update
              const legacyQuery = {
                _id: subId,
                organizationId,
                status: { $in: ["active", "pending_payment"] },
                isDeleted: false,
                appliedOperations: { $nin: [decOpId, `fence:${decOpId}`] },
                entitlements: {
                  $elemMatch: {
                    serviceId: sId,
                    remainingQuantity: { $gte: 1 },
                  },
                },
              };
              const legacyUpdate = {
                $inc: {
                  "entitlements.$.usedQuantity": 1,
                  "entitlements.$.remainingQuantity": -1,
                },
                $push: {
                  appliedOperations: decOpId,
                },
              };
              const legacyOptions = { returnDocument: "after" };
              if (session) legacyOptions.session = session;
              updatedSub = await Subscription.findOneAndUpdate(legacyQuery, legacyUpdate, legacyOptions);
            }

            if (!updatedSub) {
              // Check if it was applied concurrently
              const wasAppliedConcurrently = await Subscription.exists({
                _id: subId,
                appliedOperations: decOpId,
              });
              if (wasAppliedConcurrently) {
                updatedSub = await Subscription.findById(subId).session(session);
              } else {
                const wasFenced = await Subscription.exists({
                  _id: subId,
                  appliedOperations: `fence:${decOpId}`,
                });
                if (wasFenced) {
                  throw new AppError(
                    `Redemption operation was expired or cancelled by reconciliation recovery`,
                    409
                  );
                }
                throw new AppError(
                  `Concurrent modification or insufficient entitlement balance for service ${line.name}`,
                  409
                );
              }
            }

            // Mark intent as applied durably
            decEntry.isDecremented = true;
            decEntry.decrementedAt = new Date();
            challenge.redemptionState = "decremented";
            await challenge.save({ session });
            latestSubMap.set(subId.toString(), updatedSub);
          }
        }

        // Create SubscriptionUsage record with exact appointmentServiceId
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
          appointmentServiceId: line._id,
          appointmentCode: appointment.appointmentCode,
        };

        const usageRecord = new SubscriptionUsage(usageData);
        await usageRecord.save({ session });
        createdUsageRecords.push(usageRecord);

        // Mark corresponding service line as redeemed
        const targetLine = updatedServiceLines.find(
          (sl) => sl._id?.toString() === line._id?.toString()
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
            appointmentServiceId: line._id,
            serviceId: sId,
            verifiedBy: userId,
          },
        });
        await subAudit.save({ session });
      }

      // Check member-level and global exhaustion for all affected subscriptions
      for (const [subIdKey] of latestSubMap.entries()) {
        const freshSub = await Subscription.findById(subIdKey).session(session);
        if (freshSub) {
          let mod = false;
          if (Array.isArray(freshSub.members) && freshSub.members.length > 0) {
            for (const m of freshSub.members) {
              if (m.entitlements.every((e) => e.remainingQuantity === 0) && m.status !== "exhausted") {
                m.status = "exhausted";
                mod = true;
              }
            }
            if (freshSub.members.every((m) => m.status === "exhausted" || m.status === "cancelled")) {
              freshSub.status = "exhausted";
              mod = true;
            }
          } else if (freshSub.entitlements.every((e) => e.remainingQuantity === 0)) {
            freshSub.status = "exhausted";
            mod = true;
          }
          if (mod) {
            await freshSub.save({ session });
          }
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

      const aptOptions = { returnDocument: "after" };
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
      // Mark challenge redemptionState as completed (Audit saved)
      await aptAudit.save({ session });
      challenge.redemptionState = "completed";
      await challenge.save({ session });

      return {
        appointment: finalAppointment,
        usages: createdUsageRecords,
      };
    }, { requireTransaction: false });

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

  /**
   * CASCADING RESCHEDULE ENGINE: PREVIEW
   * Simulates adding/removing services on an appointment (scheduled or in_progress),
   * recalculates end time, identifies subsequent scheduled bookings for the staff member,
   * calculates proposed shifted slots and detects conflicts, returning a cryptographic preview token.
   */
  async previewServiceModification(id, data, organizationId) {
    const { branchId, services, serviceIds, discount } = data;

    const appointment = await appointmentRepo.findById(id, organizationId);
    if (!appointment) {
      throw new AppError("Appointment not found", 404);
    }

    const aptBranchId = appointment.branchId?._id
      ? appointment.branchId._id.toString()
      : appointment.branchId.toString();
    if (aptBranchId !== branchId.toString()) {
      throw new AppError("Target branchId does not match appointment branch", 400);
    }

    if (["completed", "cancelled", "no_show"].includes(appointment.status)) {
      throw new AppError(
        `Cannot modify services on appointment with terminal status '${appointment.status}'`,
        400
      );
    }

    // Normalize incoming service selections
    let normalizedServiceInputs = null;
    if (Array.isArray(services) && services.length > 0) {
      normalizedServiceInputs = services.map((item) => {
        if (typeof item === "string") {
          return {
            serviceType: "registered",
            serviceId: item,
            customPrice: undefined,
            appliedSubscriptionId: null,
            _id: undefined,
          };
        }
        const isCustom =
          item.serviceType === "custom" ||
          item.type === "custom" ||
          (!item.serviceId && item.name && item.duration !== undefined);

        if (isCustom) {
          if (item.appliedSubscriptionId) {
            throw new AppError(
              "Custom services cannot be assigned to or redeemed via subscriptions",
              400,
            );
          }
          return {
            serviceType: "custom",
            _id: item._id || item.id || item.appointmentServiceId,
            name: item.name ? String(item.name).trim() : "",
            duration: item.duration !== undefined ? Number(item.duration) : undefined,
            price:
              item.price !== undefined
                ? Number(item.price)
                : item.customPrice !== undefined
                  ? Number(item.customPrice)
                  : undefined,
            appliedSubscriptionId: null,
          };
        }

        return {
          serviceType: "registered",
          _id: item._id || item.id || item.appointmentServiceId,
          serviceId: item.serviceId ? item.serviceId.toString() : item.toString(),
          customPrice:
            item.customPrice !== undefined && item.customPrice !== null
              ? Number(item.customPrice)
              : undefined,
          appliedSubscriptionId:
            item.appliedSubscriptionId === undefined
              ? undefined
              : item.appliedSubscriptionId === null
                ? null
                : item.appliedSubscriptionId.toString(),
        };
      });
    } else if (Array.isArray(serviceIds) && serviceIds.length > 0) {
      normalizedServiceInputs = serviceIds.map((sid) => ({
        serviceType: "registered",
        serviceId: sid.toString(),
        customPrice: undefined,
        appliedSubscriptionId: undefined, // omitted -> auto-apply eligible
      }));
    } else {
      throw new AppError("At least one service must be selected", 400);
    }

    const registeredInputs = normalizedServiceInputs.filter(
      (item) => item.serviceType === "registered",
    );
    const uniqueIds = [...new Set(registeredInputs.map((item) => item.serviceId))];
    const dbServices = uniqueIds.length > 0
      ? await Service.find({
          _id: { $in: uniqueIds },
          organizationId,
          isDeleted: false,
          status: "active",
        })
      : [];

    if (dbServices.length !== uniqueIds.length) {
      throw new AppError(
        "One or more selected services are invalid or inactive for this organization",
        400,
      );
    }

    const existingServices = appointment.services || [];
    let totalDuration = 0;
    let subtotal = 0;

    const proposedServiceSnapshots = normalizedServiceInputs.map((item) => {
      if (item.serviceType === "custom") {
        const existingLine = item._id
          ? existingServices.find(
              (es) => es._id && es._id.toString() === item._id.toString(),
            )
          : null;

        const resolvedPrice =
          item.price !== undefined && !isNaN(item.price)
            ? item.price
            : (existingLine?.price ?? 0);

        const resolvedDuration =
          item.duration !== undefined && !isNaN(item.duration) && item.duration > 0
            ? item.duration
            : (existingLine?.duration ?? 1);

        const resolvedName = item.name || existingLine?.name || "Custom Service";

        totalDuration += resolvedDuration;
        subtotal += resolvedPrice;

        return {
          _id: existingLine?._id || undefined,
          serviceType: "custom",
          serviceId: null,
          name: resolvedName,
          duration: resolvedDuration,
          price: resolvedPrice,
          appliedSubscriptionId: null,
          isRedeemedViaSubscription: false,
          subscriptionUsageId: null,
        };
      }

      const s = dbServices.find((serv) => serv._id.toString() === item.serviceId.toString());
      const existingLine = existingServices.find((es) => {
        if (item._id && es._id && es._id.toString() === item._id.toString()) {
          return true;
        }
        return es.serviceId && es.serviceId.toString() === item.serviceId.toString();
      });

      let resolvedPrice;
      if (item.customPrice !== undefined && item.customPrice !== null) {
        resolvedPrice = Number(item.customPrice);
      } else if (existingLine && existingLine.price !== undefined && existingLine.price !== null) {
        resolvedPrice = existingLine.price;
      } else {
        resolvedPrice = s.pricing?.basePrice ?? 0;
      }

      totalDuration += s.duration;
      subtotal += resolvedPrice;

      let resolvedAppliedSubscriptionId;
      if (item.appliedSubscriptionId && item.appliedSubscriptionId !== "auto") {
        resolvedAppliedSubscriptionId = item.appliedSubscriptionId;
      } else if (item.appliedSubscriptionId === null) {
        // Explicit opt-out
        resolvedAppliedSubscriptionId = null;
      } else {
        // item.appliedSubscriptionId === undefined || item.appliedSubscriptionId === "auto"
        // Retain existing line's applied subscription if present and valid, or leave as null for preview
        resolvedAppliedSubscriptionId = existingLine?.appliedSubscriptionId
          ? existingLine.appliedSubscriptionId.toString()
          : null;
      }

      return {
        _id: existingLine?._id || undefined,
        serviceType: "registered",
        serviceId: s._id.toString(),
        name: s.name,
        duration: s.duration,
        price: resolvedPrice,
        appliedSubscriptionId: resolvedAppliedSubscriptionId,
        isRedeemedViaSubscription: existingLine ? existingLine.isRedeemedViaSubscription : false,
        subscriptionUsageId: existingLine ? existingLine.subscriptionUsageId : null,
      };
    });

    const branch = await Branch.findOne({ _id: branchId, organizationId });
    const tz = branch?.timezone || DEFAULT_TIMEZONE;

    // Calculate proposed start and end for initiating appointment
    const startAt = new Date(appointment.startAt);
    let proposedEndAt;
    let remainingMinutes = totalDuration;

    if (appointment.status === "in_progress") {
      const startedAt = appointment.startedAt ? new Date(appointment.startedAt) : null;
      // If startedAt was recorded today and startAt was today, elapsed is Date.now() - startedAt.
      // If appointment is for a future test date or startedAt is null, remaining duration starts from startAt.
      const now = Date.now();
      let elapsedMinutes = 0;
      if (startedAt && startedAt.getTime() <= now && Math.abs(now - startAt.getTime()) < 24 * 60 * 60 * 1000) {
        elapsedMinutes = Math.max(0, Math.floor((now - startedAt.getTime()) / 60000));
      }
      remainingMinutes = Math.max(0, totalDuration - elapsedMinutes);
      proposedEndAt = new Date(startAt.getTime() + (elapsedMinutes + remainingMinutes) * 60000);
    } else {
      proposedEndAt = new Date(startAt.getTime() + totalDuration * 60000);
    }

    const originalEndAt = new Date(appointment.endAt);
    const initiatingFormattedProposedEnd = formatUTCToLocal(proposedEndAt, tz);
    const initiatingFormattedStart = formatUTCToLocal(startAt, tz);

    const effectiveDiscount = discount !== undefined ? discount : appointment.pricing.discount;
    const total = Math.max(0, Number((subtotal - effectiveDiscount).toFixed(2)));

    const initiatingAppointmentProposal = {
      id: appointment._id.toString(),
      appointmentCode: appointment.appointmentCode,
      status: appointment.status,
      version: appointment.version || 1,
      originalStartAt: appointment.startAt,
      originalEndAt: appointment.endAt,
      originalStartTime: appointment.startTime,
      originalEndTime: appointment.endTime,
      proposedStartAt: startAt,
      proposedEndAt,
      proposedStartTime: initiatingFormattedStart.timeStr,
      proposedEndTime: initiatingFormattedProposedEnd.timeStr,
      totalDuration,
      remainingMinutes,
      pricing: {
        subtotal: Number(subtotal.toFixed(2)),
        discount: Number(effectiveDiscount.toFixed(2)),
        total,
      },
      services: proposedServiceSnapshots,
    };

    const affectedAppointments = [];
    const conflicts = [];

    // Validate initiating appointment against branch operating hours and midnight boundary
    if (initiatingFormattedStart.dateStr !== initiatingFormattedProposedEnd.dateStr) {
      conflicts.push({
        appointmentId: appointment._id.toString(),
        appointmentCode: appointment.appointmentCode,
        reason: `Initiating appointment exceeds calendar day boundary (${initiatingFormattedProposedEnd.dateStr}).`,
        actionRequired: "shorten_duration_or_reschedule",
      });
    }

    if (branch?.operatingHours) {
      const dayOfWeek = new Date(startAt).toLocaleDateString("en-US", {
        weekday: "long",
        timeZone: tz,
      }).toLowerCase();

      const hoursForDay = branch.operatingHours.get
        ? branch.operatingHours.get(dayOfWeek)
        : branch.operatingHours[dayOfWeek];

      if (hoursForDay) {
        if (hoursForDay.isOpen === false) {
          conflicts.push({
            appointmentId: appointment._id.toString(),
            appointmentCode: appointment.appointmentCode,
            reason: `Branch is closed on ${dayOfWeek}s.`,
            actionRequired: "reschedule_different_day",
          });
        } else if (hoursForDay.closeTime && initiatingFormattedProposedEnd.timeStr > hoursForDay.closeTime) {
          conflicts.push({
            appointmentId: appointment._id.toString(),
            appointmentCode: appointment.appointmentCode,
            reason: `Proposed service extension ends at ${initiatingFormattedProposedEnd.timeStr}, which exceeds branch closing time of ${hoursForDay.closeTime}.`,
            actionRequired: "shorten_duration_or_reschedule",
            closingTime: hoursForDay.closeTime,
          });
        }
      }
    }

    // If staff member is assigned and proposed end extends beyond original end, inspect subsequent bookings
    if (appointment.staffId && proposedEndAt > originalEndAt) {
      // Find subsequent bookings for the same staff member on the same appointmentDate
      const subsequentAppointments = await Appointment.find({
        organizationId,
        branchId,
        staffId: appointment.staffId,
        _id: { $ne: appointment._id },
        appointmentDate: appointment.appointmentDate,
        isDeleted: false,
        status: { $in: ["scheduled", "in_progress"] },
      }).sort({ startAt: 1 });

      let currentChainEnd = proposedEndAt;

      for (const nextApt of subsequentAppointments) {
        const nextStartAt = new Date(nextApt.startAt);
        const nextEndAt = new Date(nextApt.endAt);

        // Check if next appointment overlaps with the advancing chain end
        if (nextStartAt < currentChainEnd) {
          // Invariant: Do not silently shift in_progress appointments
          if (nextApt.status === "in_progress") {
            conflicts.push({
              appointmentId: nextApt._id.toString(),
              appointmentCode: nextApt.appointmentCode,
              customerName: nextApt.customerId?.name || "Customer",
              reason: "Cannot shift an appointment that is already in progress.",
              actionRequired: "reassign_or_shorten",
              conflictingWithEndAt: currentChainEnd,
            });
            break;
          }

          // Determine applicable buffer between appointments:
          // Check branch-configured bufferMinutes or previous service-configured bufferMinutes
          const branchBuffer = (branch?.bufferMinutes && branch.bufferMinutes > 0) ? branch.bufferMinutes : 0;
          let serviceBuffer = 0;
          // Determine buffer from previous appointment in chain
          const prevServices = affectedAppointments.length > 0
            ? null // handled by previous appointment in chain
            : proposedServiceSnapshots;
          if (prevServices) {
            for (const ps of prevServices) {
              if (ps.serviceId) {
                const matchedSvc = dbServices.find((s) => s._id.toString() === ps.serviceId.toString());
                if (matchedSvc?.bufferMinutes && matchedSvc.bufferMinutes > serviceBuffer) {
                  serviceBuffer = matchedSvc.bufferMinutes;
                }
              }
            }
          }
          const effectiveBuffer = Math.max(branchBuffer, serviceBuffer);

          // Propose shifting next appointment so it starts after previous service ends + buffer
          const shiftedStartAt = new Date(currentChainEnd.getTime() + effectiveBuffer * 60000);
          const shiftedEndAt = new Date(shiftedStartAt.getTime() + nextApt.totalDuration * 60000);
          const shiftedStartLocal = formatUTCToLocal(shiftedStartAt, tz);
          const shiftedEndLocal = formatUTCToLocal(shiftedEndAt, tz);

          // Check midnight boundary constraint
          if (shiftedStartLocal.dateStr !== shiftedEndLocal.dateStr || shiftedStartLocal.dateStr !== nextApt.appointmentDate) {
            conflicts.push({
              appointmentId: nextApt._id.toString(),
              appointmentCode: nextApt.appointmentCode,
              reason: `Shifted appointment would exceed branch operating calendar day (${shiftedEndLocal.dateStr}).`,
              actionRequired: "reschedule_different_day_or_reassign",
            });
            break;
          }

          // Check branch configured operating hours
          if (branch?.operatingHours) {
            const dayOfWeek = new Date(shiftedStartAt).toLocaleDateString("en-US", {
              weekday: "long",
              timeZone: tz,
            }).toLowerCase(); // e.g. "friday"

            const hoursForDay = branch.operatingHours.get
              ? branch.operatingHours.get(dayOfWeek)
              : branch.operatingHours[dayOfWeek];

            if (hoursForDay) {
              if (hoursForDay.isOpen === false) {
                conflicts.push({
                  appointmentId: nextApt._id.toString(),
                  appointmentCode: nextApt.appointmentCode,
                  reason: `Branch is closed on ${dayOfWeek}s.`,
                  actionRequired: "reschedule_different_day",
                });
                break;
              }
              if (hoursForDay.closeTime && shiftedEndLocal.timeStr > hoursForDay.closeTime) {
                conflicts.push({
                  appointmentId: nextApt._id.toString(),
                  appointmentCode: nextApt.appointmentCode,
                  reason: `Shifted appointment ends at ${shiftedEndLocal.timeStr}, which exceeds branch closing time of ${hoursForDay.closeTime}.`,
                  actionRequired: "reschedule_different_day_or_reassign",
                  closingTime: hoursForDay.closeTime,
                });
                break;
              }
            }
          }

          // Check staff approved leave
          const leaveOnDate = await Leave.findOne({
            organizationId,
            staffId: appointment.staffId,
            dates: shiftedStartLocal.dateStr,
            status: "approved",
          });
          if (leaveOnDate) {
            conflicts.push({
              appointmentId: nextApt._id.toString(),
              appointmentCode: nextApt.appointmentCode,
              reason: `Assigned staff member is on approved leave on ${shiftedStartLocal.dateStr}.`,
              actionRequired: "reassign_staff",
            });
            break;
          }

          affectedAppointments.push({
            id: nextApt._id.toString(),
            appointmentCode: nextApt.appointmentCode,
            customerName: nextApt.customerId?.name || "Customer",
            staffId: appointment.staffId.toString(),
            version: nextApt.version || 1,
            originalStartAt: nextApt.startAt,
            originalEndAt: nextApt.endAt,
            originalStartTime: nextApt.startTime,
            originalEndTime: nextApt.endTime,
            proposedStartAt: shiftedStartAt,
            proposedEndAt: shiftedEndAt,
            proposedStartTime: shiftedStartLocal.timeStr,
            proposedEndTime: shiftedEndLocal.timeStr,
            delayMinutes: Math.round((shiftedStartAt.getTime() - nextStartAt.getTime()) / 60000),
            reason: "Cascaded due to service extension on preceding appointment.",
          });

          // Advance chain end to this shifted appointment's end time
          currentChainEnd = shiftedEndAt;
        }
      }
    }

    // Generate cryptographic preview token bound to the entire canonical proposal state:
    // initiatingId, initiatingVersion, branchId, organizationId, proposedEndAt,
    // Canonical services snapshot: sort deterministically by composite key to ensure canonical ordering
    const canonicalServices = proposedServiceSnapshots
      .map((s) => ({
        type: s.serviceType || "registered",
        idOrName: String(s.serviceId || s.name || ""),
        price: Number(s.price),
        duration: Number(s.duration),
        subId: s.appliedSubscriptionId ? String(s.appliedSubscriptionId) : "",
      }))
      .sort((a, b) =>
        `${a.type}:${a.idOrName}`.localeCompare(`${b.type}:${b.idOrName}`) ||
        a.price - b.price ||
        a.duration - b.duration
      );

    const tokenPayload = JSON.stringify({
      organizationId: organizationId.toString(),
      branchId: branchId.toString(),
      initiatingId: appointment._id.toString(),
      initiatingVersion: appointment.version || 1,
      proposedEndAt: proposedEndAt.toISOString(),
      canonicalServices,
      effectiveDiscount,
      affectedIdsAndVersions: affectedAppointments.map((a) => `${a.id}:${a.version}`),
    });

    const previewSecret = env.JWT_SECRET;
    if (!previewSecret || typeof previewSecret !== "string" || previewSecret.length < 8) {
      throw new AppError("Server cryptographic secret is misconfigured", 500);
    }

    const previewToken = crypto
      .createHmac("sha256", previewSecret)
      .update(tokenPayload)
      .digest("hex");

    return {
      canCommit: conflicts.length === 0,
      previewToken,
      initiatingAppointment: initiatingAppointmentProposal,
      affectedAppointments,
      conflicts,
      requiresManagerOverride: conflicts.length > 0,
    };
  }

  /**
   * CASCADING RESCHEDULE ENGINE: ATOMIC COMMIT
   * Revalidates snapshot versions and staff availability, then applies the service modification
   * and slot shift across all affected appointments in an ACID transaction boundary.
   */
  async commitServiceModification(id, data, organizationId, userId) {
    const {
      branchId,
      previewToken,
      services,
      serviceIds,
      discount,
      affectedAppointments = [],
      managerOverrideReason = null,
    } = data;

    if (!previewToken) {
      throw new AppError("Preview token is required to commit schedule modification", 400);
    }

    const appointment = await appointmentRepo.findById(id, organizationId);
    if (!appointment) {
      throw new AppError("Appointment not found", 404);
    }

    const aptBranchId = appointment.branchId?._id
      ? appointment.branchId._id.toString()
      : appointment.branchId.toString();
    if (aptBranchId !== branchId.toString()) {
      throw new AppError("Target branchId does not match appointment branch", 400);
    }

    if (["completed", "cancelled", "no_show"].includes(appointment.status)) {
      throw new AppError(
        `Cannot modify services on appointment with terminal status '${appointment.status}'`,
        400
      );
    }

    // Execute preview revalidation to verify proposal freshness
    const freshPreview = await this.previewServiceModification(
      id,
      { branchId, services, serviceIds, discount },
      organizationId
    );

    const freshTokenBuf = Buffer.from(freshPreview.previewToken, "utf8");
    const providedTokenBuf = Buffer.from(String(previewToken), "utf8");
    const isTokenMatch =
      freshTokenBuf.length === providedTokenBuf.length &&
      crypto.timingSafeEqual(freshTokenBuf, providedTokenBuf);

    if (!isTokenMatch) {
      throw new AppError(
        "The schedule proposal is stale due to a concurrent update. Please preview again before committing.",
        409
      );
    }

    if (!freshPreview.canCommit && !managerOverrideReason) {
      throw new AppError(
        "Cannot commit schedule modification due to unresolved conflicts. Manager override reason is required if permitted by policy.",
        409
      );
    }

    const branch = await Branch.findOne({ _id: branchId, organizationId });
    const tz = branch?.timezone || DEFAULT_TIMEZONE;

    let commitResult;
    try {
      commitResult = await this.executeTransaction(async (session) => {
        // 1. Invalidate pending subscription OTP challenges for initiating appointment
        await SubscriptionConsumptionChallenge.deleteMany(
          { appointmentId: appointment._id, status: "pending" },
          { session }
        );

        // Pass 1: Temporarily clear slotMinutes on initiating and affected appointments to release old slots
        const initProposal = freshPreview.initiatingAppointment;
        await Appointment.updateOne(
          { _id: appointment._id, organizationId },
          { $set: { slotMinutes: [] } },
          { session }
        );

        for (const aff of freshPreview.affectedAppointments) {
          await Appointment.updateOne(
            { _id: aff.id, organizationId },
            { $set: { slotMinutes: [] } },
            { session }
          );
        }

        // Shift all affected subsequent appointments atomically first to free up slots
        const updatedAffected = [];
        for (const aff of freshPreview.affectedAppointments) {
          const affSlotMinutes = generateSlotMinutes(
            new Date(aff.proposedStartAt),
            new Date(aff.proposedEndAt)
          );

          // Handle documents where version may not have been explicitly set (legacy records default to 1)
          const versionFilter =
            aff.version === 1
              ? { $in: [1, null, undefined] }
              : aff.version;

          const shiftedApt = await Appointment.findOneAndUpdate(
            {
              _id: aff.id,
              organizationId,
              version: versionFilter,
              status: "scheduled",
            },
            {
              $set: {
                startAt: aff.proposedStartAt,
                endAt: aff.proposedEndAt,
                startTime: aff.proposedStartTime,
                endTime: aff.proposedEndTime,
                slotMinutes: affSlotMinutes,
              },
              $inc: { version: 1 },
            },
            { returnDocument: "after", session }
          );

          if (!shiftedApt) {
            throw new AppError(
              `Subsequent appointment ${aff.appointmentCode} was modified concurrently. Commit aborted to prevent partial shift.`,
              409
            );
          }
          updatedAffected.push(shiftedApt);
        }

        // Now expand initiating appointment into its newly vacated slots
        const initSlotMinutes = appointment.staffId
          ? generateSlotMinutes(new Date(initProposal.proposedStartAt), new Date(initProposal.proposedEndAt))
          : [];

        const initVersionFilter =
          initProposal.version === 1
            ? { $in: [1, null, undefined] }
            : initProposal.version;

        const initiatingUpdated = await Appointment.findOneAndUpdate(
          {
            _id: appointment._id,
            organizationId,
            version: initVersionFilter,
          },
          {
            $set: {
              services: initProposal.services,
              totalDuration: initProposal.totalDuration,
              endAt: initProposal.proposedEndAt,
              endTime: initProposal.proposedEndTime,
              pricing: initProposal.pricing,
              slotMinutes: initSlotMinutes,
            },
            $inc: { version: 1 },
          },
          { returnDocument: "after", session }
        );

        if (!initiatingUpdated) {
          throw new AppError("Initiating appointment was modified concurrently. Commit aborted.", 409);
        }

        // 4. Record Audit Log for cascading reschedule
        if (userId) {
          const cascadeAudit = new AuditLog({
            organizationId,
            branchId,
            actorId: userId,
            action: AUDIT_ACTIONS.APPOINTMENT_CASCADE_RESCHEDULED || "APPOINTMENT_CASCADE_RESCHEDULED",
            entityType: "Appointment",
            entityId: appointment._id,
            description: `Appointment ${appointment.appointmentCode} services modified and cascaded ${updatedAffected.length} subsequent appointments`,
            metadata: {
              appointmentCode: appointment.appointmentCode,
              initiatingAppointmentId: appointment._id,
              shiftedAppointmentsCount: updatedAffected.length,
              shiftedAppointmentCodes: updatedAffected.map((a) => a.appointmentCode),
              managerOverrideReason: managerOverrideReason || null,
            },
          });
          await cascadeAudit.save({ session });
        }

        return {
          initiatingAppointment: initiatingUpdated,
          shiftedAppointments: updatedAffected,
        };
      }, { requireTransaction: true });
    } catch (err) {
      console.error("COMMIT INNER ERROR:", {
        message: err.message,
        code: err.code,
        keyPattern: err.keyPattern,
        keyValue: err.keyValue,
      });
      if (err.code === 11000 && err.keyPattern?.slotMinutes) {
        throw new AppError(
          "Staff member slot assignment conflict during schedule commit. Concurrently overlapping booking detected.",
          409
        );
      }
      throw err;
    }

    // 5. Post-commit operations (BullMQ reminders & notifications)
    try {
      for (const shifted of commitResult.shiftedAppointments) {
        await this.cancelReminders(shifted);
        if (shifted.reminder?.enabled) {
          await this.scheduleReminders(shifted);
        }
        const cust = await Customer.findById(shifted.customerId).lean();
        if (cust?.phone) {
          await smsQueue.add("sendAppointmentRescheduledSMS", {
            phone: cust.phone,
            customerName: cust.name,
            appointmentCode: shifted.appointmentCode,
            newStartTime: shifted.startTime,
            date: shifted.appointmentDate,
          });
        }
      }
    } catch (postErr) {
      console.error("Post-commit reminder/notification dispatch error:", postErr.message);
    }

    return {
      message: "Services updated and cascading schedule committed successfully",
      initiatingAppointment: commitResult.initiatingAppointment,
      shiftedAppointments: commitResult.shiftedAppointments,
    };
  }

  /**
   * Phase 3: Upsell Subscription during an Ongoing or Scheduled Appointment
   * Atomically sells a subscription, creates its sale billing record, and
   * reassesses/attaches eligible benefits to the appointment's registered service lines.
   */
  async upsellSubscription(appointmentId, upsellData, organizationId, branchId, userId) {
    const {
      price,
      entitlements,
      planId = null,
      permittedBranchIds = [],
      startDate,
      endDate,
      notes = "",
      billImmediately = true,
    } = upsellData;

    return await runInTransaction(async (session) => {
      // 1. Fetch and validate appointment
      const appointment = await Appointment.findOne({
        _id: appointmentId,
        organizationId,
        isDeleted: false,
      }).session(session);

      if (!appointment) {
        throw new AppError("Appointment not found", 404);
      }

      if (branchId && appointment.branchId.toString() !== branchId.toString()) {
        throw new AppError("Target branchId does not match appointment branch", 400);
      }

      if (!["scheduled", "in_progress"].includes(appointment.status)) {
        throw new AppError(
          `Cannot upsell subscription to an appointment with status '${appointment.status}'. Must be 'scheduled' or 'in_progress'.`,
          400
        );
      }

      const customerId = appointment.customerId;
      const customer = await Customer.findOne({
        _id: customerId,
        organizationId,
        isDeleted: false,
      }).session(session);

      if (!customer || customer.status !== "active") {
        throw new AppError("Customer is inactive or not found", 400);
      }

      // 2. Validate dates
      const start = new Date(startDate || new Date().toISOString());
      const end = new Date(endDate);
      if (isNaN(start.getTime()) || isNaN(end.getTime())) {
        throw new AppError("Invalid start or end date", 400);
      }
      if (end <= start) {
        throw new AppError("End date must be strictly after start date", 400);
      }

      // 3. Validate entitlements
      if (!Array.isArray(entitlements) || entitlements.length === 0) {
        throw new AppError("At least one entitlement is required", 400);
      }

      const seenServiceIds = new Set();
      const resolvedEntitlements = [];
      for (const ent of entitlements) {
        const sIdStr = ent.serviceId.toString();
        if (seenServiceIds.has(sIdStr)) {
          throw new AppError(
            "Duplicate serviceId in entitlements. Consolidate into a single entitlement with total quantity.",
            400
          );
        }
        seenServiceIds.add(sIdStr);

        const service = await Service.findOne({
          _id: ent.serviceId,
          organizationId,
          isDeleted: false,
        }).session(session);

        if (!service) {
          throw new AppError(`Service ${ent.serviceId} not found in this organization`, 404);
        }
        if (service.status !== "active") {
          throw new AppError(`Service '${service.name}' is inactive and cannot be added to a subscription`, 400);
        }

        const totalQuantity = parseInt(ent.quantity, 10);
        if (isNaN(totalQuantity) || totalQuantity < 1) {
          throw new AppError(`Invalid quantity for service '${service.name}'. Must be at least 1.`, 400);
        }

        resolvedEntitlements.push({
          serviceId: service._id,
          serviceName: service.name,
          totalQuantity,
          usedQuantity: 0,
          remainingQuantity: totalQuantity,
        });
      }

      // 4. Validate permittedBranchIds
      const validPermittedBranchIds = [];
      if (Array.isArray(permittedBranchIds) && permittedBranchIds.length > 0) {
        for (const bId of permittedBranchIds) {
          const branch = await Branch.findOne({
            _id: bId,
            organizationId,
            isActive: true,
          }).session(session);
          if (!branch) {
            throw new AppError(`Permitted branch ${bId} is invalid or inactive`, 400);
          }
          validPermittedBranchIds.push(branch._id);
        }
      }

      // 5. Generate subscription code
      const sequenceKey = `SUB_${organizationId.toString()}`;
      const seq = await Sequence.findOneAndUpdate(
        { key: sequenceKey },
        { $inc: { seq: 1 } },
        { new: true, upsert: true, session }
      );
      const today = new Date();
      const yyyy = today.getFullYear();
      const mm = String(today.getMonth() + 1).padStart(2, "0");
      const dd = String(today.getDate()).padStart(2, "0");
      const num = String(seq.seq).padStart(4, "0");
      const subscriptionCode = `SUB-${yyyy}${mm}${dd}-${num}`;

      // 6. Create subscription doc
      // Status policy:
      // If billImmediately is true and price > 0, invoice is generated and subscription starts as "pending_payment"
      // until the invoice is paid via POS payment recording.
      // If price is 0 (complimentary/deferred), status is "active".
      const initialStatus = billImmediately && Number(price) > 0 ? "pending_payment" : "active";
      const newSubscription = new Subscription({
        organizationId,
        payerCustomerId: customer._id,
        customerId: customer._id,
        subscriptionCode,
        planId: planId || null,
        price: Number(price),
        members: [
          {
            customerId: customer._id,
            status: initialStatus,
            permittedBranchIds: validPermittedBranchIds,
            entitlements: resolvedEntitlements,
            notes: notes || `Upsold during appointment ${appointment.appointmentCode}`,
          },
        ],
        entitlements: resolvedEntitlements,
        permittedBranchIds: validPermittedBranchIds,
        startDate: start,
        endDate: end,
        status: initialStatus,
        notes: notes || `Upsold during appointment ${appointment.appointmentCode}`,
      });
      await newSubscription.save({ session });

      // 7. Create standalone subscription invoice if billImmediately is true
      let invoice = null;
      if (billImmediately) {
        const { billingService } = await import("../billing/billing.service.js");
        invoice = await billingService.createInvoiceForSubscriptionSale(
          {
            subscriptionId: newSubscription._id,
            branchId: appointment.branchId,
            notes: `Upsold during appointment ${appointment.appointmentCode}`,
          },
          organizationId,
          userId,
          session
        );
        newSubscription.invoiceId = invoice._id;
      }

      // 8. Reassess this appointment's registered service lines and attach the new subscription
      // Subscriptions are redeemable even when payment is pending or partial
      let newlyCoveredCount = 0;
      if (["active", "pending_payment"].includes(newSubscription.status)) {
        for (const line of appointment.services || []) {
          if (
            line.serviceType !== "custom" &&
            !line.isRedeemedViaSubscription &&
            !line.appliedSubscriptionId
          ) {
            const matchingEntitlement = newSubscription.entitlements.find(
              (e) =>
                e.serviceId.toString() === line.serviceId.toString() &&
                e.remainingQuantity >= 1
            );

            if (matchingEntitlement) {
              // Check permitted branches
              const isPermitted =
                validPermittedBranchIds.length === 0 ||
                validPermittedBranchIds.some(
                  (b) => b.toString() === appointment.branchId.toString()
                );
              if (isPermitted) {
                line.appliedSubscriptionId = newSubscription._id;
                newlyCoveredCount++;
              }
            }
          }
        }
      }

      await appointment.save({ session });

      // 9. Audit log
      const auditLog = new AuditLog({
        organizationId,
        branchId: appointment.branchId,
        actorId: userId,
        action: AUDIT_ACTIONS.SUBSCRIPTION_CREATED,
        entityType: "Subscription",
        entityId: newSubscription._id,
        description: `Subscription ${subscriptionCode} upsold during appointment ${appointment.appointmentCode} for customer ${customer.name}`,
        metadata: {
          appointmentId: appointment._id,
          appointmentCode: appointment.appointmentCode,
          subscriptionCode,
          price,
          newlyCoveredCount,
          invoiceId: invoice?._id || null,
        },
      });
      await auditLog.save({ session });

      return {
        subscription: newSubscription,
        invoice,
        appointment,
        summary: {
          newlyCoveredServicesCount: newlyCoveredCount,
          appliedSubscriptionCode: subscriptionCode,
        },
      };
    }, { requireTransaction: false });
  }
}


