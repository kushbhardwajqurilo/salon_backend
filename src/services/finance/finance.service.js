import mongoose from "mongoose";
import { DayClosure } from "../../models/finance/dayClosure.model.js";
import { Payment } from "../../models/billing/payment.model.js";
import { Invoice } from "../../models/billing/invoice.model.js";
import { Expense } from "../../models/expenses/expense.model.js";
import { PettyCashTransaction } from "../../models/expenses/pettyCash.model.js";
import { PayrollRecord } from "../../models/payroll/payrollRecord.model.js";
import { PayrollPayment } from "../../models/payroll/payrollPayment.model.js";
import { SupplierInvoice } from "../../models/procurement/supplierInvoice.model.js";
import { SupplierPayment } from "../../models/procurement/supplierPayment.model.js";
import { Branch } from "../../models/branches/branch.model.js";
import { StockMovement } from "../../models/inventory/stockMovement.model.js";
import { AppError } from "../../utils/errors.js";
import { runInTransaction } from "../../utils/transaction.js";
import { emitFinanceDayClosureOutboxEvent } from "./financeNotificationOutbox.service.js";

export class FinanceService {
  /**
   * Helper to derive local timezone day start and end in UTC for a branch.
   */
  static getBranchDayBounds(businessDateStr, timezone = "Asia/Kolkata") {
    let offsetMinutes = 330; // Default +05:30 (Asia/Kolkata)
    if (timezone === "UTC") offsetMinutes = 0;

    const [year, month, day] = businessDateStr.split("-").map(Number);
    // Local 00:00:00.000 in UTC
    const startUtcMs =
      Date.UTC(year, month - 1, day, 0, 0, 0, 0) - offsetMinutes * 60 * 1000;
    // Local 23:59:59.999 in UTC
    const endUtcMs =
      Date.UTC(year, month - 1, day, 23, 59, 59, 999) -
      offsetMinutes * 60 * 1000;

    return {
      startUtc: new Date(startUtcMs),
      endUtc: new Date(endUtcMs),
    };
  }

  /**
   * Compute system tender totals from completed Payment records for a branch on a business date.
   * Handles both negative and positive refund amounts safely using absolute values in integer paise.
   */
  static async getSystemTotals(organizationId, branchId, businessDate) {
    if (!branchId)
      throw new AppError("BranchId is required for system totals", 400);

    const branch = await Branch.findById(branchId).lean();
    if (!branch) throw new AppError("Branch not found", 404);

    const timezone = branch.timezone || "Asia/Kolkata";
    const { startUtc, endUtc } = FinanceService.getBranchDayBounds(
      businessDate,
      timezone,
    );

    const match = {
      organizationId: new mongoose.Types.ObjectId(organizationId),
      branchId: new mongoose.Types.ObjectId(branchId),
      status: "completed",
      isDeleted: false,
      paymentDate: { $gte: startUtc, $lte: endUtc },
    };

    const aggregated = await Payment.aggregate([
      { $match: match },
      {
        $group: {
          _id: { method: "$method", type: "$type" },
          totalPaise: {
            $sum: { $round: [{ $multiply: [{ $abs: "$amount" }, 100] }, 0] },
          },
        },
      },
    ]);

    const tenders = {
      cash: 0,
      card: 0,
      upi: 0,
      other: 0,
    };
    let totalCollectedPaise = 0;
    let totalRefundedPaise = 0;

    for (const row of aggregated) {
      const method = row._id.method;
      const type = row._id.type;
      const paise = row.totalPaise;

      if (type === "payment") {
        totalCollectedPaise += paise;
        if (method === "cash") tenders.cash += paise;
        else if (method === "card") tenders.card += paise;
        else if (method === "upi") tenders.upi += paise;
        else tenders.other += paise;
      } else if (type === "refund") {
        totalRefundedPaise += paise;
        if (method === "cash") tenders.cash -= paise;
        else if (method === "card") tenders.card -= paise;
        else if (method === "upi") tenders.upi -= paise;
        else tenders.other -= paise;
      }
    }

    const netExpectedPaise = totalCollectedPaise - totalRefundedPaise;

    // Check if closure already exists for this date
    const existingClosure = await DayClosure.findOne({
      organizationId,
      branchId,
      businessDate,
    }).lean();

    return {
      businessDate,
      branchId,
      branchTimezone: timezone,
      systemTotals: {
        cash: tenders.cash / 100,
        card: tenders.card / 100,
        upi: tenders.upi / 100,
        other: tenders.other / 100,
        totalCollected: totalCollectedPaise / 100,
        totalRefunded: totalRefundedPaise / 100,
        netExpected: netExpectedPaise / 100,
      },
      alreadyClosed: Boolean(existingClosure),
      existingClosureId: existingClosure
        ? existingClosure._id.toString()
        : null,
      existingClosureStatus: existingClosure?.status || null,
    };
  }

  /**
   * Submit end-of-day register closure.
   * Enforces zero-tolerance tender discrepancy policy and duplicate prevention.
   */
  static async submitDayClosure(organizationId, branchId, userId, payload) {
    if (!branchId || branchId === "all") {
      throw new AppError(
        "Select a specific branch to submit register closure.",
        400,
      );
    }

    const { businessDate, physicalCounts, discrepancyReason } = payload;

    const branch = await Branch.findById(branchId).lean();
    if (!branch) throw new AppError("Branch not found", 404);

    return runInTransaction(async (session) => {
      // 1. Concurrency guard: Duplicate prevention
      const existing = await DayClosure.findOne({
        organizationId,
        branchId,
        businessDate,
      }).session(session);

      if (existing) {
        throw new AppError(
          `Day closure for this branch and businessDate already exists (Status: ${existing.status}).`,
          409,
        );
      }

      // 2. Fetch authoritative expected collections
      const totalsResult = await FinanceService.getSystemTotals(
        organizationId,
        branchId,
        businessDate,
      );
      const expected = totalsResult.systemTotals;

      const physicalCashPaise = Math.round(
        (Number(physicalCounts.cash) || 0) * 100,
      );
      const physicalCardPaise = Math.round(
        (Number(physicalCounts.card) || 0) * 100,
      );
      const physicalUpiPaise = Math.round(
        (Number(physicalCounts.upi) || 0) * 100,
      );
      const physicalOtherPaise = Math.round(
        (Number(physicalCounts.other) || 0) * 100,
      );

      const expectedCashPaise = Math.round(expected.cash * 100);
      const expectedCardPaise = Math.round(expected.card * 100);
      const expectedUpiPaise = Math.round(expected.upi * 100);
      const expectedOtherPaise = Math.round(expected.other * 100);

      const cashDeltaPaise = physicalCashPaise - expectedCashPaise;
      const cardDeltaPaise = physicalCardPaise - expectedCardPaise;
      const upiDeltaPaise = physicalUpiPaise - expectedUpiPaise;
      const otherDeltaPaise = physicalOtherPaise - expectedOtherPaise;

      const totalCountedPaise =
        physicalCashPaise +
        physicalCardPaise +
        physicalUpiPaise +
        physicalOtherPaise;
      const netExpectedPaise = Math.round(expected.netExpected * 100);
      const totalDeltaPaise = totalCountedPaise - netExpectedPaise;

      // Tender-level zero delta check: Offsetting discrepancies are strictly NOT balanced
      const isBalanced =
        cashDeltaPaise === 0 &&
        cardDeltaPaise === 0 &&
        upiDeltaPaise === 0 &&
        otherDeltaPaise === 0;

      if (!isBalanced && (!discrepancyReason || !discrepancyReason.trim())) {
        throw new AppError(
          "A non-empty discrepancy reason is required when any tender delta is non-zero.",
          400,
        );
      }

      const closureDocs = await DayClosure.create(
        [
          {
            organizationId,
            branchId,
            businessDate,
            branchTimezone: branch.timezone || "Asia/Kolkata",
            submittedBy: userId,
            status: "submitted",
            reconciliationResult: isBalanced ? "balanced" : "discrepant",
            systemTotals: {
              cash: expected.cash,
              card: expected.card,
              upi: expected.upi,
              other: expected.other,
              totalCollected: expected.totalCollected,
              totalRefunded: expected.totalRefunded,
              netExpected: expected.netExpected,
            },
            physicalCounts: {
              cash: physicalCashPaise / 100,
              card: physicalCardPaise / 100,
              upi: physicalUpiPaise / 100,
              other: physicalOtherPaise / 100,
              totalCounted: totalCountedPaise / 100,
            },
            discrepancy: {
              cashDelta: cashDeltaPaise / 100,
              cardDelta: cardDeltaPaise / 100,
              upiDelta: upiDeltaPaise / 100,
              otherDelta: otherDeltaPaise / 100,
              totalDelta: totalDeltaPaise / 100,
              reason: isBalanced ? "" : discrepancyReason.trim(),
            },
          },
        ],
        { session },
      );

      const createdDoc = closureDocs[0].toObject
        ? closureDocs[0].toObject()
        : closureDocs[0];
      createdDoc.id = createdDoc._id.toString();
      await emitFinanceDayClosureOutboxEvent({
        eventType: "finance.day_closure_submitted",
        closure: createdDoc,
        session,
      });
      return createdDoc;
    });
  }

