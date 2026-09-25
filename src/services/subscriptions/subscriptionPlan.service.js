import mongoose from "mongoose";
import { AppError } from "../../utils/errors.js";
import { AUDIT_ACTIONS } from "../../models/audit/auditLog.model.js";

export class SubscriptionPlanService {
  constructor(subscriptionPlanRepo, serviceRepo, branchRepo, auditRepo) {
    this.subscriptionPlanRepo = subscriptionPlanRepo;
    this.serviceRepo = serviceRepo;
    this.branchRepo = branchRepo;
    this.auditRepo = auditRepo;
  }

  /**
   * Create a new reusable subscription plan template
   */
  async createPlan(data, organizationId, userId) {
    const {
      name,
      code,
      description = "",
      suggestedPrice,
      validityMonths,
      entitlements,
      permittedBranchIds = [],
    } = data;

    // 1. Check code uniqueness if provided
    if (code) {
      const existing = await this.subscriptionPlanRepo.findByCode(
        code,
        organizationId
      );
      if (existing) {
        throw new AppError(
          `Subscription plan with code '${code}' already exists in this organization`,
          409
        );
      }
    }

    // 2. Validate permitted branches
    const validPermittedBranchIds = [];
    if (Array.isArray(permittedBranchIds) && permittedBranchIds.length > 0) {
      for (const branchId of permittedBranchIds) {
        let branch;
        if (this.branchRepo && typeof this.branchRepo.findById === "function") {
          branch = await this.branchRepo.findById(branchId);
        } else if (this.branchRepo && typeof this.branchRepo.findOne === "function") {
          branch = await this.branchRepo.findOne({ _id: branchId });
        } else {
          const BranchModel = mongoose.model("Branch");
          branch = await BranchModel.findById(branchId);
        }

        if (
          !branch ||
          branch.organizationId.toString() !== organizationId.toString() ||
          branch.isDeleted ||
          branch.isActive === false
        ) {
          throw new AppError(
            `Permitted branch ${branchId} is invalid or inactive`,
            400
          );
        }
        validPermittedBranchIds.push(branch._id);
      }
    }

    // 3. Validate entitlements: no duplicates, services must exist and belong to org
    if (!Array.isArray(entitlements) || entitlements.length === 0) {
      throw new AppError("At least one entitlement is required", 400);
    }

    const seenServiceIds = new Set();
    const resolvedEntitlements = [];

    for (const ent of entitlements) {
      const sIdStr = ent.serviceId.toString();
      if (seenServiceIds.has(sIdStr)) {
        throw new AppError(
          "Duplicate serviceId in entitlements. Consolidate into a single entitlement with total quantity.",
          400
        );
      }
      seenServiceIds.add(sIdStr);

      let service;
      if (this.serviceRepo && typeof this.serviceRepo.findById === "function") {
        service = await this.serviceRepo.findById(ent.serviceId, organizationId);
      } else {
        const ServiceModel = mongoose.model("Service");
        service = await ServiceModel.findById(ent.serviceId);
      }

      if (
        !service ||
        service.organizationId.toString() !== organizationId.toString() ||
        service.isDeleted
      ) {
        throw new AppError(
          `Service ${ent.serviceId} not found in this organization`,
          404
        );
      }

      const quantity = parseInt(ent.quantity, 10);
      if (isNaN(quantity) || quantity < 1) {
        throw new AppError(
          `Invalid quantity for service '${service.name}'. Must be at least 1.`,
          400
        );
      }

      resolvedEntitlements.push({
        serviceId: service._id,
        quantity,
      });
    }

    // 4. Create Plan Document
    const plan = await this.subscriptionPlanRepo.create(
      {
        organizationId,
        name: name.trim(),
        code: code ? code.trim() : null,
        description: description ? description.trim() : "",
        suggestedPrice: Number(suggestedPrice),
        validityMonths: parseInt(validityMonths, 10),
        entitlements: resolvedEntitlements,
        permittedBranchIds: validPermittedBranchIds,
        isActive: true,
      },
      userId
    );

    // 5. Audit Log
    if (this.auditRepo && typeof this.auditRepo.create === "function") {
      await this.auditRepo.create(
        {
          branchId: null,
          action: AUDIT_ACTIONS.SUBSCRIPTION_PLAN_CREATED,
          entityType: "SubscriptionPlan",
          entityId: plan._id,
          description: `Subscription plan '${plan.name}' created with suggested price ${plan.suggestedPrice}`,
          metadata: {
            planId: plan._id,
            name: plan.name,
            code: plan.code,
            suggestedPrice: plan.suggestedPrice,
            validityMonths: plan.validityMonths,
          },
        },
        organizationId,
        userId
      );
    }

    return plan;
  }

  /**
   * List plans (organization-scoped, no branch filtering)
   */
  async listPlans(query, organizationId) {
    const { page = 1, limit = 20, search, status = "all" } = query;

    const filter = {
      organizationId,
      isDeleted: false,
    };

    if (status === "active") {
      filter.isActive = true;
    } else if (status === "inactive") {
      filter.isActive = false;
    }

    if (search) {
      filter.$or = [
        { name: { $regex: search, $options: "i" } },
        { code: { $regex: search, $options: "i" } },
      ];
    }

    const options = {
      page: parseInt(page, 10),
      limit: parseInt(limit, 10),
      populate: [
        { path: "entitlements.serviceId", select: "name code duration pricing" },
        { path: "permittedBranchIds", select: "name" },
      ],
      sort: { createdAt: -1 },
    };

    return this.subscriptionPlanRepo.find(filter, options);
  }

