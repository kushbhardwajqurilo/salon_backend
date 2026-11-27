import mongoose from "mongoose";
import { Invoice } from "../../models/billing/invoice.model.js";
import { Payment } from "../../models/billing/payment.model.js";
import { Appointment } from "../../models/appointments/appointment.model.js";
import { Customer } from "../../models/customers/customer.model.js";
import { StockBalance } from "../../models/inventory/stockBalance.model.js";
import { StockMovement } from "../../models/inventory/stockMovement.model.js";
import { Product } from "../../models/inventory/product.model.js";
import { Service } from "../../models/services/service.model.js";
import { ServiceCategory } from "../../models/services/serviceCategory.model.js";
import { Branch } from "../../models/branches/branch.model.js";
import {
  resolveTimezone,
  getUTCDayRange,
  getComparisonDates,
  calculateMetricDelta,
  calculateRateDelta,
  maskPhoneNumber,
} from "./reportCalculations.js";

const DEFAULT_PAGE_SIZE = 10;

const resolvePagination = (
  query,
  total,
  pageKey = "page",
  limitKey = "limit",
  includeAllRows = false,
) => {
  const requestedLimit = Number(query[limitKey]) || DEFAULT_PAGE_SIZE;
  const totalPages = Math.ceil(total / requestedLimit);
  const requestedPage = Number(query[pageKey]) || 1;
  const page = totalPages > 0 ? Math.min(requestedPage, totalPages) : 1;
  const limit = includeAllRows ? Math.max(total, 1) : requestedLimit;

  return {
    page: includeAllRows ? 1 : page,
    limit,
    total,
    totalPages: includeAllRows ? (total > 0 ? 1 : 0) : totalPages,
    skip: includeAllRows ? 0 : (page - 1) * requestedLimit,
  };
};

const getPaginationMetadata = ({ page, limit, total, totalPages }) => ({
  page,
  limit,
  total,
  totalPages,
});

class ReportsService {
  /**
   * Builds tenant and branch scoped match filters.
   */
  _buildScope(organizationId, branchId) {
    const scope = {
      organizationId: new mongoose.Types.ObjectId(organizationId),
      isDeleted: false,
    };
    if (branchId) {
      scope.branchId = new mongoose.Types.ObjectId(branchId);
    }
    return scope;
  }

  /**
   * Resolves common report metadata.
   */
  async _resolveMeta(organizationId, branchId, startDate, endDate, compareWith) {
    const timezone = await resolveTimezone(organizationId, branchId);
    const { comparisonStartDate, comparisonEndDate } = getComparisonDates(
      startDate,
      endDate,
      compareWith
    );

    let branchName = "All Branches";
    if (branchId) {
      const b = await Branch.findOne({ _id: branchId, organizationId }).select("name");
      if (b?.name) branchName = b.name;
    }

    return {
      organizationId: organizationId.toString(),
      branchId: branchId ? branchId.toString() : null,
      branchName,
      currency: "INR",
      startDate,
      endDate,
      comparisonStartDate,
      comparisonEndDate,
      timezone,
      generatedAt: new Date().toISOString(),
    };
  }

  _getComparisonQuery(query, meta) {
    if (!meta.comparisonStartDate || !meta.comparisonEndDate) return null;
    return {
      ...query,
      startDate: meta.comparisonStartDate,
      endDate: meta.comparisonEndDate,
      compareWith: "none",
    };
  }

