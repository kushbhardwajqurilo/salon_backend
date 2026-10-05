import crypto from "crypto";
import { cloudinary, deleteFromCloudinary } from "../services/cloudinary.service.js";
import { env } from "../config/env.js";

const ALLOWED_FOLDERS = {
  "employees/avatars": {
    tags: ["temp_upload"],
  },
};

/**
 * POST /api/upload/sign
 */
export const generateUploadSignature = async (req, res) => {
  try {
    const { folder = "employees/avatars" } = req.body;

    if (!ALLOWED_FOLDERS[folder]) {
      return res.status(400).json({
        success: false,
        message: `Forbidden destination folder: ${folder}`,
      });
    }

    const folderConfig = ALLOWED_FOLDERS[folder];
    const timestamp = Math.round(new Date().getTime() / 1000);
    const uniqueSuffix = crypto.randomBytes(4).toString("hex");
    const publicId = `${folder}/${Date.now()}_${uniqueSuffix}`;

    // Cloudinary signing contract: parameters must be signed in alphabetical order
    const paramsToSign = {
      folder,
      public_id: publicId,
      tags: folderConfig.tags.join(","),
      timestamp,
    };

    const apiSecret = env.CLOUDINARY_API_SECRET || process.env.CLOUDINARY_API_SECRET;
    const apiKey = env.CLOUDINARY_API_KEY || process.env.CLOUDINARY_API_KEY;
    const cloudName = env.CLOUDINARY_CLOUD_NAME || process.env.CLOUDINARY_CLOUD_NAME;

    const signature = cloudinary.utils.api_sign_request(
      paramsToSign,
      apiSecret
    );

    return res.status(200).json({
      success: true,
      data: {
        signature,
        timestamp,
        apiKey,
        cloudName,
        folder,
        publicId,
        tags: folderConfig.tags.join(","),
        uploadUrl: `https://api.cloudinary.com/v1_1/${cloudName}/image/upload`,
      },
    });
  } catch (error) {
    console.error("[Upload Controller Error] Failed to generate signature:", error);
    return res.status(500).json({
      success: false,
      message: "Internal error generating media upload credentials.",
    });
  }
};

/**
 * POST /api/upload/cleanup
 */
export const cleanupUpload = async (req, res) => {
  try {
    const { publicId, url } = req.body;
    const target = publicId || url;

    if (!target) {
      return res.status(400).json({
        success: false,
        message: "A publicId or url is required for asset cleanup.",
      });
    }

    await deleteFromCloudinary(target);

    return res.status(200).json({
      success: true,
      message: "Media asset purged successfully.",
    });
  } catch (error) {
    console.error("[Upload Controller Error] Failed to run asset cleanup:", error);
    return res.status(500).json({
      success: false,
      message: "Internal error purging asset.",
    });
  }
};