  /**
   * Manager approval of day closure.
   */
  static async approveDayClosure(
    organizationId,
    closureId,
    branchId,
    managerUserId,
    managerNotes = "",
  ) {
    return await runInTransaction(async (session) => {
      const filter = { _id: closureId, organizationId };
      if (branchId && branchId !== "all") filter.branchId = branchId;

      const closure = await DayClosure.findOne(filter).session(session);
      if (!closure) throw new AppError("Day closure not found", 404);

      if (closure.status === "approved") {
        throw new AppError("Day closure is already approved.", 400);
      }

      // Enforce separation of duties: Submitter cannot approve their own register closure
      if (
        closure.submittedBy &&
        closure.submittedBy.toString() === managerUserId.toString()
      ) {
        throw new AppError(
          "Separation of duties: User cannot approve their own submitted day closure.",
          403,
        );
      }

      closure.status = "approved";
      closure.approvedBy = managerUserId;
      closure.approvedAt = new Date();
      closure.managerNotes = managerNotes ? managerNotes.trim() : "";

      await closure.save({ session });
      await emitFinanceDayClosureOutboxEvent({
        eventType: "finance.day_closure_approved",
        closure,
        session,
      });
      return closure;
    }, { requireTransaction: true });
  }

  /**
   * List closures with pagination and filters.
   */
  static async listDayClosures(organizationId, branchId, query = {}) {
    const filter = { organizationId };
    if (branchId && branchId !== "all") filter.branchId = branchId;

    if (query.startDate || query.endDate) {
      filter.businessDate = {};
      if (query.startDate) filter.businessDate.$gte = query.startDate;
      if (query.endDate) filter.businessDate.$lte = query.endDate;
    }
    if (query.status) filter.status = query.status;
    if (query.reconciliationResult) {
      filter.reconciliationResult = query.reconciliationResult;
    }

    const page = Math.max(1, parseInt(query.page, 10) || 1);
    const limit = Math.max(1, Math.min(100, parseInt(query.limit, 10) || 20));
    const skip = (page - 1) * limit;

    const [items, total] = await Promise.all([
      DayClosure.find(filter)
        .sort({ businessDate: -1, _id: -1 })
        .skip(skip)
        .limit(limit)
        .populate("submittedBy", "name email")
        .populate("approvedBy", "name email")
        .populate("branchId", "name timezone")
        .lean(),
      DayClosure.countDocuments(filter),
    ]);

    return {
      items: items.map((doc) => {
        doc.id = doc._id.toString();
        return doc;
      }),
      pagination: {
        page,
        limit,
        total,
        totalPages: Math.ceil(total / limit) || 1,
      },
    };
  }

  /**
   * Single closure details.
   */
  static async getDayClosureById(organizationId, closureId, branchId = null) {
    const filter = { _id: closureId, organizationId };
    if (branchId && branchId !== "all") filter.branchId = branchId;

    const closure = await DayClosure.findOne(filter)
      .populate("submittedBy", "name email")
      .populate("approvedBy", "name email")
      .populate("branchId", "name timezone")
      .lean();

    if (!closure) throw new AppError("Day closure not found", 404);
    closure.id = closure._id.toString();
    return closure;
  }

