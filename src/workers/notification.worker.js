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
