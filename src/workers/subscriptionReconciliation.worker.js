import { subscriptionService } from "../services/subscriptions/subscription.service.js";
import { logger } from "../utils/logger.js";
import { redis } from "../utils/redis.js";
import crypto from "crypto";

let reconciliationInterval = null;
let isReconciliationRunning = false;
let activePassPromise = null;

const DISTRIBUTED_LOCK_KEY = "lock:subscription:reconciliation";
const DISTRIBUTED_LOCK_TTL_MS = 60000;

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
 * Executes a single bounded reconciliation pass.
 * Prevents overlapping executions using a multi-layer strategy:
 * 1. Process-level mutex for intra-process concurrency.
 * 2. Redis distributed lock (SET NX PX) with cryptographic token ownership and Lua release
 *    for cross-process multi-instance clustering.
 * 3. Heartbeat lock renewal to prevent expiration during extended passes.
 * 4. MongoDB atomic lease state machine with stale lease expiration (reconciliationClaimedAt)
 *    and durable operation identity (appliedOperations) to guarantee database-level safety
 *    even if Redis is partitioned, unavailable, or expired.
 */
export async function runSubscriptionReconciliationPass() {
  if (isReconciliationRunning) {
    logger.debug("[Subscription Reconciliation] Previous pass still in progress in this process. Skipping.");
    return null;
  }

  isReconciliationRunning = true;
  let hasRedisLock = false;
  const lockToken = `${process.pid}:${Date.now()}:${crypto.randomBytes(8).toString("hex")}`;
  let heartbeatTimer = null;

  const execution = (async () => {
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
            logger.debug("[Subscription Reconciliation] Distributed lock held by another cluster instance. Skipping.");
            return null;
          }
          hasRedisLock = true;

          // Start heartbeat renewal every 20 seconds (1/3 of TTL)
          if (typeof redis.eval === "function") {
            heartbeatTimer = setInterval(async () => {
              try {
                await redis.eval(RENEW_LOCK_LUA, 1, DISTRIBUTED_LOCK_KEY, lockToken, DISTRIBUTED_LOCK_TTL_MS);
              } catch (renewErr) {
                logger.warn(`[Subscription Reconciliation] Heartbeat lock renewal failed: ${renewErr.message}`);
              }
            }, 20000);
          }
        } catch (redisErr) {
          logger.warn(`[Subscription Reconciliation] Redis lock acquisition failed, proceeding with DB CAS safety: ${redisErr.message}`);
        }
      }

      // 2. Execute reconciliation with 5-minute age cutoff and 2-minute stale lock reclamation
      const report = await subscriptionService.reconcileIncompleteRedemptions(null, {
        maxAgeMinutes: 5,
        staleLockTimeoutMs: 120000,
      });

      if (report && report.inspected > 0) {
        logger.info(
          `[Subscription Reconciliation] Completed pass: Inspected ${report.inspected}, Finalized ${report.reconciledCompleted}, Restored ${report.reconciledRestored}, Errors ${report.errors}`
        );
      }
      return report;
    } catch (err) {
      logger.error(`[Subscription Reconciliation Error] Pass failed: ${err.message}`);
      return null;
    } finally {
      if (heartbeatTimer) {
        clearInterval(heartbeatTimer);
        heartbeatTimer = null;
      }

      if (hasRedisLock && redis) {
        try {
          if (typeof redis.eval === "function") {
            await redis.eval(RELEASE_LOCK_LUA, 1, DISTRIBUTED_LOCK_KEY, lockToken);
          } else if (typeof redis.del === "function") {
            await redis.del(DISTRIBUTED_LOCK_KEY);
          }
        } catch (delErr) {
          logger.warn(`[Subscription Reconciliation] Failed to release Redis lock safely: ${delErr.message}`);
        }
      }
      isReconciliationRunning = false;
      activePassPromise = null;
    }
  })();

  activePassPromise = execution;
  return execution;
}

/**
 * Starts the periodic reconciliation sweeper.
 * Runs every 2 minutes by default.
 */
export function startSubscriptionReconciliationWorker(intervalMs = 120000) {
  if (process.env.JEST_WORKER_ID !== undefined) {
    return;
  }

  if (reconciliationInterval) {
    logger.warn("[Subscription Reconciliation] Worker is already running.");
    return;
  }

  logger.info(`🔄 Subscription Redemption Reconciliation Worker started (interval: ${intervalMs / 1000}s)`);

  // Run initial pass after a brief initial warmup delay (5 seconds)
  setTimeout(() => {
    runSubscriptionReconciliationPass().catch(() => {});
  }, 5000);

  reconciliationInterval = setInterval(() => {
    runSubscriptionReconciliationPass().catch(() => {});
  }, intervalMs);
}

/**
 * Stops the periodic reconciliation sweeper during server shutdown.
 * Clears recurring interval and cleanly awaits any active pass in flight.
 */
export async function stopSubscriptionReconciliationWorker() {
  if (reconciliationInterval) {
    clearInterval(reconciliationInterval);
    reconciliationInterval = null;
  }

  if (activePassPromise) {
    try {
      await activePassPromise;
    } catch (e) {
      // Ignored during shutdown
    }
  }

  logger.info("🛑 Subscription Redemption Reconciliation Worker stopped.");
}