  /**
   * Operating Result (Qualified P&L) Aggregation.
   *
   * Formulations:
   * 1. Gross Revenue = Finalized Invoices in period.
   *    - Reconciled line-level stream distribution: Services, Retail Products, Memberships, Subscriptions.
   * 2. Refunds = Completed Payment Refunds in period (Payment.paymentDate).
   * 3. Net Revenue = Gross Invoiced - Customer Refunds.
   * 4. Cash Collections = Completed Payment Inflows by tender (Cash, Card, UPI, Other) minus tender refunds.
   * 5. Operating Overhead = Approved Expenses in period (Expense.expenseDate).
   *    - Non-stock procurement-linked expenses (sourceType: 'procurement_invoice') are preserved.
   * 6. Workforce Labor Cost = Finalized Payroll Records (PayrollRecord.status in ['approved', 'paid'])
   *    - Uses calculations.totalGrossPay which includes basic, allowances, and incentives.
   * 7. Qualified Operating Result = Net Revenue - (Operating Overhead + Finalized Payroll).
   */
  static async getOperatingProfit(
    organizationId,
    branchId,
    startDateStr,
    endDateStr,
  ) {
    const branch =
      branchId && branchId !== "all"
        ? await Branch.findById(branchId).lean()
        : null;
    const timezone = branch?.timezone || "Asia/Kolkata";

    const { startUtc } = FinanceService.getBranchDayBounds(
      startDateStr,
      timezone,
    );
    const { endUtc } = FinanceService.getBranchDayBounds(endDateStr, timezone);

    const orgId = new mongoose.Types.ObjectId(organizationId);
    const branchFilter =
      branchId && branchId !== "all"
        ? { branchId: new mongoose.Types.ObjectId(branchId) }
        : {};

    // -------------------------------------------------------------
    // 1. Gross Finalized Invoices & Revenue Stream Breakdown
    // -------------------------------------------------------------
    const invoiceMatch = {
      organizationId: orgId,
      ...branchFilter,
      status: "finalized",
      isDeleted: false,
      $or: [
        { finalizedAt: { $gte: startUtc, $lte: endUtc } },
        { finalizedAt: null, createdAt: { $gte: startUtc, $lte: endUtc } },
      ],
    };

    const [invoiceAgg, streamAgg] = await Promise.all([
      Invoice.aggregate([
        { $match: invoiceMatch },
        {
          $group: {
            _id: null,
            grossPaise: {
              $sum: { $round: [{ $multiply: ["$payableAmount", 100] }, 0] },
            },
            invoiceCount: { $sum: 1 },
          },
        },
      ]),
      Invoice.aggregate([
        { $match: invoiceMatch },
        { $unwind: "$lines" },
        {
          $group: {
            _id: "$lines.lineType",
            streamPaise: {
              $sum: {
                $round: [
                  {
                    $multiply: [
                      {
                        $ifNull: ["$lines.customerPayable", "$lines.lineTotal"],
                      },
                      100,
                    ],
                  },
                  0,
                ],
              },
            },
          },
        },
      ]),
    ]);

    const grossRevenuePaise = invoiceAgg[0]?.grossPaise || 0;
    const invoiceCount = invoiceAgg[0]?.invoiceCount || 0;

    const streams = {
      services: 0,
      retailProducts: 0,
      memberships: 0,
      subscriptions: 0,
    };

    for (const row of streamAgg) {
      const paise = row.streamPaise || 0;
      if (row._id === "service") streams.services += paise;
      else if (row._id === "product") streams.retailProducts += paise;
      else if (row._id === "membership") streams.memberships += paise;
      else if (row._id === "subscription") streams.subscriptions += paise;
    }

    // -------------------------------------------------------------
    // 2. Authoritative Completed Customer Refunds & Tender Collections
    // -------------------------------------------------------------
    const paymentMatch = {
      organizationId: orgId,
      ...branchFilter,
      status: "completed",
      isDeleted: false,
      paymentDate: { $gte: startUtc, $lte: endUtc },
    };

    const paymentAgg = await Payment.aggregate([
      { $match: paymentMatch },
      {
        $group: {
          _id: { type: "$type", method: "$method" },
          totalPaise: {
            $sum: { $round: [{ $multiply: [{ $abs: "$amount" }, 100] }, 0] },
          },
          count: { $sum: 1 },
        },
      },
    ]);

    let refundPaise = 0;
    let collectionsPaise = 0;
    const tenders = { cash: 0, card: 0, upi: 0, other: 0 };

    for (const row of paymentAgg) {
      const type = row._id.type;
      const method = row._id.method;
      const paise = row.totalPaise;

      if (type === "refund") {
        refundPaise += paise;
        if (method === "cash") tenders.cash -= paise;
        else if (method === "card") tenders.card -= paise;
        else if (method === "upi") tenders.upi -= paise;
        else tenders.other -= paise;
      } else if (type === "payment") {
        collectionsPaise += paise;
        if (method === "cash") tenders.cash += paise;
        else if (method === "card") tenders.card += paise;
        else if (method === "upi") tenders.upi += paise;
        else tenders.other += paise;
      }
    }

    const netRevenuePaise = grossRevenuePaise - refundPaise;

    // -------------------------------------------------------------
    // 3. Approved Operating Overhead (Expenses)
    // Excludes inventory stock procurement expenses (sourceType: 'procurement_invoice' with stock/inventory categories)
    // and procurement liability settlements (sourceType: 'procurement_payment')
    // to strictly prevent double counting stock purchases with supplier payables,
    // while PRESERVING legitimate non-stock operational procurement costs (maintenance, cleaning, utilities, etc.).
    // -------------------------------------------------------------
    const expenseMatch = {
      organizationId: orgId,
      ...branchFilter,
      approvalStatus: "approved",
      isDeleted: false,
      $nor: [
        {
          sourceType: "procurement_invoice",
          category: {
            $in: [
              "supplies",
              "inventory_purchase",
              "inventory",
              "stock",
              "retail_products",
              "salon_consumables",
            ],
          },
        },
        { sourceType: "procurement_payment" },
      ],
      expenseDate: { $gte: startUtc, $lte: endUtc },
    };

    const expenseAgg = await Expense.aggregate([
      { $match: expenseMatch },
      {
        $group: {
          _id: "$category",
          categoryPaise: {
            $sum: { $round: [{ $multiply: ["$amount", 100] }, 0] },
          },
        },
      },
    ]);

    const operatingExpenses = {};
    let totalExpensePaise = 0;
    for (const row of expenseAgg) {
      operatingExpenses[row._id] = row.categoryPaise / 100;
      totalExpensePaise += row.categoryPaise;
    }

    // -------------------------------------------------------------
    // 4. Authoritative Finalized Workforce Compensation (Payroll)
    // -------------------------------------------------------------
    // Derive monthYear strings falling within this date range
    const startMY = startDateStr.substring(0, 7);
    const endMY = endDateStr.substring(0, 7);

    const payrollMatch = {
      organizationId: orgId,
      ...branchFilter,
      status: { $in: ["approved", "paid"] },
      isDeleted: false,
      monthYear: { $gte: startMY, $lte: endMY },
    };

    const payrollAgg = await PayrollRecord.aggregate([
      { $match: payrollMatch },
      {
        $group: {
          _id: null,
          totalGrossPaise: {
            $sum: {
              $round: [{ $multiply: ["$calculations.totalGrossPay", 100] }, 0],
            },
          },
          approvedStaffCount: { $sum: 1 },
        },
      },
    ]);

    const finalizedGrossPayrollPaise = payrollAgg[0]?.totalGrossPaise || 0;
    const approvedStaffCount = payrollAgg[0]?.approvedStaffCount || 0;

    // Actual confirmed payroll disbursements in period:
    // Amount is already in integer paise in PayrollPayment.amountInPaise
    const disbursedAgg = await PayrollPayment.aggregate([
      {
        $match: {
          organizationId: orgId,
          ...branchFilter,
          status: "confirmed",
          paymentDate: { $gte: startUtc, $lte: endUtc },
        },
      },
      {
        $group: {
          _id: null,
          totalPaise: { $sum: "$amountInPaise" },
          disbursedCount: { $sum: 1 },
        },
      },
    ]);
    const actualDisbursedPayrollPaise = disbursedAgg[0]?.totalPaise || 0;
    const disbursedPaymentsCount = disbursedAgg[0]?.disbursedCount || 0;

    // -------------------------------------------------------------
    // 4b. Inventory Cost of Goods Sold (COGS) & Stock Shrinkage Aggregation
    // Considers service_consumption, pos_sale, negative adjustments (stock losses), and movement reversals.
    // Movement reversals subtract from COGS in their authoritative accounting period.
    // -------------------------------------------------------------
    const cogsMatch = {
      organizationId: orgId,
      ...branchFilter,
      $or: [
        { movementType: { $in: ["service_consumption", "pos_sale", "movement_reversal"] } },
        { movementType: "adjustment", quantityDelta: { $lt: 0 } },
      ],
      accountingDate: { $gte: startUtc, $lte: endUtc },
    };

    const cogsAgg = await StockMovement.aggregate([
      { $match: cogsMatch },
      {
        $group: {
          _id: null,
          totalValuedCostPaise: {
            $sum: {
              $cond: [
                { $eq: ["$movementType", "movement_reversal"] },
                { $multiply: [{ $ifNull: ["$totalCostPaise", 0] }, -1] },
                { $ifNull: ["$totalCostPaise", 0] },
              ],
            },
          },
          totalValuedQuantityMilli: {
            $sum: {
              $cond: [
                { $eq: ["$movementType", "movement_reversal"] },
                { $multiply: [{ $ifNull: ["$valuedQuantityMilli", 0] }, -1] },
                { $ifNull: ["$valuedQuantityMilli", 0] },
              ],
            },
          },
          totalUnvaluedQuantityMilli: {
            $sum: {
              $cond: [
                { $eq: ["$movementType", "movement_reversal"] },
                { $multiply: [{ $ifNull: ["$unvaluedQuantityMilli", 0] }, -1] },
                { $ifNull: ["$unvaluedQuantityMilli", 0] },
              ],
            },
          },
          unvaluedMovementCount: {
            $sum: {
              $cond: [
                {
                  $and: [
                    { $gt: [{ $ifNull: ["$unvaluedQuantityMilli", 0] }, 0] },
                    { $ne: ["$movementType", "movement_reversal"] },
                  ],
                },
                1,
                0,
              ],
            },
          },
        },
      },
    ]);

    const cogsPaise = Math.max(0, cogsAgg[0]?.totalValuedCostPaise || 0);
    const valuedStockConsumptionUnits = (cogsAgg[0]?.totalValuedQuantityMilli || 0) / 1000;
    const unvaluedStockConsumptionUnits = (cogsAgg[0]?.totalUnvaluedQuantityMilli || 0) / 1000;
    const unvaluedMovementsCount = cogsAgg[0]?.unvaluedMovementCount || 0;
    const isCogsFullyValued = unvaluedMovementsCount === 0;

    // -------------------------------------------------------------
    // 5. Qualified Operating Result Calculation
    // Total recognized costs = Operating Expenses + Gross Payroll + Valued COGS
    // -------------------------------------------------------------
    const recognizedCostsPaise = totalExpensePaise + finalizedGrossPayrollPaise + cogsPaise;
    const operatingResultPaise = netRevenuePaise - recognizedCostsPaise;
    const operatingMarginPercentage =
      netRevenuePaise > 0
        ? Number(((operatingResultPaise / netRevenuePaise) * 100).toFixed(2))
        : 0;

    const costCoverageNotice = isCogsFullyValued
      ? (cogsPaise > 0
          ? "Operating Result reflects Net Revenue minus Approved Operating Expenses, Finalized Gross Payroll, and FIFO Valued Stock Consumption (COGS)."
          : "Operating Result reflects Net Revenue minus Approved Operating Expenses and Finalized Gross Payroll (No stock consumption recorded).")
      : `Operating Result (Before Unvalued Stock Consumption): ${unvaluedStockConsumptionUnits.toFixed(3)} units consumed across ${unvaluedMovementsCount} movements without purchase lot valuation. Unknown cost is not treated as zero cost.`;

    return {
      period: { startDate: startDateStr, endDate: endDateStr, timezone },
      costCoverageNotice,
      isCogsFullyValued,
      grossRevenue: grossRevenuePaise / 100,
      refunds: refundPaise / 100,
      netRevenue: netRevenuePaise / 100,
      invoiceCount,
      revenueStreams: {
        services: streams.services / 100,
        retailProducts: streams.retailProducts / 100,
        memberships: streams.memberships / 100,
        subscriptions: streams.subscriptions / 100,
      },
      collections: {
        cash: tenders.cash / 100,
        card: tenders.card / 100,
        upi: tenders.upi / 100,
        other: tenders.other / 100,
        totalCollected: collectionsPaise / 100,
        netCollections: (collectionsPaise - refundPaise) / 100,
      },
      operatingExpenses: {
        ...operatingExpenses,
        total: totalExpensePaise / 100,
      },
      workforceCosts: {
        finalizedGrossPayroll: finalizedGrossPayrollPaise / 100,
        approvedStaffCount,
        actualDisbursedPayroll: actualDisbursedPayrollPaise / 100,
        disbursedPaymentsCount,
      },
      inventoryCost: {
        cogs: cogsPaise / 100,
        cogsPaise,
        valuedConsumptionUnits: valuedStockConsumptionUnits,
        unvaluedConsumptionUnits: unvaluedStockConsumptionUnits,
        unvaluedMovementsCount,
        isFullyValued: isCogsFullyValued,
      },
      operatingProfit: operatingResultPaise / 100, // Preserved field for backward compatibility
      operatingResult: operatingResultPaise / 100,
      operatingMarginPercentage,
    };
  }

