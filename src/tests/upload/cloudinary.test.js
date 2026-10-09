import { describe, expect, it, jest, beforeEach } from "@jest/globals";

// Mock Cloudinary config/SDK
const mockDestroy = jest.fn();
const mockReplaceTag = jest.fn();
const mockRemoveTag = jest.fn();
const mockApiSignRequest = jest.fn();
const mockSearchExecute = jest.fn();
const mockDeleteResources = jest.fn();

const mockCloudinary = {
  uploader: {
    destroy: mockDestroy,
    replace_tag: mockReplaceTag,
    remove_tag: mockRemoveTag,
  },
  api: {
    delete_resources: mockDeleteResources,
  },
  utils: {
    api_sign_request: mockApiSignRequest,
  },
  search: {
    expression: jest.fn().mockReturnThis(),
    max_results: jest.fn().mockReturnThis(),
    execute: mockSearchExecute,
  },
};

jest.unstable_mockModule("../../config/cloudinary.config.js", () => ({
  default: mockCloudinary,
  cloudinary: mockCloudinary,
}));

// Import modules dynamically after mock setup
const { extractPublicIdFromUrl, deleteFromCloudinary, commitAsset, confirmAsset } =
  await import("../../services/cloudinary.service.js");
const { generateUploadSignature, cleanupUpload } =
  await import("../../controllers/upload.controller.js");
const { cleanupAbandonedUploads } =
  await import("../../jobs/cloudinaryCleanup.job.js");

