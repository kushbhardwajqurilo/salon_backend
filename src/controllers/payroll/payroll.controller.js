import { asyncHandler } from "../../utils/errors.js";
import { PayrollService } from "../../services/payroll/payroll.service.js";
import { generatePayslipPdf } from "../../services/payroll/payslipPdf.service.js";

const getActorId = (req) => req.user?.id || req.user?._id;

export class PayrollController {
  static setSalaryStructure = asyncHandler(async (req, res) => {
    const { organizationId, branchId } = req;
    const structure = await PayrollService.setSalaryStructure({
      organizationId,
      branchId,
      ...req.body,
      userId: getActorId(req),
    });

    res.status(200).json({
      success: true,
      data: structure,
      message: "Salary structure configured successfully",
    });
  });

  static getEffectiveSalaryStructure = asyncHandler(async (req, res) => {
    const { organizationId, branchId } = req;
    const { staffId } = req.params;
    const { date } = req.query;

    const structure = await PayrollService.getEffectiveSalaryStructure({
      organizationId,
      branchId,
      staffId,
      date,
    });

    res.status(200).json({
      success: true,
      data: structure,
    });
  });

  static getSalaryStructureHistory = asyncHandler(async (req, res) => {
    const { organizationId, branchId } = req;
    const { staffId } = req.params;

    const history = await PayrollService.getSalaryStructureHistory({
      organizationId,
      branchId,
      staffId,
    });

    res.status(200).json({
      success: true,
      data: history,
    });
  });

  static createPayrollPeriod = asyncHandler(async (req, res) => {
    const { organizationId } = req;
    const period = await PayrollService.createPayrollPeriod({
      organizationId,
      ...req.body,
      userId: getActorId(req),
    });

    res.status(201).json({
      success: true,
      data: period,
      message: "Payroll period created successfully",
    });
  });

  static listPayrollPeriods = asyncHandler(async (req, res) => {
    const { organizationId } = req;
    const periods = await PayrollService.listPayrollPeriods({ organizationId });

    res.status(200).json({
      success: true,
      data: periods,
    });
  });

  static calculatePayroll = asyncHandler(async (req, res) => {
    const { organizationId, branchId } = req;
    const { payrollPeriodId, staffIds } = req.body;

    const records = await PayrollService.calculatePayroll({
      organizationId,
      payrollPeriodId,
      staffIds,
      branchId,
      userId: getActorId(req),
    });

    res.status(200).json({
      success: true,
      data: records,
      message: `Calculated payroll for ${records.length} staff member(s)`,
    });
  });

  static submitForApproval = asyncHandler(async (req, res) => {
    const { organizationId, branchId } = req;
    const { id } = req.params;

    const record = await PayrollService.submitForApproval({
      organizationId,
      branchId,
      recordId: id,
      userId: getActorId(req),
    });

    res.status(200).json({
      success: true,
      data: record,
      message: "Payroll record submitted for approval",
    });
  });

  static approvePayrollRecord = asyncHandler(async (req, res) => {
    const { organizationId, branchId } = req;
    const { id } = req.params;

    const record = await PayrollService.approvePayrollRecord({
      organizationId,
      branchId,
      recordId: id,
      userId: getActorId(req),
    });

    res.status(200).json({
      success: true,
      data: record,
      message: "Payroll record approved successfully",
    });
  });

  static recordPayment = asyncHandler(async (req, res) => {
    const { organizationId, branchId } = req;
    const { id } = req.params;
    const {
      paymentMethod,
      paymentReference,
      amountInPaise,
      paymentDate,
      idempotencyKey,
    } = req.body;

    const result = await PayrollService.recordPayment({
      organizationId,
      branchId,
      recordId: id,
      paymentMethod,
      paymentReference,
      amountInPaise,
      paymentDate,
      idempotencyKey,
      userId: getActorId(req),
    });

    res.status(result.isIdempotentReplay ? 200 : 201).json({
      success: true,
      data: result,
      message: result.isIdempotentReplay
        ? "Existing payroll payment attempt returned"
        : "Payment attempt recorded; payroll remains unsettled until confirmation",
    });
  });