  /**
   * Financial Overview Alerts & Outstanding Obligations.
   *
   * Surfaces:
   * 1. Pending Expense Approvals (vouchers awaiting manager sign-off)
   * 2. Day Closure Drawer Discrepancies (unreconciled cash/card registers)
   * 3. Outstanding Supplier Obligations (unpaid or partially paid supplier invoices from Procurement)
   * 4. Outstanding Salary Obligations (approved payrolls awaiting disbursement from Payroll)
   */
  static async getFinancialAlertsAndObligations(
    organizationId,
    branchId = null,
  ) {
    const orgId = new mongoose.Types.ObjectId(organizationId);
    const branchFilter =
      branchId && branchId !== "all"
        ? { branchId: new mongoose.Types.ObjectId(branchId) }
        : {};

    const [
      pendingExpensesAgg,
      discrepantClosuresAgg,
      supplierInvoicesAgg,
      salaryObligationsAgg,
    ] = await Promise.all([
      // 1. Pending Expense Approvals
      Expense.aggregate([
        {
          $match: {
            organizationId: orgId,
            ...branchFilter,
            approvalStatus: "pending_approval",
            isDeleted: false,
          },
        },
        {
          $group: {
            _id: null,
            count: { $sum: 1 },
            totalPaise: {
              $sum: { $round: [{ $multiply: ["$amount", 100] }, 0] },
            },
          },
        },
      ]),

      // 2. Drawer Discrepancies in submitted or unreconciled closures
      DayClosure.aggregate([
        {
          $match: {
            organizationId: orgId,
            ...branchFilter,
            reconciliationResult: "discrepant",
            status: "submitted",
          },
        },
        {
          $group: {
            _id: null,
            count: { $sum: 1 },
            totalDiscrepancyPaise: {
              $sum: {
                $round: [
                  { $multiply: [{ $abs: "$discrepancy.totalDelta" }, 100] },
                  0,
                ],
              },
            },
          },
        },
      ]),

      // 3. Outstanding Supplier Invoices (Procurement)
      // Authoritatively reconciles against actual SupplierPayment ledger while preserving support
      // for legacy records with cached amountPaid. Excludes cancelled invoices.
      SupplierInvoice.aggregate([
        {
          $match: {
            organizationId: orgId,
            ...branchFilter,
            status: { $in: ["unpaid", "partially_paid"] },
          },
        },
        {
          $lookup: {
            from: "supplierpayments",
            let: { invoiceId: "$_id" },
            pipeline: [
              {
                $match: {
                  $expr: {
                    $eq: ["$supplierInvoiceId", "$$invoiceId"],
                  },
                },
              },
              {
                $group: {
                  _id: null,
                  totalPaidPaise: {
                    $sum: { $round: [{ $multiply: ["$amount", 100] }, 0] },
                  },
                  count: { $sum: 1 },
                },
              },
            ],
            as: "payments",
          },
        },
        {
          $addFields: {
            actualPaidPaise: {
              $ifNull: [{ $arrayElemAt: ["$payments.totalPaidPaise", 0] }, 0],
            },
            paymentsCount: {
              $ifNull: [{ $arrayElemAt: ["$payments.count", 0] }, 0],
            },
            totalAmountPaise: {
              $round: [{ $multiply: ["$totalAmount", 100] }, 0],
            },
            cachedAmountPaidPaise: {
              $round: [{ $multiply: [{ $ifNull: ["$amountPaid", 0] }, 100] }, 0],
            },
          },
        },
        {
          $addFields: {
            effectivePaidPaise: {
              $cond: [
                { $gt: ["$paymentsCount", 0] },
                "$actualPaidPaise",
                "$cachedAmountPaidPaise",
              ],
            },
          },
        },
        {
          $addFields: {
            outstandingPaise: {
              $max: [
                0,
                { $subtract: ["$totalAmountPaise", "$effectivePaidPaise"] },
              ],
            },
          },
        },
        {
          $match: {
            outstandingPaise: { $gt: 0 },
          },
        },
        {
          $group: {
            _id: null,
            count: { $sum: 1 },
            totalPayablePaise: { $sum: "$outstandingPaise" },
          },
        },
      ]),

      // 4. Outstanding Approved Payrolls Awaiting Settlement
      // In accordance with authoritative Payroll payment lifecycle:
      // Reconciles approved and paid payroll records against confirmed PayrollPayment disbursements.
      // Correctly accounts for partial payments (reducing net payable by confirmed amount),
      // in-flight attempts, failures, and reversals (which do not reduce obligations).
      PayrollRecord.aggregate([
        {
          $match: {
            organizationId: orgId,
            ...branchFilter,
            status: { $in: ["approved", "paid"] },
            isDeleted: false,
          },
        },
        {
          $lookup: {
            from: "payrollpayments",
            let: { recordId: "$_id" },
            pipeline: [
              {
                $match: {
                  $expr: {
                    $and: [
                      { $eq: ["$payrollRecordId", "$$recordId"] },
                      { $eq: ["$status", "confirmed"] },
                    ],
                  },
                },
              },
              {
                $group: {
                  _id: null,
                  confirmedPaise: { $sum: "$amountInPaise" },
                  count: { $sum: 1 },
                },
              },
            ],
            as: "confirmedPayments",
          },
        },
        {
          $addFields: {
            confirmedPaymentsPaise: {
              $ifNull: [
                { $arrayElemAt: ["$confirmedPayments.confirmedPaise", 0] },
                0,
              ],
            },
            confirmedPaymentsCount: {
              $ifNull: [
                { $arrayElemAt: ["$confirmedPayments.count", 0] },
                0,
              ],
            },
            netPayablePaise: {
              $round: [{ $multiply: ["$calculations.netPayable", 100] }, 0],
            },
          },
        },
        {
          $addFields: {
            effectiveDisbursedPaise: {
              $cond: [
                { $gt: ["$confirmedPaymentsCount", 0] },
                "$confirmedPaymentsPaise",
                {
                  $cond: [
                    {
                      $and: [
                        { $eq: ["$status", "paid"] },
                        { $eq: ["$manualPaymentStatus", "confirmed"] },
                      ],
                    },
                    {
                      $ifNull: [
                        "$manualPaymentAmountInPaise",
                        "$netPayablePaise",
                      ],
                    },
                    0,
                  ],
                },
              ],
            },
          },
        },
        {
          $addFields: {
            outstandingPaise: {
              $max: [
                0,
                { $subtract: ["$netPayablePaise", "$effectiveDisbursedPaise"] },
              ],
            },
          },
        },
        {
          $match: {
            outstandingPaise: { $gt: 0 },
          },
        },
        {
          $group: {
            _id: null,
            count: { $sum: 1 },
            totalPayablePaise: { $sum: "$outstandingPaise" },
          },
        },
      ]),
    ]);

    return {
      pendingExpenseApprovals: {
        count: pendingExpensesAgg[0]?.count || 0,
        totalAmount: (pendingExpensesAgg[0]?.totalPaise || 0) / 100,
      },
      unreconciledClosures: {
        count: discrepantClosuresAgg[0]?.count || 0,
        totalDiscrepancy:
          (discrepantClosuresAgg[0]?.totalDiscrepancyPaise || 0) / 100,
      },
      outstandingSupplierInvoices: {
        count: supplierInvoicesAgg[0]?.count || 0,
        totalUnpaidAmount:
          (supplierInvoicesAgg[0]?.totalPayablePaise || 0) / 100,
      },
      outstandingPayrollObligations: {
        count: salaryObligationsAgg[0]?.count || 0,
        totalUnpaidAmount:
          (salaryObligationsAgg[0]?.totalPayablePaise || 0) / 100,
      },
    };
  }

