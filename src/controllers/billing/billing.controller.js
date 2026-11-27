import { AppError, asyncHandler } from "../../utils/errors.js";
import { billingService } from "../../services/billing/billing.service.js";
import { refundService } from "../../services/billing/refund.service.js";

export const createInvoice = asyncHandler(async (req, res) => {
  // All entry points converge into one authoritative unified checkout pipeline
  const invoice = await billingService.createUnifiedInvoice(
    req.body,
    req.user.organizationId,
    req.user.id || req.user._id
  );

  res.status(201).json({
    success: true,
    message: "Draft invoice created successfully",
    data: invoice,
  });
});

export const updateDraftInvoice = asyncHandler(async (req, res) => {
  const branchId = req.branchId || req.body?.branchId;
  const invoice = await billingService.updateDraftInvoice(
    req.params.id,
    req.body,
    req.user.organizationId,
    branchId,
    req.user.id || req.user._id
  );
  res.status(200).json({
    success: true,
    message: "Draft invoice updated successfully",
    data: invoice,
  });
});

export const correctInvoiceAttribution = asyncHandler(async (req, res) => {
  const result = await billingService.correctInvoiceAttribution(
    req.params.id,
    req.body,
    req.user.organizationId,
    req.branchId || req.body.branchId,
    req.user.id || req.user._id,
  );
  res.status(200).json({
    success: true,
    message: "Invoice attribution corrected successfully",
    data: result,
  });
});

export const applyInvoiceDiscount = asyncHandler(async (req, res) => {
  const branchId = req.branchId || req.body?.branchId;
  const result = await billingService.applyInvoiceDiscount(
    req.params.id,
    req.body,
    req.user.organizationId,
    branchId,
    req.user.id || req.user._id
  );
  res.status(200).json({
    success: true,
    message: "Discount applied successfully",
    data: result,
  });
});

export const modifyInvoiceDiscount = asyncHandler(async (req, res) => {
  const branchId = req.branchId || req.body?.branchId;
  const result = await billingService.modifyInvoiceDiscount(
    req.params.id,
    req.params.discountId,
    req.body,
    req.user.organizationId,
    branchId,
    req.user.id || req.user._id
  );
  res.status(200).json({
    success: true,
    message: "Discount modified successfully",
    data: result,
  });
});

export const removeInvoiceDiscount = asyncHandler(async (req, res) => {
  const branchId = req.branchId || req.body?.branchId;
  const result = await billingService.removeInvoiceDiscount(
    req.params.id,
    req.params.discountId,
    req.body,
    req.user.organizationId,
    branchId,
    req.user.id || req.user._id
  );
  res.status(200).json({
    success: true,
    message: "Discount removed successfully",
    data: result,
  });
});

export const getInvoiceDiscountHistory = asyncHandler(async (req, res) => {
  const branchId = req.branchId || req.headers["x-branch-id"] || null;
  const history = await billingService.getInvoiceDiscountHistory(
    req.params.id,
    req.user.organizationId,
    branchId
  );
  res.status(200).json({
    success: true,
    message: "Discount history retrieved successfully",
    data: history,
  });
});

export const finalizeInvoice = asyncHandler(async (req, res) => {
  const branchId = req.branchId || req.body?.branchId;
  const invoice = await billingService.finalizeInvoice(
    req.params.id,
    req.body,
    req.user.organizationId,
    branchId,
    req.user.id || req.user._id
  );
  res.status(200).json({
    success: true,
    message: "Invoice finalized successfully",
    data: invoice,
  });
});

export const cancelInvoice = asyncHandler(async (req, res) => {
  const branchId = req.branchId || req.body?.branchId;
  const invoice = await billingService.cancelInvoice(
    req.params.id,
    req.body.reason,
    req.user.organizationId,
    branchId,
    req.user.id || req.user._id
  );
  res.status(200).json({
    success: true,
    message: "Invoice cancelled successfully",
    data: invoice,
  });
});

