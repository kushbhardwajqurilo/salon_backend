import express from "express";
import { authenticate } from "../../middleware/auth.js";
import { requireOrganizationScope, requireBranchScope } from "../../middleware/branchScope.js";
import { requirePermission } from "../../middleware/rbac.js";
import { validate } from "../../middleware/validate.js";
import { asyncHandler, AppError } from "../../utils/errors.js";
import {
  createInvoiceSchema,
  updateDraftInvoiceSchema,
  finalizeInvoiceSchema,
  cancelInvoiceSchema,
  recordPaymentSchema,
  voidPaymentSchema,
  listInvoicesQuerySchema,
} from "../../validation/billing/billing.validation.js";
import {
  createInvoice,
  updateDraftInvoice,
  finalizeInvoice,
  cancelInvoice,
  recordPayment,
  voidPayment,
  getInvoiceById,
  listInvoices,
  getPaymentsByInvoiceId,
  getInvoicePdf,
} from "../../controllers/billing/billing.controller.js";

const router = express.Router();

/**
 * Middleware to enforce active mutation branch scope strictly.
 * Rejects "all" and ensures caller has access to the specified branch.
 */
const validateMutationBranch = asyncHandler(async (req, res, next) => {
  const branchId =
    req.body?.branchId ||
    req.headers["x-branch-id"] ||
    req.headers["X-Branch-Id"] ||
    req.branchId;

  if (!branchId || branchId === "all") {
    throw new AppError("branchId (body or X-Branch-Id header) is required for this mutation", 400);
  }

  if (!req.body) req.body = {};
  req.body.branchId = branchId;
  req.branchId = branchId;

  const { hasOrgWideAccess, branchAccess } = req.user;
  let isAuthorized = false;

  if (hasOrgWideAccess === true) {
    isAuthorized = true;
  } else {
    isAuthorized = (branchAccess || []).some(
      (b) => b.branchId.toString() === branchId.toString() && b.isActive
    );
  }

  if (!isAuthorized) {
    throw new AppError("Access denied. You do not have access to this branch.", 403);
  }

  next();
});

// All billing endpoints require authentication and organization scope
router.use(authenticate);
router.use(requireOrganizationScope);

// Invoices
router.post(
  "/invoices",
  validateMutationBranch,
  validate(createInvoiceSchema),
  requirePermission("billing.checkout"),
  createInvoice
);

router.get(
  "/invoices",
  requireBranchScope,
  validate(listInvoicesQuerySchema),
  requirePermission("billing.view"),
  listInvoices
);

router.get(
  "/invoices/:id",
  requireBranchScope,
  requirePermission("billing.view"),
  getInvoiceById
);

router.get(
  "/invoices/:id/pdf",
  requireBranchScope,
  requirePermission("billing.view"),
  getInvoicePdf
);

router.patch(
  "/invoices/:id",
  validateMutationBranch,
  validate(updateDraftInvoiceSchema),
  requirePermission("billing.checkout"),
  updateDraftInvoice
);

router.post(
  "/invoices/:id/finalize",
  validateMutationBranch,
  validate(finalizeInvoiceSchema),
  requirePermission("billing.checkout"),
  finalizeInvoice
);

router.post(
  "/invoices/:id/cancel",
  validateMutationBranch,
  validate(cancelInvoiceSchema),
  requirePermission("billing.void"),
  cancelInvoice
);

// Payments
router.post(
  "/invoices/:id/payments",
  validateMutationBranch,
  validate(recordPaymentSchema),
  requirePermission("payments.receive"),
  recordPayment
);

router.get(
  "/invoices/:id/payments",
  requireBranchScope,
  requirePermission("payments.view"),
  getPaymentsByInvoiceId
);

router.post(
  "/payments/:paymentId/void",
  validateMutationBranch,
  validate(voidPaymentSchema),
  requirePermission("payments.refund"),
  voidPayment
);

export default router;