  /**
   * Branch-by-branch financial performance comparison matrix.
   * If branchId is passed (e.g. branch-scoped user), returns only that authorized branch.
   * If branchId is omitted (org-wide Owner), computes side-by-side performance across all active branches.
   */
  static async getBranchPerformance(
    organizationId,
    branchId,
    startDateStr,
    endDateStr,
    options = {},
  ) {
    const orgId = new mongoose.Types.ObjectId(organizationId);

    let branches = [];
    if (branchId && branchId !== "all") {
      const b = await Branch.findOne({
        _id: new mongoose.Types.ObjectId(branchId),
        organizationId: orgId,
        isActive: true,
      }).lean();
      if (!b) throw new AppError("Branch not found", 404);
      branches = [b];
    } else {
      branches = await Branch.find({ organizationId: orgId, isActive: true })
        .sort({ name: 1 })
        .lean();
    }

    const branchResults = await Promise.all(
      branches.map(async (branch) => {
        const profit = await FinanceService.getOperatingProfit(
          organizationId,
          branch._id.toString(),
          startDateStr,
          endDateStr,
        );

        const alerts = await FinanceService.getFinancialAlertsAndObligations(
          organizationId,
          branch._id.toString(),
        );

        return {
          branchId: branch._id.toString(),
          branchName: branch.name,
          branchCode: branch.code || "",
          timezone: branch.timezone || "Asia/Kolkata",
          grossRevenue: profit.grossRevenue,
          refunds: profit.refunds,
          netRevenue: profit.netRevenue,
          invoiceCount: profit.invoiceCount || 0,
          revenueStreams: profit.revenueStreams,
          collections: profit.collections,
          operatingExpenses: profit.operatingExpenses.total,
          finalizedGrossPayroll:
            profit.workforceCosts?.finalizedGrossPayroll || 0,
          actualDisbursedPayroll:
            profit.workforceCosts?.actualDisbursedPayroll || 0,
          operatingResult:
            profit.operatingResult ?? profit.operatingProfit ?? 0,
          operatingMarginPercentage: profit.operatingMarginPercentage,
          unreconciledClosuresCount: alerts.unreconciledClosures.count,
          pendingExpenseApprovalsCount: alerts.pendingExpenseApprovals.count,
        };
      }),
    );

    let totalGrossPaise = 0;
    let totalRefundsPaise = 0;
    let totalNetPaise = 0;
    let totalInvoices = 0;
    let totalCollectedPaise = 0;
    let totalExpensesPaise = 0;
    let totalPayrollPaise = 0;
    let totalDisbursedPayrollPaise = 0;
    let totalOperatingResultPaise = 0;

    for (const br of branchResults) {
      totalGrossPaise += Math.round(br.grossRevenue * 100);
      totalRefundsPaise += Math.round(br.refunds * 100);
      totalNetPaise += Math.round(br.netRevenue * 100);
      totalInvoices += br.invoiceCount;
      totalCollectedPaise += Math.round(br.collections.totalCollected * 100);
      totalExpensesPaise += Math.round(br.operatingExpenses * 100);
      totalPayrollPaise += Math.round(br.finalizedGrossPayroll * 100);
      totalDisbursedPayrollPaise += Math.round(br.actualDisbursedPayroll * 100);
      totalOperatingResultPaise += Math.round(br.operatingResult * 100);
    }

    const consolidatedNet = totalNetPaise / 100;
    const consolidatedMargin =
      consolidatedNet > 0
        ? Number(((totalOperatingResultPaise / totalNetPaise) * 100).toFixed(2))
        : 0;

    const consolidated = {
      grossRevenue: totalGrossPaise / 100,
      refunds: totalRefundsPaise / 100,
      netRevenue: consolidatedNet,
      invoiceCount: totalInvoices,
      totalCollected: totalCollectedPaise / 100,
      operatingExpenses: totalExpensesPaise / 100,
      finalizedGrossPayroll: totalPayrollPaise / 100,
      actualDisbursedPayroll: totalDisbursedPayrollPaise / 100,
      operatingResult: totalOperatingResultPaise / 100,
      operatingMarginPercentage: consolidatedMargin,
    };

    const total = branchResults.length;
    const limit = Math.min(100, Math.max(1, Number(options.limit) || 20));
    const totalPages = Math.max(1, Math.ceil(total / limit));
    const page = Math.min(totalPages, Math.max(1, Number(options.page) || 1));
    const startIdx = (page - 1) * limit;
    const paginatedBranches = branchResults.slice(startIdx, startIdx + limit);

    return {
      period: { startDate: startDateStr, endDate: endDateStr },
      branches: paginatedBranches,
      consolidated,
      pagination: {
        page,
        limit,
        total,
        totalPages,
      },
    };
  }

