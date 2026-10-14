import { asyncHandler } from "../../utils/errors.js";
import { loyaltyService } from "../../services/loyalty/loyalty.service.js";

export class LoyaltyController {
  /**
   * 1. GET /api/v1/loyalty/program
   * Permission: loyalty.view
   */
  getProgram = asyncHandler(async (req, res) => {
    const { organizationId } = req.user;
    const config = await loyaltyService.getEffectiveConfig(organizationId);

    return res.status(200).json({
      success: true,
      message: "Loyalty program configuration retrieved successfully",
      data: {
        ...config,
        program: config,
      },
    });
  });

  /**
   * 2. PUT /api/v1/loyalty/program
   * Permission: loyalty.configure
   */
  updateProgram = asyncHandler(async (req, res) => {
    const { organizationId, id: userId } = req.user;
    const payload = req.body;

    const updatedConfig = await loyaltyService.updateConfig(
      organizationId,
      payload,
      userId
    );

    const configObj = updatedConfig.toObject ? updatedConfig.toObject() : updatedConfig;

    return res.status(200).json({
      success: true,
      message: "Loyalty program configuration updated successfully",
      data: {
        ...configObj,
        program: configObj,
      },
    });
  });

  /**
   * 3. GET /api/v1/loyalty/customers/:customerId/ledger
   * Permission: loyalty.view
   */
  getCustomerLedger = asyncHandler(async (req, res) => {
    const { organizationId } = req.user;
    const { customerId } = req.params;
    const {
      page = 1,
      limit = 20,
      type,
      startDate,
      endDate,
      sortBy = "createdAt",
      sortOrder = "desc",
    } = req.query;

    const result = await loyaltyService.listCustomerLedger(
      customerId,
      organizationId,
      { type, startDate, endDate, sortBy, sortOrder },
      { page, limit }
    );

    return res.status(200).json({
      success: true,
      message: "Customer loyalty ledger retrieved successfully",
      data: result.items,
      pagination: result.pagination,
    });
  });

  /**
   * 4. POST /api/v1/loyalty/customers/:customerId/adjust
   * Permission: loyalty.adjust
   */
  adjustCustomerPoints = asyncHandler(async (req, res) => {
    const { organizationId, id: userId } = req.user;
    const { customerId } = req.params;
    const { points, operation, reason, idempotencyKey } = req.body;
    const branchId =
      req.body.branchId ||
      req.headers["x-branch-id"] ||
      req.headers["X-Branch-Id"] ||
      req.branchId;

    const result = await loyaltyService.adjustCustomerPoints({
      customerId,
      organizationId,
      branchId,
      points,
      operation,
      reason,
      idempotencyKey,
      actorId: userId,
    });

    const status = result.isIdempotentReplay ? 200 : 201;

    return res.status(status).json({
      success: true,
      message: `Customer points successfully ${operation === "CREDIT" ? "credited" : "debited"}`,
      data: {
        transaction: result.transaction,
        customer: result.customer,
        isIdempotentReplay: result.isIdempotentReplay,
      },
    });
  });

  /**
   * 5. GET /api/v1/loyalty/preview-redemption
   * Permission: loyalty.view
   */
  previewRedemption = asyncHandler(async (req, res) => {
    const { organizationId } = req.user;
    const { customerId, billAmount, pointsRequested, invoiceId } = req.query;

    const preview = await loyaltyService.previewRedemption(
      customerId,
      billAmount !== undefined ? Number(billAmount) : null,
      pointsRequested !== undefined ? Number(pointsRequested) : null,
      organizationId,
      null,
      invoiceId || null
    );

    return res.status(200).json({
      success: true,
      message: "Loyalty redemption preview calculated successfully",
      data: preview,
    });
  });
}

export const loyaltyController = new LoyaltyController();
