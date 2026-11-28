import { logger } from "../utils/logger.js";
import { runAutoMarkAbsentSweep } from "../jobs/autoMarkAbsent.job.js";

const DEFAULT_INTERVAL_MS = 5 * 60 * 1000; // 5 minutes
let sweepTimer = null;

export function startAutoMarkAbsentWorker() {
  if (sweepTimer) return;
  const intervalMs = Math.max(
    60_000,
    Number(process.env.AUTO_MARK_ABSENT_INTERVAL_MS) || DEFAULT_INTERVAL_MS,
  );

  sweepTimer = setInterval(() => {
    runAutoMarkAbsentSweep().catch((err) => {
      logger.error(`[AutoMarkAbsent] Scheduled sweep failed: ${err.message}`);
    });
  }, intervalMs);

  if (typeof sweepTimer.unref === "function") {
    sweepTimer.unref();
  }

  logger.info(
    `⏱️ Auto-Mark Absent Worker started (interval: ${Math.round(intervalMs / 1000)}s).`,
  );
}

export async function stopAutoMarkAbsentWorker() {
  if (sweepTimer) {
    clearInterval(sweepTimer);
    sweepTimer = null;
    logger.info("🛑 Auto-Mark Absent Worker stopped.");
  }
}

export { runAutoMarkAbsentSweep };