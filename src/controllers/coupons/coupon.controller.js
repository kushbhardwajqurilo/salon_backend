import { asyncHandler } from "../../utils/errors.js";
import { sendResponse } from "../../utils/response.js";
import { couponService } from "../../services/coupons/coupon.service.js";
import { AuditLogService, extractAuditContext } from "../../services/audit/auditLog.service.js";
import { AUDIT_ACTIONS } from "../../models/audit/auditLog.model.js";

const auditLogService = new AuditLogService();

export const createCoupon = asyncHandler(async (req, res) => {
  const actorId = req.user?.id || req.user?._id;
  const result = await couponService.createCoupon(
    req.body,
    req.organizationId,
    actorId
  );
  await auditLogService.createAuditLog(
    {
      action: AUDIT_ACTIONS.COUPON_CREATED,
      entityType: "Coupon",
      entityId: result._id || result.id,
      description: `Coupon '${result.code || req.body?.code}' created`,
      ...extractAuditContext(req),
      metadata: { code: result.code || req.body?.code },
    },
    req.organizationId,
    actorId
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
  const actorId = req.user?.id || req.user?._id;
  const result = await couponService.updateCoupon(
    req.params.id,
    req.body,
    req.organizationId,
    actorId
  );
  await auditLogService.createAuditLog(
    {
      action: AUDIT_ACTIONS.COUPON_UPDATED,
      entityType: "Coupon",
      entityId: req.params.id,
      description: `Coupon updated`,
      ...extractAuditContext(req),
      metadata: { updatedFields: Object.keys(req.body || {}) },
    },
    req.organizationId,
    actorId
  );
  return sendResponse(res, 200, "Coupon updated successfully", result);
});

export const updateCouponStatus = asyncHandler(async (req, res) => {
  const actorId = req.user?.id || req.user?._id;
  const result = await couponService.updateCouponStatus(
    req.params.id,
    req.body.status,
    req.organizationId,
    actorId
  );
  await auditLogService.createAuditLog(
    {
      action: req.body.status === "active" ? AUDIT_ACTIONS.COUPON_ACTIVATED : AUDIT_ACTIONS.COUPON_DEACTIVATED,
      entityType: "Coupon",
      entityId: req.params.id,
      description: `Coupon status updated to '${req.body.status}'`,
      ...extractAuditContext(req),
      metadata: { after: { status: req.body.status } },
    },
    req.organizationId,
    actorId
  );
  return sendResponse(res, 200, "Coupon status updated successfully", result);
});

export const deleteCoupon = asyncHandler(async (req, res) => {
  const actorId = req.user?.id || req.user?._id;
  const result = await couponService.deleteCoupon(
    req.params.id,
    req.organizationId,
    actorId
  );
  await auditLogService.createAuditLog(
    {
      action: AUDIT_ACTIONS.COUPON_DELETED,
      entityType: "Coupon",
      entityId: req.params.id,
      description: `Coupon deleted`,
      ...extractAuditContext(req),
    },
    req.organizationId,
    actorId
  );
  return sendResponse(res, 200, "Coupon deleted successfully", result);
});