  /**
   * Search unified financial transactions across Payments, Refunds, Expenses, Petty Cash, Payroll, and Supplier Payments.
   * Guarantees deterministic global sorting and real server-side pagination with accurate totals.
   */
  static async getTransactions(organizationId, branchId, query = {}) {
    const orgId = new mongoose.Types.ObjectId(organizationId);
    const branchFilter =
      branchId && branchId !== "all"
        ? { branchId: new mongoose.Types.ObjectId(branchId) }
        : {};

    let dateMatch = {};
    if (query.startDate || query.endDate) {
      const start = query.startDate || "2020-01-01";
      const end = query.endDate || "2099-12-31";
      const { startUtc } = FinanceService.getBranchDayBounds(
        start,
        "Asia/Kolkata",
      );
      const { endUtc } = FinanceService.getBranchDayBounds(end, "Asia/Kolkata");
      dateMatch = { $gte: startUtc, $lte: endUtc };
    }

    const paymentDateMatch = Object.keys(dateMatch).length
      ? { paymentDate: dateMatch }
      : {};
    const expenseDateMatch = Object.keys(dateMatch).length
      ? { expenseDate: dateMatch }
      : {};
    const pettyCashDateMatch = Object.keys(dateMatch).length
      ? { transactionDate: dateMatch }
      : {};
    const payrollDateMatch = Object.keys(dateMatch).length
      ? { paymentDate: dateMatch }
      : {};
    const supplierDateMatch = Object.keys(dateMatch).length
      ? { paymentDate: dateMatch }
      : {};

    const page = Math.max(1, parseInt(query.page, 10) || 1);
    const limit = Math.max(1, Math.min(100, parseInt(query.limit, 10) || 20));
    const skip = (page - 1) * limit;

    const unifiedMatchFilters = [];
    if (query.type && query.type !== "all") {
      unifiedMatchFilters.push({ sourceType: query.type });
    }
    if (query.method && query.method !== "all") {
      unifiedMatchFilters.push({ method: query.method });
    }
    if (query.minAmount !== undefined && query.minAmount !== null) {
      unifiedMatchFilters.push({ amount: { $gte: Number(query.minAmount) } });
    }
    if (query.maxAmount !== undefined && query.maxAmount !== null) {
      unifiedMatchFilters.push({ amount: { $lte: Number(query.maxAmount) } });
    }
    if (query.search && query.search.trim()) {
      const regex = new RegExp(query.search.trim(), "i");
      unifiedMatchFilters.push({
        $or: [
          { referenceNumber: regex },
          { description: regex },
          { category: regex },
        ],
      });
    }

    const postFilterStage = unifiedMatchFilters.length
      ? [{ $match: { $and: unifiedMatchFilters } }]
      : [];

    const pipeline = [
      {
        $match: {
          organizationId: orgId,
          ...branchFilter,
          status: "completed",
          isDeleted: false,
          ...paymentDateMatch,
        },
      },
      {
        $project: {
          _id: 1,
          sourceType: {
            $cond: [
              { $eq: ["$type", "refund"] },
              "customer_refund",
              "customer_payment",
            ],
          },
          sourceId: "$_id",
          organizationId: 1,
          branchId: 1,
          eventDate: "$paymentDate",
          amount: { $abs: "$amount" },
          amountPaise: {
            $round: [{ $multiply: [{ $abs: "$amount" }, 100] }, 0],
          },
          direction: {
            $cond: [{ $eq: ["$type", "refund"] }, "outflow", "inflow"],
          },
          method: "$method",
          category: {
            $cond: [{ $eq: ["$type", "refund"] }, "Refund", "POS Collection"],
          },
          referenceNumber: "$paymentNumber",
          description: { $ifNull: ["$referenceNote", "Customer Payment"] },
          status: "$status",
          sourceReferenceId: "$invoiceId",
          sourceModel: { $literal: "Payment" },
        },
      },
      {
        $unionWith: {
          coll: "expenses",
          pipeline: [
            {
              $match: {
                organizationId: orgId,
                ...branchFilter,
                isDeleted: false,
                ...expenseDateMatch,
              },
            },
            {
              $project: {
                _id: 1,
                sourceType: { $literal: "expense" },
                sourceId: "$_id",
                organizationId: 1,
                branchId: 1,
                eventDate: "$expenseDate",
                amount: "$amount",
                amountPaise: { $round: [{ $multiply: ["$amount", 100] }, 0] },
                direction: { $literal: "outflow" },
                method: "$paymentMethod",
                category: "$category",
                referenceNumber: "$expenseCode",
                description: {
                  $concat: [
                    "Payee: ",
                    { $ifNull: ["$payeeName", ""] },
                    " - ",
                    { $ifNull: ["$description", ""] },
                  ],
                },
                status: "$approvalStatus",
                sourceReferenceId: "$_id",
                sourceModel: { $literal: "Expense" },
              },
            },
          ],
        },
      },
      {
        $unionWith: {
          coll: "pettycashtransactions",
          pipeline: [
            {
              $match: {
                organizationId: orgId,
                ...branchFilter,
                ...pettyCashDateMatch,
              },
            },
            {
              $project: {
                _id: 1,
                sourceType: { $literal: "petty_cash" },
                sourceId: "$_id",
                organizationId: 1,
                branchId: 1,
                eventDate: "$transactionDate",
                amount: "$amount",
                amountPaise: { $round: [{ $multiply: ["$amount", 100] }, 0] },
                direction: {
                  $cond: [
                    {
                      $in: [
                        "$type",
                        ["replenishment", "payout_reversal", "opening_balance"],
                      ],
                    },
                    "inflow",
                    "outflow",
                  ],
                },
                method: { $literal: "cash" },
                category: "$type",
                referenceNumber: "$transactionNumber",
                description: {
                  $ifNull: ["$description", "Petty Cash Movement"],
                },
                status: { $literal: "completed" },
                sourceReferenceId: "$linkedExpenseId",
                sourceModel: { $literal: "PettyCashTransaction" },
              },
            },
          ],
        },
      },
      {
        $unionWith: {
          coll: "payrollpayments",
          pipeline: [
            {
              $match: {
                organizationId: orgId,
                ...branchFilter,
                ...payrollDateMatch,
              },
            },
            {
              $project: {
                _id: 1,
                sourceType: { $literal: "payroll_payment" },
                sourceId: "$_id",
                organizationId: 1,
                branchId: 1,
                eventDate: "$paymentDate",
                amount: { $divide: ["$amountInPaise", 100] },
                amountPaise: "$amountInPaise",
                direction: { $literal: "outflow" },
                method: "$paymentMethod",
                category: { $literal: "Payroll" },
                referenceNumber: "$paymentReference",
                description: { $literal: "Staff Salary Disbursement" },
                status: "$status",
                sourceReferenceId: "$payrollRecordId",
                sourceModel: { $literal: "PayrollPayment" },
              },
            },
          ],
        },
      },
      {
        $unionWith: {
          coll: "supplierpayments",
          pipeline: [
            {
              $match: {
                organizationId: orgId,
                ...branchFilter,
                ...supplierDateMatch,
              },
            },
            {
              $project: {
                _id: 1,
                sourceType: { $literal: "supplier_payment" },
                sourceId: "$_id",
                organizationId: 1,
                branchId: 1,
                eventDate: "$paymentDate",
                amount: "$amount",
                amountPaise: { $round: [{ $multiply: ["$amount", 100] }, 0] },
                direction: { $literal: "outflow" },
                method: "$paymentMethod",
                category: { $literal: "Supplier" },
                referenceNumber: "$paymentNumber",
                description: {
                  $ifNull: ["$referenceNote", "Supplier Bill Settlement"],
                },
                status: { $literal: "completed" },
                sourceReferenceId: "$supplierInvoiceId",
                sourceModel: { $literal: "SupplierPayment" },
              },
            },
          ],
        },
      },
      ...postFilterStage,
      {
        $facet: {
          totals: [
            {
              $group: {
                _id: null,
                totalCount: { $sum: 1 },
                totalInflowPaise: {
                  $sum: {
                    $cond: [
                      { $eq: ["$direction", "inflow"] },
                      "$amountPaise",
                      0,
                    ],
                  },
                },
                totalOutflowPaise: {
                  $sum: {
                    $cond: [
                      { $eq: ["$direction", "outflow"] },
                      "$amountPaise",
                      0,
                    ],
                  },
                },
              },
            },
          ],
          data: [
            { $sort: { eventDate: -1, sourceType: -1, _id: -1 } },
            { $skip: skip },
            { $limit: limit },
            {
              $lookup: {
                from: "branches",
                localField: "branchId",
                foreignField: "_id",
                as: "branchDoc",
              },
            },
            {
              $unwind: {
                path: "$branchDoc",
                preserveNullAndEmptyArrays: true,
              },
            },
            {
              $project: {
                _id: 0,
                id: { $toString: "$_id" },
                sourceType: 1,
                sourceId: { $toString: "$sourceId" },
                branchId: { $toString: "$branchId" },
                branchName: { $ifNull: ["$branchDoc.name", "Unknown Branch"] },
                eventDate: 1,
                amount: 1,
                direction: 1,
                method: 1,
                category: 1,
                referenceNumber: 1,
                description: 1,
                status: 1,
                sourceReferenceId: { $toString: "$sourceReferenceId" },
                sourceModel: 1,
              },
            },
          ],
        },
      },
    ];

    const results = await Payment.aggregate(pipeline);
    const facetTotals = results[0]?.totals[0] || {
      totalCount: 0,
      totalInflowPaise: 0,
      totalOutflowPaise: 0,
    };
    const items = results[0]?.data || [];

    const totalCount = facetTotals.totalCount;
    const totalInflow = facetTotals.totalInflowPaise / 100;
    const totalOutflow = facetTotals.totalOutflowPaise / 100;
    const netCashFlow =
      (facetTotals.totalInflowPaise - facetTotals.totalOutflowPaise) / 100;

    return {
      items,
      pagination: {
        page,
        limit,
        total: totalCount,
        totalPages: Math.ceil(totalCount / limit) || 1,
      },
      summary: {
        totalInflow,
        totalOutflow,
        netCashFlow,
      },
    };
  }

