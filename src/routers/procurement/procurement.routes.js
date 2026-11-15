import { Router } from "express";
import { authenticate } from "../../middleware/auth.js";
import { requireBranchScope } from "../../middleware/branchScope.js";
import { authorize } from "../../middleware/rbac.js";
import { validate } from "../../middleware/validate.js";
import * as procurementController from "../../controllers/procurement/procurement.controller.js";
import {
  createSupplierSchema,
  updateSupplierSchema,
  listSuppliersSchema,
  createPurchaseOrderSchema,
  updatePurchaseOrderStatusSchema,
  listPurchaseOrdersSchema,
  receiveGoodsSchema,
  listGoodsReceiptsSchema,
  createSupplierInvoiceSchema,
  listSupplierInvoicesSchema,
  recordSupplierPaymentSchema,
  listSupplierPaymentsSchema,
  objectIdSchema,
} from "../../validation/procurement/procurement.validation.js";
import { z } from "zod";

const router = Router();

const withIdParam = (schema = z.object({})) =>
  z.object({
    params: z.object({
      id: objectIdSchema,
    }),
  });

// ---------------------------------------------------------
// PROCUREMENT OVERVIEW
// ---------------------------------------------------------
router.get(
  "/overview",
  authenticate,
  authorize("procurement.orders.view"),
  procurementController.getProcurementOverview
);

// ---------------------------------------------------------
// SUPPLIER DIRECTORY
// ---------------------------------------------------------
router.post(
  "/suppliers",
  authenticate,
  authorize("procurement.suppliers.manage"),
  validate(createSupplierSchema),
  procurementController.createSupplier
);

router.get(
  "/suppliers",
  authenticate,
  authorize("procurement.suppliers.view"),
  validate(listSuppliersSchema),
  procurementController.listSuppliers
);

router.get(
  "/suppliers/:id",
  authenticate,
  authorize("procurement.suppliers.view"),
  validate(withIdParam()),
  procurementController.getSupplier
);

router.put(
  "/suppliers/:id",
  authenticate,
  authorize("procurement.suppliers.manage"),
  validate(updateSupplierSchema),
  procurementController.updateSupplier
);

// ---------------------------------------------------------
// PURCHASE ORDERS
// ---------------------------------------------------------
router.post(
  "/orders",
  authenticate,
  requireBranchScope,
  authorize("procurement.orders.create"),
  validate(createPurchaseOrderSchema),
  procurementController.createPurchaseOrder
);

router.get(
  "/orders",
  authenticate,
  requireBranchScope,
  authorize("procurement.orders.view"),
  validate(listPurchaseOrdersSchema),
  procurementController.listPurchaseOrders
);

router.get(
  "/orders/:id",
  authenticate,
  authorize("procurement.orders.view"),
  validate(withIdParam()),
  procurementController.getPurchaseOrder
);

router.patch(
  "/orders/:id/status",
  authenticate,
  authorize("procurement.orders.update"),
  validate(updatePurchaseOrderStatusSchema),
  procurementController.updatePurchaseOrderStatus
);

// ---------------------------------------------------------
// GOODS RECEIVING (GRN)
// ---------------------------------------------------------
router.post(
  "/orders/:id/receive",
  authenticate,
  requireBranchScope,
  authorize("procurement.orders.update"),
  validate(receiveGoodsSchema),
  procurementController.receiveGoods
);

router.get(
  "/receipts",
  authenticate,
  requireBranchScope,
  authorize("procurement.orders.view"),
  validate(listGoodsReceiptsSchema),
  procurementController.listGoodsReceipts
);

// ---------------------------------------------------------
// SUPPLIER INVOICES / BILLS
// ---------------------------------------------------------
router.post(
  "/invoices",
  authenticate,
  requireBranchScope,
  authorize("procurement.invoices.manage"),
  validate(createSupplierInvoiceSchema),
  procurementController.createSupplierInvoice
);

router.get(
  "/invoices",
  authenticate,
  requireBranchScope,
  authorize("procurement.orders.view"),
  validate(listSupplierInvoicesSchema),
  procurementController.listSupplierInvoices
);

router.get(
  "/invoices/:id",
  authenticate,
  authorize("procurement.orders.view"),
  validate(withIdParam()),
  procurementController.getSupplierInvoice
);

// ---------------------------------------------------------
// SUPPLIER PAYMENTS
// ---------------------------------------------------------
router.post(
  "/payments",
  authenticate,
  requireBranchScope,
  authorize("procurement.payments.manage"),
  validate(recordSupplierPaymentSchema),
  procurementController.recordSupplierPayment
);

router.get(
  "/payments",
  authenticate,
  requireBranchScope,
  authorize("procurement.orders.view"),
  validate(listSupplierPaymentsSchema),
  procurementController.listSupplierPayments
);

export default router;

