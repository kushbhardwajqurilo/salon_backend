import { asyncHandler } from "../../utils/errors.js";
import { billingService } from "../../services/billing/billing.service.js";

export const createInvoice = asyncHandler(async (req, res) => {
  const invoice = await billingService.createInvoiceFromAppointment(
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
  const result = await billingService.recordPayment(
    req.params.id,
    req.body,
    req.user.organizationId,
    branchId,
    req.user.id || req.user._id
  );
  res.status(201).json({
    success: true,
    message: "Payment recorded successfully",
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
  const { page, limit, sortBy, sortOrder, status, paymentStatus, customerId, branchId, appointmentId } = req.query;

  const filter = {};
  if (status) filter.status = status;
  if (paymentStatus) filter.paymentStatus = paymentStatus;
  if (customerId) filter.customerId = customerId;
  if (appointmentId) filter.appointmentId = appointmentId;

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
    data: result.data,
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
