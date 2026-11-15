import mongoose from "mongoose";
import { Coupon } from "../../models/coupons/coupon.model.js";
import { Branch } from "../../models/branches/branch.model.js";
import { AppError } from "../../utils/errors.js";

export class CouponService {
  /**
   * Helper to validate that all provided branch IDs exist, are active, not deleted,
   * and belong to the authenticated organization.
   */
  async validateBranchesBelongToOrg(branchIds, organizationId) {
    if (!branchIds || branchIds.length === 0) return [];

    const uniqueBranchIds = Array.from(new Set(branchIds.map((b) => b.toString())));
    const objectIds = uniqueBranchIds.map((id) => new mongoose.Types.ObjectId(id));

    const validBranches = await Branch.find({
      _id: { $in: objectIds },
      organizationId,
      isActive: true,
    });

    if (validBranches.length !== uniqueBranchIds.length) {
      const foundIds = new Set(validBranches.map((b) => b._id.toString()));
      const missingIds = uniqueBranchIds.filter((id) => !foundIds.has(id));
      throw new AppError(
        `Invalid excludedBranchIds: Branches [${missingIds.join(", ")}] do not exist, are inactive, or belong to another organization`,
        400
      );
    }

    return uniqueBranchIds.map((id) => new mongoose.Types.ObjectId(id));
  }

  /**
   * 1. CREATE COUPON
   */
  async createCoupon(data, organizationId, userId) {
    if (!organizationId) {
      throw new AppError("Organization scope is required", 400);
    }

    const {
      code,
      description = "",
      discountType,
      discountValue,
      validFrom,
      validUntil,
      status = "active",
      totalUsageLimit = null,
      perCustomerLimit = null,
      excludedBranchIds = [],
    } = data;

    const normalizedCode = code.trim();
    const codeUpper = normalizedCode.toUpperCase();

    // Check duplicate code within organization (including soft-deleted coupons)
    const existing = await Coupon.findOne({
      organizationId,
      codeUpper,
    });

    if (existing) {
      throw new AppError(
        `A coupon with code '${normalizedCode}' already exists in this organization`,
        409
      );
    }

    // Validate excluded branches
    const validatedBranchIds = await this.validateBranchesBelongToOrg(
      excludedBranchIds,
      organizationId
    );

    try {
      const coupon = await Coupon.create({
        organizationId,
        code: normalizedCode,
        codeUpper,
        description,
        discountType,
        discountValue,
        validFrom,
        validUntil,
        status,
        totalUsageLimit: totalUsageLimit || null,
        usageCount: 0,
        perCustomerLimit: perCustomerLimit || null,
        excludedBranchIds: validatedBranchIds,
        createdBy: userId,
        updatedBy: null,
        isDeleted: false,
        deletedAt: null,
      });

      return coupon;
    } catch (err) {
      if (err.code === 11000) {
        throw new AppError(
          `A coupon with code '${normalizedCode}' already exists in this organization`,
          409
        );
      }
      throw err;
    }
  }

  /**
   * 2. LIST COUPONS
   */
  async listCoupons(query, organizationId) {
    if (!organizationId) {
      throw new AppError("Organization scope is required", 400);
    }

    const { page = 1, limit = 20, search, status = "all" } = query;
    const filter = {
      organizationId,
      isDeleted: false,
    };

    if (status && status !== "all") {
      filter.status = status;
    }

    if (search) {
      const searchRegex = new RegExp(search.trim(), "i");
      filter.$or = [{ code: searchRegex }, { description: searchRegex }];
    }

    const skip = (page - 1) * limit;

    const [coupons, total] = await Promise.all([
      Coupon.find(filter)
        .sort({ createdAt: -1 })
        .skip(skip)
        .limit(limit)
        .populate("excludedBranchIds", "name"),
      Coupon.countDocuments(filter),
    ]);

    const totalPages = Math.ceil(total / limit) || 1;

    return {
      data: coupons,
      meta: {
        total,
        page,
        limit,
        totalPages,
      },
    };
  }