export const recordPayment = asyncHandler(async (req, res) => {
  const branchId = req.branchId || req.body?.branchId;
  const idempotencyKey =
    req.headers["idempotency-key"] ||
    req.headers["x-idempotency-key"] ||
    req.body?.idempotencyKey;

  const paymentPayload = {
    ...req.body,
    ...(idempotencyKey ? { idempotencyKey: String(idempotencyKey).trim() } : {}),
  };

  const result = await billingService.recordPayment(
    req.params.id,
    paymentPayload,
    req.user.organizationId,
    branchId,
    req.user.id || req.user._id
  );
  const statusCode = result?.isIdempotentReplay ? 200 : 201;
  res.status(statusCode).json({
    success: true,
    message: result?.isIdempotentReplay ? "Payment already processed (idempotent replay)" : "Payment recorded successfully",
    data: result,
  });
});

export const voidPayment = asyncHandler(async (req, res) => {
  const branchId = req.branchId || req.body?.branchId;
  const result = await billingService.voidPayment(
    req.params.paymentId,
    req.body.reason,
    req.user.organizationId,
    branchId,
    req.user.id || req.user._id
  );
  res.status(200).json({
    success: true,
    message: "Payment voided successfully",
    data: result,
  });
});

export const getInvoiceById = asyncHandler(async (req, res) => {
  const result = await billingService.getInvoiceById(
    req.params.id,
    req.user.organizationId,
    req.branchId
  );
  res.status(200).json({
    success: true,
    data: result,
  });
});

export const listInvoices = asyncHandler(async (req, res) => {
  const {
    page,
    limit,
    sortBy,
    sortOrder,
    status,
    paymentStatus,
    customerId,
    branchId,
    appointmentId,
    startDate,
    endDate,
    search,
  } = req.query;

  const filter = {};
  if (status) filter.status = status;
  if (paymentStatus) filter.paymentStatus = paymentStatus;
  if (customerId) filter.customerId = customerId;
  if (appointmentId) filter.appointmentId = appointmentId;
  if (startDate) filter.startDate = startDate;
  if (endDate) filter.endDate = endDate;
  if (search) filter.search = search;

  // Branch filter: if caller provides query branchId and user has access, or fallback to header branchId
  const effectiveBranchId = branchId || req.branchId;

  const result = await billingService.listInvoices(
    filter,
    { page, limit, sortBy, sortOrder },
    req.user.organizationId,
    effectiveBranchId
  );

  res.status(200).json({
    success: true,
    status: "success",
    data: result.data,
    meta: result.meta,
    pagination: result.pagination,
  });
});

export const getPaymentsByInvoiceId = asyncHandler(async (req, res) => {
  const payments = await billingService.getPaymentsByInvoiceId(
    req.params.id,
    req.user.organizationId,
    req.branchId
  );
  res.status(200).json({
    success: true,
    data: payments,
  });
});

export const getInvoicePdf = asyncHandler(async (req, res) => {
  const { pdfBuffer, invoice } = await billingService.generateInvoicePdf(
    req.params.id,
    req.user.organizationId,
    req.branchId
  );

  const filename = `${invoice.invoiceNumber || `INV-${invoice._id}`}.pdf`;

  res.setHeader("Content-Type", "application/pdf");
  res.setHeader("Content-Disposition", `inline; filename="${filename}"`);

  if (invoice.status === "finalized") {
    res.setHeader("Cache-Control", "private, max-age=86400, immutable");
  } else {
    res.setHeader("Cache-Control", "private, no-cache, no-store, must-revalidate");
  }

  res.status(200).send(pdfBuffer);
});

export const getCheckoutQueue = asyncHandler(async (req, res) => {
  const { date, branchId, customerId } = req.query;
  const effectiveBranchId = branchId || req.branchId;

  const result = await billingService.getCheckoutQueue({
    organizationId: req.user.organizationId,
    branchId: effectiveBranchId,
    customerId,
    date,
  });

  res.status(200).json({
    success: true,
    message: "Checkout queue retrieved successfully",
    data: result.data,
    meta: result.meta,
  });
});