  /**
   * Consolidated financial audit history.
   * Aggregates day closure submissions/approvals, expense approvals/rejections, and petty cash operations.
   */
  static async getAuditHistory(organizationId, branchId, query = {}) {
    const orgId = new mongoose.Types.ObjectId(organizationId);
    const branchFilter =
      branchId && branchId !== "all"
        ? { branchId: new mongoose.Types.ObjectId(branchId) }
        : {};

    const page = Math.max(1, parseInt(query.page, 10) || 1);
    const limit = Math.max(1, Math.min(100, parseInt(query.limit, 10) || 20));
    const skip = (page - 1) * limit;

    let dateMatch = {};
    if (query.startDate || query.endDate) {
      const start = query.startDate || "2020-01-01";
      const end = query.endDate || "2099-12-31";
      const { startUtc } = FinanceService.getBranchDayBounds(
        start,
        "Asia/Kolkata",
      );
      const { endUtc } = FinanceService.getBranchDayBounds(end, "Asia/Kolkata");
      dateMatch = { $gte: startUtc, $lte: endUtc };
    }

    const closureMatch = Object.keys(dateMatch).length
      ? { createdAt: dateMatch }
      : {};
    const expenseMatch = Object.keys(dateMatch).length
      ? { updatedAt: dateMatch }
      : {};
    const pettyCashMatch = Object.keys(dateMatch).length
      ? { transactionDate: dateMatch }
      : {};

    // 1. Fetch Day Closure events
    const closures = await DayClosure.find({
      organizationId: orgId,
      ...branchFilter,
      ...closureMatch,
    })
      .populate("submittedBy", "name email")
      .populate("approvedBy", "name email")
      .populate("branchId", "name")
      .lean();

    const closureEvents = closures.map((c) => ({
      id: c._id.toString(),
      entityType: "day_closure",
      action: c.status === "approved" ? "approved" : "submitted",
      timestamp: c.approvedAt || c.submittedAt || c.createdAt,
      actorName:
        c.status === "approved"
          ? c.approvedBy?.name || "Manager"
          : c.submittedBy?.name || "Cashier",
      actorEmail:
        c.status === "approved"
          ? c.approvedBy?.email || ""
          : c.submittedBy?.email || "",
      branchName: c.branchId?.name || "Branch",
      referenceNumber: `CLOSURE-${c.businessDate}`,
      amount: Math.abs(c.discrepancy?.totalDelta || 0),
      noteOrReason:
        c.managerNotes ||
        c.discrepancy?.reason ||
        `Closure result: ${c.reconciliationResult}`,
      details: {
        businessDate: c.businessDate,
        status: c.status,
        previousState: c.status === "approved" ? "submitted" : "unsubmitted",
        newState: c.status,
        reconciliationResult: c.reconciliationResult,
        totalDelta: c.discrepancy?.totalDelta || 0,
      },
    }));

    // 2. Fetch Expense events (approvals, rejections, deletions)
    const expenses = await Expense.find({
      organizationId: orgId,
      ...branchFilter,
      approvalStatus: { $in: ["approved", "rejected"] },
      ...expenseMatch,
    })
      .populate("approvedBy", "name email")
      .populate("rejectedBy", "name email")
      .populate("branchId", "name")
      .lean();

    const expenseEvents = expenses.map((e) => ({
      id: e._id.toString(),
      entityType: "expense",
      action: e.approvalStatus === "approved" ? "approved" : "rejected",
      timestamp: e.approvedAt || e.rejectedAt || e.updatedAt,
      actorName:
        e.approvalStatus === "approved"
          ? e.approvedBy?.name || "Approver"
          : e.rejectedBy?.name || "Approver",
      actorEmail:
        e.approvalStatus === "approved"
          ? e.approvedBy?.email || ""
          : e.rejectedBy?.email || "",
      branchName: e.branchId?.name || "Branch",
      referenceNumber: e.expenseCode,
      amount: e.amount,
      noteOrReason:
        e.rejectionReason || e.description || `Expense ${e.category}`,
      details: {
        category: e.category,
        paymentMethod: e.paymentMethod,
        approvalStatus: e.approvalStatus,
        previousState: "pending_approval",
        newState: e.approvalStatus,
      },
    }));

    // 3. Fetch Petty Cash transactions (replenishments, reversals)
    const pettyCash = await PettyCashTransaction.find({
      organizationId: orgId,
      ...branchFilter,
      type: { $in: ["replenishment", "payout_reversal"] },
      ...pettyCashMatch,
    })
      .populate("recordedBy", "name email")
      .populate("branchId", "name")
      .lean();

    const pettyCashEvents = pettyCash.map((p) => ({
      id: p._id.toString(),
      entityType: "petty_cash",
      action: p.type === "replenishment" ? "replenished" : "recovered",
      timestamp: p.transactionDate || p.createdAt,
      actorName: p.recordedBy?.name || "User",
      actorEmail: p.recordedBy?.email || "",
      branchName: p.branchId?.name || "Branch",
      referenceNumber: p.transactionNumber,
      amount: p.amount,
      noteOrReason: p.description || `Petty Cash ${p.type}`,
      details: {
        type: p.type,
        previousState: "in_drawer",
        newState: p.type === "replenishment" ? "replenished" : "recovered",
      },
    }));

    // Filter by entityType if requested
    let allEvents = [...closureEvents, ...expenseEvents, ...pettyCashEvents];
    if (query.entityType && query.entityType !== "all") {
      allEvents = allEvents.filter((ev) => ev.entityType === query.entityType);
    }

    // Deterministic sort: timestamp desc, id desc
    allEvents.sort((a, b) => {
      const diff =
        new Date(b.timestamp).getTime() - new Date(a.timestamp).getTime();
      if (diff !== 0) return diff;
      return b.id.localeCompare(a.id);
    });

    const total = allEvents.length;
    const paginatedEvents = allEvents.slice(skip, skip + limit);

    return {
      items: paginatedEvents,
      pagination: {
        page,
        limit,
        total,
        totalPages: Math.ceil(total / limit) || 1,
      },
    };
  }

