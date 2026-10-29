import { subscriptionService } from "../services/subscriptions/subscription.service.js";
import { logger } from "../utils/logger.js";

let reconciliationInterval = null;
let isReconciliationRunning = false;

/**
 * Executes a single bounded reconciliation pass.
 * Prevents overlapping executions using a memory lock.
 */
export async function runSubscriptionReconciliationPass() {
  if (isReconciliationRunning) {
    logger.debug("[Subscription Reconciliation] Previous pass still in progress. Skipping.");
    return null;
  }

  isReconciliationRunning = true;
  try {
    const report = await subscriptionService.reconcileIncompleteRedemptions(null, { maxAgeMinutes: 5 });
    if (report.inspected > 0) {
      logger.info(
        `[Subscription Reconciliation] Completed pass: Inspected ${report.inspected}, Finalized ${report.reconciledCompleted}, Restored ${report.reconciledRestored}, Errors ${report.errors}`
      );
    }
    return report;
  } catch (err) {
    logger.error(`[Subscription Reconciliation Error] Pass failed: ${err.message}`);
    return null;
  } finally {
    isReconciliationRunning = false;
  }
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
 */
export function stopSubscriptionReconciliationWorker() {
  if (reconciliationInterval) {
    clearInterval(reconciliationInterval);
    reconciliationInterval = null;
    logger.info("🛑 Subscription Redemption Reconciliation Worker stopped.");
  }
}
