import cloudinary from "../config/cloudinary.config.js";

/**
 * Extracts public_id with its folder path from any Cloudinary URL.
 * Supports versioned URLs (v123456789) and multiple folder levels.
 * Example:
 *   "https://res.cloudinary.com/demo/image/upload/v1720000000/employees/avatars/emp_abc.webp"
 *   => "employees/avatars/emp_abc"
 */
export function extractPublicIdFromUrl(url) {
  if (!url || typeof url !== "string") return null;
  const match = url.match(/\/upload\/(?:v\d+\/)?([^\.]+)/);
  return match ? match[1] : null;
}

/**
 * Removes an asset from Cloudinary and invalidates edge CDN caches.
 * Non-blocking: logs warnings instead of bubbling errors up to parent DB transactions.
 */
export async function deleteFromCloudinary(publicIdOrUrl) {
  try {
    if (!publicIdOrUrl) return null;
    const publicId = publicIdOrUrl.startsWith("http")
      ? extractPublicIdFromUrl(publicIdOrUrl)
      : publicIdOrUrl;

    if (!publicId) return null;

    const result = await cloudinary.uploader.destroy(publicId, {
      invalidate: true,
      resource_type: "image",
    });

    console.info(`[Cloudinary Lifecycle] Asset purged: ${publicId}`);
    return result;
  } catch (error) {
    console.error(
      `[Cloudinary Lifecycle Error] Failed to purge asset ${publicIdOrUrl}:`,
      error.message
    );
    return null;
  }
}

/**
 * Commits an asset by removing the 'temp_upload' tag.
 */
export async function commitAsset(publicIdOrUrl) {
  try {
    if (!publicIdOrUrl) return;
    const publicId = publicIdOrUrl.startsWith("http")
      ? extractPublicIdFromUrl(publicIdOrUrl)
      : publicIdOrUrl;

    if (!publicId) return;

    await cloudinary.uploader.remove_tag("temp_upload", [publicId]);
    console.info(`[Cloudinary Lifecycle] Asset committed (temp_upload removed): ${publicId}`);
  } catch (error) {
    console.warn(
      `[Cloudinary Lifecycle] Failed to commit asset (remove temp_upload) for ${publicIdOrUrl}:`,
      error.message
    );
  }
}

// Backward-compatible alias
export const confirmAsset = commitAsset;

export { cloudinary };
