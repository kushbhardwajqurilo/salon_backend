import mongoose from "mongoose";
import { Invoice } from "../../models/billing/invoice.model.js";
import { Payment } from "../../models/billing/payment.model.js";
import { Appointment } from "../../models/appointments/appointment.model.js";
import { Customer } from "../../models/customers/customer.model.js";
import { StockBalance } from "../../models/inventory/stockBalance.model.js";
import { Product } from "../../models/inventory/product.model.js";
import { Branch } from "../../models/branches/branch.model.js";
import { Expense } from "../../models/expenses/expense.model.js";
import { CustomerMembership } from "../../models/memberships/customerMembership.model.js";
import { Subscription } from "../../models/subscriptions/subscription.model.js";
import { SubscriptionUsage } from "../../models/subscriptions/subscriptionUsage.model.js";
import { CouponUsage } from "../../models/coupons/couponUsage.model.js";
import { LoyaltyTransaction } from "../../models/loyalty/loyaltyTransaction.model.js";
import { PurchaseOrder } from "../../models/procurement/purchaseOrder.model.js";
import { SupplierInvoice } from "../../models/procurement/supplierInvoice.model.js";
import { PayrollRecord } from "../../models/payroll/payrollRecord.model.js";
import { IncentiveLedger } from "../../models/incentives/incentiveLedger.model.js";
import {
  resolveTimezone,
  getUTCDayRange,
  getComparisonDates,
  calculateMetricDelta,
  calculateRateDelta,
} from "../reports/reportCalculations.js";
import { logger } from "../../utils/logger.js";

/**
 * Universal Currency Rounding Helper:
 * Uses Number.EPSILON to guarantee half-up rounding and eliminate IEEE 754 floating-point inaccuracies
 * (e.g., 0.1 + 0.2 === 0.30000000000000004 -> 0.30).
 * Handles negative and positive values explicitly.
 * Throws TypeError if input is not a finite numeric value (NaN, Infinity, null, undefined, non-numeric strings),
 * preventing silent fallback or masking of aggregation failures.
 */
export function roundCurrency(val) {
  if (val === null || val === undefined || typeof val === "boolean") {
    throw new TypeError(`Cannot round non-numeric value: ${val}`);
  }
  const num = Number(val);
  if (!Number.isFinite(num)) {
    throw new TypeError(`Cannot round non-finite value: ${val}`);
  }
  const sign = num < 0 ? -1 : 1;
  const absNum = Math.abs(num);
  return sign * (Math.round((absNum + Number.EPSILON) * 100) / 100);
}

export class DashboardOverviewService {
  /**
   * Constructs base match filter for tenant and optional branch.
   * Safe universal soft-delete check: { isDeleted: { $ne: true } }
   */
  _buildScope(organizationId, branchId) {
    const scope = {
      organizationId: new mongoose.Types.ObjectId(organizationId),
      isDeleted: { $ne: true },
    };
    if (branchId) {
      scope.branchId = new mongoose.Types.ObjectId(branchId);
    }
    return scope;
  }

  /**
   * Resolves common report and query metadata.
   */
  async _resolveMeta(
    organizationId,
    branchId,
    startDate,
    endDate,
    compareWith,
    userPermissions,
  ) {
    const timezone = await resolveTimezone(organizationId, branchId);
    const { comparisonStartDate, comparisonEndDate } = getComparisonDates(
      startDate,
      endDate,
      compareWith,
    );

    let branchName = "All Branches";
    if (branchId) {
      const b = await Branch.findOne({ _id: branchId, organizationId }).select(
        "name",
      );
      if (b?.name) branchName = b.name;
    }

    // Determine available widgets based strictly on granular permissions
    const hasBilling = userPermissions.includes("billing.view");
    const hasPayments = userPermissions.includes("payments.view");
    const hasAppts = userPermissions.includes("appointments.view");
    const hasCustomers = userPermissions.includes("customers.view");

    const availableWidgets = [];

    // Core KPIs widget is visible if user has at least one domain view permission
    if (hasBilling || hasPayments || hasAppts || hasCustomers) {
      availableWidgets.push("kpis");
    }

    // Revenue trend requires financial ledger permissions
    if (hasBilling || hasPayments) {
      availableWidgets.push("revenueTrend");
    }

    if (hasAppts) {
      availableWidgets.push("appointments");
    }

    if (hasCustomers) {
      availableWidgets.push("customers");
    }

    if (hasBilling) {
      availableWidgets.push("services");
    }

    if (!branchId && (hasBilling || hasPayments || hasAppts)) {
      availableWidgets.push("branchComparison");
    }

    if (
      userPermissions.includes("finance.view") ||
      userPermissions.includes("expenses.view")
    ) {
      availableWidgets.push("finance");
    }
    if (userPermissions.includes("inventory.view")) {
      availableWidgets.push("inventory");
    }
    if (userPermissions.includes("memberships.view")) {
      availableWidgets.push("memberships");
    }
    if (userPermissions.includes("subscriptions.view")) {
      availableWidgets.push("subscriptions");
    }
    if (userPermissions.includes("coupons.view")) {
      availableWidgets.push("coupons");
    }
    if (userPermissions.includes("loyalty.view")) {
      availableWidgets.push("loyalty");
    }
    if (userPermissions.includes("procurement.orders.view")) {
      availableWidgets.push("procurement");
    }
    if (userPermissions.includes("payroll.view")) {
      availableWidgets.push("payroll");
    }
    if (userPermissions.includes("incentives.view")) {
      availableWidgets.push("incentives");
    }

    return {
      organizationId: organizationId.toString(),
      branchId: branchId ? branchId.toString() : null,
      branchName,
      currency: "INR",
      timezone,
      startDate,
      endDate,
      comparisonStartDate,
      comparisonEndDate,
      generatedAt: new Date().toISOString(),
      availableWidgets,
    };
  }

