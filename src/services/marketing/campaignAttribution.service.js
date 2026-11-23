import mongoose from "mongoose";
import { Campaign } from "../../models/marketing/campaign.model.js";
import { Invoice } from "../../models/billing/invoice.model.js";
import { Expense } from "../../models/expenses/expense.model.js";
import { Payment } from "../../models/billing/payment.model.js";
import { AppError } from "../../utils/errors.js";
import { FinanceService } from "../finance/finance.service.js";

export class CampaignAttributionService {
  /**
   * Evaluates server-authoritative campaign attribution snapshot.
   * Precedence Hierarchy:
   * 1. Verified Direct Promo Code (e.g. couponCode matched to Campaign.campaignCode)
   * 2. Valid Appointment Booking Source (bookingSource metadata)
   * 3. Valid Manual POS Selection (req.body.campaignId / campaignCode)
   * 4. Unassigned
   *
   * Fallback rule: An invalid higher-priority source must NOT suppress a valid lower-priority source!
   */
  static async resolveAttributionSnapshot({
    organizationId,
    branchId,
    promoCode = null,
    appointmentSource = null,
    appointmentCreatedAt = null,
    manualCampaignId = null,
    finalizedAt = new Date(),
    session = null,
  }) {
    let candidate = null;

    // 1. Direct Promo Code Evaluation
    if (promoCode && typeof promoCode === "string" && promoCode.trim()) {
      const codeClean = promoCode.trim().toUpperCase();
      let query = Campaign.findOne({
        organizationId,
        branchId,
        campaignCode: codeClean,
        status: { $in: ["active", "completed"] },
      });
      if (session) query = query.session(session);
      const campaign = await query;

      if (campaign && CampaignAttributionService._isWithinWindow(campaign, finalizedAt, finalizedAt)) {
        return {
          campaignId: campaign._id,
          campaignCode: campaign.campaignCode,
          channel: campaign.channel,
          sourceType: "direct_promo",
          sourceIdentifier: codeClean,
          sourceEvidenceTimestamp: finalizedAt,
          attributedAt: finalizedAt,
        };
      }
      // Invalid direct promo code falls through to appointment source!
    }

    // 2. Appointment Booking Source Evaluation
    if (appointmentSource && typeof appointmentSource === "string" && appointmentSource.trim()) {
      const sourceClean = appointmentSource.trim().toUpperCase();
      let query = Campaign.findOne({
        organizationId,
        branchId,
        campaignCode: sourceClean,
        status: { $in: ["active", "completed"] },
      });
      if (session) query = query.session(session);
      const campaign = await query;

      const evidenceTime = appointmentCreatedAt || finalizedAt;
      if (campaign && CampaignAttributionService._isWithinWindow(campaign, evidenceTime, finalizedAt)) {
        return {
          campaignId: campaign._id,
          campaignCode: campaign.campaignCode,
          channel: campaign.channel,
          sourceType: "appointment_source",
          sourceIdentifier: sourceClean,
          sourceEvidenceTimestamp: evidenceTime,
          attributedAt: finalizedAt,
        };
      }
      // Invalid appointment source falls through to manual selection!
    }

    // 3. Manual POS Selection Evaluation
    if (manualCampaignId && mongoose.Types.ObjectId.isValid(manualCampaignId)) {
      let query = Campaign.findOne({
        _id: manualCampaignId,
        organizationId,
        branchId,
        status: { $in: ["active", "completed"] },
      });
      if (session) query = query.session(session);
      const campaign = await query;

      if (campaign && CampaignAttributionService._isWithinWindow(campaign, finalizedAt, finalizedAt)) {
        return {
          campaignId: campaign._id,
          campaignCode: campaign.campaignCode,
          channel: campaign.channel,
          sourceType: "manual_pos",
          sourceIdentifier: campaign.campaignCode,
          sourceEvidenceTimestamp: finalizedAt,
          attributedAt: finalizedAt,
        };
      }
    }

    // 4. Fallback to Unassigned
    return {
      campaignId: null,
      campaignCode: null,
      channel: null,
      sourceType: "unassigned",
      sourceIdentifier: null,
      sourceEvidenceTimestamp: null,
      attributedAt: finalizedAt,
    };
  }

  /**
   * Helper to check if event date falls within campaign start and attribution window days.
   */
  static _isWithinWindow(campaign, evidenceTimestamp, finalizedAt) {
    const start = new Date(campaign.startDate);
    const evidenceTime = new Date(evidenceTimestamp);

    if (evidenceTime < start) {
      return false;
    }

    // If campaign has explicit end date, check window from end date, else from start date
    const windowDays = campaign.attributionWindowDays || 14;
    const windowEndLimit = campaign.endDate
      ? new Date(new Date(campaign.endDate).getTime() + windowDays * 86400000)
      : null;

    if (windowEndLimit && evidenceTime > windowEndLimit) {
      return false;
    }

    return true;
  }