  /**
   * Get single plan by ID
   */
  async getPlanById(id, organizationId) {
    const plan = await this.subscriptionPlanRepo.findOne(
      { _id: id, organizationId, isDeleted: false },
      [
        { path: "entitlements.serviceId", select: "name code duration pricing" },
        { path: "permittedBranchIds", select: "name isActive" },
      ]
    );

    if (!plan) {
      throw new AppError("Subscription plan not found", 404);
    }

    return plan;
  }

  /**
   * Update plan
   */
  async updatePlan(id, updateData, organizationId, userId) {
    const plan = await this.subscriptionPlanRepo.findOne({
      _id: id,
      organizationId,
      isDeleted: false,
    });

    if (!plan) {
      throw new AppError("Subscription plan not found", 404);
    }

    const allowedUpdates = {};

    if (updateData.name !== undefined) {
      allowedUpdates.name = updateData.name.trim();
    }

    if (updateData.description !== undefined) {
      allowedUpdates.description = updateData.description.trim();
    }

    if (updateData.suggestedPrice !== undefined) {
      allowedUpdates.suggestedPrice = Number(updateData.suggestedPrice);
    }

    if (updateData.validityMonths !== undefined) {
      allowedUpdates.validityMonths = parseInt(updateData.validityMonths, 10);
    }

    if (updateData.isActive !== undefined) {
      allowedUpdates.isActive = Boolean(updateData.isActive);
    }

    if (updateData.code !== undefined) {
      const trimmedCode = updateData.code ? updateData.code.trim() : null;
      if (trimmedCode && trimmedCode !== plan.code) {
        const existing = await this.subscriptionPlanRepo.findByCode(
          trimmedCode,
          organizationId
        );
        if (existing && existing._id.toString() !== id.toString()) {
          throw new AppError(
            `Subscription plan with code '${trimmedCode}' already exists in this organization`,
            409
          );
        }
      }
      allowedUpdates.code = trimmedCode;
    }

    if (updateData.permittedBranchIds !== undefined) {
      const validBranchIds = [];
      for (const bId of updateData.permittedBranchIds) {
        let branch;
        if (this.branchRepo && typeof this.branchRepo.findById === "function") {
          branch = await this.branchRepo.findById(bId);
        } else if (this.branchRepo && typeof this.branchRepo.findOne === "function") {
          branch = await this.branchRepo.findOne({ _id: bId });
        } else {
          const BranchModel = mongoose.model("Branch");
          branch = await BranchModel.findById(bId);
        }

        if (
          !branch ||
          branch.organizationId.toString() !== organizationId.toString() ||
          branch.isDeleted
        ) {
          throw new AppError(`Permitted branch ${bId} is invalid`, 400);
        }
        validBranchIds.push(branch._id);
      }
      allowedUpdates.permittedBranchIds = validBranchIds;
    }

    if (updateData.entitlements !== undefined) {
      if (!Array.isArray(updateData.entitlements) || updateData.entitlements.length === 0) {
        throw new AppError("At least one entitlement is required", 400);
      }

      const seenServiceIds = new Set();
      const resolvedEntitlements = [];

      for (const ent of updateData.entitlements) {
        const sIdStr = ent.serviceId.toString();
        if (seenServiceIds.has(sIdStr)) {
          throw new AppError(
            "Duplicate serviceId in entitlements. Consolidate into a single entitlement with total quantity.",
            400
          );
        }
        seenServiceIds.add(sIdStr);

        let service;
        if (this.serviceRepo && typeof this.serviceRepo.findById === "function") {
          service = await this.serviceRepo.findById(ent.serviceId, organizationId);
        } else {
          const ServiceModel = mongoose.model("Service");
          service = await ServiceModel.findById(ent.serviceId);
        }

        if (
          !service ||
          service.organizationId.toString() !== organizationId.toString() ||
          service.isDeleted
        ) {
          throw new AppError(
            `Service ${ent.serviceId} not found in this organization`,
            404
          );
        }

        const quantity = parseInt(ent.quantity, 10);
        if (isNaN(quantity) || quantity < 1) {
          throw new AppError(
            `Invalid quantity for service '${service.name}'. Must be at least 1.`,
            400
          );
        }

        resolvedEntitlements.push({
          serviceId: service._id,
          quantity,
        });
      }

      allowedUpdates.entitlements = resolvedEntitlements;
    }

    const updated = await this.subscriptionPlanRepo.updateById(
      id,
      allowedUpdates,
      userId
    );

    if (this.auditRepo && typeof this.auditRepo.create === "function") {
      await this.auditRepo.create(
        {
          branchId: null,
          action: AUDIT_ACTIONS.SUBSCRIPTION_PLAN_UPDATED,
          entityType: "SubscriptionPlan",
          entityId: id,
          description: `Subscription plan '${plan.name}' updated`,
          metadata: { updatedFields: Object.keys(allowedUpdates) },
        },
        organizationId,
        userId
      );
    }

    return updated;
  }

  /**
   * Delete plan (soft-delete)
   */
  async deletePlan(id, organizationId, userId) {
    const plan = await this.subscriptionPlanRepo.findOne({
      _id: id,
      organizationId,
      isDeleted: false,
    });

    if (!plan) {
      throw new AppError("Subscription plan not found", 404);
    }

    const deleted = await this.subscriptionPlanRepo.deleteById(id, userId);

    if (this.auditRepo && typeof this.auditRepo.create === "function") {
      await this.auditRepo.create(
        {
          branchId: null,
          action: AUDIT_ACTIONS.SUBSCRIPTION_PLAN_DELETED,
          entityType: "SubscriptionPlan",
          entityId: id,
          description: `Subscription plan '${plan.name}' deleted`,
          metadata: { planId: id, name: plan.name },
        },
        organizationId,
        userId
      );
    }

    return deleted;
  }
}