  // =========================================================================
  // 1. REVENUE REPORT
  // =========================================================================
  async getRevenueReport(organizationId, branchId, query, options = {}) {
    const { startDate, endDate, compareWith } = query;
    const meta = await this._resolveMeta(organizationId, branchId, startDate, endDate, compareWith);

    const { startUtc, endUtc } = getUTCDayRange(startDate, meta.timezone);
    const { endUtc: finalEndUtc } = getUTCDayRange(endDate, meta.timezone);

    // Billed cohort: Invoice.finalizedAt within [startUtc, finalEndUtc]
    const invoiceScope = {
      ...this._buildScope(organizationId, branchId),
      status: "finalized",
      finalizedAt: { $gte: startUtc, $lte: finalEndUtc },
    };

    // Cash collections cohort: Payment.paymentDate within [startUtc, finalEndUtc]
    const paymentScope = {
      ...this._buildScope(organizationId, branchId),
      status: "completed",
      paymentDate: { $gte: startUtc, $lte: finalEndUtc },
    };

    // Current period aggregations
    const [invoiceTotals] = await Invoice.aggregate([
      { $match: invoiceScope },
      {
        $facet: {
          summary: [
            {
              $group: {
                _id: null,
                grossBilled: { $sum: "$subtotal" },
                totalDiscounts: { $sum: "$discountTotal" },
                subscriptionCoveredValue: { $sum: "$subscriptionCoveredAmount" },
                netBilled: { $sum: "$payableAmount" },
                amountPaidOnInvoices: { $sum: "$amountPaid" },
                outstandingReceivables: { $sum: "$amountDue" },
              },
            },
          ],
          streams: [
            { $unwind: "$lines" },
            {
              $group: {
                _id: "$lines.lineType",
                total: { $sum: "$lines.customerPayable" },
              },
            },
          ],
          dailyBilled: [
            {
              $group: {
                _id: {
                  $dateToString: {
                    date: "$finalizedAt",
                    format: "%Y-%m-%d",
                    timezone: meta.timezone,
                  },
                },
                billedSales: { $sum: "$payableAmount" },
              },
            },
            { $sort: { _id: 1 } },
          ],
        },
      },
    ]);

    const [paymentTotals] = await Payment.aggregate([
      { $match: paymentScope },
      {
        $facet: {
          tenders: [
            {
              $group: {
                _id: { type: "$type", method: "$method" },
                totalAmount: { $sum: "$amount" },
                count: { $sum: 1 },
              },
            },
          ],
          dailyCash: [
            {
              $group: {
                _id: {
                  $dateToString: {
                    date: "$paymentDate",
                    format: "%Y-%m-%d",
                    timezone: meta.timezone,
                  },
                },
                collected: {
                  $sum: {
                    $cond: [{ $eq: ["$type", "payment"] }, "$amount", 0],
                  },
                },
                refunded: {
                  $sum: {
                    $cond: [
                      { $eq: ["$type", "refund"] },
                      { $abs: "$amount" },
                      0,
                    ],
                  },
                },
              },
            },
            { $sort: { _id: 1 } },
          ],
        },
      },
    ]);

    // Process summary numbers
    const curSummary = invoiceTotals?.summary?.[0] || {
      grossBilled: 0,
      totalDiscounts: 0,
      subscriptionCoveredValue: 0,
      netBilled: 0,
      outstandingReceivables: 0,
    };

    let grossCollected = 0;
    let refundsIssued = 0;
    const tenderBreakdownMap = { upi: { amount: 0, count: 0 }, card: { amount: 0, count: 0 }, cash: { amount: 0, count: 0 }, other: { amount: 0, count: 0 } };

    (paymentTotals?.tenders || []).forEach((t) => {
      const type = t._id.type;
      const method = t._id.method;
      if (type === "payment") {
        grossCollected += t.totalAmount;
        if (tenderBreakdownMap[method]) {
          tenderBreakdownMap[method].amount += t.totalAmount;
          tenderBreakdownMap[method].count += t.count;
        } else {
          tenderBreakdownMap.other.amount += t.totalAmount;
          tenderBreakdownMap.other.count += t.count;
        }
      } else if (type === "refund") {
        refundsIssued += Math.abs(t.totalAmount);
      }
    });

    const netCollected = grossCollected - refundsIssued;

    // Optional comparison period computation
    let prevSummary = null;
    let prevGrossCollected = null;
    let prevRefundsIssued = null;
    let prevNetCollected = null;

    if (meta.comparisonStartDate && meta.comparisonEndDate) {
      const { startUtc: cmpStartUtc } = getUTCDayRange(meta.comparisonStartDate, meta.timezone);
      const { endUtc: cmpEndUtc } = getUTCDayRange(meta.comparisonEndDate, meta.timezone);

      const [cmpInvoiceDocs, cmpPayments] = await Promise.all([
        Invoice.aggregate([
          {
            $match: {
              ...this._buildScope(organizationId, branchId),
              status: "finalized",
              finalizedAt: { $gte: cmpStartUtc, $lte: cmpEndUtc },
            },
          },
          {
            $group: {
              _id: null,
              grossBilled: { $sum: "$subtotal" },
              totalDiscounts: { $sum: "$discountTotal" },
              subscriptionCoveredValue: { $sum: "$subscriptionCoveredAmount" },
              netBilled: { $sum: "$payableAmount" },
              outstandingReceivables: { $sum: "$amountDue" },
            },
          },
        ]),
        Payment.aggregate([
          {
            $match: {
              ...this._buildScope(organizationId, branchId),
              status: "completed",
              paymentDate: { $gte: cmpStartUtc, $lte: cmpEndUtc },
            },
          },
          {
            $group: {
              _id: "$type",
              total: { $sum: "$amount" },
            },
          },
        ]),
      ]);

      const cmpInvoice = cmpInvoiceDocs?.[0];

      prevSummary = cmpInvoice || {
        grossBilled: 0,
        totalDiscounts: 0,
        subscriptionCoveredValue: 0,
        netBilled: 0,
        outstandingReceivables: 0,
      };

      let pCollected = 0;
      let pRefunded = 0;
      (cmpPayments || []).forEach((p) => {
        if (p._id === "payment") pCollected = p.total;
        if (p._id === "refund") pRefunded = Math.abs(p.total);
      });
      prevGrossCollected = pCollected;
      prevRefundsIssued = pRefunded;
      prevNetCollected = pCollected - pRefunded;
    }

    // Format streams
    const streamsMap = { service: 0, product: 0, membership: 0, subscription: 0 };
    (invoiceTotals?.streams || []).forEach((st) => {
      if (streamsMap[st._id] !== undefined) {
        streamsMap[st._id] = st.total;
      }
    });

    // Format tenders
    const tenderBreakdown = Object.entries(tenderBreakdownMap).map(([method, data]) => ({
      method,
      amount: data.amount,
      transactionCount: data.count,
      percentageOfTotal:
        grossCollected > 0 ? Number(((data.amount / grossCollected) * 100).toFixed(2)) : 0,
    }));

    // Merge time series
    const dailyMap = new Map();
    (invoiceTotals?.dailyBilled || []).forEach((d) => {
      dailyMap.set(d._id, { date: d._id, billedSales: d.billedSales, moneyCollected: 0, refunds: 0 });
    });
    (paymentTotals?.dailyCash || []).forEach((d) => {
      const existing = dailyMap.get(d._id) || { date: d._id, billedSales: 0, moneyCollected: 0, refunds: 0 };
      existing.moneyCollected = d.collected;
      existing.refunds = d.refunded;
      dailyMap.set(d._id, existing);
    });

    const timeSeries = Array.from(dailyMap.values()).sort((a, b) => a.date.localeCompare(b.date));

    // Recent transactions for table drill-down
    const recentTransactionsCount = await Invoice.countDocuments(invoiceScope);
    const recentTransactionsPagination = resolvePagination(
      query,
      recentTransactionsCount,
      "page",
      "limit",
      options.includeAllRows,
    );
    let recentInvoicesQuery = Invoice.find(invoiceScope)
      .sort({ finalizedAt: -1, _id: -1 })
      .select("invoiceNumber customerSnapshot finalizedAt payableAmount amountPaid amountDue paymentStatus");
    if (!options.includeAllRows) {
      recentInvoicesQuery = recentInvoicesQuery
        .skip(recentTransactionsPagination.skip)
        .limit(recentTransactionsPagination.limit);
    }
    const recentInvoices = await recentInvoicesQuery.lean();

    const recentTransactions = recentInvoices.map((inv) => ({
      invoiceId: inv._id.toString(),
      invoiceNumber: inv.invoiceNumber,
      clientName: inv.customerSnapshot?.name || "Walk-In Client",
      date: inv.finalizedAt ? inv.finalizedAt.toISOString().split("T")[0] : "",
      billedAmount: inv.payableAmount,
      paidAmount: inv.amountPaid,
      dueAmount: inv.amountDue,
      paymentStatus: inv.paymentStatus,
    }));

    return {
      meta,
      summary: {
        grossBilled: calculateMetricDelta(curSummary.grossBilled, prevSummary?.grossBilled),
        totalDiscounts: calculateMetricDelta(curSummary.totalDiscounts, prevSummary?.totalDiscounts),
        subscriptionCoveredValue: calculateMetricDelta(
          curSummary.subscriptionCoveredValue,
          prevSummary?.subscriptionCoveredValue
        ),
        netBilled: calculateMetricDelta(curSummary.netBilled, prevSummary?.netBilled),
        grossCollected: calculateMetricDelta(grossCollected, prevGrossCollected),
        refundsIssued: calculateMetricDelta(refundsIssued, prevRefundsIssued),
        netCollected: calculateMetricDelta(netCollected, prevNetCollected),
        outstandingReceivables: calculateMetricDelta(
          curSummary.outstandingReceivables,
          prevSummary?.outstandingReceivables
        ),
      },
      streams: {
        servicesBilled: streamsMap.service,
        retailBilled: streamsMap.product,
        membershipsBilled: streamsMap.membership,
        subscriptionsBilled: streamsMap.subscription,
      },
      tenderBreakdown,
      timeSeries,
      recentTransactions,
      pagination: {
        recentTransactions: getPaginationMetadata(recentTransactionsPagination),
      },
    };
  }

