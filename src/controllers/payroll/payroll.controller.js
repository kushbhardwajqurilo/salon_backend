import { asyncHandler } from "../../utils/errors.js";
import { PayrollService } from "../../services/payroll/payroll.service.js";
import { generatePayslipPdf } from "../../services/payroll/payslipPdf.service.js";

export class PayrollController {
  static setSalaryStructure = asyncHandler(async (req, res) => {
    const { organizationId } = req;
    const structure = await PayrollService.setSalaryStructure({
      organizationId,
      ...req.body,
      userId: req.user._id,
    });

    res.status(200).json({
      success: true,
      data: structure,
      message: "Salary structure configured successfully",
    });
  });

  static getEffectiveSalaryStructure = asyncHandler(async (req, res) => {
    const { organizationId } = req;
    const { staffId } = req.params;
    const { date } = req.query;

    const structure = await PayrollService.getEffectiveSalaryStructure({
      organizationId,
      staffId,
      date,
    });

    res.status(200).json({
      success: true,
      data: structure,
    });
  });

  static getSalaryStructureHistory = asyncHandler(async (req, res) => {
    const { organizationId } = req;
    const { staffId } = req.params;

    const history = await PayrollService.getSalaryStructureHistory({
      organizationId,
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
      userId: req.user._id,
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
      userId: req.user._id,
    });

    res.status(200).json({
      success: true,
      data: records,
      message: `Calculated payroll for ${records.length} staff member(s)`,
    });
  });

  static submitForApproval = asyncHandler(async (req, res) => {
    const { organizationId } = req;
    const { id } = req.params;

    const record = await PayrollService.submitForApproval({
      organizationId,
      recordId: id,
      userId: req.user._id,
    });

    res.status(200).json({
      success: true,
      data: record,
      message: "Payroll record submitted for approval",
    });
  });

  static approvePayrollRecord = asyncHandler(async (req, res) => {
    const { organizationId } = req;
    const { id } = req.params;

    const record = await PayrollService.approvePayrollRecord({
      organizationId,
      recordId: id,
      userId: req.user._id,
    });

    res.status(200).json({
      success: true,
      data: record,
      message: "Payroll record approved successfully",
    });
  });

  static recordPayment = asyncHandler(async (req, res) => {
    const { organizationId } = req;
    const { id } = req.params;
    const { paymentMethod, paymentReference } = req.body;

    const record = await PayrollService.recordPayment({
      organizationId,
      recordId: id,
      paymentMethod,
      paymentReference,
      userId: req.user._id,
    });

    res.status(200).json({
      success: true,
      data: record,
      message: "Payment recorded successfully",
    });
  });

  static addAdjustment = asyncHandler(async (req, res) => {
    const { organizationId } = req;
    const { id } = req.params;
    const { type, amount, reason, reference } = req.body;
    const userId = req.user?.id || req.user?._id;

    const record = await PayrollService.addAdjustment({
      organizationId,
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
    const { organizationId } = req;
    const { id } = req.params;
    const { reversalReason } = req.body;

    const record = await PayrollService.reversePayment({
      organizationId,
      recordId: id,
      reversalReason,
      userId: req.user._id,
    });

    res.status(200).json({
      success: true,
      data: record,
      message: "Payment reversed successfully",
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
    const { organizationId } = req;
    const { id } = req.params;

    const record = await PayrollService.getPayrollRecordById({
      organizationId,
      recordId: id,
    });

    res.status(200).json({
      success: true,
      data: record,
    });
  });

  static downloadPayslipPdf = asyncHandler(async (req, res) => {
    const { organizationId } = req;
    const { id } = req.params;

    const record = await PayrollService.getPayrollRecordById({
      organizationId,
      recordId: id,
    });

    const pdfBuffer = await generatePayslipPdf(record);

    const filename = `payslip-${record.monthYear}-${record.staffId?.staffCode || "staff"}.pdf`;

    res.setHeader("Content-Type", "application/pdf");
    res.setHeader("Content-Disposition", `attachment; filename="${filename}"`);
    res.status(200).send(pdfBuffer);
  });
}
