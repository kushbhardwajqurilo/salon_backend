import { asyncHandler } from "../../utils/errors.js";
import { sendResponse } from "../../utils/response.js";
import { couponService } from "../../services/coupons/coupon.service.js";

export const createCoupon = asyncHandler(async (req, res) => {
  const result = await couponService.createCoupon(
    req.body,
    req.organizationId,
    req.user?.id || req.user?._id
  );
  return sendResponse(res, 201, "Coupon created successfully", result);
});

export const listCoupons = asyncHandler(async (req, res) => {
  const result = await couponService.listCoupons(req.query, req.organizationId);
  return sendResponse(
    res,
    200,
    "Coupons retrieved successfully",
    {
      coupons: result.data || [],
      pagination: result.meta,
    },
    result.meta
  );
});

export const getCouponById = asyncHandler(async (req, res) => {
  const result = await couponService.getCouponById(req.params.id, req.organizationId);
  return sendResponse(res, 200, "Coupon retrieved successfully", result);
});

export const updateCoupon = asyncHandler(async (req, res) => {
  const result = await couponService.updateCoupon(
    req.params.id,
    req.body,
    req.organizationId,
    req.user?.id || req.user?._id
  );
  return sendResponse(res, 200, "Coupon updated successfully", result);
});

export const updateCouponStatus = asyncHandler(async (req, res) => {
  const result = await couponService.updateCouponStatus(
    req.params.id,
    req.body.status,
    req.organizationId,
    req.user?.id || req.user?._id
  );
  return sendResponse(res, 200, "Coupon status updated successfully", result);
});

export const deleteCoupon = asyncHandler(async (req, res) => {
  const result = await couponService.deleteCoupon(
    req.params.id,
    req.organizationId,
    req.user?.id || req.user?._id
  );
  return sendResponse(res, 200, "Coupon deleted successfully", result);
});