  // =========================================================================
  // 2. STAFF PERFORMANCE REPORT
  // =========================================================================
  async getStaffPerformanceReport(organizationId, branchId, query, options = {}) {
    const { startDate, endDate, compareWith } = query;
    const meta = await this._resolveMeta(organizationId, branchId, startDate, endDate, compareWith);

    const { startUtc, endUtc } = getUTCDayRange(startDate, meta.timezone);
    const { endUtc: finalEndUtc } = getUTCDayRange(endDate, meta.timezone);

    const baseScope = this._buildScope(organizationId, branchId);

    // 1. Authoritative finalized invoice line attribution
    const finalizedInvoices = await Invoice.find({
      ...baseScope,
      status: "finalized",
      finalizedAt: { $gte: startUtc, $lte: finalEndUtc },
    })
      .select("lines finalizedAt")
      .lean();

    // 2. Authoritative completed appointments in the period
    const completedAppointments = await Appointment.find({
      ...baseScope,
      status: "completed",
      startAt: { $gte: startUtc, $lte: finalEndUtc },
    })
      .select("staffId services startAt")
      .lean();

    // Collect all billed appointmentServiceId to deduplicate
    const billedAppointmentServiceIds = new Set();
    finalizedInvoices.forEach((inv) => {
      (inv.lines || []).forEach((line) => {
        if (line.appointmentServiceId) {
          billedAppointmentServiceIds.add(line.appointmentServiceId.toString());
        }
      });
    });

    // Staff ranking aggregators: staffId -> { name, code, servicesCompletedCount, serviceHours, ... }
    const staffMap = new Map();

    const getOrCreateStaff = (staffIdStr, name, code) => {
      if (!staffMap.has(staffIdStr)) {
        staffMap.set(staffIdStr, {
          staffId: staffIdStr,
          name: name || "Unassigned Staff",
          staffCode: code || "N/A",
          servicesCompletedCount: 0,
          serviceHours: 0,
          serviceRevenueCredit: 0,
          retailSalesCredit: 0,
          packageSalesCredit: 0,
          totalRevenueContribution: 0,
        });
      }
      return staffMap.get(staffIdStr);
    };

    // A. Attribute from finalized invoice lines
    finalizedInvoices.forEach((inv) => {
      (inv.lines || []).forEach((line) => {
        const lineType = line.lineType;
        const payable = line.customerPayable || 0;
        const durationMins = line.duration || 0;

        if (lineType === "service") {
          const performer = line.attribution?.performedBy;
          const sId = performer?.staffId?.toString() || line.staffId?.toString() || "unassigned";
          const st = getOrCreateStaff(sId, performer?.name, performer?.staffCode);
          st.servicesCompletedCount += line.quantity || 1;
          st.serviceHours += (durationMins * (line.quantity || 1)) / 60;
          st.serviceRevenueCredit += payable;
          st.totalRevenueContribution += payable;
        } else if (lineType === "product") {
          const seller = line.attribution?.soldBy;
          const sId = seller?.staffId?.toString() || "unassigned";
          const st = getOrCreateStaff(sId, seller?.name, seller?.staffCode);
          st.retailSalesCredit += payable;
          st.totalRevenueContribution += payable;
        } else if (lineType === "membership" || lineType === "subscription") {
          const seller = line.attribution?.soldBy;
          const sId = seller?.staffId?.toString() || "unassigned";
          const st = getOrCreateStaff(sId, seller?.name, seller?.staffCode);
          st.packageSalesCredit += payable;
          st.totalRevenueContribution += payable;
        }
      });
    });

    // B. Add unbilled completed appointment services (deduplicated)
    completedAppointments.forEach((apt) => {
      (apt.services || []).forEach((svc) => {
        const svcIdStr = svc._id.toString();
        if (!billedAppointmentServiceIds.has(svcIdStr)) {
          // Unbilled physical completion
          const sId = apt.staffId ? apt.staffId.toString() : "unassigned";
          const st = getOrCreateStaff(sId, null, null);
          st.servicesCompletedCount += 1;
          st.serviceHours += (svc.duration || 30) / 60;
          // Unbilled service revenue is 0 until finalized
        }
      });
    });

    const rankings = Array.from(staffMap.values()).map((st) => ({
      ...st,
      serviceHours: Number(st.serviceHours.toFixed(1)),
      serviceRevenueCredit: Number(st.serviceRevenueCredit.toFixed(2)),
      retailSalesCredit: Number(st.retailSalesCredit.toFixed(2)),
      packageSalesCredit: Number(st.packageSalesCredit.toFixed(2)),
      totalRevenueContribution: Number(st.totalRevenueContribution.toFixed(2)),
      totalRevenueCredit: Number(st.totalRevenueContribution.toFixed(2)),
    }));

    rankings.sort(
      (a, b) =>
        b.totalRevenueContribution - a.totalRevenueContribution ||
        a.staffId.localeCompare(b.staffId),
    );

    // Summary totals
    let totalServices = 0;
    let totalHours = 0;
    let totalServiceRev = 0;
    let totalRetailRev = 0;

    rankings.forEach((r) => {
      totalServices += r.servicesCompletedCount;
      totalHours += r.serviceHours;
      totalServiceRev += r.serviceRevenueCredit;
      totalRetailRev += r.retailSalesCredit;
    });

    const topStaff = rankings.length > 0 && rankings[0].staffId !== "unassigned" ? rankings[0].name : null;
    const rankingsPagination = resolvePagination(
      query,
      rankings.length,
      "page",
      "limit",
      options.includeAllRows,
    );
    const paginatedRankings = options.includeAllRows
      ? rankings
      : rankings.slice(
          rankingsPagination.skip,
          rankingsPagination.skip + rankingsPagination.limit,
        );
    const comparisonQuery = this._getComparisonQuery(query, meta);
    const previousReport = comparisonQuery
      ? await this.getStaffPerformanceReport(organizationId, branchId, comparisonQuery)
      : null;

    return {
      meta,
      summary: {
        totalServicesDelivered: calculateMetricDelta(
          totalServices,
          previousReport?.summary.totalServicesDelivered.current,
        ),
        totalChairTimeHours: calculateMetricDelta(
          Number(totalHours.toFixed(1)),
          previousReport?.summary.totalChairTimeHours.current,
        ),
        serviceRevenueGenerated: calculateMetricDelta(
          totalServiceRev,
          previousReport?.summary.serviceRevenueGenerated.current,
        ),
        retailSalesGenerated: calculateMetricDelta(
          totalRetailRev,
          previousReport?.summary.retailSalesGenerated.current,
        ),
        topPerformingStaffName: topStaff,
      },
      rankings: paginatedRankings,
      pagination: {
        rankings: getPaginationMetadata(rankingsPagination),
      },
    };
  }

