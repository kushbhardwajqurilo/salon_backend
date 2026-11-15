import { Router } from "express";
import { authenticate } from "../../middleware/auth.js";
import { requireOrganizationScope } from "../../middleware/branchScope.js";
import { requirePermission } from "../../middleware/rbac.js";
import { validate } from "../../middleware/validate.js";
import * as couponController from "../../controllers/coupons/coupon.controller.js";
import * as couponValidation from "../../validation/coupons/coupon.validation.js";

const router = Router();

// All coupon endpoints require authentication and organization scope
router.use(authenticate);
router.use(requireOrganizationScope);

// 1. Create Coupon
router.post(
  "/",
  requirePermission("coupons.configure"),
  validate(couponValidation.createCouponSchema),
  couponController.createCoupon
);

// 2. List Coupons
router.get(
  "/",
  requirePermission("coupons.view"),
  validate(couponValidation.queryCouponsSchema),
  couponController.listCoupons
);

// 3. Get Coupon by ID
router.get(
  "/:id",
  requirePermission("coupons.view"),
  validate(couponValidation.getCouponParamsSchema),
  couponController.getCouponById
);

// 4. Update Coupon
router.patch(
  "/:id",
  requirePermission("coupons.configure"),
  validate(couponValidation.updateCouponSchema),
  couponController.updateCoupon
);

// 5. Update Coupon Status
router.patch(
  "/:id/status",
  requirePermission("coupons.configure"),
  validate(couponValidation.updateCouponStatusSchema),
  couponController.updateCouponStatus
);

// 6. Delete Coupon (Soft Delete)
router.delete(
  "/:id",
  requirePermission("coupons.configure"),
  validate(couponValidation.getCouponParamsSchema),
  couponController.deleteCoupon
);

export default router;

