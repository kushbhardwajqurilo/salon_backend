import { procurementService } from "../../services/procurement/procurement.service.js";
import { sendResponse } from "../../utils/response.js";

const getIdempotencyKey = (req) => {
  return (
    req.headers["idempotency-key"] ||
    req.headers["x-idempotency-key"] ||
    req.body?.idempotencyKey ||
    null
  );
};

// ---------------------------------------------------------
// SUPPLIERS
// ---------------------------------------------------------
export const createSupplier = async (req, res, next) => {
  try {
    const supplier = await procurementService.createSupplier(
      req.body,
      req.user.organizationId,
      req.user.id
    );
    return sendResponse(res, 201, "Supplier created successfully", supplier);
  } catch (error) {
    next(error);
  }
};

export const updateSupplier = async (req, res, next) => {
  try {
    const supplier = await procurementService.updateSupplier(
      req.params.id,
      req.body,
      req.user.organizationId,
      req.user.id
    );
    return sendResponse(res, 200, "Supplier updated successfully", supplier);
  } catch (error) {
    next(error);
  }
};

export const getSupplier = async (req, res, next) => {
  try {
    const supplier = await procurementService.getSupplierById(
      req.params.id,
      req.user.organizationId
    );
    return sendResponse(res, 200, "Supplier retrieved successfully", supplier);
  } catch (error) {
    next(error);
  }
};

export const listSuppliers = async (req, res, next) => {
  try {
    const { page, limit, status, search } = req.query;
    const result = await procurementService.listSuppliers(
      { organizationId: req.user.organizationId, status, search },
      { page: parseInt(page) || 1, limit: parseInt(limit) || 20 }
    );
    return sendResponse(
      res,
      200,
      "Suppliers retrieved successfully",
      result.suppliers,
      result.pagination
    );
  } catch (error) {
    next(error);
  }
};

// ---------------------------------------------------------
// PURCHASE ORDERS
// ---------------------------------------------------------
export const createPurchaseOrder = async (req, res, next) => {
  try {
    const branchId = req.body.branchId || req.branchId;
    const po = await procurementService.createPurchaseOrder(
      req.body,
      req.user.organizationId,
      branchId,
      req.user.id
    );
    return sendResponse(res, 201, "Purchase order created successfully", po);
  } catch (error) {
    next(error);
  }
};

export const updatePurchaseOrderStatus = async (req, res, next) => {
  try {
    const po = await procurementService.updatePurchaseOrderStatus(
      req.params.id,
      req.body,
      req.user.organizationId,
      req.user.id
    );
    return sendResponse(res, 200, "Purchase order status updated successfully", po);
  } catch (error) {
    next(error);
  }
};

export const getPurchaseOrder = async (req, res, next) => {
  try {
    const po = await procurementService.getPurchaseOrderById(
      req.params.id,
      req.user.organizationId
    );
    return sendResponse(res, 200, "Purchase order retrieved successfully", po);
  } catch (error) {
    next(error);
  }
};

export const listPurchaseOrders = async (req, res, next) => {
  try {
    const branchId = req.query.branchId || req.branchId;
    const { page, limit, supplierId, status, search } = req.query;
    const result = await procurementService.listPurchaseOrders(
      { organizationId: req.user.organizationId, branchId, supplierId, status, search },
      { page: parseInt(page) || 1, limit: parseInt(limit) || 20 }
    );
    return sendResponse(
      res,
      200,
      "Purchase orders retrieved successfully",
      result.orders,
      result.pagination
    );
  } catch (error) {
    next(error);
  }
};

// ---------------------------------------------------------
// GOODS RECEIVING
// ---------------------------------------------------------
export const receiveGoods = async (req, res, next) => {
  try {
    const idempotencyKey = getIdempotencyKey(req);
    const payload = {
      ...req.body,
      idempotencyKey,
    };
    const result = await procurementService.receiveGoods(
      req.params.id,
      payload,
      req.user.organizationId,
      req.user.id
    );
    return sendResponse(res, 200, "Goods received successfully", result);
  } catch (error) {
    next(error);
  }
};

export const listGoodsReceipts = async (req, res, next) => {
  try {
    const branchId = req.query.branchId || req.branchId;
    const { page, limit, purchaseOrderId, supplierId } = req.query;
    const result = await procurementService.listGoodsReceipts(
      { organizationId: req.user.organizationId, branchId, purchaseOrderId, supplierId },
      { page: parseInt(page) || 1, limit: parseInt(limit) || 20 }
    );
    return sendResponse(
      res,
      200,
      "Goods receipts retrieved successfully",
      result.receipts,
      result.pagination
    );
  } catch (error) {
    next(error);
  }
};

// ---------------------------------------------------------
// SUPPLIER INVOICES
// ---------------------------------------------------------
export const createSupplierInvoice = async (req, res, next) => {
  try {
    const branchId = req.body.branchId || req.branchId;
    const invoice = await procurementService.createSupplierInvoice(
      req.body,
      req.user.organizationId,
      branchId,
      req.user.id
    );
    return sendResponse(res, 201, "Supplier invoice created successfully", invoice);
  } catch (error) {
    next(error);
  }
};

export const getSupplierInvoice = async (req, res, next) => {
  try {
    const invoice = await procurementService.getSupplierInvoiceById(
      req.params.id,
      req.user.organizationId
    );
    return sendResponse(res, 200, "Supplier invoice retrieved successfully", invoice);
  } catch (error) {
    next(error);
  }
};

export const listSupplierInvoices = async (req, res, next) => {
  try {
    const branchId = req.query.branchId || req.branchId;
    const { page, limit, supplierId, status } = req.query;
    const result = await procurementService.listSupplierInvoices(
      { organizationId: req.user.organizationId, branchId, supplierId, status },
      { page: parseInt(page) || 1, limit: parseInt(limit) || 20 }
    );
    return sendResponse(
      res,
      200,
      "Supplier invoices retrieved successfully",
      result.invoices,
      result.pagination
    );
  } catch (error) {
    next(error);
  }
};

// ---------------------------------------------------------
// SUPPLIER PAYMENTS
// ---------------------------------------------------------
export const recordSupplierPayment = async (req, res, next) => {
  try {
    const idempotencyKey = getIdempotencyKey(req);
    const branchId = req.body.branchId || req.branchId;
    const payload = {
      ...req.body,
      idempotencyKey,
    };
    const result = await procurementService.recordSupplierPayment(
      payload,
      req.user.organizationId,
      branchId,
      req.user.id
    );
    return sendResponse(res, 201, "Supplier payment recorded successfully", result);
  } catch (error) {
    next(error);
  }
};

export const listSupplierPayments = async (req, res, next) => {
  try {
    const branchId = req.query.branchId || req.branchId;
    const { page, limit, supplierId, supplierInvoiceId } = req.query;
    const result = await procurementService.listSupplierPayments(
      { organizationId: req.user.organizationId, branchId, supplierId, supplierInvoiceId },
      { page: parseInt(page) || 1, limit: parseInt(limit) || 20 }
    );
    return sendResponse(
      res,
      200,
      "Supplier payments retrieved successfully",
      result.payments,
      result.pagination
    );
  } catch (error) {
    next(error);
  }
};

// ---------------------------------------------------------
// OVERVIEW
// ---------------------------------------------------------
export const getProcurementOverview = async (req, res, next) => {
  try {
    const branchId = req.query.branchId || req.branchId || null;
    const overview = await procurementService.getProcurementOverview(
      req.user.organizationId,
      branchId
    );
    return sendResponse(res, 200, "Procurement overview retrieved successfully", overview);
  } catch (error) {
    next(error);
  }
};