  // =========================================================================
  // 3. CUSTOMER RETENTION REPORT
  // =========================================================================
  async getCustomerRetentionReport(
    organizationId,
    branchId,
    query,
    userPermissions = [],
    options = {},
  ) {
    const { startDate, endDate, compareWith } = query;
    const meta = await this._resolveMeta(organizationId, branchId, startDate, endDate, compareWith);

    const { startUtc, endUtc } = getUTCDayRange(startDate, meta.timezone);
    const { endUtc: finalEndUtc } = getUTCDayRange(endDate, meta.timezone);

    const canViewUnmaskedPhone = userPermissions.includes("customers.view");
    const baseScope = this._buildScope(organizationId, branchId);

    // 1. Visiting customers in current period
    // A. From finalized invoices
    const periodInvoices = await Invoice.find({
      ...baseScope,
      status: "finalized",
      finalizedAt: { $gte: startUtc, $lte: finalEndUtc },
    })
      .select("customerId finalizedAt appointmentId")
      .lean();

    // B. From completed appointments
    const periodAppointments = await Appointment.find({
      ...baseScope,
      status: "completed",
      startAt: { $gte: startUtc, $lte: finalEndUtc },
    })
      .select("customerId startAt")
      .lean();

    // Deduplicate distinct visits and distinct customer IDs in period
    const visitingCustomerIdsSet = new Set();
    const periodVisitsMap = new Map();

    periodInvoices.forEach((inv) => {
      if (inv.customerId) {
        const cIdStr = inv.customerId.toString();
        visitingCustomerIdsSet.add(cIdStr);
        const visitKey = inv.appointmentId ? inv.appointmentId.toString() : inv._id.toString();
        periodVisitsMap.set(visitKey, { customerId: cIdStr, date: inv.finalizedAt });
      }
    });

    periodAppointments.forEach((apt) => {
      if (apt.customerId) {
        const cIdStr = apt.customerId.toString();
        visitingCustomerIdsSet.add(cIdStr);
        const visitKey = apt._id.toString();
        if (!periodVisitsMap.has(visitKey)) {
          periodVisitsMap.set(visitKey, { customerId: cIdStr, date: apt.startAt });
        }
      }
    });

    const totalVisitingClientsCount = visitingCustomerIdsSet.size;

    // 2. Classify New vs Returning clients
    // For each visiting client, check if they had a visit prior to startUtc
    const visitingCustomerIds = Array.from(visitingCustomerIdsSet).map(
      (id) => new mongoose.Types.ObjectId(id)
    );

    const priorInvoiceClients = await Invoice.distinct("customerId", {
      ...baseScope,
      customerId: { $in: visitingCustomerIds },
      status: "finalized",
      finalizedAt: { $lt: startUtc },
    });

    const priorApptClients = await Appointment.distinct("customerId", {
      ...baseScope,
      customerId: { $in: visitingCustomerIds },
      status: "completed",
      startAt: { $lt: startUtc },
    });

    const priorClientSet = new Set([
      ...priorInvoiceClients.map((id) => id.toString()),
      ...priorApptClients.map((id) => id.toString()),
    ]);

    let returningClientsCount = 0;
    let newClientsCount = 0;

    visitingCustomerIdsSet.forEach((cIdStr) => {
      if (priorClientSet.has(cIdStr)) {
        returningClientsCount++;
      } else {
        newClientsCount++;
      }
    });

    const repeatVisitRate =
      totalVisitingClientsCount > 0
        ? Number(((returningClientsCount / totalVisitingClientsCount) * 100).toFixed(1))
        : null;

    // 3. Recency cohorts anchored to report endDate
    const reportEndInstant = finalEndUtc;
    const dayMs = 24 * 60 * 60 * 1000;

    const allCustomerLatestVisits = await Invoice.aggregate([
      {
        $match: {
          ...baseScope,
          status: "finalized",
          finalizedAt: { $lte: reportEndInstant },
          customerId: { $ne: null },
        },
      },
      {
        $project: {
          _id: 0,
          customerId: 1,
          visitKey: {
            $cond: [
              { $ifNull: ["$appointmentId", false] },
              { $concat: ["appointment:", { $toString: "$appointmentId" }] },
              { $concat: ["invoice:", { $toString: "$_id" }] },
            ],
          },
          visitDate: "$finalizedAt",
          sourcePriority: { $literal: 1 },
        },
      },
      {
        $unionWith: {
          coll: Appointment.collection.name,
          pipeline: [
            {
              $match: {
                ...baseScope,
                status: "completed",
                startAt: { $lte: reportEndInstant },
                customerId: { $ne: null },
              },
            },
            {
              $project: {
                _id: 0,
                customerId: 1,
                visitKey: { $concat: ["appointment:", { $toString: "$_id" }] },
                visitDate: "$startAt",
                sourcePriority: { $literal: 0 },
              },
            },
          ],
        },
      },
      { $sort: { visitKey: 1, sourcePriority: -1 } },
      {
        $group: {
          _id: "$visitKey",
          customerId: { $first: "$customerId" },
          visitDate: { $first: "$visitDate" },
        },
      },
      {
        $group: {
          _id: "$customerId",
          latestVisit: { $max: "$visitDate" },
          visitCount: { $sum: 1 },
        },
      },
      { $sort: { latestVisit: -1, _id: 1 } },
    ]);

    const recencyBuckets = { active: 0, dueForService: 0, atRisk: 0, lapsed: 0 };
    const frequencyTiers = { "1 visit": 0, "2 visits": 0, "3-5 visits": 0, "6+ visits": 0 };

    allCustomerLatestVisits.forEach((cv) => {
      const daysInactive = Math.max(
        0,
        Math.floor((reportEndInstant.getTime() - new Date(cv.latestVisit).getTime()) / dayMs)
      );

      if (daysInactive <= 45) recencyBuckets.active++;
      else if (daysInactive <= 75) recencyBuckets.dueForService++;
      else if (daysInactive <= 105) recencyBuckets.atRisk++;
      else recencyBuckets.lapsed++;

      if (cv.visitCount === 1) frequencyTiers["1 visit"]++;
      else if (cv.visitCount === 2) frequencyTiers["2 visits"]++;
      else if (cv.visitCount <= 5) frequencyTiers["3-5 visits"]++;
      else frequencyTiers["6+ visits"]++;
    });

    // 4. Client Directory drill-down table
    const clientDirectoryPagination = resolvePagination(
      query,
      allCustomerLatestVisits.length,
      "page",
      "limit",
      options.includeAllRows,
    );
    const directoryVisits = options.includeAllRows
      ? allCustomerLatestVisits
      : allCustomerLatestVisits.slice(
          clientDirectoryPagination.skip,
          clientDirectoryPagination.skip + clientDirectoryPagination.limit,
        );
    const targetCustomerIds = directoryVisits.map((c) => c._id);
    const customerProfiles = await Customer.find({
      _id: { $in: targetCustomerIds },
      organizationId,
    })
      .select("name phone createdAt")
      .lean();

    const profileMap = new Map(customerProfiles.map((p) => [p._id.toString(), p]));

    const clientDirectory = directoryVisits.map((cv) => {
      const cIdStr = cv._id.toString();
      const prof = profileMap.get(cIdStr);
      const days = Math.max(
        0,
        Math.floor((reportEndInstant.getTime() - new Date(cv.latestVisit).getTime()) / dayMs)
      );

      let statusTier = "active";
      if (days > 105) statusTier = "lapsed";
      else if (days > 75) statusTier = "atRisk";
      else if (days > 45) statusTier = "dueForService";

      return {
        customerId: cIdStr,
        name: prof?.name || "Client",
        phone: canViewUnmaskedPhone ? prof?.phone || "" : maskPhoneNumber(prof?.phone),
        lastVisitDate: new Date(cv.latestVisit).toISOString().split("T")[0],
        totalLifetimeVisits: cv.visitCount,
        daysSinceLastVisit: days,
        statusTier,
      };
    });

    const comparisonQuery = this._getComparisonQuery(query, meta);
    const previousReport = comparisonQuery
      ? await this.getCustomerRetentionReport(
          organizationId,
          branchId,
          comparisonQuery,
          userPermissions,
        )
      : null;

    return {
      meta,
      summary: {
        totalVisitingClients: calculateMetricDelta(
          totalVisitingClientsCount,
          previousReport?.summary.totalVisitingClients.current,
        ),
        newClientsAcquired: calculateMetricDelta(
          newClientsCount,
          previousReport?.summary.newClientsAcquired.current,
        ),
        returningClients: calculateMetricDelta(
          returningClientsCount,
          previousReport?.summary.returningClients.current,
        ),
        repeatVisitRate: calculateRateDelta(
          repeatVisitRate,
          previousReport?.summary.repeatVisitRate.current,
        ),
        atRiskClientsCount: recencyBuckets.atRisk,
        historyCompleteness: "truncated",
        historyCompletenessNote: "Historical customer visit logs begin from available system records; earlier lifetime visits prior to system digital records cannot be certified.",
      },
      recencyBuckets,
      visitFrequencyDistribution: Object.entries(frequencyTiers).map(([tier, count]) => ({
        frequencyTier: tier,
        clientCount: count,
        percentageOfTotal:
          allCustomerLatestVisits.length > 0
            ? Number(((count / allCustomerLatestVisits.length) * 100).toFixed(1))
            : 0,
      })),
      clientDirectory,
      pagination: {
        clientDirectory: getPaginationMetadata(clientDirectoryPagination),
      },
    };
  }

