import { Worker } from "bullmq";
import { redisOptions } from "../config/redis.js";
import { logger } from "../utils/logger.js";
import { subscriptionService } from "../services/subscriptions/subscription.service.js";

let cancellationWorker = null;

export const processSubscriptionCancellationJob = async (job) => {
  logger.info(`📥 Processing Subscription Cancellation Job [${job.id}] - ${job.name}`);
  const { operationId, organizationId, userId } = job.data;
  if (!operationId || !organizationId) {
    throw new Error("Missing required parameters for cancellation operation");
  }

  return await subscriptionService.executeCancellationOperation(
    operationId,
    organizationId,
    userId
  );
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