describe("Cloudinary Presigned Upload & Zero-Orphan Media Lifecycle", () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  describe("1. extractPublicIdFromUrl", () => {
    it("should return null for empty or non-string inputs", () => {
      expect(extractPublicIdFromUrl(null)).toBeNull();
      expect(extractPublicIdFromUrl("")).toBeNull();
      expect(extractPublicIdFromUrl(123)).toBeNull();
    });

    it("should extract public_id with versioned URL and nested folders", () => {
      const url =
        "https://res.cloudinary.com/demo/image/upload/v1720000000/employees/avatars/emp_abc.webp";
      expect(extractPublicIdFromUrl(url)).toBe("employees/avatars/emp_abc");
    });

    it("should extract public_id without version segment", () => {
      const url =
        "https://res.cloudinary.com/demo/image/upload/employees/avatars/avatar_123_xyz.png";
      expect(extractPublicIdFromUrl(url)).toBe("employees/avatars/avatar_123_xyz");
    });
  });

  describe("2. deleteFromCloudinary & confirmAsset", () => {
    it("should call cloudinary.uploader.destroy with publicId and invalidate cache", async () => {
      mockDestroy.mockResolvedValueOnce({ result: "ok" });
      const res = await deleteFromCloudinary("employees/avatars/emp_1");

      expect(mockDestroy).toHaveBeenCalledWith("employees/avatars/emp_1", {
        invalidate: true,
        resource_type: "image",
      });
      expect(res).toEqual({ result: "ok" });
    });

    it("should extract public_id if full URL passed to deleteFromCloudinary", async () => {
      mockDestroy.mockResolvedValueOnce({ result: "ok" });
      const url =
        "https://res.cloudinary.com/demo/image/upload/v1720000000/employees/avatars/emp_1.jpg";
      await deleteFromCloudinary(url);

      expect(mockDestroy).toHaveBeenCalledWith("employees/avatars/emp_1", {
        invalidate: true,
        resource_type: "image",
      });
    });

    it("should safely handle errors without throwing in deleteFromCloudinary", async () => {
      mockDestroy.mockRejectedValueOnce(new Error("Network timeout"));
      const res = await deleteFromCloudinary("employees/avatars/emp_err");
      expect(res).toBeNull();
    });

    it("should remove tag temp_upload in commitAsset", async () => {
      mockRemoveTag.mockResolvedValueOnce({ result: "ok" });
      await commitAsset("employees/avatars/emp_2");

      expect(mockRemoveTag).toHaveBeenCalledWith("temp_upload", [
        "employees/avatars/emp_2",
      ]);
    });
  });

  describe("3. Upload Controller", () => {
    it("generateUploadSignature: should reject non-whitelisted folders", async () => {
      const req = { body: { folder: "malicious/folder" } };
      const res = {
        status: jest.fn().mockReturnThis(),
        json: jest.fn(),
      };

      await generateUploadSignature(req, res);

      expect(res.status).toHaveBeenCalledWith(400);
      expect(res.json).toHaveBeenCalledWith(
        expect.objectContaining({
          success: false,
          message: "Forbidden destination folder: malicious/folder",
        })
      );
    });

    it("generateUploadSignature: should generate signature and upload parameters for allowed folder", async () => {
      process.env.CLOUDINARY_API_SECRET = "mock_secret";
      process.env.CLOUDINARY_API_KEY = "mock_key";
      process.env.CLOUDINARY_CLOUD_NAME = "mock_cloud";
      mockApiSignRequest.mockReturnValueOnce("test_hmac_signature");
      const req = { body: { folder: "employees/avatars" } };
      const res = {
        status: jest.fn().mockReturnThis(),
        json: jest.fn(),
      };

      await generateUploadSignature(req, res);

      expect(res.status).toHaveBeenCalledWith(200);
      expect(res.json).toHaveBeenCalledWith({
        success: true,
        data: expect.objectContaining({
          signature: "test_hmac_signature",
          folder: "employees/avatars",
          tags: "temp_upload",
          publicId: expect.stringMatching(/^employees\/avatars\/\d+_[a-f0-9]+$/),
          uploadUrl: expect.stringContaining("/image/upload"),
        }),
      });
      expect(mockApiSignRequest).toHaveBeenCalledWith(
        expect.objectContaining({
          folder: "employees/avatars",
          tags: "temp_upload",
        }),
        expect.anything()
      );
    });

    it("cleanupUpload: should reject when publicId or url is missing", async () => {
      const req = { body: {} };
      const res = {
        status: jest.fn().mockReturnThis(),
        json: jest.fn(),
      };

      await cleanupUpload(req, res);

      expect(res.status).toHaveBeenCalledWith(400);
      expect(res.json).toHaveBeenCalledWith(
        expect.objectContaining({
          success: false,
          message: "A publicId or url is required for asset cleanup.",
        })
      );
    });

    it("cleanupUpload: should purge target asset via deleteFromCloudinary", async () => {
      mockDestroy.mockResolvedValueOnce({ result: "ok" });
      const req = {
        body: {
          url: "https://res.cloudinary.com/demo/image/upload/v123/employees/avatars/avatar_temp.jpg",
        },
      };
      const res = {
        status: jest.fn().mockReturnThis(),
        json: jest.fn(),
      };

      await cleanupUpload(req, res);

      expect(mockDestroy).toHaveBeenCalledWith("employees/avatars/avatar_temp", {
        invalidate: true,
        resource_type: "image",
      });
      expect(res.status).toHaveBeenCalledWith(200);
      expect(res.json).toHaveBeenCalledWith(
        expect.objectContaining({
          success: true,
          message: "Media asset purged successfully.",
        })
      );
    });
  });

  describe("4. Abandoned File Sweeper Cron Job", () => {
    it("should query for unconfirmed temp_upload older than 24h and purge them via delete_resources", async () => {
      mockSearchExecute.mockResolvedValueOnce({
        resources: [
          { public_id: "employees/avatars/avatar_old_1" },
          { public_id: "employees/avatars/avatar_old_2" },
        ],
      });
      mockDeleteResources.mockResolvedValueOnce({ deleted: {} });

      await cleanupAbandonedUploads();

      expect(mockSearchExecute).toHaveBeenCalled();
      expect(mockDeleteResources).toHaveBeenCalledWith(
        ["employees/avatars/avatar_old_1", "employees/avatars/avatar_old_2"],
        {
          invalidate: true,
          resource_type: "image",
        }
      );
    });

    it("should gracefully handle zero orphaned assets", async () => {
      mockSearchExecute.mockResolvedValueOnce({ resources: [] });

      await cleanupAbandonedUploads();

      expect(mockSearchExecute).toHaveBeenCalled();
      expect(mockDeleteResources).not.toHaveBeenCalled();
      expect(mockDestroy).not.toHaveBeenCalled();
    });
  });
});
