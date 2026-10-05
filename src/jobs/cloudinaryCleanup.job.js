import { cloudinary } from "../services/cloudinary.service.js";

/**
 * Sweeper job: Finds and deletes orphaned assets tagged 'temp_upload'
 * created more than 24 hours ago.
 * Run daily (e.g. 03:00 UTC) via scheduled runner or cron.
 */
export async function cleanupAbandonedUploads() {
  try {
    console.info("[Cron] Initiating Cloudinary orphaned asset sweeper (tags:temp_upload)...");

    const searchResult = await cloudinary.search
      .expression("tags:temp_upload AND created_at<24h")
      .max_results(100)
      .execute();

    const resources = searchResult?.resources || [];

    if (resources.length === 0) {
      console.info("[Cron] Zero orphaned assets detected.");
      return;
    }

    const publicIdsToDelete = resources.map((res) => res.public_id);
    console.info(`[Cron] Purging ${publicIdsToDelete.length} orphaned asset(s)...`);

    if (publicIdsToDelete.length > 0) {
      if (cloudinary.api && typeof cloudinary.api.delete_resources === "function") {
        await cloudinary.api.delete_resources(publicIdsToDelete, {
          invalidate: true,
          resource_type: "image",
        });
      } else {
        // Fallback to per-asset uploader destroy if admin api client is mocked or unavailable
        for (const pid of publicIdsToDelete) {
          await cloudinary.uploader.destroy(pid, {
            invalidate: true,
            resource_type: "image",
          });
        }
      }
      console.info(`[Cron] Successfully purged orphaned assets: ${publicIdsToDelete.join(", ")}`);
    }
  } catch (error) {
    console.error("[Cron Error] Abandoned asset sweeper failed:", error.message);
  }
}