  // =========================================================================
  // 4. SERVICE ANALYTICS REPORT
  // =========================================================================
  async getServiceAnalyticsReport(organizationId, branchId, query, options = {}) {
    const { startDate, endDate, compareWith } = query;
    const meta = await this._resolveMeta(organizationId, branchId, startDate, endDate, compareWith);

    const { startUtc, endUtc } = getUTCDayRange(startDate, meta.timezone);
    const { endUtc: finalEndUtc } = getUTCDayRange(endDate, meta.timezone);

    const invoiceScope = {
      ...this._buildScope(organizationId, branchId),
      status: "finalized",
      finalizedAt: { $gte: startUtc, $lte: finalEndUtc },
    };

    const serviceStats = await Invoice.aggregate([
      { $match: invoiceScope },
      { $unwind: "$lines" },
      { $match: { "lines.lineType": "service" } },
      {
        $group: {
          _id: "$lines.serviceId",
          name: { $first: "$lines.name" },
          executionCount: { $sum: "$lines.quantity" },
          grossRevenue: { $sum: "$lines.customerPayable" },
          totalDuration: { $sum: { $multiply: ["$lines.duration", "$lines.quantity"] } },
        },
      },
      { $sort: { executionCount: -1, _id: 1 } },
    ]);

    // Populate category names
    const serviceIds = serviceStats.map((s) => s._id).filter(Boolean);
    const catalogServices = await Service.find({
      _id: { $in: serviceIds },
      organizationId,
    })
      .select("categoryId")
      .populate("categoryId", "name")
      .lean();

    const categoryMap = new Map();
    catalogServices.forEach((s) => {
      categoryMap.set(s._id.toString(), s.categoryId?.name || "General Services");
    });

    let totalExecutions = 0;
    let totalGrossRev = 0;

    const topServices = serviceStats.map((st) => {
      const sIdStr = st._id ? st._id.toString() : "custom";
      const catName = categoryMap.get(sIdStr) || "General Services";
      totalExecutions += st.executionCount;
      totalGrossRev += st.grossRevenue;

      return {
        serviceId: sIdStr,
        name: st.name,
        category: catName,
        executionCount: st.executionCount,
        totalGrossRevenue: st.grossRevenue,
        averageDurationMinutes:
          st.executionCount > 0 ? Math.round(st.totalDuration / st.executionCount) : 0,
        percentageContribution: 0,
      };
    });

    // Compute percentage contribution
    topServices.forEach((s) => {
      s.percentageContribution =
        totalExecutions > 0 ? Number(((s.executionCount / totalExecutions) * 100).toFixed(1)) : 0;
    });

    // Category aggregation
    const catAggregationMap = new Map();
    topServices.forEach((s) => {
      const existing = catAggregationMap.get(s.category) || { count: 0, revenue: 0 };
      existing.count += s.executionCount;
      existing.revenue += s.totalGrossRevenue;
      catAggregationMap.set(s.category, existing);
    });

    const categoryShare = Array.from(catAggregationMap.entries()).map(([cat, data]) => ({
      category: cat,
      executionCount: data.count,
      revenue: data.revenue,
      percentageShare:
        totalExecutions > 0 ? Number(((data.count / totalExecutions) * 100).toFixed(1)) : 0,
    }));

    const averageServiceTicket =
      totalExecutions > 0 ? Number((totalGrossRev / totalExecutions).toFixed(2)) : 0;
    categoryShare.sort(
      (a, b) => b.revenue - a.revenue || a.category.localeCompare(b.category),
    );
    const topServicePagination = resolvePagination(
      query,
      topServices.length,
      "page",
      "limit",
      options.includeAllRows,
    );
    const categoryPagination = resolvePagination(
      query,
      categoryShare.length,
      "categoryPage",
      "categoryLimit",
      options.includeAllRows,
    );
    const paginatedTopServices = options.includeAllRows
      ? topServices
      : topServices.slice(
          topServicePagination.skip,
          topServicePagination.skip + topServicePagination.limit,
        );
    const paginatedCategoryShare = options.includeAllRows
      ? categoryShare
      : categoryShare.slice(
          categoryPagination.skip,
          categoryPagination.skip + categoryPagination.limit,
        );
    const comparisonQuery = this._getComparisonQuery(query, meta);
    const previousReport = comparisonQuery
      ? await this.getServiceAnalyticsReport(organizationId, branchId, comparisonQuery)
      : null;

    return {
      meta,
      summary: {
        totalServicesCompleted: calculateMetricDelta(
          totalExecutions,
          previousReport?.summary.totalServicesCompleted.current,
        ),
        averageServiceTicket: calculateMetricDelta(
          averageServiceTicket,
          previousReport?.summary.averageServiceTicket.current,
        ),
        mostRequestedServiceName: topServices.length > 0 ? topServices[0].name : "N/A",
        topRevenueCategoryName: categoryShare[0]?.category || "N/A",
      },
      topServices: paginatedTopServices,
      categoryShare: paginatedCategoryShare,
      pagination: {
        topServices: getPaginationMetadata(topServicePagination),
        categoryShare: getPaginationMetadata(categoryPagination),
      },
    };
  }