  /**
   * Financial Summary Reports and CSV Generation.
   */
  static async getFinancialReports(organizationId, branchId, query = {}) {
    const { reportType, startDate, endDate, format } = query;

    let reportData = null;
    let filename = `${reportType}-${startDate}-${endDate}`;

    if (reportType === "pnl_statement") {
      reportData = await FinanceService.getOperatingProfit(
        organizationId,
        branchId,
        startDate,
        endDate,
      );
      filename += ".pnl";
    } else if (reportType === "tender_reconciliation") {
      const closures = await DayClosure.find({
        organizationId,
        ...(branchId && branchId !== "all"
          ? { branchId: new mongoose.Types.ObjectId(branchId) }
          : {}),
        businessDate: { $gte: startDate, $lte: endDate },
      })
        .populate("branchId", "name")
        .sort({ businessDate: -1 })
        .lean();

      reportData = closures.map((c) => ({
        businessDate: c.businessDate,
        branchName: c.branchId?.name || "Branch",
        systemCash: c.systemTotals.cash,
        physicalCash: c.physicalCounts.cash,
        cashDelta: c.discrepancy.cashDelta,
        systemCard: c.systemTotals.card,
        physicalCard: c.physicalCounts.card,
        cardDelta: c.discrepancy.cardDelta,
        systemUpi: c.systemTotals.upi,
        physicalUpi: c.physicalCounts.upi,
        upiDelta: c.discrepancy.upiDelta,
        totalDelta: c.discrepancy.totalDelta,
        reconciliationResult: c.reconciliationResult,
        status: c.status,
        reason: c.discrepancy.reason || "",
      }));
    } else if (reportType === "expense_breakdown") {
      const expenses = await Expense.find({
        organizationId,
        ...(branchId && branchId !== "all"
          ? { branchId: new mongoose.Types.ObjectId(branchId) }
          : {}),
        approvalStatus: "approved",
        isDeleted: false,
        expenseDate: {
          $gte: new Date(`${startDate}T00:00:00.000Z`),
          $lte: new Date(`${endDate}T23:59:59.999Z`),
        },
      })
        .populate("branchId", "name")
        .sort({ expenseDate: -1 })
        .lean();

      reportData = expenses.map((e) => ({
        expenseCode: e.expenseCode,
        branchName: e.branchId?.name || "Branch",
        expenseDate: e.expenseDate.toISOString().slice(0, 10),
        category: e.category,
        amount: e.amount,
        paymentMethod: e.paymentMethod,
        payeeName: e.payeeName,
        description: e.description,
      }));
    } else if (reportType === "revenue_streams") {
      const profit = await FinanceService.getOperatingProfit(
        organizationId,
        branchId,
        startDate,
        endDate,
      );
      reportData = {
        period: profit.period,
        revenueStreams: profit.revenueStreams,
        collections: profit.collections,
        refunds: profit.refunds,
        netRevenue: profit.netRevenue,
      };
    }

    if (format === "csv") {
      let csvContent = "";
      if (Array.isArray(reportData) && reportData.length > 0) {
        const headers = Object.keys(reportData[0]);
        csvContent =
          headers.join(",") +
          "\n" +
          reportData
            .map((row) =>
              headers
                .map((h) => {
                  const val =
                    row[h] !== undefined && row[h] !== null
                      ? String(row[h])
                      : "";
                  return `"${val.replace(/"/g, '""')}"`;
                })
                .join(","),
            )
            .join("\n");
      } else if (reportData && typeof reportData === "object") {
        // Flat key-value dump for nested summary objects
        csvContent = "Metric,Value\n";
        for (const [k, v] of Object.entries(reportData)) {
          if (typeof v === "object" && v !== null) {
            for (const [subK, subV] of Object.entries(v)) {
              csvContent += `"${k}.${subK}","${String(subV)}"\n`;
            }
          } else {
            csvContent += `"${k}","${String(v)}"\n`;
          }
        }
      }

      return {
        format: "csv",
        filename: `${filename}.csv`,
        data: csvContent,
      };
    }

    return {
      format: "json",
      filename: `${filename}.json`,
      data: reportData,
    };
  }
}
