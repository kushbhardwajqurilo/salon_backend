import { Worker } from "bullmq";
import { logger } from "../utils/logger.js";
import { EmailService } from "../services/notifications/email.service.js";
import { SmsService } from "../services/notifications/sms.service.js";
import { redisOptions } from "../config/redis.js";

const emailService = new EmailService();
const smsService = new SmsService();

let emailWorker = null;
let smsWorker = null;

export const startNotificationWorkers = () => {
  if (process.env.JEST_WORKER_ID !== undefined) {
    logger.info("⚙️ Skipping BullMQ notification workers start during Jest test suite execution");
    return;
  }

  try {
    // 1. Email Worker Processor
    emailWorker = new Worker(
      "email",
      async (job) => {
        logger.info(`📥 Processing Email Job [${job.id}] - ${job.name}`);
        switch (job.name) {
          case "sendWelcomeCredentialsEmail":
            return await emailService.sendWelcomeCredentialsEmail(job.data);
          case "sendVerificationEmail":
            return await emailService.sendVerificationEmail(job.data);
          case "sendPasswordResetEmail":
            return await emailService.sendPasswordResetEmail(job.data);
          case "sendAppointmentReminderEmail": {
            const { appointmentId, organizationId } = job.data;
            const { Appointment } = await import("../models/appointments/appointment.model.js");
            const { Customer } = await import("../models/customers/customer.model.js");
            const { Branch } = await import("../models/branches/branch.model.js");
            const { formatUTCToLocal } = await import("../services/appointments/appointment.service.js");

            // ATOMIC CLAIM: Only proceed if email.status is scheduled, pending, or failed (for retries) and appointment is active
            const apt = await Appointment.findOneAndUpdate(
              {
                _id: appointmentId,
                organizationId,
                isDeleted: false,
                status: "scheduled",
                "reminder.enabled": true,
                "reminder.email.status": { $in: ["scheduled", "pending", "failed"] },
              },
              {
                $set: { "reminder.email.status": "processing" },
              },
              { new: true }
            );

            if (!apt) {
              logger.warn(`[REMINDER_SKIPPED] Appointment ${appointmentId} not eligible or already processing/sent/terminal`);
              return true;
            }

            const customer = await Customer.findOne({ _id: apt.customerId, organizationId, isDeleted: false });
            if (!customer || !customer.email) {
              const smsStatus = apt.reminder?.sms?.status || "pending";
              const aggStatus = smsStatus === "sent" ? "partial_delivery" : "failed";
              await Appointment.updateOne({ _id: appointmentId }, {
                "reminder.email.status": "failed",
                "reminder.email.failedAt": new Date(),
                "reminder.email.failureReason": "Customer email missing or unconfigured",
                "reminder.status": aggStatus,
                "reminder.failureReason": "Customer email missing or unconfigured",
              });
              logger.warn(`[REMINDER_FAILED] Customer ${apt.customerId} has no email address`);
              return false;
            }

            const branch = await Branch.findOne({ _id: apt.branchId, organizationId });
            const tz = branch?.timezone || "Asia/Kolkata";
            const formatted = formatUTCToLocal(apt.startAt, tz);

            try {
              console.log("cutomer", customer)
              await emailService.sendMail({
                to: customer.email,
                subject: `Appointment Reminder — ${apt.appointmentCode}`,
                text: `Hello ${customer.name}, this is a reminder for your upcoming salon appointment on ${formatted.dateStr} at ${formatted.timeStr}.`,
                html: `<p>Hello <strong>${customer.name}</strong>,</p><p>This is a reminder for your upcoming salon appointment (Code: <code>${apt.appointmentCode}</code>) scheduled on <strong>${formatted.dateStr}</strong> at <strong>${formatted.timeStr}</strong>.</p>`,
              });
            } catch (err) {
              const updatedApt = await Appointment.findById(appointmentId);
              const smsStatus = updatedApt.reminder?.sms?.status || "pending";
              const aggStatus = smsStatus === "sent" ? "partial_delivery" : "failed";
              await Appointment.updateOne({ _id: appointmentId }, {
                "reminder.email.status": "failed",
                "reminder.email.failedAt": new Date(),
                "reminder.email.failureReason": err.message,
                "reminder.status": aggStatus,
                "reminder.failureReason": `Email dispatch failed: ${err.message}`,
              });
              throw err;
            }

            const updatedApt = await Appointment.findById(appointmentId);
            const smsStatus = updatedApt.reminder?.sms?.status || "pending";
            const reqChannel = updatedApt.reminder?.channel || "email";
            const now = new Date();

            let newAggStatus = "sent";
            if (reqChannel === "both" && smsStatus !== "sent") {
              newAggStatus = "partial_delivery";
            }

            await Appointment.updateOne({ _id: appointmentId }, {
              "reminder.email.status": "sent",
              "reminder.email.sentAt": now,
              "reminder.email.failureReason": null,
              "reminder.status": newAggStatus,
              "reminder.sentAt": now,
            });
            return true;
          }
          default:
            logger.warn(`Unknown email job type: ${job.name}`);
            return true;
        }
      },
      { connection: redisOptions },
    );

    emailWorker.on("completed", (job) => {
      logger.info(`✅ Email Job [${job.id}] ${job.name} completed successfully`);
    });

    emailWorker.on("failed", (job, err) => {
      logger.error(`❌ Email Job [${job?.id}] ${job?.name} failed: ${err.message}`);
    });

    emailWorker.on("error", (err) => {
      logger.warn(`⚠️ [REDIS_WORKER_WARN] Email Worker connection warning: ${err.message}`);
    });

    // 2. SMS Worker Processor
    smsWorker = new Worker(
      "sms",
      async (job) => {
        logger.info(`📥 Processing SMS Job [${job.id}] - ${job.name}`);
        switch (job.name) {
          case "sendOtpSMS":
            return await smsService.sendOtpSMS(job.data);
          case "sendAppointmentReminderSMS": {
            const { appointmentId, organizationId } = job.data;
            const { Appointment } = await import("../models/appointments/appointment.model.js");
            const { Customer } = await import("../models/customers/customer.model.js");
            const { Branch } = await import("../models/branches/branch.model.js");
            const { formatUTCToLocal } = await import("../services/appointments/appointment.service.js");

            // ATOMIC CLAIM: Only proceed if sms.status is scheduled, pending, or failed (for retries) and appointment is active
            const apt = await Appointment.findOneAndUpdate(
              {
                _id: appointmentId,
                organizationId,
                isDeleted: false,
                status: "scheduled",
                "reminder.enabled": true,
                "reminder.sms.status": { $in: ["scheduled", "pending", "failed"] },
              },
              {
                $set: { "reminder.sms.status": "processing" },
              },
              { new: true }
            );

            if (!apt) {
              logger.warn(`[REMINDER_SKIPPED] Appointment ${appointmentId} not eligible or already processing/sent/terminal`);
              return true;
            }

            const customer = await Customer.findOne({ _id: apt.customerId, organizationId, isDeleted: false });
            if (!customer || !customer.phone) {
              const emailStatus = apt.reminder?.email?.status || "pending";
              const aggStatus = emailStatus === "sent" ? "partial_delivery" : "failed";
              await Appointment.updateOne({ _id: appointmentId }, {
                "reminder.sms.status": "failed",
                "reminder.sms.failedAt": new Date(),
                "reminder.sms.failureReason": "Customer phone missing or unconfigured",
                "reminder.status": aggStatus,
                "reminder.failureReason": "Customer phone missing or unconfigured",
              });
              logger.warn(`[REMINDER_FAILED] Customer ${apt.customerId} has no phone number`);
              return false;
            }

            const branch = await Branch.findOne({ _id: apt.branchId, organizationId });
            const tz = branch?.timezone || "Asia/Kolkata";
            const formatted = formatUTCToLocal(apt.startAt, tz);

            try {
              await smsService.sendSms({
                phone: customer.phone,
                message: `Reminder: Your appointment ${apt.appointmentCode} is scheduled for ${formatted.dateStr} at ${formatted.timeStr}.`,
              });
            } catch (err) {
              const updatedApt = await Appointment.findById(appointmentId);
              const emailStatus = updatedApt.reminder?.email?.status || "pending";
              const aggStatus = emailStatus === "sent" ? "partial_delivery" : "failed";
              await Appointment.updateOne({ _id: appointmentId }, {
                "reminder.sms.status": "failed",
                "reminder.sms.failedAt": new Date(),
                "reminder.sms.failureReason": err.message,
                "reminder.status": aggStatus,
                "reminder.failureReason": `SMS dispatch failed: ${err.message}`,
              });
              throw err;
            }

            const updatedApt = await Appointment.findById(appointmentId);
            const emailStatus = updatedApt.reminder?.email?.status || "pending";
            const reqChannel = updatedApt.reminder?.channel || "sms";
            const now = new Date();

            let newAggStatus = "sent";
            if (reqChannel === "both" && emailStatus !== "sent") {
              newAggStatus = "partial_delivery";
            }

            await Appointment.updateOne({ _id: appointmentId }, {
              "reminder.sms.status": "sent",
              "reminder.sms.sentAt": now,
              "reminder.sms.failureReason": null,
              "reminder.status": newAggStatus,
              "reminder.sentAt": now,
            });
            return true;
          }
          default:
            logger.warn(`Unknown SMS job type: ${job.name}`);
            return true;
        }
      },
      { connection: redisOptions },
    );

    smsWorker.on("completed", (job) => {
      logger.info(`✅ SMS Job [${job.id}] ${job.name} completed successfully`);
    });

    smsWorker.on("failed", (job, err) => {
      logger.error(`❌ SMS Job [${job?.id}] ${job?.name} failed: ${err.message}`);
    });

    smsWorker.on("error", (err) => {
      logger.warn(`⚠️ [REDIS_WORKER_WARN] SMS Worker connection warning: ${err.message}`);
    });

    logger.info("🚀 Active BullMQ Notification Workers (Email & SMS) initialized");
  } catch (error) {
    logger.error(`❌ Failed to start notification workers: ${error.message}`);
  }
};

export const stopNotificationWorkers = async () => {
  if (emailWorker) await emailWorker.close();
  if (smsWorker) await smsWorker.close();
  logger.info("🛑 BullMQ Notification Workers shut down gracefully");
};
