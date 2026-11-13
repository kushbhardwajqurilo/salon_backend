import { inventoryService } from "../../services/inventory/inventory.service.js";
import { sendResponse } from "../../utils/response.js";

// Helper to extract idempotency key from header or body
const getIdempotencyKey = (req) => {
  return (
    req.headers["idempotency-key"] ||
    req.headers["x-idempotency-key"] ||
    req.body?.idempotencyKey ||
    null
  );
};

export const createProduct = async (req, res, next) => {
  try {
    const product = await inventoryService.createProduct(
      req.body,
      req.user.organizationId,
      req.user.id
    );
    return sendResponse(res, 201, "Product created successfully", product);
  } catch (error) {
    next(error);
  }
};

export const updateProduct = async (req, res, next) => {
  try {
    const product = await inventoryService.updateProduct(
      req.params.id,
      req.body,
      req.user.organizationId,
      req.user.id
    );
    return sendResponse(res, 200, "Product updated successfully", product);
  } catch (error) {
    next(error);
  }
};

export const getProduct = async (req, res, next) => {
  try {
    const product = await inventoryService.getProductById(
      req.params.id,
      req.user.organizationId
    );
    return sendResponse(res, 200, "Product retrieved successfully", product);
  } catch (error) {
    next(error);
  }
};

export const listProducts = async (req, res, next) => {
  try {
    const { page, limit, category, usageType, status, search } = req.query;
    const result = await inventoryService.listProducts(
      { organizationId: req.user.organizationId, category, usageType, status, search },
      { page: parseInt(page) || 1, limit: parseInt(limit) || 20 }
    );
    return sendResponse(res, 200, "Products retrieved successfully", result.products, result.pagination);
  } catch (error) {
    next(error);
  }
};

export const listBranchStock = async (req, res, next) => {
  try {
    const branchId = req.query.branchId || req.branchId;
    const { page, limit, lowStock } = req.query;
    const result = await inventoryService.listBranchStock(
      req.user.organizationId,
      branchId,
      { page: parseInt(page) || 1, limit: parseInt(limit) || 20, lowStock }
    );
    return sendResponse(res, 200, "Branch stock retrieved successfully", result.balances, result.pagination);
  } catch (error) {
    next(error);
  }
};

export const recordManualConsumption = async (req, res, next) => {
  try {
    const idempotencyKey = getIdempotencyKey(req);
    const payload = {
      ...req.body,
      branchId: req.body.branchId || req.branchId,
      idempotencyKey
    };
    const result = await inventoryService.recordManualConsumption(
      payload,
      req.user.organizationId,
      req.user.id
    );
    return sendResponse(res, 200, "Salon consumption recorded successfully", result);
  } catch (error) {
    next(error);
  }
};

export const recordAdjustment = async (req, res, next) => {
  try {
    const idempotencyKey = getIdempotencyKey(req);
    const payload = {
      ...req.body,
      branchId: req.body.branchId || req.branchId,
      idempotencyKey
    };
    const result = await inventoryService.recordAdjustment(
      payload,
      req.user.organizationId,
      req.user.id
    );
    return sendResponse(res, 200, "Stock adjustment recorded successfully", result);
  } catch (error) {
    next(error);
  }
};

export const recordTransfer = async (req, res, next) => {
  try {
    const idempotencyKey = getIdempotencyKey(req);
    const payload = {
      ...req.body,
      idempotencyKey
    };
    const result = await inventoryService.recordTransfer(
      payload,
      req.user.organizationId,
      req.user.id
    );
    return sendResponse(res, 200, "Stock transfer recorded successfully", result);
  } catch (error) {
    next(error);
  }
};

export const listStockMovements = async (req, res, next) => {
  try {
    const { branchId, productId, movementType, startDate, endDate, page, limit } = req.query;
    const result = await inventoryService.listStockMovements(
      {
        organizationId: req.user.organizationId,
        branchId: branchId || (req.branchId ? req.branchId : undefined),
        productId,
        movementType,
        startDate,
        endDate
      },
      { page: parseInt(page) || 1, limit: parseInt(limit) || 20 }
    );
    return sendResponse(res, 200, "Stock movements retrieved successfully", result.movements, result.pagination);
  } catch (error) {
    next(error);
  }
};