  /**
   * 3. GET COUPON BY ID
   */
  async getCouponById(id, organizationId) {
    if (!organizationId) {
      throw new AppError("Organization scope is required", 400);
    }

    const coupon = await Coupon.findOne({
      _id: id,
      organizationId,
      isDeleted: false,
    }).populate("excludedBranchIds", "name");

    if (!coupon) {
      throw new AppError("Coupon not found", 404);
    }

    return coupon;
  }

  /**
   * 4. UPDATE COUPON
   */
  async updateCoupon(id, data, organizationId, userId) {
    if (!organizationId) {
      throw new AppError("Organization scope is required", 400);
    }

    const coupon = await Coupon.findOne({
      _id: id,
      organizationId,
      isDeleted: false,
    });

    if (!coupon) {
      throw new AppError("Coupon not found", 404);
    }

    // Check discount type & value mutability when coupon has already been used
    if (
      (data.discountType !== undefined && data.discountType !== coupon.discountType) ||
      (data.discountValue !== undefined && data.discountValue !== coupon.discountValue)
    ) {
      if (coupon.usageCount > 0) {
        throw new AppError(
          "Cannot modify discountType or discountValue on a coupon that has already been used",
          400
        );
      }
    }

    // Check totalUsageLimit cannot be lower than existing usageCount
    if (data.totalUsageLimit !== undefined && data.totalUsageLimit !== null) {
      if (data.totalUsageLimit < coupon.usageCount) {
        throw new AppError(
          `totalUsageLimit (${data.totalUsageLimit}) cannot be less than current usageCount (${coupon.usageCount})`,
          400
        );
      }
    }

    // Validate date sequence if one or both dates are updated
    const nextValidFrom = data.validFrom ? new Date(data.validFrom) : coupon.validFrom;
    const nextValidUntil = data.validUntil ? new Date(data.validUntil) : coupon.validUntil;
    if (nextValidUntil.getTime() <= nextValidFrom.getTime()) {
      throw new AppError("validUntil must be strictly later than validFrom", 400);
    }

    // Validate excluded branches if updated
    if (data.excludedBranchIds !== undefined) {
      coupon.excludedBranchIds = await this.validateBranchesBelongToOrg(
        data.excludedBranchIds,
        organizationId
      );
    }

    if (data.description !== undefined) coupon.description = data.description;
    if (data.discountType !== undefined) coupon.discountType = data.discountType;
    if (data.discountValue !== undefined) coupon.discountValue = data.discountValue;
    if (data.validFrom !== undefined) coupon.validFrom = data.validFrom;
    if (data.validUntil !== undefined) coupon.validUntil = data.validUntil;
    if (data.status !== undefined) coupon.status = data.status;
    if (data.totalUsageLimit !== undefined) coupon.totalUsageLimit = data.totalUsageLimit;
    if (data.perCustomerLimit !== undefined) coupon.perCustomerLimit = data.perCustomerLimit;

    coupon.updatedBy = userId;
    await coupon.save();

    return coupon;
  }

  /**
   * 5. UPDATE COUPON STATUS (ACTIVATE / DEACTIVATE)
   */
  async updateCouponStatus(id, status, organizationId, userId) {
    if (!organizationId) {
      throw new AppError("Organization scope is required", 400);
    }

    const coupon = await Coupon.findOne({
      _id: id,
      organizationId,
      isDeleted: false,
    });

    if (!coupon) {
      throw new AppError("Coupon not found", 404);
    }

    coupon.status = status;
    coupon.updatedBy = userId;
    await coupon.save();

    return coupon;
  }

  /**
   * 6. SOFT DELETE COUPON
   */
  async deleteCoupon(id, organizationId, userId) {
    if (!organizationId) {
      throw new AppError("Organization scope is required", 400);
    }

    const coupon = await Coupon.findOne({
      _id: id,
      organizationId,
      isDeleted: false,
    });

    if (!coupon) {
      throw new AppError("Coupon not found", 404);
    }

    coupon.isDeleted = true;
    coupon.deletedAt = new Date();
    coupon.updatedBy = userId;
    await coupon.save();

    return { id: coupon._id.toString(), message: "Coupon deleted successfully" };
  }
}

export const couponService = new CouponService();

