import { Router } from "express";
import { authenticate } from "../../middleware/auth.js";
import { requireBranchScope } from "../../middleware/branchScope.js";
import { authorize } from "../../middleware/rbac.js";
import { Campaign } from "../../models/marketing/campaign.model.js";
import { CampaignAttributionService } from "../../services/marketing/campaignAttribution.service.js";
import { sendResponse } from "../../utils/response.js";
import { AppError } from "../../utils/errors.js";

const router = Router();

/**
 * 1. CREATE CAMPAIGN
 */
router.post(
  "/",
  authenticate,
  requireBranchScope,
  authorize("finance.manage"),
  async (req, res, next) => {
    try {
      const {
        name,
        campaignCode,
        channel,
        startDate,
        endDate,
        budget,
        targetAudience,
        utmSource,
        utmMedium,
        utmCampaign,
        attributionWindowDays,
      } = req.body;

      if (!name || !campaignCode || !channel || !startDate) {
        throw new AppError("Name, campaignCode, channel, and startDate are required", 400);
      }

      const existing = await Campaign.findOne({
        organizationId: req.user.organizationId,
        campaignCode: campaignCode.trim().toUpperCase(),
      });
      if (existing) {
        throw new AppError(`Campaign code '${campaignCode.toUpperCase()}' already exists in organization`, 409);
      }

      const campaign = new Campaign({
        organizationId: req.user.organizationId,
        branchId: req.branchId || req.body.branchId,
        name: name.trim(),
        campaignCode: campaignCode.trim().toUpperCase(),
        channel,
        startDate: new Date(startDate),
        endDate: endDate ? new Date(endDate) : null,
        budgetPaise: budget ? Math.round(budget * 100) : 0,
        targetAudience: targetAudience || "",
        utmSource: utmSource || null,
        utmMedium: utmMedium || null,
        utmCampaign: utmCampaign || null,
        attributionWindowDays: attributionWindowDays || 14,
        status: "active",
        createdBy: req.user.id,
        updatedBy: req.user.id,
      });

      await campaign.save();
      return sendResponse(res, 201, "Campaign created successfully", campaign);
    } catch (err) {
      next(err);
    }
  }
);

/**
 * 2. LIST CAMPAIGNS
 */
router.get(
  "/",
  authenticate,
  requireBranchScope,
  authorize("finance.view"),
  async (req, res, next) => {
    try {
      const { status, channel, page, limit } = req.query;
      const query = {
        organizationId: req.user.organizationId,
        branchId: req.branchId || req.query.branchId,
      };

      if (status) query.status = status;
      if (channel) query.channel = channel;

      const pageNum = parseInt(page) || 1;
      const limitNum = parseInt(limit) || 20;
      const skip = (pageNum - 1) * limitNum;

      const [campaigns, total] = await Promise.all([
        Campaign.find(query).sort({ startDate: -1 }).skip(skip).limit(limitNum),
        Campaign.countDocuments(query),
      ]);

      return sendResponse(res, 200, "Campaigns retrieved successfully", campaigns, {
        page: pageNum,
        limit: limitNum,
        total,
        totalPages: Math.ceil(total / limitNum),
      });
    } catch (err) {
      next(err);
    }
  }
);

/**
 * 3. GET CAMPAIGN BY ID
 */
router.get(
  "/:id",
  authenticate,
  requireBranchScope,
  authorize("finance.view"),
  async (req, res, next) => {
    try {
      const campaign = await Campaign.findOne({
        _id: req.params.id,
        organizationId: req.user.organizationId,
        branchId: req.branchId || req.query.branchId,
      });

      if (!campaign) {
        throw new AppError("Campaign not found or branch unauthorized", 404);
      }

      return sendResponse(res, 200, "Campaign retrieved successfully", campaign);
    } catch (err) {
      next(err);
    }
  }
);

/**
 * 4. GET CAMPAIGN PERFORMANCE (FINANCIAL ATTRIBUTION)
 */
router.get(
  "/:id/performance",
  authenticate,
  requireBranchScope,
  authorize("finance.view"),
  async (req, res, next) => {
    try {
      const { startDate, endDate } = req.query;
      const performance = await CampaignAttributionService.getCampaignPerformance(
        req.params.id,
        req.user.organizationId,
        { startDateStr: startDate, endDateStr: endDate }
      );

      return sendResponse(res, 200, "Campaign performance metrics calculated", performance);
    } catch (err) {
      next(err);
    }
  }
);

export default router;
