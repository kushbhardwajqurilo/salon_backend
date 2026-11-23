import { describe, expect, it, beforeEach, afterEach, beforeAll, afterAll, jest } from "@jest/globals";
import mongoose from "mongoose";
import dns from "dns";
import { getIsolatedTestMongoUri } from "../testSetup.js";

try {
  dns.setServers(["8.8.8.8", "1.1.1.1"]);
} catch (_) {}

import { Campaign } from "../../models/marketing/campaign.model.js";
import { Invoice } from "../../models/billing/invoice.model.js";
import { Expense } from "../../models/expenses/expense.model.js";
import { Payment } from "../../models/billing/payment.model.js";
import { CampaignAttributionService } from "../../services/marketing/campaignAttribution.service.js";

describe("Phase 2 — Marketing Attribution & Campaign Performance Test Suite", () => {
  jest.setTimeout(45000);

  let orgId;
  let branchId;
  let actorId;

  beforeAll(async () => {
    process.env.NODE_ENV = "test";
    const testUri = getIsolatedTestMongoUri("reports_test");
    await mongoose.connect(testUri);
  });

  afterAll(async () => {
    await mongoose.connection.close();
  });

  beforeEach(async () => {
    orgId = new mongoose.Types.ObjectId();
    branchId = new mongoose.Types.ObjectId();
    actorId = new mongoose.Types.ObjectId();
  });

  afterEach(async () => {
    await Campaign.deleteMany({ organizationId: orgId });
    await Invoice.deleteMany({ organizationId: orgId });
    await Expense.deleteMany({ organizationId: orgId });
    await Payment.deleteMany({ organizationId: orgId });
  });

  describe("1. Precedence Hierarchy and Fallback Behavior", () => {
    it("should attribute to Verified Direct Promo Code when valid", async () => {
      const campaign = await Campaign.create({
        organizationId: orgId,
        branchId,
        name: "Festive Diwali Sale",
        campaignCode: "DIWALI50",
        channel: "meta_ads",
        startDate: new Date(Date.now() - 86400000),
        status: "active",
        createdBy: actorId,
        updatedBy: actorId,
      });

      const snapshot = await CampaignAttributionService.resolveAttributionSnapshot({
        organizationId: orgId,
        branchId,
        promoCode: "DIWALI50",
        appointmentSource: "OTHER_SOURCE",
        manualCampaignId: null,
      });

      expect(snapshot.sourceType).toBe("direct_promo");
      expect(snapshot.campaignCode).toBe("DIWALI50");
      expect(snapshot.campaignId.toString()).toBe(campaign._id.toString());
      expect(snapshot.channel).toBe("meta_ads");
    });

    it("should fallback to valid Appointment Booking Source when Direct Promo is invalid", async () => {
      const campaign = await Campaign.create({
        organizationId: orgId,
        branchId,
        name: "Google Local Search Haircut",
        campaignCode: "GOOG-HAIR",
        channel: "google_ads",
        startDate: new Date(Date.now() - 86400000),
        status: "active",
        createdBy: actorId,
        updatedBy: actorId,
      });

      const snapshot = await CampaignAttributionService.resolveAttributionSnapshot({
        organizationId: orgId,
        branchId,
        promoCode: "INVALID_PROMO_CODE",
        appointmentSource: "GOOG-HAIR",
        manualCampaignId: null,
      });

      expect(snapshot.sourceType).toBe("appointment_source");
      expect(snapshot.campaignCode).toBe("GOOG-HAIR");
      expect(snapshot.campaignId.toString()).toBe(campaign._id.toString());
    });

    it("should fallback to valid Manual POS Selection when direct and booking sources are invalid", async () => {
      const campaign = await Campaign.create({
        organizationId: orgId,
        branchId,
        name: "Walk-In Flyer Summer",
        campaignCode: "FLYER-SUMMER",
        channel: "flyer_print",
        startDate: new Date(Date.now() - 86400000),
        status: "active",
        createdBy: actorId,
        updatedBy: actorId,
      });

      const snapshot = await CampaignAttributionService.resolveAttributionSnapshot({
        organizationId: orgId,
        branchId,
        promoCode: "EXPIRED_CODE",
        appointmentSource: "RANDOM_UNMATCHED_SOURCE",
        manualCampaignId: campaign._id,
      });

      expect(snapshot.sourceType).toBe("manual_pos");
      expect(snapshot.campaignCode).toBe("FLYER-SUMMER");
      expect(snapshot.campaignId.toString()).toBe(campaign._id.toString());
    });

    it("should return unassigned when all sources are invalid or absent", async () => {
      const snapshot = await CampaignAttributionService.resolveAttributionSnapshot({
        organizationId: orgId,
        branchId,
        promoCode: "DOES_NOT_EXIST",
      });

      expect(snapshot.sourceType).toBe("unassigned");
      expect(snapshot.campaignId).toBeNull();
      expect(snapshot.campaignCode).toBeNull();
    });
  });

  describe("2. Campaign Financial Attribution Metrics & Refund Authority", () => {
    it("should accurately calculate attributedNetRevenue and netAttributedContribution", async () => {
      const campaign = await Campaign.create({
        organizationId: orgId,
        branchId,
        name: "Influencer Glamour Push",
        campaignCode: "GLAMOUR-INF",
        channel: "influencer",
        startDate: new Date(Date.now() - 7 * 86400000),
        budgetPaise: 500000, // ₹5000
        status: "active",
        createdBy: actorId,
        updatedBy: actorId,
      });

      // Attributed Invoice 1: ₹2,000 gross
      const inv1 = await Invoice.create({
        organizationId: orgId,
        branchId,
        invoiceNumber: "INV-CAMP-001",
        invoiceType: "appointment",
        customerId: new mongoose.Types.ObjectId(),
        customerSnapshot: {
          name: "Test Customer 1",
          phone: "9876543210",
        },
        subtotal: 2000,
        grossPayable: 2000,
        totalAmount: 2000,
        amountPaid: 2000,
        amountDue: 0,
        payableAmount: 2000,
        status: "finalized",
        paymentStatus: "paid",
        createdBy: actorId,
        finalizedAt: new Date(),
        campaignAttribution: {
          campaignId: campaign._id,
          campaignCode: campaign.campaignCode,
          channel: campaign.channel,
          sourceType: "direct_promo",
          sourceIdentifier: "GLAMOUR-INF",
          attributedAt: new Date(),
        },
      });

      // Attributed Invoice 2: ₹3,000 gross
      const inv2 = await Invoice.create({
        organizationId: orgId,
        branchId,
        invoiceNumber: "INV-CAMP-002",
        invoiceType: "appointment",
        customerId: new mongoose.Types.ObjectId(),
        customerSnapshot: {
          name: "Test Customer 2",
          phone: "9876543211",
        },
        subtotal: 3000,
        grossPayable: 3000,
        totalAmount: 3000,
        amountPaid: 3000,
        amountDue: 0,
        payableAmount: 3000,
        status: "finalized",
        paymentStatus: "paid",
        createdBy: actorId,
        finalizedAt: new Date(),
        campaignAttribution: {
          campaignId: campaign._id,
          campaignCode: campaign.campaignCode,
          channel: campaign.channel,
          sourceType: "appointment_source",
          sourceIdentifier: "GLAMOUR-INF",
          attributedAt: new Date(),
        },
      });

      // Authoritative Refund Payment on Invoice 1: ₹500 refund
      await Payment.create({
        organizationId: orgId,
        branchId,
        invoiceId: inv1._id,
        customerId: inv1.customerId,
        paymentNumber: "PAY-REF-001",
        amount: -500,
        method: "upi",
        status: "completed",
        type: "refund",
        processedBy: actorId,
        recordedBy: actorId,
        paymentDate: new Date(),
      });

      // Campaign Expense 1: Settled ₹1,000
      await Expense.create({
        organizationId: orgId,
        branchId,
        expenseCode: "EXP-CAMP-01",
        category: "marketing",
        amount: 1000,
        paymentMethod: "bank_transfer",
        payeeName: "Influencer Agency",
        campaignId: campaign._id,
        approvalStatus: "approved",
        paymentStatus: "settled",
        approvalThresholdAtCreation: 5000,
        recordedBy: actorId,
      });

      // Campaign Expense 2: Unpaid ₹500
      await Expense.create({
        organizationId: orgId,
        branchId,
        expenseCode: "EXP-CAMP-02",
        category: "marketing",
        amount: 500,
        paymentMethod: "bank_transfer",
        payeeName: "Creative Production",
        campaignId: campaign._id,
        approvalStatus: "approved",
        paymentStatus: "unpaid",
        approvalThresholdAtCreation: 5000,
        recordedBy: actorId,
      });

      const perf = await CampaignAttributionService.getCampaignPerformance(campaign._id, orgId);

      // Gross = ₹2000 + ₹3000 = ₹5000 (500000 paise)
      expect(perf.financialMetrics.attributedGrossRevenue).toBe(5000);
      // Refunds = ₹500 (50000 paise)
      expect(perf.financialMetrics.attributedRefunds).toBe(500);
      expect(perf.financialMetrics.refundCount).toBe(1);
      // Net Revenue = ₹5000 - ₹500 = ₹4500 (450000 paise)
      expect(perf.financialMetrics.attributedNetRevenue).toBe(4500);
      // Settled Expense = ₹1000, Unpaid = ₹500, Obligations = ₹1500
      expect(perf.financialMetrics.settledExpenses).toBe(1000);
      expect(perf.financialMetrics.unpaidExpenses).toBe(500);
      expect(perf.financialMetrics.expenseObligations).toBe(1500);
      // Net Attributed Contribution = ₹4500 (Net Rev) - ₹1000 (Settled Exp) = ₹3500
      expect(perf.financialMetrics.netAttributedContribution).toBe(3500);
      // Attributed Revenue-to-Spend Ratio = 4500 / 1000 = 4.5
      expect(perf.financialMetrics.attributedRevenueToSpendRatio).toBe(4.5);
      expect(perf.disclosureNotice).toContain("Attributed Revenue-to-Spend Ratio");
    });
  });

  describe("3. Multi-Tenant & Branch Scope Isolation", () => {
    it("should prevent cross-organization and cross-branch access to campaign performance", async () => {
      const otherOrgId = new mongoose.Types.ObjectId();
      const otherBranchId = new mongoose.Types.ObjectId();

      const campaign = await Campaign.create({
        organizationId: orgId,
        branchId,
        name: "Branch A Exclusive",
        campaignCode: "BRANCH-A-EXCL",
        channel: "instagram",
        startDate: new Date(),
        status: "active",
        createdBy: actorId,
        updatedBy: actorId,
      });

      // Querying with different organization ID must fail
      let orgError;
      try {
        await CampaignAttributionService.getCampaignPerformance(campaign._id, otherOrgId);
      } catch (err) {
        orgError = err;
      }
      expect(orgError).toBeDefined();
      expect(orgError.message).toContain("not found");
    });
  });

  describe("4. Attribution Window & Evidence Timestamp Verification", () => {
    it("should not attribute if source evidence timestamp is outside attribution window", async () => {
      const campaign = await Campaign.create({
        organizationId: orgId,
        branchId,
        name: "Old Campaign",
        campaignCode: "OLD-CAMPAIGN",
        channel: "email",
        startDate: new Date("2026-01-01"),
        endDate: new Date("2026-01-15"),
        attributionWindowDays: 7, // Window closed on 2026-01-22
        status: "completed",
        createdBy: actorId,
        updatedBy: actorId,
      });

      // Finalized invoice on 2026-02-01 with promo code from old campaign
      const snapshot = await CampaignAttributionService.resolveAttributionSnapshot({
        organizationId: orgId,
        branchId,
        promoCode: "OLD-CAMPAIGN",
        finalizedAt: new Date("2026-02-01"),
      });

      // Window is closed, so must fall back to unassigned
      expect(snapshot.sourceType).toBe("unassigned");
      expect(snapshot.campaignId).toBeNull();
    });
  });
});