export const returnInvoiceItems = asyncHandler(async (req, res) => {
  const branchId = req.branchId || req.body?.branchId;
  const idempotencyKey = String(
    req.headers["idempotency-key"] || req.headers["x-idempotency-key"] || "",
  ).trim();
  if (!idempotencyKey || idempotencyKey.length > 200) {
    throw new AppError("A valid Idempotency-Key header is required for invoice returns", 400);
  }
  const result = await billingService.processInvoiceReturn(
    req.params.id,
    req.body,
    req.user.organizationId,
    branchId,
    req.user.id || req.user._id,
    idempotencyKey,
  );
  res.status(200).json({
    success: true,
    message: "Invoice items returned and processed successfully",
    data: result,
  });
});

export const refundUnusedMembershipLine = asyncHandler(async (req, res) => {
  const branchId = req.branchId || req.body?.branchId;
  const idempotencyKey = String(
    req.headers["idempotency-key"] || req.headers["x-idempotency-key"] || "",
  ).trim();
  if (!idempotencyKey || idempotencyKey.length > 200) {
    throw new AppError("A valid Idempotency-Key header is required for membership refunds", 400);
  }
  const result = await billingService.refundUnusedMembershipLine(
    req.params.id,
    req.body,
    req.user.organizationId,
    branchId,
    req.user.id || req.user._id,
    idempotencyKey,
  );
  res.status(200).json({
    success: true,
    message: "Unused membership refund recorded successfully",
    data: result,
  });
});

export const listMembershipPlans = asyncHandler(async (req, res) => {
  const plans = await billingService.listMembershipPlans(req.user.organizationId, req.query);
  res.status(200).json({
    success: true,
    message: "Membership plans retrieved successfully",
    data: plans,
  });
});

export const applyCoupon = asyncHandler(async (req, res) => {
  const branchId = req.branchId || req.body?.branchId;
  const result = await billingService.applyCouponToInvoice(
    req.params.id,
    req.body.code,
    req.user.organizationId,
    branchId,
    req.user.id || req.user._id
  );
  res.status(200).json({
    success: true,
    message: "Coupon applied successfully",
    data: result,
  });
});

export const removeCoupon = asyncHandler(async (req, res) => {
  const branchId = req.branchId || req.body?.branchId;
  const result = await billingService.removeCouponFromInvoice(
    req.params.id,
    req.user.organizationId,
    branchId,
    req.user.id || req.user._id
  );
  res.status(200).json({
    success: true,
    message: "Coupon removed successfully",
    data: result,
  });
});

export const getRefundContext = asyncHandler(async (req, res) => {
  const result = await refundService.getRefundContext(
    req.params.id,
    req.user.organizationId,
    req.branchId
  );
  res.status(200).json({
    success: true,
    data: result,
  });
});

export const previewRefund = asyncHandler(async (req, res) => {
  const branchId = req.branchId || req.body?.branchId;
  const result = await refundService.previewRefund(
    req.params.id,
    req.body,
    req.user.organizationId,
    branchId
  );
  res.status(200).json({
    success: true,
    data: result,
  });
});

export const createRefund = asyncHandler(async (req, res) => {
  const branchId = req.branchId || req.body?.branchId;
  const idempotencyKey = String(
    req.headers["idempotency-key"] || req.headers["x-idempotency-key"] || ""
  ).trim();
  const result = await refundService.createPendingRefundCase(
    req.params.id,
    req.body,
    req.user.organizationId,
    branchId,
    req.user.id || req.user._id,
    idempotencyKey
  );
  res.status(result.idempotentReplay ? 200 : 201).json({
    success: true,
    data: result,
  });
});

export const settleRefund = asyncHandler(async (req, res) => {
  const branchId = req.branchId || req.body?.branchId;
  const idempotencyKey = String(
    req.headers["idempotency-key"] || req.headers["x-idempotency-key"] || ""
  ).trim();
  const result = await refundService.settleRefundCase(
    req.params.id,
    req.params.refundCaseId,
    req.body,
    req.user.organizationId,
    branchId,
    req.user.id || req.user._id,
    idempotencyKey
  );
  res.status(200).json({
    success: true,
    data: result,
  });
});

export const retryRefundReversals = asyncHandler(async (req, res) => {
  const branchId = req.branchId || req.body?.branchId;
  const result = await refundService.retryDomainReversals(
    req.params.id,
    req.params.refundCaseId,
    req.user.organizationId,
    branchId,
    req.user.id || req.user._id
  );
  res.status(200).json({
    success: true,
    data: result,
  });
});

