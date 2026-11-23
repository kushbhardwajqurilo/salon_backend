import { stocktakeService } from "../../services/inventory/stocktake.service.js";
import { sendResponse } from "../../utils/response.js";

const getIdempotencyKey = (req) => {
  return (
    req.headers["idempotency-key"] ||
    req.headers["x-idempotency-key"] ||
    req.body?.idempotencyKey ||
    null
  );
};

export const createStocktake = async (req, res, next) => {
  try {
    const branchId = req.branchId || req.body.branchId;
    const { title, targetDomain, notes } = req.body;

    const stocktake = await stocktakeService.createStocktake({
      organizationId: req.user.organizationId,
      branchId,
      userId: req.user.id,
      title,
      targetDomain,
      notes,
    });

    return sendResponse(res, 201, "Stocktake session created successfully", stocktake);
  } catch (error) {
    next(error);
  }
};

export const listStocktakes = async (req, res, next) => {
  try {
    const branchId = req.branchId || req.query.branchId;
    const { status, targetDomain, page, limit } = req.query;

    const result = await stocktakeService.listStocktakes({
      organizationId: req.user.organizationId,
      branchId,
      status,
      targetDomain,
      page: parseInt(page) || 1,
      limit: parseInt(limit) || 20,
    });

    return sendResponse(
      res,
      200,
      "Stocktakes retrieved successfully",
      result.stocktakes,
      result.pagination
    );
  } catch (error) {
    next(error);
  }
};

export const getStocktakeById = async (req, res, next) => {
  try {
    const branchId = req.branchId || req.query.branchId;
    const { id } = req.params;

    const stocktake = await stocktakeService.getStocktakeById({
      stocktakeId: id,
      organizationId: req.user.organizationId,
      branchId,
    });

    return sendResponse(res, 200, "Stocktake details retrieved successfully", stocktake);
  } catch (error) {
    next(error);
  }
};

export const recordCounts = async (req, res, next) => {
  try {
    const branchId = req.branchId || req.body.branchId;
    const { id } = req.params;
    const { items } = req.body;

    const result = await stocktakeService.recordCounts({
      stocktakeId: id,
      organizationId: req.user.organizationId,
      branchId,
      userId: req.user.id,
      items,
    });

    return sendResponse(res, 200, "Physical counts recorded successfully", result);
  } catch (error) {
    next(error);
  }
};

export const getDiscrepancies = async (req, res, next) => {
  try {
    const branchId = req.branchId || req.query.branchId;
    const { id } = req.params;

    const discrepancies = await stocktakeService.getDiscrepancies({
      stocktakeId: id,
      organizationId: req.user.organizationId,
      branchId,
    });

    return sendResponse(res, 200, "Discrepancy preview calculated successfully", discrepancies);
  } catch (error) {
    next(error);
  }
};

export const postStocktake = async (req, res, next) => {
  try {
    const branchId = req.branchId || req.body.branchId;
    const { id } = req.params;
    const idempotencyKey = getIdempotencyKey(req);

    const result = await stocktakeService.postStocktake({
      stocktakeId: id,
      organizationId: req.user.organizationId,
      branchId,
      userId: req.user.id,
      idempotencyKey,
    });

    return sendResponse(res, 200, result.message || "Stocktake posted successfully", result);
  } catch (error) {
    next(error);
  }
};

export const cancelStocktake = async (req, res, next) => {
  try {
    const branchId = req.branchId || req.body.branchId;
    const { id } = req.params;
    const { reason } = req.body;

    const stocktake = await stocktakeService.cancelStocktake({
      stocktakeId: id,
      organizationId: req.user.organizationId,
      branchId,
      userId: req.user.id,
      reason,
    });

    return sendResponse(res, 200, "Stocktake cancelled successfully", stocktake);
  } catch (error) {
    next(error);
  }
};
