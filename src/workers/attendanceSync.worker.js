import { logger } from "../utils/logger.js";
import { syncAllActiveETimeOfficeBranches } from "../services/attendance/etimeoffice.service.js";

const DEFAULT_INTERVAL_MS = 2 * 60 * 1000; // 2 minutes
let syncTimer = null;

export function startAttendanceSyncWorker() {
  if (syncTimer) return;
  const intervalMs = Math.max(
    30_000,
    Number(process.env.ATTENDANCE_SYNC_INTERVAL_MS) || DEFAULT_INTERVAL_MS,
  );

  syncTimer = setInterval(() => {
    syncAllActiveETimeOfficeBranches().catch((err) => {
      logger.error(`[AttendanceSync] Scheduled sweep failed: ${err.message}`);
    });
  }, intervalMs);

  // Don't keep the event loop alive solely for this timer during shutdown
  if (typeof syncTimer.unref === "function") {
    syncTimer.unref();
  }

  logger.info(
    `⏱️ Attendance Sync Worker started (interval: ${Math.round(intervalMs / 1000)}s).`,
  );
}

export async function stopAttendanceSyncWorker() {
  if (syncTimer) {
    clearInterval(syncTimer);
    syncTimer = null;
    logger.info("🛑 Attendance Sync Worker stopped.");
  }
}