  // =========================================================================
  // 5. INVENTORY REPORT
  // =========================================================================
  async getInventoryReport(organizationId, branchId, query, options = {}) {
    const { startDate, endDate, compareWith } = query;
    const meta = await this._resolveMeta(organizationId, branchId, startDate, endDate, compareWith);

    const { startUtc, endUtc } = getUTCDayRange(startDate, meta.timezone);
    const { endUtc: finalEndUtc } = getUTCDayRange(endDate, meta.timezone);

    const baseScope = this._buildScope(organizationId, branchId);

    // 1. StockBalances and reorderLevel comparison
    const stockBalanceScope = {
      organizationId: new mongoose.Types.ObjectId(organizationId),
      ...(branchId ? { branchId: new mongoose.Types.ObjectId(branchId) } : {}),
    };
    const stockBalanceWithProduct = [
      { $match: stockBalanceScope },
      {
        $lookup: {
          from: Product.collection.name,
          localField: "productId",
          foreignField: "_id",
          as: "product",
        },
      },
      { $unwind: { path: "$product", preserveNullAndEmptyArrays: true } },
    ];
    const lowStockExpression = {
      $or: [
        {
          $and: [
            { $eq: ["$product.usageType", "salon_consumption"] },
            { $gt: ["$product.reorderLevel", 0] },
            { $lte: ["$onHandConsumables", "$product.reorderLevel"] },
          ],
        },
        {
          $and: [
            { $eq: ["$product.usageType", "retail_sale"] },
            { $gt: ["$product.reorderLevel", 0] },
            { $lte: ["$onHandRetail", "$product.reorderLevel"] },
          ],
        },
        {
          $and: [
            { $eq: ["$product.usageType", "both"] },
            {
              $or: [
                { $eq: ["$onHandConsumables", 0] },
                { $eq: ["$onHandRetail", 0] },
                {
                  $and: [
                    { $gt: ["$product.reorderLevel", 0] },
                    { $lte: ["$onHand", "$product.reorderLevel"] },
                  ],
                },
              ],
            },
          ],
        },
      ],
    };
    const [stockSummary] = await StockBalance.aggregate([
      ...stockBalanceWithProduct,
      {
        $group: {
          _id: null,
          totalTrackedSkuCount: { $sum: 1 },
          lowStockConsumablesCount: {
            $sum: {
              $cond: [
                {
                  $and: [
                    { $eq: ["$product.usageType", "salon_consumption"] },
                    { $gt: ["$product.reorderLevel", 0] },
                    { $lte: ["$onHandConsumables", "$product.reorderLevel"] },
                  ],
                },
                1,
                0,
              ],
            },
          },
          lowStockRetailCount: {
            $sum: {
              $cond: [
                {
                  $and: [
                    { $eq: ["$product.usageType", "retail_sale"] },
                    { $gt: ["$product.reorderLevel", 0] },
                    { $lte: ["$onHandRetail", "$product.reorderLevel"] },
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
    const [lowStockCountResult] = await StockBalance.aggregate([
      ...stockBalanceWithProduct,
      { $match: { $expr: lowStockExpression } },
      { $count: "total" },
    ]);
    const lowStockAlertsPagination = resolvePagination(
      query,
      lowStockCountResult?.total || 0,
      "lowStockPage",
      "lowStockLimit",
      options.includeAllLowStockAlerts || options.includeAllRows,
    );
    let lowStockAlertsQuery = StockBalance.aggregate([
      ...stockBalanceWithProduct,
      { $match: { $expr: lowStockExpression } },
      { $sort: { "product.name": 1, _id: 1 } },
    ]);
    if (!(options.includeAllLowStockAlerts || options.includeAllRows)) {
      lowStockAlertsQuery = lowStockAlertsQuery
        .skip(lowStockAlertsPagination.skip)
        .limit(lowStockAlertsPagination.limit);
    }
    const paginatedLowStockAlerts = await lowStockAlertsQuery
      .project({
        _id: 0,
        stockBalanceId: { $toString: "$_id" },
        productId: { $toString: "$product._id" },
        name: "$product.name",
        sku: "$product.sku",
        category: "$product.category",
        usageType: "$product.usageType",
        onHandConsumables: 1,
        onHandRetail: 1,
        totalOnHand: "$onHand",
        reorderLevel: { $ifNull: ["$product.reorderLevel", 0] },
        urgency: {
          $cond: [
            {
              $or: [
                {
                  $and: [
                    { $eq: ["$product.usageType", "salon_consumption"] },
                    { $eq: ["$onHandConsumables", 0] },
                  ],
                },
                {
                  $and: [
                    { $eq: ["$product.usageType", "retail_sale"] },
                    { $eq: ["$onHandRetail", 0] },
                  ],
                },
                {
                  $and: [
                    { $eq: ["$product.usageType", "both"] },
                    {
                      $or: [
                        { $eq: ["$onHandConsumables", 0] },
                        { $eq: ["$onHandRetail", 0] },
                      ],
                    },
                  ],
                },
              ],
            },
            "critical",
            "warning",
          ],
        },
      })
      .exec();

    // 2. Stock movements in period
    const movementScope = {
      organizationId: new mongoose.Types.ObjectId(organizationId),
      ...(branchId ? { branchId: new mongoose.Types.ObjectId(branchId) } : {}),
      accountingDate: { $gte: startUtc, $lte: finalEndUtc },
    };

    const [movementTotals] = await StockMovement.aggregate([
      { $match: movementScope },
      {
        $lookup: {
          from: StockMovement.collection.name,
          localField: "reversesMovementId",
          foreignField: "_id",
          as: "reversedMovement",
        },
      },
      {
        $unwind: {
          path: "$reversedMovement",
          preserveNullAndEmptyArrays: true,
        },
      },
      {
        $group: {
          _id: null,
          consumablesUsed: {
            $sum: {
              $switch: {
                branches: [
                  {
                    case: { $eq: ["$movementType", "service_consumption"] },
                    then: { $abs: "$quantityDelta" },
                  },
                  {
                    case: {
                      $and: [
                        { $eq: ["$movementType", "movement_reversal"] },
                        { $eq: ["$reversedMovement.movementType", "service_consumption"] },
                      ],
                    },
                    then: { $multiply: [{ $abs: "$quantityDelta" }, -1] },
                  },
                ],
                default: 0,
              },
            },
          },
          retailUnitsSold: {
            $sum: {
              $switch: {
                branches: [
                  {
                    case: { $eq: ["$movementType", "pos_sale"] },
                    then: { $abs: "$quantityDelta" },
                  },
                  {
                    case: {
                      $and: [
                        { $eq: ["$movementType", "movement_reversal"] },
                        { $eq: ["$reversedMovement.movementType", "pos_sale"] },
                      ],
                    },
                    then: { $multiply: [{ $abs: "$quantityDelta" }, -1] },
                  },
                ],
                default: 0,
              },
            },
          },
          auditNetDiscrepancy: {
            $sum: {
              $cond: [
                {
                  $or: [
                    { $in: ["$movementType", ["stocktake", "adjustment"]] },
                    {
                      $and: [
                        { $eq: ["$movementType", "movement_reversal"] },
                        { $in: ["$reversedMovement.movementType", ["stocktake", "adjustment"]] },
                      ],
                    },
                  ],
                },
                "$quantityDelta",
                0,
              ],
            },
          },
        },
      },
    ]);

    const movementCount = await StockMovement.countDocuments(movementScope);
    const movementLogsPagination = resolvePagination(
      query,
      movementCount,
      "movementPage",
      "movementLimit",
      options.includeAllMovementLogs,
    );
    let movements = [];
    if (options.includeMovementLogs !== false) {
      let movementQuery = StockMovement.find(movementScope)
        .sort({ accountingDate: -1, _id: -1 })
        .populate("productId", "name sku")
        .populate("actorId", "name")
        .populate("reversesMovementId", "movementType");
      if (!options.includeAllMovementLogs) {
        movementQuery = movementQuery
          .skip(movementLogsPagination.skip)
          .limit(movementLogsPagination.limit);
      }
      movements = await movementQuery.lean();
    }

    const movementLogs = movements.map((m) => ({
      movementId: m._id.toString(),
      timestamp: m.accountingDate.toISOString(),
      productName: m.productId?.name || "Product",
      sku: m.productId?.sku || "N/A",
      movementType: m.movementType,
      quantityDelta: m.quantityDelta,
      stockDomain: m.stockDomain,
      actorName: m.actorId?.name || "System",
      notes: m.notes || "",
    }));

    const comparisonQuery = this._getComparisonQuery(query, meta);
    const previousReport = comparisonQuery
      ? await this.getInventoryReport(organizationId, branchId, comparisonQuery)
      : null;

    return {
      meta,
      summary: {
        totalTrackedSkuCount: stockSummary?.totalTrackedSkuCount || 0,
        lowStockConsumablesCount: stockSummary?.lowStockConsumablesCount || 0,
        lowStockRetailCount: stockSummary?.lowStockRetailCount || 0,
        consumablesUsedInPeriod: calculateMetricDelta(
          movementTotals?.consumablesUsed || 0,
          previousReport?.summary.consumablesUsedInPeriod.current,
        ),
        retailUnitsSoldInPeriod: calculateMetricDelta(
          movementTotals?.retailUnitsSold || 0,
          previousReport?.summary.retailUnitsSoldInPeriod.current,
        ),
        auditNetDiscrepancyDelta: movementTotals?.auditNetDiscrepancy || 0,
      },
      lowStockAlerts: paginatedLowStockAlerts,
      movementLogs,
      pagination: {
        lowStockAlerts: getPaginationMetadata(lowStockAlertsPagination),
        movementLogs: getPaginationMetadata(movementLogsPagination),
      },
    };
  }

  // =========================================================================
  // 6. REPORTS OVERVIEW (EXECUTIVE TELEMETRY)
  // =========================================================================
  async getReportsOverview(organizationId, branchId, query, userPermissions = []) {
    const hasRevenuePerm = userPermissions.includes("reports.revenue.view");
    const hasRetentionPerm = userPermissions.includes("reports.retention.view");
    const hasStaffPerm = userPermissions.includes("reports.performance.view");
    const hasInventoryPerm = userPermissions.includes("reports.inventory.view");

    const [revenueReport, retentionReport, staffReport, inventoryReport] = await Promise.all([
      hasRevenuePerm ? this.getRevenueReport(organizationId, branchId, query) : null,
      hasRetentionPerm ? this.getCustomerRetentionReport(organizationId, branchId, query, userPermissions) : null,
      hasStaffPerm ? this.getStaffPerformanceReport(organizationId, branchId, query) : null,
      hasInventoryPerm ? this.getInventoryReport(organizationId, branchId, query) : null,
    ]);

    const meta = await this._resolveMeta(
      organizationId,
      branchId,
      query.startDate,
      query.endDate,
      query.compareWith
    );

    const operationalSignals = [];

    if (inventoryReport && inventoryReport.summary.lowStockConsumablesCount > 0) {
      operationalSignals.push({
        id: "sig-low-consumables",
        type: "warning",
        title: `${inventoryReport.summary.lowStockConsumablesCount} Salon Consumables Below Reorder Level`,
        description: "Back-bar products are running low and may halt service execution.",
        actionLabel: "Review Inventory",
        actionHref: "/reports/inventory",
      });
    }

    if (revenueReport && revenueReport.summary.outstandingReceivables.current > 0) {
      operationalSignals.push({
        id: "sig-unpaid-invoices",
        type: "info",
        title: `₹${revenueReport.summary.outstandingReceivables.current} in Pending Receivables`,
        description: "Invoices finalized in this period have outstanding payment balances.",
        actionLabel: "View Unpaid Sales",
        actionHref: "/reports/revenue",
      });
    }

    const quickInsights = [];
    if (revenueReport) {
      quickInsights.push({
        category: "revenue",
        observation: `Net money collected is ₹${revenueReport.summary.netCollected.current.toLocaleString()}`,
        detail: `Based on ₹${revenueReport.summary.grossCollected.current.toLocaleString()} collections minus ₹${revenueReport.summary.refundsIssued.current.toLocaleString()} refunds.`,
        trend: "positive",
      });
    }
    if (retentionReport) {
      quickInsights.push({
        category: "clients",
        observation: `Repeat client rate stands at ${retentionReport.summary.repeatVisitRate.current || 0}%`,
        detail: `${retentionReport.summary.returningClients.current} returning clients visited during this period.`,
        trend: "positive",
      });
    }

    return {
      meta,
      summary: {
        netSalesBilled: revenueReport ? revenueReport.summary.netBilled : null,
        moneyCollected: revenueReport ? revenueReport.summary.netCollected : null,
        completedServices: staffReport ? staffReport.summary.totalServicesDelivered : null,
        totalVisitingClients: retentionReport ? retentionReport.summary.totalVisitingClients : null,
        repeatVisitRate: retentionReport ? retentionReport.summary.repeatVisitRate : null,
        lowStockItemCount: inventoryReport
          ? inventoryReport.summary.lowStockConsumablesCount +
            inventoryReport.summary.lowStockRetailCount
          : null,
      },
      operationalSignals,
      quickInsights,
    };
  }

  // =========================================================================
  // 7. CSV EXPORT UTILITY
  // =========================================================================
  async exportReportCSV(organizationId, branchId, reportType, query, userPermissions = []) {
    let csvData = "";

    if (reportType === "revenue") {
      const rep = await this.getRevenueReport(organizationId, branchId, query, {
        includeAllRows: true,
      });
      const headers = ["Invoice Number", "Client Name", "Date", "Billed (INR)", "Paid (INR)", "Due (INR)", "Status"];
      const rows = rep.recentTransactions.map((t) => [
        `"${t.invoiceNumber}"`,
        `"${t.clientName}"`,
        `"${t.date}"`,
        t.billedAmount,
        t.paidAmount,
        t.dueAmount,
        `"${t.paymentStatus}"`,
      ]);
      csvData = [headers.join(","), ...rows.map((r) => r.join(","))].join("\n");
    } else if (reportType === "staff-performance") {
      const rep = await this.getStaffPerformanceReport(organizationId, branchId, query, {
        includeAllRows: true,
      });
      const headers = ["Staff Name", "Code", "Services Completed", "Chair Hours", "Service Revenue (INR)", "Retail Sales (INR)", "Total Production (INR)"];
      const rows = rep.rankings.map((r) => [
        `"${r.name}"`,
        `"${r.staffCode}"`,
        r.servicesCompletedCount,
        r.serviceHours,
        r.serviceRevenueCredit,
        r.retailSalesCredit,
        r.totalRevenueContribution,
      ]);
      csvData = [headers.join(","), ...rows.map((r) => r.join(","))].join("\n");
    } else if (reportType === "customer-retention") {
      const rep = await this.getCustomerRetentionReport(
        organizationId,
        branchId,
        query,
        userPermissions,
        { includeAllRows: true },
      );
      const headers = ["Client Name", "Phone", "Last Visit Date", "Lifetime Visits", "Days Inactive", "Status Tier"];
      const rows = rep.clientDirectory.map((c) => [
        `"${c.name}"`,
        `"${c.phone}"`,
        `"${c.lastVisitDate}"`,
        c.totalLifetimeVisits,
        c.daysSinceLastVisit,
        `"${c.statusTier}"`,
      ]);
      csvData = [headers.join(","), ...rows.map((r) => r.join(","))].join("\n");
    } else if (reportType === "service-analytics") {
      const rep = await this.getServiceAnalyticsReport(organizationId, branchId, query, {
        includeAllRows: true,
      });
      const headers = ["Service Name", "Category", "Executions", "Avg Duration (Min)", "Gross Revenue (INR)", "Share (%)"];
      const rows = rep.topServices.map((s) => [
        `"${s.name}"`,
        `"${s.category}"`,
        s.executionCount,
        s.averageDurationMinutes,
        s.totalGrossRevenue,
        s.percentageContribution,
      ]);
      csvData = [headers.join(","), ...rows.map((r) => r.join(","))].join("\n");
    } else if (reportType === "inventory") {
      const rep = await this.getInventoryReport(organizationId, branchId, query, {
        includeAllLowStockAlerts: true,
        includeMovementLogs: false,
      });
      const headers = ["Product Name", "SKU", "Category", "Usage Type", "Consumables On-Hand", "Retail On-Hand", "Reorder Level", "Urgency"];
      const rows = rep.lowStockAlerts.map((a) => [
        `"${a.name}"`,
        `"${a.sku}"`,
        `"${a.category}"`,
        `"${a.usageType}"`,
        a.onHandConsumables,
        a.onHandRetail,
        a.reorderLevel,
        `"${a.urgency}"`,
      ]);
      csvData = [headers.join(","), ...rows.map((r) => r.join(","))].join("\n");
    }

    return csvData;
  }
}

export const reportsService = new ReportsService();