  /**
   * Computes campaign financial attribution metrics across independent date dimensions.
   *
   * Metrics:
   * - attributedGrossRevenuePaise: Sum of gross invoice revenue
   * - attributedRefundPaise: Exclusively from completed, non-deleted Payment records with type: "refund"
   * - attributedNetRevenuePaise: attributedGrossRevenuePaise - attributedRefundPaise
   * - expenseObligationsPaise: Approved/recorded expenses linked to campaign
   * - settledExpensesPaise: Settled expenses linked to campaign
   * - netAttributedContributionPaise: attributedNetRevenuePaise - settledExpensesPaise
   * - attributedRevenueToSpendRatio: attributedNetRevenue / (settledExpenses || 1)
   *
   * Policy Disclosure:
   * "Attributed Contribution reflects attributed net revenue minus campaign expenses. It is an operational attribution metric, not proven incremental financial profit."
   */
  static async getCampaignPerformance(campaignId, organizationId, { startDateStr, endDateStr, timezone = "Asia/Kolkata" } = {}) {
    const campaign = await Campaign.findOne({
      _id: new mongoose.Types.ObjectId(campaignId),
      organizationId: new mongoose.Types.ObjectId(organizationId),
    });
    if (!campaign) {
      throw new AppError("Campaign not found", 404);
    }

    let dateFilterInvoice = {};
    let dateFilterPayment = {};
    let dateFilterExpense = {};

    if (startDateStr && endDateStr) {
      const bounds = FinanceService.getBranchDayBounds(startDateStr, timezone);
      const endBounds = FinanceService.getBranchDayBounds(endDateStr, timezone);
      dateFilterInvoice.finalizedAt = { $gte: bounds.startUtc, $lte: endBounds.endUtc };
      dateFilterPayment.paymentDate = { $gte: bounds.startUtc, $lte: endBounds.endUtc };
      dateFilterExpense.expenseDate = { $gte: bounds.startUtc, $lte: endBounds.endUtc };
    }

    // 1. Attributed Invoices
    const query = {
      organizationId: new mongoose.Types.ObjectId(organizationId),
      "campaignAttribution.campaignId": new mongoose.Types.ObjectId(campaign._id),
      status: "finalized",
      isDeleted: false,
      ...dateFilterInvoice,
    };
    const invoices = await Invoice.find(query);

    const invoiceIds = invoices.map((inv) => inv._id);
    let grossRevenuePaise = 0;
    for (const inv of invoices) {
      const amt = inv.payableAmount ?? inv.totalAmount ?? 0;
      grossRevenuePaise += Math.round(amt * 100);
    }

    // 2. Authoritative Refunds (completed, non-deleted refund payments on attributed invoices)
    let refundPaise = 0;
    let refundCount = 0;
    if (invoiceIds.length > 0) {
      const refundAgg = await Payment.aggregate([
        {
          $match: {
            organizationId: new mongoose.Types.ObjectId(organizationId),
            invoiceId: { $in: invoiceIds },
            type: "refund",
            status: "completed",
            isDeleted: false,
            ...dateFilterPayment,
          },
        },
        {
          $group: {
            _id: null,
            totalPaise: {
              $sum: { $abs: { $round: [{ $multiply: ["$amount", 100] }, 0] } },
            },
            count: { $sum: 1 },
          },
        },
      ]);
      refundPaise = refundAgg[0]?.totalPaise || 0;
      refundCount = refundAgg[0]?.count || 0;
    }

    const netRevenuePaise = Math.max(0, grossRevenuePaise - refundPaise);

    // 3. Campaign Expenses (Approved vs Settled)
    const expenseAgg = await Expense.aggregate([
      {
        $match: {
          organizationId: new mongoose.Types.ObjectId(organizationId),
          branchId: campaign.branchId,
          campaignId: campaign._id,
          approvalStatus: "approved",
          isDeleted: false,
          ...dateFilterExpense,
        },
      },
      {
        $group: {
          _id: null,
          totalObligationsPaise: {
            $sum: { $round: [{ $multiply: ["$amount", 100] }, 0] },
          },
          settledExpensesPaise: {
            $sum: {
              $cond: [
                { $eq: ["$paymentStatus", "settled"] },
                { $round: [{ $multiply: ["$amount", 100] }, 0] },
                0,
              ],
            },
          },
          unpaidExpensesPaise: {
            $sum: {
              $cond: [
                { $eq: ["$paymentStatus", "unpaid"] },
                { $round: [{ $multiply: ["$amount", 100] }, 0] },
                0,
              ],
            },
          },
          count: { $sum: 1 },
        },
      },
    ]);

    const expenseObligationsPaise = expenseAgg[0]?.totalObligationsPaise || 0;
    const settledExpensesPaise = expenseAgg[0]?.settledExpensesPaise || 0;
    const unpaidExpensesPaise = expenseAgg[0]?.unpaidExpensesPaise || 0;
    const expenseCount = expenseAgg[0]?.count || 0;

    const netAttributedContributionPaise = netRevenuePaise - settledExpensesPaise;

    const attributedRevenueToSpendRatio =
      settledExpensesPaise > 0
        ? Number((netRevenuePaise / settledExpensesPaise).toFixed(2))
        : netRevenuePaise > 0
        ? 999.99
        : 0;

    return {
      campaign: {
        id: campaign._id,
        name: campaign.name,
        campaignCode: campaign.campaignCode,
        channel: campaign.channel,
        status: campaign.status,
        budget: (campaign.budgetPaise || 0) / 100,
      },
      financialMetrics: {
        attributedGrossRevenue: grossRevenuePaise / 100,
        attributedGrossRevenuePaise: grossRevenuePaise,
        attributedRefunds: refundPaise / 100,
        attributedRefundsPaise: refundPaise,
        refundCount,
        attributedNetRevenue: netRevenuePaise / 100,
        attributedNetRevenuePaise: netRevenuePaise,
        invoiceCount: invoices.length,
        expenseObligations: expenseObligationsPaise / 100,
        settledExpenses: settledExpensesPaise / 100,
        unpaidExpenses: unpaidExpensesPaise / 100,
        expenseCount,
        netAttributedContribution: netAttributedContributionPaise / 100,
        netAttributedContributionPaise,
        attributedRevenueToSpendRatio,
      },
      disclosureNotice:
        "Attributed Revenue-to-Spend Ratio and Net Attributed Contribution reflect operational attribution of invoice collections and campaign expenses. They do not represent Net Profit or proven incremental financial causality.",
    };
  }
}