  static confirmPayment = asyncHandler(async (req, res) => {
    const { organizationId, branchId } = req;
    const { id, paymentId } = req.params;
    const result = await PayrollService.confirmPayment({
      organizationId,
      branchId,
      recordId: id,
      paymentId,
      userId: getActorId(req),
    });

    res.status(200).json({
      success: true,
      data: result,
      message: result.isIdempotentReplay
        ? "Payroll settlement was already confirmed"
        : "Payroll settlement confirmed",
    });
  });

  static failPayment = asyncHandler(async (req, res) => {
    const { organizationId, branchId } = req;
    const { id, paymentId } = req.params;
    const { failureReason } = req.body;
    const result = await PayrollService.failPayment({
      organizationId,
      branchId,
      recordId: id,
      paymentId,
      failureReason,
      userId: getActorId(req),
    });

    res.status(200).json({
      success: true,
      data: result,
      message: result.isIdempotentReplay
        ? "Payment failure was already recorded"
        : "Payment failure recorded; payroll remains approved and may be retried",
    });
  });

  static addAdjustment = asyncHandler(async (req, res) => {
    const { organizationId, branchId } = req;
    const { id } = req.params;
    const { type, amount, reason, reference } = req.body;
    const userId = getActorId(req);

    const record = await PayrollService.addAdjustment({
      organizationId,
      branchId,
      recordId: id,
      type,
      amount,
      reason,
      reference,
      userId,
    });

    res.status(200).json({
      success: true,
      data: record,
      message: `Adjustment (${type}) added successfully`,
    });
  });

  static reversePayment = asyncHandler(async (req, res) => {
    const { organizationId, branchId } = req;
    const { id } = req.params;
    const { reversalReason } = req.body;

    const result = await PayrollService.reversePayment({
      organizationId,
      branchId,
      recordId: id,
      reversalReason,
      userId: getActorId(req),
    });

    res.status(200).json({
      success: true,
      data: result.record,
      payment: result.payment,
      isIdempotentReplay: result.isIdempotentReplay,
      message: result.isIdempotentReplay
        ? "Payment reversal was already recorded"
        : "Payment reversed successfully",
    });
  });

  static listPayrollRecords = asyncHandler(async (req, res) => {
    const { organizationId, branchId } = req;
    const {
      monthYear,
      startDate,
      endDate,
      status,
      staffId,
      search,
      page,
      limit,
      sortBy,
      sortOrder,
    } = req.query;

    const result = await PayrollService.listPayrollRecords({
      organizationId,
      branchId,
      monthYear,
      startDate,
      endDate,
      status,
      staffId,
      search,
      page,
      limit,
      sortBy,
      sortOrder,
    });

    res.status(200).json({
      success: true,
      data: result.records,
      pagination: result.pagination,
      summary: result.summary,
    });
  });

  static getPayrollRecordById = asyncHandler(async (req, res) => {
    const { organizationId, branchId } = req;
    const { id } = req.params;

    const record = await PayrollService.getPayrollRecordById({
      organizationId,
      branchId,
      recordId: id,
    });

    res.status(200).json({
      success: true,
      data: record,
    });
  });

  static downloadPayslipPdf = asyncHandler(async (req, res) => {
    const { organizationId, branchId } = req;
    const { id } = req.params;

    const record = await PayrollService.getPayrollRecordById({
      organizationId,
      branchId,
      recordId: id,
    });

    const pdfBuffer = await generatePayslipPdf(record);

    const filename = `payslip-${record.monthYear}-${record.staffId?.staffCode || "staff"}.pdf`;

    res.setHeader("Content-Type", "application/pdf");
    res.setHeader("Content-Disposition", `attachment; filename="${filename}"`);
    res.status(200).send(pdfBuffer);
  });
}