  /**
   * Aggregates executive KPIs, trends, and domain intelligence.
   */
  async getOverview(organizationId, branchId, query, userPermissions = []) {
    const { startDate, endDate, compareWith = "previous_period" } = query;
    const meta = await this._resolveMeta(
      organizationId,
      branchId,
      startDate,
      endDate,
      compareWith,
      userPermissions,
    );

    const { startUtc, endUtc: startDayEndUtc } = getUTCDayRange(
      startDate,
      meta.timezone,
    );
    const { endUtc: finalEndUtc } = getUTCDayRange(endDate, meta.timezone);

    // Billed scope: Invoices finalized in period
    const currentInvoiceScope = {
      ...this._buildScope(organizationId, branchId),
      status: "finalized",
      finalizedAt: { $gte: startUtc, $lte: finalEndUtc },
    };

    // Cash collections scope: Payments completed in period
    const currentPaymentScope = {
      ...this._buildScope(organizationId, branchId),
      status: "completed",
      paymentDate: { $gte: startUtc, $lte: finalEndUtc },
    };

    // Appointments scope: startAt in period
    const currentAppointmentScope = {
      ...this._buildScope(organizationId, branchId),
      startAt: { $gte: startUtc, $lte: finalEndUtc },
    };

    // Setup comparison scopes if applicable
    let prevInvoiceScope = null;
    let prevPaymentScope = null;
    let prevAppointmentScope = null;
    let prevNewCustomersCount = 0;

    if (meta.comparisonStartDate && meta.comparisonEndDate) {
      const { startUtc: cmpStartUtc } = getUTCDayRange(
        meta.comparisonStartDate,
        meta.timezone,
      );
      const { endUtc: cmpEndUtc } = getUTCDayRange(
        meta.comparisonEndDate,
        meta.timezone,
      );

      prevInvoiceScope = {
        ...this._buildScope(organizationId, branchId),
        status: "finalized",
        finalizedAt: { $gte: cmpStartUtc, $lte: cmpEndUtc },
      };

      prevPaymentScope = {
        ...this._buildScope(organizationId, branchId),
        status: "completed",
        paymentDate: { $gte: cmpStartUtc, $lte: cmpEndUtc },
      };

      prevAppointmentScope = {
        ...this._buildScope(organizationId, branchId),
        startAt: { $gte: cmpStartUtc, $lte: cmpEndUtc },
      };

      prevNewCustomersCount = await Customer.countDocuments({
        organizationId: new mongoose.Types.ObjectId(organizationId),
        isDeleted: { $ne: true },
        createdAt: { $gte: cmpStartUtc, $lte: cmpEndUtc },
        ...(branchId
          ? { visitedBranchIds: new mongoose.Types.ObjectId(branchId) }
          : {}),
      });
    }

    // =========================================================================
    // 1. Core Financials & KPI Aggregations (Parallel Execution)
    // =========================================================================
    const [
      [curInvoiceAgg],
      [prevInvoiceAgg],
      curPaymentAgg,
      prevPaymentAgg,
      outstandingAgg,
      [curApptAgg],
      [prevApptAgg],
      newCustomersCount,
      repeatCustomerStats,
    ] = await Promise.all([
      // Current Invoices Aggregation
      Invoice.aggregate([
        { $match: currentInvoiceScope },
        {
          $group: {
            _id: null,
            grossSales: { $sum: "$subtotal" },
            discountsTotal: { $sum: "$discountTotal" },
            netSales: { $sum: "$payableAmount" },
            invoiceCount: { $sum: 1 },
          },
        },
      ]),

      // Previous Invoices Aggregation
      prevInvoiceScope
        ? Invoice.aggregate([
            { $match: prevInvoiceScope },
            {
              $group: {
                _id: null,
                grossSales: { $sum: "$subtotal" },
                discountsTotal: { $sum: "$discountTotal" },
                netSales: { $sum: "$payableAmount" },
                invoiceCount: { $sum: 1 },
              },
            },
          ])
        : Promise.resolve([]),

      // Current Payments Aggregation
      Payment.aggregate([
        { $match: currentPaymentScope },
        {
          $group: {
            _id: "$type",
            totalAmount: { $sum: "$amount" },
            count: { $sum: 1 },
          },
        },
      ]),

      // Previous Payments Aggregation
      prevPaymentScope
        ? Payment.aggregate([
            { $match: prevPaymentScope },
            {
              $group: {
                _id: "$type",
                totalAmount: { $sum: "$amount" },
              },
            },
          ])
        : Promise.resolve([]),

      // Outstanding Receivables across currently open finalized invoices
      Invoice.aggregate([
        {
          $match: {
            ...this._buildScope(organizationId, branchId),
            status: "finalized",
            paymentStatus: { $in: ["unpaid", "partially_paid"] },
          },
        },
        {
          $group: {
            _id: null,
            totalOutstanding: { $sum: "$amountDue" },
            count: { $sum: 1 },
          },
        },
      ]),

      // Current Appointments Aggregation
      Appointment.aggregate([
        { $match: currentAppointmentScope },
        {
          $group: {
            _id: null,
            totalAppointments: { $sum: 1 },
            completed: {
              $sum: { $cond: [{ $eq: ["$status", "completed"] }, 1, 0] },
            },
            cancelled: {
              $sum: { $cond: [{ $eq: ["$status", "cancelled"] }, 1, 0] },
            },
            noShow: {
              $sum: { $cond: [{ $eq: ["$status", "no_show"] }, 1, 0] },
            },
            inProgress: {
              $sum: { $cond: [{ $eq: ["$status", "in_progress"] }, 1, 0] },
            },
            scheduled: {
              $sum: { $cond: [{ $eq: ["$status", "scheduled"] }, 1, 0] },
            },
            walkIn: {
              $sum: { $cond: [{ $eq: ["$bookingType", "walk_in"] }, 1, 0] },
            },
            advance: {
              $sum: { $cond: [{ $eq: ["$bookingType", "advance"] }, 1, 0] },
            },
          },
        },
      ]),

      // Previous Appointments Aggregation
      prevAppointmentScope
        ? Appointment.aggregate([
            { $match: prevAppointmentScope },
            {
              $group: {
                _id: null,
                totalAppointments: { $sum: 1 },
              },
            },
          ])
        : Promise.resolve([]),

      // New Customers acquired in period
      Customer.countDocuments({
        organizationId: new mongoose.Types.ObjectId(organizationId),
        isDeleted: { $ne: true },
        createdAt: { $gte: startUtc, $lte: finalEndUtc },
        ...(branchId
          ? { visitedBranchIds: new mongoose.Types.ObjectId(branchId) }
          : {}),
      }),

      // Repeat Customer Visit Rate
      Invoice.aggregate([
        { $match: currentInvoiceScope },
        {
          $group: {
            _id: "$customerId",
            periodInvoices: { $sum: 1 },
          },
        },
        {
          $lookup: {
            from: "invoices",
            let: { custId: "$_id" },
            pipeline: [
              {
                $match: {
                  $expr: {
                    $and: [
                      {
                        $eq: [
                          "$organizationId",
                          new mongoose.Types.ObjectId(organizationId),
                        ],
                      },
                      { $eq: ["$customerId", "$$custId"] },
                      { $eq: ["$status", "finalized"] },
                      { $ne: ["$isDeleted", true] },
                      ...(branchId
                        ? [
                            {
                              $eq: [
                                "$branchId",
                                new mongoose.Types.ObjectId(branchId),
                              ],
                            },
                          ]
                        : []),
                    ],
                  },
                },
              },
              { $count: "lifetimeInvoices" },
            ],
            as: "lifetime",
          },
        },
        {
          $project: {
            isRepeat: {
              $gte: [
                {
                  $ifNull: [
                    { $arrayElemAt: ["$lifetime.lifetimeInvoices", 0] },
                    0,
                  ],
                },
                2,
              ],
            },
          },
        },
        {
          $group: {
            _id: null,
            totalCustomers: { $sum: 1 },
            repeatCustomers: { $sum: { $cond: ["$isRepeat", 1, 0] } },
          },
        },
      ]),
    ]);

    // Parse Financial Aggregations with strict IEEE 754 half-up precision
    const curGrossSales = roundCurrency(curInvoiceAgg?.grossSales || 0);
    const prevGrossSales = roundCurrency(prevInvoiceAgg?.grossSales || 0);
    const curDiscounts = roundCurrency(curInvoiceAgg?.discountsTotal || 0);
    const prevDiscounts = roundCurrency(prevInvoiceAgg?.discountsTotal || 0);
    const curNetSales = roundCurrency(curInvoiceAgg?.netSales || 0);
    const prevNetSales = roundCurrency(prevInvoiceAgg?.netSales || 0);
    const curInvoiceCount = curInvoiceAgg?.invoiceCount || 0;
    const prevInvoiceCount = prevInvoiceAgg?.invoiceCount || 0;

    const curPaymentDoc = (curPaymentAgg || []).find(
      (p) => p._id === "payment",
    );
    const curRefundDoc = (curPaymentAgg || []).find((p) => p._id === "refund");
    const prevPaymentDoc = (prevPaymentAgg || []).find(
      (p) => p._id === "payment",
    );
    const prevRefundDoc = (prevPaymentAgg || []).find(
      (p) => p._id === "refund",
    );

    const curCollections = roundCurrency(curPaymentDoc?.totalAmount || 0);
    const prevCollections = roundCurrency(prevPaymentDoc?.totalAmount || 0);
    const curRefunds = roundCurrency(Math.abs(curRefundDoc?.totalAmount || 0));
    const prevRefunds = roundCurrency(Math.abs(prevRefundDoc?.totalAmount || 0));

    const curNetCollections = roundCurrency(curCollections - curRefunds);
    const prevNetCollections = roundCurrency(prevCollections - prevRefunds);

    const currentOutstanding = roundCurrency(
      outstandingAgg[0]?.totalOutstanding || 0,
    );

    const curABV =
      curInvoiceCount > 0
        ? roundCurrency(curNetSales / curInvoiceCount)
        : 0;
    const prevABV =
      prevInvoiceCount > 0
        ? roundCurrency(prevNetSales / prevInvoiceCount)
        : 0;

    const curTotalAppts = curApptAgg?.totalAppointments || 0;
    const prevTotalAppts = prevApptAgg?.totalAppointments || 0;

    const totalUniqueCustInPeriod = repeatCustomerStats[0]?.totalCustomers || 0;
    const repeatCustInPeriod = repeatCustomerStats[0]?.repeatCustomers || 0;
    const repeatRate =
      totalUniqueCustInPeriod > 0
        ? roundCurrency((repeatCustInPeriod / totalUniqueCustInPeriod) * 100)
        : 0;

    // Granular Permissions Check for KPI Assembly
    const hasBilling = userPermissions.includes("billing.view");
    const hasPayments = userPermissions.includes("payments.view");
    const hasAppts = userPermissions.includes("appointments.view");
    const hasCustomers = userPermissions.includes("customers.view");

    // Assemble delta-rich KPI object strictly bounded by permissions
    let kpis = undefined;
    if (hasBilling || hasPayments || hasAppts || hasCustomers) {
      kpis = {};

      if (hasBilling) {
        kpis.grossSales = calculateMetricDelta(
          curGrossSales,
          meta.comparisonStartDate ? prevGrossSales : null,
        );
        kpis.discountsTotal = calculateMetricDelta(
          curDiscounts,
          meta.comparisonStartDate ? prevDiscounts : null,
        );
        kpis.netSales = calculateMetricDelta(
          curNetSales,
          meta.comparisonStartDate ? prevNetSales : null,
        );
        kpis.outstandingReceivables = {
          current: currentOutstanding,
          previous: null,
          percentageChange: null,
          trend: "neutral",
        };
        kpis.averageBillValue = calculateMetricDelta(
          curABV,
          meta.comparisonStartDate ? prevABV : null,
        );
      }

      if (hasPayments) {
        kpis.collections = calculateMetricDelta(
          curCollections,
          meta.comparisonStartDate ? prevCollections : null,
        );
        kpis.refunds = calculateMetricDelta(
          curRefunds,
          meta.comparisonStartDate ? prevRefunds : null,
        );
        kpis.netCollections = calculateMetricDelta(
          curNetCollections,
          meta.comparisonStartDate ? prevNetCollections : null,
        );
      }

      if (hasAppts) {
        kpis.totalAppointments = calculateMetricDelta(
          curTotalAppts,
          meta.comparisonStartDate ? prevTotalAppts : null,
        );
      }

      if (hasCustomers) {
        kpis.newCustomers = calculateMetricDelta(
          newCustomersCount,
          meta.comparisonStartDate ? prevNewCustomersCount : null,
        );
        kpis.repeatCustomerRate = calculateRateDelta(repeatRate, null);
      }
    }

    // =========================================================================
    // 2. Revenue Trend & Daily Breakdown
    // =========================================================================
    const [dailyInvoices, dailyPayments] = await Promise.all([
      Invoice.aggregate([
        { $match: currentInvoiceScope },
        {
          $group: {
            _id: {
              $dateToString: {
                date: "$finalizedAt",
                format: "%Y-%m-%d",
                timezone: meta.timezone,
              },
            },
            billedRevenue: { $sum: "$payableAmount" },
          },
        },
      ]),
      Payment.aggregate([
        { $match: currentPaymentScope },
        {
          $group: {
            _id: {
              date: {
                $dateToString: {
                  date: "$paymentDate",
                  format: "%Y-%m-%d",
                  timezone: meta.timezone,
                },
              },
              type: "$type",
            },
            amount: { $sum: "$amount" },
          },
        },
      ]),
    ]);

    // Map daily aggregation into continuous chronological timeline
    const dailyMap = {};
    const startDateObj = new Date(`${startDate}T00:00:00.000Z`);
    const endDateObj = new Date(`${endDate}T00:00:00.000Z`);
    const dayMs = 24 * 60 * 60 * 1000;
    const numDays = Math.min(
      366,
      Math.round((endDateObj.getTime() - startDateObj.getTime()) / dayMs) + 1,
    );

    for (let i = 0; i < numDays; i++) {
      const d = new Date(startDateObj.getTime() + i * dayMs);
      const dStr = d.toISOString().split("T")[0];
      const entry = { date: dStr };
      if (hasBilling) {
        entry.billedRevenue = 0;
      }
      if (hasPayments) {
        entry.collections = 0;
        entry.refunds = 0;
        entry.netCollections = 0;
      }
      dailyMap[dStr] = entry;
    }

    if (hasBilling) {
      dailyInvoices.forEach((item) => {
        if (dailyMap[item._id]) {
          dailyMap[item._id].billedRevenue = roundCurrency(
            item.billedRevenue || 0,
          );
        }
      });
    }

    if (hasPayments) {
      dailyPayments.forEach((item) => {
        const dStr = item._id.date;
        if (dailyMap[dStr]) {
          if (item._id.type === "payment") {
            dailyMap[dStr].collections = roundCurrency(item.amount || 0);
          } else if (item._id.type === "refund") {
            dailyMap[dStr].refunds = roundCurrency(Math.abs(item.amount || 0));
          }
          dailyMap[dStr].netCollections = roundCurrency(
            (dailyMap[dStr].collections || 0) - (dailyMap[dStr].refunds || 0),
          );
        }
      });
    }

    const revenueTrend = (hasBilling || hasPayments)
      ? Object.values(dailyMap).sort((a, b) => a.date.localeCompare(b.date))
      : undefined;

    // =========================================================================
    // 3. Appointments Breakdown
    // =========================================================================
    const appointmentsData = {
      byStatus: {
        scheduled: curApptAgg?.scheduled || 0,
        in_progress: curApptAgg?.inProgress || 0,
        completed: curApptAgg?.completed || 0,
        cancelled: curApptAgg?.cancelled || 0,
        no_show: curApptAgg?.noShow || 0,
      },
      byBookingType: {
        advance: curApptAgg?.advance || 0,
        walk_in: curApptAgg?.walkIn || 0,
      },
      completionRate:
        curTotalAppts > 0
          ? Number(
              (
                ((curApptAgg?.completed || 0) /
                  Math.max(1, curTotalAppts - (curApptAgg?.cancelled || 0))) *
                100
              ).toFixed(2),
            )
          : 0,
    };

    // =========================================================================
    // 4. Customers & Acquisition Intelligence
    // =========================================================================
    const [customerSources, totalActiveCustomers] = await Promise.all([
      Customer.aggregate([
        {
          $match: {
            organizationId: new mongoose.Types.ObjectId(organizationId),
            isDeleted: { $ne: true },
            ...(branchId
              ? { visitedBranchIds: new mongoose.Types.ObjectId(branchId) }
              : {}),
          },
        },
        {
          $group: {
            _id: "$acquisitionSource",
            count: { $sum: 1 },
          },
        },
        { $sort: { count: -1 } },
      ]),
      Customer.countDocuments({
        organizationId: new mongoose.Types.ObjectId(organizationId),
        status: "active",
        isDeleted: { $ne: true },
        ...(branchId
          ? { visitedBranchIds: new mongoose.Types.ObjectId(branchId) }
          : {}),
      }),
    ]);

    const customersData = {
      totalActiveCustomers,
      newCustomersInPeriod: newCustomersCount,
      repeatCustomerRate: repeatRate,
      acquisitionSources: customerSources.map((s) => ({
        source: s._id || "walk_in",
        count: s.count,
      })),
      newVsReturning: {
        new: newCustomersCount,
        returning: Math.max(0, totalUniqueCustInPeriod - newCustomersCount),
      },
    };

    // =========================================================================
    // 5. Popular Services & Product Performance
    // =========================================================================
    const [topServicesAgg, retailSalesAgg] = await Promise.all([
      Invoice.aggregate([
        { $match: currentInvoiceScope },
        { $unwind: "$lines" },
        {
          $match: {
            "lines.lineType": "service",
          },
        },
        {
          $group: {
            _id: "$lines.serviceId",
            name: { $first: "$lines.name" },
            count: { $sum: "$lines.quantity" },
            revenue: { $sum: "$lines.lineTotal" },
          },
        },
        { $sort: { count: -1 } },
        { $limit: 5 },
      ]),
      Invoice.aggregate([
        { $match: currentInvoiceScope },
        { $unwind: "$lines" },
        {
          $match: {
            "lines.lineType": "product",
          },
        },
        {
          $group: {
            _id: null,
            totalQuantitySold: { $sum: "$lines.quantity" },
            totalRetailRevenue: { $sum: "$lines.lineTotal" },
          },
        },
      ]),
    ]);

    const servicesData = {
      topServices: topServicesAgg.map((s) => ({
        id: s._id ? s._id.toString() : "custom",
        name: s.name || "Custom Service",
        count: s.count,
        revenue: Number((s.revenue || 0).toFixed(2)),
      })),
      retailProducts: {
        totalQuantitySold: retailSalesAgg[0]?.totalQuantitySold || 0,
        totalRevenue: Number(
          (retailSalesAgg[0]?.totalRetailRevenue || 0).toFixed(2),
        ),
      },
    };

    // =========================================================================
    // 6. Branch Comparison (Consolidated All Branches view only)
    // =========================================================================
    let branchComparison = undefined;
    if (!branchId && (hasBilling || hasPayments || hasAppts)) {
      const activeBranches = await Branch.find({
        organizationId: new mongoose.Types.ObjectId(organizationId),
        isActive: true,
      }).select("name");

      const [branchInvoices, branchPayments, branchAppts] = await Promise.all([
        hasBilling
          ? Invoice.aggregate([
              {
                $match: {
                  organizationId: new mongoose.Types.ObjectId(organizationId),
                  isDeleted: { $ne: true },
                  status: "finalized",
                  finalizedAt: { $gte: startUtc, $lte: finalEndUtc },
                },
              },
              {
                $group: {
                  _id: "$branchId",
                  billedRevenue: { $sum: "$payableAmount" },
                  invoiceCount: { $sum: 1 },
                },
              },
            ])
          : Promise.resolve([]),
        hasPayments
          ? Payment.aggregate([
              {
                $match: {
                  organizationId: new mongoose.Types.ObjectId(organizationId),
                  isDeleted: { $ne: true },
                  status: "completed",
                  type: "payment",
                  paymentDate: { $gte: startUtc, $lte: finalEndUtc },
                },
              },
              {
                $group: {
                  _id: "$branchId",
                  collections: { $sum: "$amount" },
                },
              },
            ])
          : Promise.resolve([]),
        hasAppts
          ? Appointment.aggregate([
              {
                $match: {
                  organizationId: new mongoose.Types.ObjectId(organizationId),
                  isDeleted: { $ne: true },
                  startAt: { $gte: startUtc, $lte: finalEndUtc },
                },
              },
              {
                $group: {
                  _id: "$branchId",
                  count: { $sum: 1 },
                },
              },
            ])
          : Promise.resolve([]),
      ]);

      const branchMap = {};
      activeBranches.forEach((b) => {
        const item = {
          branchId: b._id.toString(),
          branchName: b.name,
        };
        if (hasBilling) {
          item.billedRevenue = 0;
        }
        if (hasPayments) {
          item.collections = 0;
        }
        if (hasAppts) {
          item.appointmentsCount = 0;
        }
        branchMap[b._id.toString()] = item;
      });

      if (hasBilling) {
        branchInvoices.forEach((bi) => {
          const id = bi._id?.toString();
          if (branchMap[id])
            branchMap[id].billedRevenue = roundCurrency(bi.billedRevenue || 0);
        });
      }

      if (hasPayments) {
        branchPayments.forEach((bp) => {
          const id = bp._id?.toString();
          if (branchMap[id])
            branchMap[id].collections = roundCurrency(bp.collections || 0);
        });
      }

      if (hasAppts) {
        branchAppts.forEach((ba) => {
          const id = ba._id?.toString();
          if (branchMap[id]) branchMap[id].appointmentsCount = ba.count || 0;
        });
      }

      branchComparison = Object.values(branchMap);
    }

    // =========================================================================
    // 7. Permission-Gated Modular Intelligence
    // =========================================================================
    const result = {
      success: true,
      meta,
      kpis,
      revenueTrend,
      appointments: hasAppts ? appointmentsData : undefined,
      customers: hasCustomers ? customersData : undefined,
      services: hasBilling ? servicesData : undefined,
      branchComparison,
    };

    // A. Finance & Operating Expenses
    const hasFinanceView = userPermissions.includes("finance.view");
    const hasExpensesView = userPermissions.includes("expenses.view");
    if (hasFinanceView || hasExpensesView) {
      try {
        const expenseScope = {
          ...this._buildScope(organizationId, branchId),
          approvalStatus: "approved",
          expenseDate: { $gte: startUtc, $lte: finalEndUtc },
        };

        const expenseAgg = await Expense.aggregate([
          { $match: expenseScope },
          {
            $group: {
              _id: "$category",
              amount: { $sum: "$amount" },
            },
          },
          { $sort: { amount: -1 } },
        ]);

        const totalExpenses = roundCurrency(
          expenseAgg.reduce((sum, item) => sum + item.amount, 0),
        );
        
        // operatingCashMargin requires finance.view (expenses.view alone only exposes expense metrics)
        const canViewMargin = hasFinanceView;
        const operatingCashMargin = canViewMargin
          ? roundCurrency(curNetCollections - totalExpenses)
          : undefined;

        result.finance = {
          status: expenseAgg.length === 0 ? "EMPTY" : "AVAILABLE",
          totalExpenses,
          ...(canViewMargin ? { operatingCashMargin } : {}),
          expensesByCategory: expenseAgg.map((e) => ({
            category: e._id || "general",
            amount: roundCurrency(e.amount || 0),
          })),
        };
      } catch (err) {
        logger.error(`Dashboard finance aggregation failed: ${err.message}`);
        result.finance = {
          status: "FAILED",
          error: "Failed to compute financial metrics",
        };
      }
    }

    // B. Inventory Intelligence
    if (userPermissions.includes("inventory.view")) {
      try {
        const balanceScope = {
          organizationId: new mongoose.Types.ObjectId(organizationId),
        };
        if (branchId) {
          balanceScope.branchId = new mongoose.Types.ObjectId(branchId);
        }
        const inventoryAgg = await StockBalance.aggregate([
          { $match: balanceScope },
          {
            $lookup: {
              from: "products",
              localField: "productId",
              foreignField: "_id",
              as: "product",
            },
          },
          { $unwind: "$product" },
          {
            $match: {
              "product.isDeleted": { $ne: true },
              "product.status": "active",
            },
          },
          {
            $project: {
              onHand: 1,
              onHandConsumables: 1,
              onHandRetail: 1,
              reorderLevel: "$product.reorderLevel",
              usageType: "$product.usageType",
              isOutOfStock: { $eq: ["$onHand", 0] },
              isLowStock: {
                $and: [
                  { $gt: ["$onHand", 0] },
                  { $lte: ["$onHand", "$product.reorderLevel"] },
                ],
              },
            },
          },
          {
            $group: {
              _id: null,
              outOfStockCount: { $sum: { $cond: ["$isOutOfStock", 1, 0] } },
              lowStockCount: { $sum: { $cond: ["$isLowStock", 1, 0] } },
              consumablesShortage: {
                $sum: {
                  $cond: [
                    {
                      $and: [
                        { $in: ["$usageType", ["salon_consumption", "both"]] },
                        { $lte: ["$onHandConsumables", 0] },
                      ],
                    },
                    1,
                    0,
                  ],
                },
              },
              retailShortage: {
                $sum: {
                  $cond: [
                    {
                      $and: [
                        { $in: ["$usageType", ["retail_sale", "both"]] },
                        { $lte: ["$onHandRetail", 0] },
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

        const isInvEmpty =
          (inventoryAgg[0]?.outOfStockCount || 0) === 0 &&
          (inventoryAgg[0]?.lowStockCount || 0) === 0 &&
          (inventoryAgg[0]?.consumablesShortage || 0) === 0 &&
          (inventoryAgg[0]?.retailShortage || 0) === 0;

        result.inventory = {
          status: isInvEmpty ? "EMPTY" : "AVAILABLE",
          outOfStockCount: inventoryAgg[0]?.outOfStockCount || 0,
          lowStockCount: inventoryAgg[0]?.lowStockCount || 0,
          consumablesShortageCount: inventoryAgg[0]?.consumablesShortage || 0,
          retailShortageCount: inventoryAgg[0]?.retailShortage || 0,
        };
      } catch (err) {
        logger.error(`Dashboard inventory aggregation failed: ${err.message}`);
        result.inventory = {
          status: "FAILED",
          error: "Failed to compute inventory metrics",
        };
      }
    }

    // C. Memberships Intelligence
    if (userPermissions.includes("memberships.view")) {
      try {
        const now = new Date();
        const thirtyDaysFuture = new Date(
          now.getTime() + 30 * 24 * 60 * 60 * 1000,
        );
        const memScope = {
          organizationId: new mongoose.Types.ObjectId(organizationId),
          isDeleted: { $ne: true },
        };
        if (branchId) {
          memScope.$or = [
            { permittedBranchIds: new mongoose.Types.ObjectId(branchId) },
            { permittedBranchIds: { $size: 0 } },
          ];
        }

        const [activeCount, expiringCount, [memSalesAgg]] = await Promise.all([
          CustomerMembership.countDocuments({
            ...memScope,
            status: { $in: ["active", "pending_payment"] },
            startDate: { $lte: now },
            endDate: { $gte: now },
          }),
          CustomerMembership.countDocuments({
            ...memScope,
            status: { $in: ["active", "pending_payment"] },
            startDate: { $lte: now },
            endDate: { $gte: now, $lte: thirtyDaysFuture },
          }),
          Invoice.aggregate([
            { $match: currentInvoiceScope },
            { $unwind: "$lines" },
            { $match: { "lines.lineType": "membership" } },
            {
              $group: {
                _id: null,
                count: { $sum: "$lines.quantity" },
                amount: { $sum: "$lines.lineTotal" },
              },
            },
          ]),
        ]);

        const newSoldInPeriod = memSalesAgg?.count || 0;
        const salesAmountInPeriod = roundCurrency(memSalesAgg?.amount || 0);

        const isMemEmpty =
          activeCount === 0 && expiringCount === 0 && newSoldInPeriod === 0;
        result.memberships = {
          status: isMemEmpty ? "EMPTY" : "AVAILABLE",
          activeCount,
          expiringCount,
          newSoldInPeriod,
          salesAmountInPeriod,
        };
      } catch (err) {
        logger.error(
          `Dashboard memberships aggregation failed: ${err.message}`,
        );
        result.memberships = {
          status: "FAILED",
          error: "Failed to compute membership metrics",
        };
      }
    }

    // D. Subscriptions Intelligence
    if (userPermissions.includes("subscriptions.view")) {
      try {
        const now = new Date();
        const thirtyDaysFuture = new Date(
          now.getTime() + 30 * 24 * 60 * 60 * 1000,
        );
        const subScope = {
          organizationId: new mongoose.Types.ObjectId(organizationId),
          isDeleted: { $ne: true },
        };
        if (branchId) {
          subScope.$or = [
            { "members.permittedBranchIds": new mongoose.Types.ObjectId(branchId) },
            { "members.permittedBranchIds": { $size: 0 } },
          ];
        }

        const usageScope = {
          ...this._buildScope(organizationId, branchId),
          isReversed: { $ne: true },
          createdAt: { $gte: startUtc, $lte: finalEndUtc },
        };

        const [activeCount, expiringCount, redemptionsInPeriod, [subSalesAgg]] =
          await Promise.all([
            Subscription.countDocuments({
              ...subScope,
              status: { $in: ["active", "pending_payment"] },
              startDate: { $lte: now },
              endDate: { $gte: now },
            }),
            Subscription.countDocuments({
              ...subScope,
              status: { $in: ["active", "pending_payment"] },
              startDate: { $lte: now },
              endDate: { $gte: now, $lte: thirtyDaysFuture },
            }),
            SubscriptionUsage.countDocuments(usageScope),
            Invoice.aggregate([
              { $match: currentInvoiceScope },
              { $unwind: "$lines" },
              { $match: { "lines.lineType": "subscription" } },
              {
                $group: {
                  _id: null,
                  count: { $sum: "$lines.quantity" },
                  amount: { $sum: "$lines.lineTotal" },
                },
              },
            ]),
          ]);

        const soldInPeriod = subSalesAgg?.count || 0;
        const salesAmountInPeriod = roundCurrency(subSalesAgg?.amount || 0);

        const isSubEmpty =
          activeCount === 0 &&
          expiringCount === 0 &&
          redemptionsInPeriod === 0 &&
          soldInPeriod === 0;
        result.subscriptions = {
          status: isSubEmpty ? "EMPTY" : "AVAILABLE",
          activeCount,
          expiringCount,
          redemptionsInPeriod,
          soldInPeriod,
          salesAmountInPeriod,
        };
      } catch (err) {
        logger.error(
          `Dashboard subscriptions aggregation failed: ${err.message}`,
        );
        result.subscriptions = {
          status: "FAILED",
          error: "Failed to compute subscription metrics",
        };
      }
    }

    // E. Coupons Intelligence
    if (userPermissions.includes("coupons.view")) {
      try {
        const couponScope = {
          ...this._buildScope(organizationId, branchId),
          status: "consumed",
          $or: [
            { consumedAt: { $gte: startUtc, $lte: finalEndUtc } },
            { usedAt: { $gte: startUtc, $lte: finalEndUtc } },
          ],
        };

        const couponAgg = await CouponUsage.aggregate([
          { $match: couponScope },
          {
            $group: {
              _id: null,
              redemptionCount: { $sum: 1 },
              totalDiscountGiven: { $sum: "$discountAmount" },
            },
          },
        ]);

        const redemptionCount = couponAgg[0]?.redemptionCount || 0;
        result.coupons = {
          status: redemptionCount === 0 ? "EMPTY" : "AVAILABLE",
          redemptionCount,
          totalDiscountGiven: Number(
            (couponAgg[0]?.totalDiscountGiven || 0).toFixed(2),
          ),
        };
      } catch (err) {
        logger.error(`Dashboard coupons aggregation failed: ${err.message}`);
        result.coupons = {
          status: "FAILED",
          error: "Failed to compute coupon metrics",
        };
      }
    }

    // F. Loyalty Intelligence
    if (userPermissions.includes("loyalty.view")) {
      try {
        const loyaltyScope = {
          organizationId: new mongoose.Types.ObjectId(organizationId),
          isDeleted: { $ne: true },
          createdAt: { $gte: startUtc, $lte: finalEndUtc },
        };
        if (branchId) {
          loyaltyScope.branchId = new mongoose.Types.ObjectId(branchId);
        }

        const loyaltyAgg = await LoyaltyTransaction.aggregate([
          { $match: loyaltyScope },
          {
            $group: {
              _id: "$type",
              totalPoints: { $sum: "$pointsDelta" },
            },
          },
        ]);

        const earnedDoc = loyaltyAgg.find((l) => l._id === "EARNED");
        const redeemedDoc = loyaltyAgg.find((l) => l._id === "REDEEMED");

        const pointsEarned = earnedDoc ? Math.abs(earnedDoc.totalPoints) : 0;
        const pointsRedeemed = redeemedDoc
          ? Math.abs(redeemedDoc.totalPoints)
          : 0;
        result.loyalty = {
          status:
            pointsEarned === 0 && pointsRedeemed === 0 ? "EMPTY" : "AVAILABLE",
          pointsEarned,
          pointsRedeemed,
        };
      } catch (err) {
        logger.error(`Dashboard loyalty aggregation failed: ${err.message}`);
        result.loyalty = {
          status: "FAILED",
          error: "Failed to compute loyalty metrics",
        };
      }
    }

    // G. Procurement & Supplier Payables
    if (userPermissions.includes("procurement.orders.view")) {
      try {
        const procScope = this._buildScope(organizationId, branchId);
        const [pendingOrders, [payablesAgg]] = await Promise.all([
          PurchaseOrder.countDocuments({
            ...procScope,
            status: { $in: ["ordered", "partially_received"] },
          }),
          SupplierInvoice.aggregate([
            {
              $match: {
                ...procScope,
                status: { $in: ["unpaid", "partially_paid"] },
              },
            },
            {
              $group: {
                _id: null,
                totalPayable: {
                  $sum: { $subtract: ["$totalAmount", "$amountPaid"] },
                },
                count: { $sum: 1 },
              },
            },
          ]),
        ]);

        const totalPayable = payablesAgg?.totalPayable || 0;
        result.procurement = {
          status:
            pendingOrders === 0 && totalPayable === 0 ? "EMPTY" : "AVAILABLE",
          pendingOrdersCount: pendingOrders,
          outstandingSupplierPayables: Number(totalPayable.toFixed(2)),
        };
      } catch (err) {
        logger.error(
          `Dashboard procurement aggregation failed: ${err.message}`,
        );
        result.procurement = {
          status: "FAILED",
          error: "Failed to compute procurement metrics",
        };
      }
    }

    // H. Payroll Intelligence
    if (userPermissions.includes("payroll.view")) {
      try {
        const payScope = this._buildScope(organizationId, branchId);
        const pendingPayrollAgg = await PayrollRecord.aggregate([
          {
            $match: {
              ...payScope,
              status: "pending_approval",
            },
          },
          {
            $group: {
              _id: null,
              count: { $sum: 1 },
              totalPayable: { $sum: "$calculations.netPayable" },
            },
          },
        ]);

        const count = pendingPayrollAgg[0]?.count || 0;
        result.payroll = {
          status: count === 0 ? "EMPTY" : "AVAILABLE",
          pendingApprovalsCount: count,
          totalPendingPayable: Number(
            (pendingPayrollAgg[0]?.totalPayable || 0).toFixed(2),
          ),
        };
      } catch (err) {
        logger.error(`Dashboard payroll aggregation failed: ${err.message}`);
        result.payroll = {
          status: "FAILED",
          error: "Failed to compute payroll metrics",
        };
      }
    }

    // I. Incentives Intelligence
    if (userPermissions.includes("incentives.view")) {
      try {
        const incScope = {
          ...this._buildScope(organizationId, branchId),
          entryType: "ACCRUAL",
          createdAt: { $gte: startUtc, $lte: finalEndUtc },
        };

        const [incTotalAgg, topPerformersAgg] = await Promise.all([
          IncentiveLedger.aggregate([
            { $match: incScope },
            {
              $group: {
                _id: null,
                totalPaise: { $sum: "$amountInPaise" },
              },
            },
          ]),
          IncentiveLedger.aggregate([
            { $match: incScope },
            {
              $group: {
                _id: "$staffId",
                totalPaise: { $sum: "$amountInPaise" },
              },
            },
            { $sort: { totalPaise: -1 } },
            { $limit: 5 },
            {
              $lookup: {
                from: "staffs",
                let: { sId: "$_id" },
                pipeline: [
                  {
                    $match: {
                      $expr: {
                        $and: [
                          { $eq: ["$_id", "$$sId"] },
                          { $ne: ["$isDeleted", true] },
                        ],
                      },
                    },
                  },
                ],
                as: "staff",
              },
            },
            { $unwind: "$staff" },
            {
              $project: {
                staffId: "$_id",
                staffName: "$staff.name",
                amount: { $divide: ["$totalPaise", 100] },
              },
            },
          ]),
        ]);

        const totalPaise = incTotalAgg[0]?.totalPaise || 0;
        result.incentives = {
          status: totalPaise === 0 ? "EMPTY" : "AVAILABLE",
          accruedIncentives: Number((totalPaise / 100).toFixed(2)),
          topPerformers: topPerformersAgg.map((tp) => ({
            staffId: tp.staffId.toString(),
            staffName: tp.staffName,
            amount: Number(tp.amount.toFixed(2)),
          })),
        };
      } catch (err) {
        logger.error(`Dashboard incentives aggregation failed: ${err.message}`);
        result.incentives = {
          status: "FAILED",
          error: "Failed to compute incentive metrics",
        };
      }
    }

    return result;
  }
}
