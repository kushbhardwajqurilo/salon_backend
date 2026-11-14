import { Worker } from "bullmq";
import { redisOptions } from "../config/redis.js";
import { logger } from "../utils/logger.js";
import { redis } from "../utils/redis.js";
import { inventoryService } from "../services/inventory/inventory.service.js";
import { stockReservationExpiryQueue } from "../queues/client.js";
import crypto from "crypto";

let stockExpiryWorker = null;
let isPassRunning = false;

const DISTRIBUTED_LOCK_KEY = "lock:inventory:reservation-expiry";
const DISTRIBUTED_LOCK_TTL_MS = 60000; // 60s lock TTL

const RELEASE_LOCK_LUA = `
  if redis.call("get", KEYS[1]) == ARGV[1] then
    return redis.call("del", KEYS[1])
  else
    return 0
  end
`;

const RENEW_LOCK_LUA = `
  if redis.call("get", KEYS[1]) == ARGV[1] then
    return redis.call("pexpire", KEYS[1], ARGV[2])
  else
    return 0
  end
`;

/**
 * Executes a single bounded reservation cleanup pass.
 * Idempotent across multiple worker instances via:
 * 1. Process-level mutex.
 * 2. Redis distributed lock (SET NX PX) with cryptographic token ownership.
 * 3. MongoDB transactional state machine in inventoryService.cleanupExpiredReservations.
 */
export async function runStockReservationExpiryPass(batchSize = 100) {
  if (isPassRunning) {
    logger.debug("[Stock Reservation Expiry] Previous cleanup pass in progress in this process. Skipping.");
    return { skipped: true, reason: "in_progress" };
  }

  isPassRunning = true;
  let hasRedisLock = false;
  const lockToken = `${process.pid}:${Date.now()}:${crypto.randomBytes(8).toString("hex")}`;
  let heartbeatTimer = null;

  try {
    // 1. Attempt Redis distributed lock if available
    if (redis && typeof redis.set === "function") {
      try {
        const lockResult = await redis.set(
          DISTRIBUTED_LOCK_KEY,
          lockToken,
          "PX",
          DISTRIBUTED_LOCK_TTL_MS,
          "NX"
        );
        if (lockResult !== "OK" && lockResult !== true) {
          logger.debug("[Stock Reservation Expiry] Lock held by another cluster instance. Skipping.");
          return { skipped: true, reason: "locked" };
        }
        hasRedisLock = true;

        if (typeof redis.eval === "function") {
          heartbeatTimer = setInterval(async () => {
            try {
              await redis.eval(RENEW_LOCK_LUA, 1, DISTRIBUTED_LOCK_KEY, lockToken, DISTRIBUTED_LOCK_TTL_MS);
            } catch (renewErr) {
              logger.warn(`[Stock Reservation Expiry] Heartbeat lock renewal failed: ${renewErr.message}`);
            }
          }, 20000);
        }
      } catch (redisErr) {
        logger.warn(`[Stock Reservation Expiry] Redis lock failed, falling back to DB transaction CAS: ${redisErr.message}`);
      }
    }

    // 2. Execute transactional cleanup pass
    const report = await inventoryService.cleanupExpiredReservations(batchSize);

    if (report && report.processedCount > 0) {
      logger.info(`[Stock Reservation Expiry] Cleaned up ${report.processedCount} expired stock reservation(s).`);
    }

    return report;
  } catch (err) {
    logger.error(`[Stock Reservation Expiry Error] Pass failed: ${err.message}`);
    return { error: err.message };
  } finally {
    if (heartbeatTimer) {
      clearInterval(heartbeatTimer);
    }
    if (hasRedisLock && redis && typeof redis.eval === "function") {
      try {
        await redis.eval(RELEASE_LOCK_LUA, 1, DISTRIBUTED_LOCK_KEY, lockToken);
      } catch (releaseErr) {
        logger.warn(`[Stock Reservation Expiry] Lock release error: ${releaseErr.message}`);
      }
    }
    isPassRunning = false;
  }
}

/**
 * BullMQ job processor for recurring 5-minute cleanup job
 */
export const processStockReservationExpiryJob = async (job) => {
  logger.info(`📥 Processing Stock Reservation Expiry Job [${job.id}] - ${job.name}`);
  return await runStockReservationExpiryPass(job.data?.batchSize || 100);
};

/**
 * Schedules recurring BullMQ repeatable job every 5 minutes and initializes BullMQ worker
 */
export const startStockReservationExpiryWorker = async () => {
  if (process.env.NODE_ENV === "test" || process.env.JEST_WORKER_ID !== undefined) {
    return;
  }

  if (stockExpiryWorker) {
    logger.warn("[Stock Reservation Expiry] Worker is already running.");
    return;
  }

  try {
    // 1. Schedule repeatable job every 5 minutes (300,000 ms) in BullMQ
    const queue = stockReservationExpiryQueue.getQueue();
    if (queue && typeof queue.add === "function") {
      await queue.add(
        "cleanup-expired-reservations",
        { batchSize: 100 },
        {
          repeat: {
            every: 5 * 60 * 1000, // 5 minutes
          },
          jobId: "recurring-stock-reservation-expiry",
          removeOnComplete: true,
        }
      );
      logger.info("⏱️ Scheduled BullMQ recurring job: 'cleanup-expired-reservations' every 5 minutes");
    }

    // 2. Initialize BullMQ Worker
    stockExpiryWorker = new Worker(
      "stock-reservation-expiry",
      processStockReservationExpiryJob,
      {
        connection: redisOptions,
        concurrency: 1, // Single job concurrency per instance
      }
    );

    stockExpiryWorker.on("completed", (job) => {
      logger.info(`✅ Stock Reservation Expiry Job [${job.id}] finished successfully`);
    });

    stockExpiryWorker.on("failed", (job, err) => {
      logger.error(`❌ Stock Reservation Expiry Job [${job?.id}] failed: ${err.message}`);
    });

    logger.info("🔄 Stock Reservation Expiry BullMQ Worker started");
  } catch (error) {
    logger.error(`❌ Failed to start Stock Reservation Expiry BullMQ Worker: ${error.message}`);
  }
};

export const stopStockReservationExpiryWorker = async () => {
  if (stockExpiryWorker) {
    await stockExpiryWorker.close();
    stockExpiryWorker = null;
    logger.info("🛑 Stock Reservation Expiry BullMQ Worker stopped");
  }
};

