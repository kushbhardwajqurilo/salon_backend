import { Worker } from "bullmq";
import { redisOptions } from "../config/redis.js";
import { logger } from "../utils/logger.js";
import { subscriptionService } from "../services/subscriptions/subscription.service.js";
import { AuditLogService } from "../services/audit/auditLog.service.js";
import { AUDIT_ACTIONS } from "../models/audit/auditLog.model.js";

const auditLogService = new AuditLogService();
let cancellationWorker = null;

export const processSubscriptionCancellationJob = async (job) => {
  logger.info(`📥 Processing Subscription Cancellation Job [${job.id}] - ${job.name}`);
  const { operationId, organizationId, userId } = job.data;
  if (!operationId || !organizationId) {
    throw new Error("Missing required parameters for cancellation operation");
  }

  const result = await subscriptionService.executeCancellationOperation(
    operationId,
    organizationId,
    userId
  );

  try {
    await auditLogService.createAuditLog(
      {
        action: AUDIT_ACTIONS.SUBSCRIPTION_AUTO_CANCELLED,
        entityType: "Subscription",
        entityId: operationId,
        actorType: "background_job",
        source: "scheduled_job",
        description: `Background subscription cancellation job executed`,
        metadata: { jobId: job.id, idempotencyKey: `sub_cancel_${operationId}` },
      },
      organizationId,
      null
    );
  } catch (e) {
    if (e?.code !== 11000) {
      logger.error(`[Subscription Cancellation] Audit persistence failed: ${e.message}`);
      throw e;
    }
    logger.debug(`[Subscription Cancellation] Idempotent audit replay skipped for operation ${operationId}`);
  }

  return result;
};

export const startSubscriptionCancellationWorker = () => {
  if (process.env.NODE_ENV === "test" || process.env.JEST_WORKER_ID !== undefined) {
    return;
  }

  if (cancellationWorker) {
    logger.warn("[Subscription Cancellation] Worker is already running.");
    return;
  }

  try {
    cancellationWorker = new Worker(
      "subscription-cancellation",
      processSubscriptionCancellationJob,
      {
        connection: redisOptions,
        concurrency: 2,
      }
    );

    cancellationWorker.on("completed", (job) => {
      logger.info(`✅ Subscription Cancellation Job [${job.id}] completed successfully`);
    });

    cancellationWorker.on("failed", (job, err) => {
      logger.error(`❌ Subscription Cancellation Job [${job?.id}] failed: ${err.message}`);
    });

    logger.info("🔄 Subscription Cancellation BullMQ Worker started");
  } catch (error) {
    logger.error(`❌ Failed to start Subscription Cancellation Worker: ${error.message}`);
  }
};

export const stopSubscriptionCancellationWorker = async () => {
  if (cancellationWorker) {
    await cancellationWorker.close();
    cancellationWorker = null;
    logger.info("🛑 Subscription Cancellation BullMQ Worker stopped");
  }
};

