import mongoose from "mongoose";
import { MembershipPlan } from "../../models/memberships/membershipPlan.model.js";
import { CustomerMembership } from "../../models/memberships/customerMembership.model.js";
import { Customer } from "../../models/customers/customer.model.js";
import { AppError } from "../../utils/errors.js";
import { runInTransaction } from "../../utils/transaction.js";

class MembershipService {
  /**
   * 1. CREATE MEMBERSHIP PLAN
   */
  async createPlan(data, organizationId, userId) {
    const {
      name,
      code,
      tier,
      description,
      termsAndConditions,
      price,
      validityMonths,
      validityUnit = "months",
      validityDuration = 12,
      maxBeneficiaries = 1,
      benefits,
      beneficiaryPolicy,
      permittedBranchIds = [],
      isCustom = false,
      isActive = true,
    } = data;

    if (code) {
      const existing = await MembershipPlan.findOne({
        organizationId,
        code: code.toUpperCase(),
        isDeleted: false,
      });
      if (existing) {
        throw new AppError(`Membership plan with code '${code}' already exists`, 409);
      }
    }

    const plan = new MembershipPlan({
      organizationId,
      name,
      code: code ? code.toUpperCase() : null,
      tier: tier || "Standard",
      description: description || "",
      termsAndConditions: termsAndConditions || "",
      price,
      validityDuration: validityDuration || validityMonths || 12,
      validityUnit: validityUnit || "months",
      validityMonths: validityMonths || validityDuration || 12,
      maxBeneficiaries,
      benefits: benefits || {},
      beneficiaryPolicy: beneficiaryPolicy || {
        allowMultipleBeneficiaries: maxBeneficiaries > 1,
        maxBeneficiaries,
        payerMustBeBeneficiary: false,
        allowBeneficiaryChanges: true,
      },
      permittedBranchIds,
      isCustom: Boolean(isCustom),
      isActive,
      createdBy: userId,
    });

    await plan.save();
    return plan;
  }

  /**
   * 2. LIST MEMBERSHIP PLANS
   */
  async listPlans(filter = {}, organizationId) {
    const query = { organizationId, isDeleted: false };
    if (filter.isCustom !== undefined) {
      query.isCustom = filter.isCustom === "true" || filter.isCustom === true;
    } else if (filter.includeCustom !== "true" && filter.includeCustom !== true) {
      // Default: exclude custom one-off plans from the general catalog so they don't pollute the catalog
      query.isCustom = { $ne: true };
    }
    if (filter.isActive !== undefined) {
      query.isActive = filter.isActive === "true" || filter.isActive === true;
    }
    if (filter.tier) {
      query.tier = filter.tier;
    }
    if (filter.search) {
      query.$or = [
        { name: { $regex: filter.search, $options: "i" } },
        { code: { $regex: filter.search, $options: "i" } },
      ];
    }

    const page = Math.max(1, parseInt(filter.page, 10) || 1);
    const limit = Math.min(100, Math.max(1, parseInt(filter.limit, 10) || 50));
    const skip = (page - 1) * limit;

    const [plans, total] = await Promise.all([
      MembershipPlan.find(query)
        .sort({ createdAt: -1 })
        .skip(skip)
        .limit(limit)
        .lean(),
      MembershipPlan.countDocuments(query),
    ]);

    return {
      plans: plans.map((p) => ({ ...p, id: p._id.toString() })),
      total,
      page,
      totalPages: Math.ceil(total / limit),
    };
  }

  /**
   * 3. GET MEMBERSHIP PLAN BY ID
   */
  async getPlanById(planId, organizationId) {
    const plan = await MembershipPlan.findOne({
      _id: planId,
      organizationId,
      isDeleted: false,
    });
    if (!plan) {
      throw new AppError("Membership plan not found", 404);
    }
    return plan;
  }

  /**
   * 4. UPDATE MEMBERSHIP PLAN
   */
  async updatePlan(planId, updates, organizationId, userId) {
    const plan = await MembershipPlan.findOne({
      _id: planId,
      organizationId,
      isDeleted: false,
    });
    if (!plan) {
      throw new AppError("Membership plan not found", 404);
    }

    if (updates.code && updates.code.toUpperCase() !== plan.code) {
      const existing = await MembershipPlan.findOne({
        _id: { $ne: plan._id },
        organizationId,
        code: updates.code.toUpperCase(),
        isDeleted: false,
      });
      if (existing) {
        throw new AppError(`Membership plan with code '${updates.code}' already exists`, 409);
      }
      plan.code = updates.code.toUpperCase();
    }

    if (updates.name !== undefined) plan.name = updates.name;
    if (updates.tier !== undefined) plan.tier = updates.tier;
    if (updates.description !== undefined) plan.description = updates.description;
    if (updates.termsAndConditions !== undefined) plan.termsAndConditions = updates.termsAndConditions;
    if (updates.price !== undefined) plan.price = updates.price;
    if (updates.validityMonths !== undefined) {
      plan.validityMonths = updates.validityMonths;
      plan.validityDuration = updates.validityDuration || updates.validityMonths;
    }
    if (updates.validityUnit !== undefined) plan.validityUnit = updates.validityUnit;
    if (updates.validityDuration !== undefined) {
      plan.validityDuration = updates.validityDuration;
      if (plan.validityUnit === "months") plan.validityMonths = updates.validityDuration;
    }
    if (updates.maxBeneficiaries !== undefined) {
      plan.maxBeneficiaries = updates.maxBeneficiaries;
      if (plan.beneficiaryPolicy) {
        plan.beneficiaryPolicy.maxBeneficiaries = updates.maxBeneficiaries;
        plan.beneficiaryPolicy.allowMultipleBeneficiaries = updates.maxBeneficiaries > 1;
      }
    }
    if (updates.beneficiaryPolicy !== undefined) {
      plan.beneficiaryPolicy = { ...plan.beneficiaryPolicy, ...updates.beneficiaryPolicy };
    }
    if (updates.benefits !== undefined) plan.benefits = { ...plan.benefits, ...updates.benefits };
    if (updates.permittedBranchIds !== undefined) plan.permittedBranchIds = updates.permittedBranchIds;
    if (updates.isActive !== undefined) plan.isActive = updates.isActive;
    plan.updatedBy = userId;

    await plan.save();
    return plan;
  }

  /**
   * 4b. DUPLICATE MEMBERSHIP PLAN
   */
  async duplicatePlan(planId, organizationId, userId) {
    const original = await MembershipPlan.findOne({
      _id: planId,
      organizationId,
      isDeleted: false,
    });
    if (!original) {
      throw new AppError("Original membership plan not found", 404);
    }

    const timestamp = Date.now().toString().slice(-4);
    const newPlan = new MembershipPlan({
      organizationId,
      name: `${original.name} (Copy)`,
      code: original.code ? `${original.code}_${timestamp}` : null,
      tier: original.tier,
      description: original.description,
      termsAndConditions: original.termsAndConditions,
      price: original.price,
      validityDuration: original.validityDuration || 12,
      validityUnit: original.validityUnit || "months",
      validityMonths: original.validityMonths,
      maxBeneficiaries: original.maxBeneficiaries,
      beneficiaryPolicy: original.beneficiaryPolicy,
      benefits: original.benefits,
      permittedBranchIds: original.permittedBranchIds,
      isActive: false, // Default duplicated plan to inactive until configured
      createdBy: userId,
    });

    await newPlan.save();
    return newPlan;
  }

  /**
   * 5. SOFT-DELETE PLAN
   */
  async deletePlan(planId, organizationId, userId) {
    const plan = await MembershipPlan.findOne({
      _id: planId,
      organizationId,
      isDeleted: false,
    });
    if (!plan) {
      throw new AppError("Membership plan not found", 404);
    }

    plan.isDeleted = true;
    plan.isActive = false;
    plan.updatedBy = userId;
    await plan.save();
    return { success: true, message: "Membership plan deactivated successfully" };
  }

  /**
   * 6. LIST CUSTOMER MEMBERSHIPS (With Payer & Beneficiary distinctions)
   */
  async listCustomerMemberships(filter = {}, organizationId) {
    const query = { organizationId, isDeleted: false };

    if (filter.customerId) {
      query.customerId = filter.customerId;
    }
    if (filter.payerCustomerId) {
      query.payerCustomerId = filter.payerCustomerId;
    }
    if (filter.status) {
      query.status = filter.status;
    }
    if (filter.membershipPlanId) {
      query.membershipPlanId = filter.membershipPlanId;
    }
    if (filter.search) {
      query.$or = [
        { membershipCode: { $regex: filter.search, $options: "i" } },
        { "planSnapshot.name": { $regex: filter.search, $options: "i" } },
      ];
    }

    const page = Math.max(1, parseInt(filter.page, 10) || 1);
    const limit = Math.min(100, Math.max(1, parseInt(filter.limit, 10) || 20));
    const skip = (page - 1) * limit;

    const [memberships, total] = await Promise.all([
      CustomerMembership.find(query)
        .populate("customerId", "name phone email")
        .populate("payerCustomerId", "name phone email")
        .populate("membershipPlanId", "name code tier price maxBeneficiaries")
        .populate("invoiceId", "invoiceNumber paymentStatus payableAmount amountPaid")
        .sort({ createdAt: -1 })
        .skip(skip)
        .limit(limit)
        .lean(),
      CustomerMembership.countDocuments(query),
    ]);

    return {
      memberships: memberships.map((m) => ({ ...m, id: m._id.toString() })),
      total,
      page,
      totalPages: Math.ceil(total / limit),
    };
  }

  /**
   * 7. GET CUSTOMER MEMBERSHIP BY ID
   */
  async getCustomerMembershipById(membershipId, organizationId) {
    const membership = await CustomerMembership.findOne({
      _id: membershipId,
      organizationId,
      isDeleted: false,
    })
      .populate("customerId", "name phone email")
      .populate("payerCustomerId", "name phone email")
      .populate("membershipPlanId", "name code tier price benefits permittedBranchIds maxBeneficiaries")
      .populate("invoiceId", "invoiceNumber paymentStatus payableAmount amountPaid");

    if (!membership) {
      throw new AppError("Customer membership not found", 404);
    }
    return membership;
  }

  /**
   * 8. CANCEL / DEACTIVATE AN INDIVIDUAL BENEFICIARY MEMBERSHIP
   */
  async cancelBeneficiaryMembership(membershipId, { reason }, organizationId, userId) {
    const membership = await CustomerMembership.findOne({
      _id: membershipId,
      organizationId,
      isDeleted: false,
    });

    if (!membership) {
      throw new AppError("Customer membership not found", 404);
    }

    if (membership.status === "cancelled") {
      throw new AppError("Membership is already cancelled", 400);
    }

    membership.status = "cancelled";
    membership.cancelledAt = new Date();
    membership.cancelledBy = userId;
    membership.cancellationReason = reason;

    await membership.save();
    return membership;
  }

  /**
   * 8b. SUSPEND BENEFICIARY MEMBERSHIP
   */
  async suspendBeneficiaryMembership(membershipId, { reason }, organizationId, userId) {
    const membership = await CustomerMembership.findOne({
      _id: membershipId,
      organizationId,
      isDeleted: false,
    });

    if (!membership) {
      throw new AppError("Customer membership not found", 404);
    }

    if (membership.status !== "active") {
      throw new AppError(`Cannot suspend membership with status '${membership.status}'. Must be active.`, 400);
    }

    membership.status = "suspended";
    membership.suspendedAt = new Date();
    membership.suspendedBy = userId;
    membership.suspensionReason = reason;

    await membership.save();
    return membership;
  }

  /**
   * 8c. REACTIVATE SUSPENDED BENEFICIARY MEMBERSHIP
   */
  async reactivateBeneficiaryMembership(membershipId, organizationId, userId) {
    const membership = await CustomerMembership.findOne({
      _id: membershipId,
      organizationId,
      isDeleted: false,
    });

    if (!membership) {
      throw new AppError("Customer membership not found", 404);
    }

    if (membership.status !== "suspended") {
      throw new AppError(`Cannot reactivate membership with status '${membership.status}'. Must be suspended.`, 400);
    }

    // Check if expiry date has passed while suspended
    if (new Date(membership.endDate) < new Date()) {
      membership.status = "expired";
      await membership.save();
      throw new AppError("Membership has expired while suspended and cannot be reactivated.", 400);
    }

    membership.status = "active";
    membership.reactivatedAt = new Date();
    membership.suspendedAt = null;
    membership.suspendedBy = null;
    membership.suspensionReason = null;

    await membership.save();
    return membership;
  }

  /**
   * 8d. MEMBERSHIP REPORTING & ANALYTICS
   */
  async getMembershipReports(filter = {}, organizationId) {
    const query = { organizationId, isDeleted: false };
    if (filter.branchId && filter.branchId !== "all") {
      query.permittedBranchIds = filter.branchId;
    }

    const now = new Date();
    const startOfMonth = new Date(now.getFullYear(), now.getMonth(), 1);
    const thirtyDaysFromNow = new Date(now.getTime() + 30 * 24 * 60 * 60 * 1000);

    const [
      totalMemberships,
      activeCount,
      expiredCount,
      cancelledCount,
      suspendedCount,
      pendingPaymentCount,
      soldThisMonthCount,
      expiringSoonCount,
      plansCount,
    ] = await Promise.all([
      CustomerMembership.countDocuments(query),
      CustomerMembership.countDocuments({ ...query, status: "active" }),
      CustomerMembership.countDocuments({ ...query, status: "expired" }),
      CustomerMembership.countDocuments({ ...query, status: "cancelled" }),
      CustomerMembership.countDocuments({ ...query, status: "suspended" }),
      CustomerMembership.countDocuments({ ...query, status: "pending_payment" }),
      CustomerMembership.countDocuments({ ...query, createdAt: { $gte: startOfMonth } }),
      CustomerMembership.countDocuments({
        ...query,
        status: "active",
        endDate: { $gte: now, $lte: thirtyDaysFromNow },
      }),
      MembershipPlan.countDocuments({ organizationId, isDeleted: false, isCustom: { $ne: true } }),
    ]);

    // Unique beneficiaries count
    const uniqueBeneficiaries = await CustomerMembership.distinct("customerId", query);

    // Calculate total revenue from active/paid memberships
    const revenueAgg = await CustomerMembership.aggregate([
      { $match: { ...query, status: { $in: ["active", "expired"] } } },
      { $group: { _id: null, totalRevenue: { $sum: "$planSnapshot.price" } } },
    ]);
    const totalRevenue = revenueAgg[0]?.totalRevenue || 0;

    return {
      totalMemberships,
      activeMemberships: activeCount,
      expiredMemberships: expiredCount,
      cancelledMemberships: cancelledCount,
      suspendedMemberships: suspendedCount,
      pendingPaymentCount,
      soldThisMonthCount,
      expiringSoonCount,
      totalRevenue,
      uniqueBeneficiariesCount: uniqueBeneficiaries.length,
      activePlansCount: plansCount,
    };
  }

  /**
   * 9. RESOLVE ACTIVE MEMBERSHIP & BENEFITS FOR A BENEFICIARY (Discount lookup)
   */
  async resolveActiveMembershipForCustomer(customerId, branchId, organizationId, session = null) {
    const now = new Date();
    let query = CustomerMembership.findOne({
      organizationId,
      customerId,
      status: { $in: ["active", "pending_payment"] },
      startDate: { $lte: now },
      endDate: { $gte: now },
      isDeleted: false,
    });
    if (session) query = query.session(session);
    const membership = await query;

    if (!membership) {
      return null;
    }

    // Branch authorization check
    if (Array.isArray(membership.permittedBranchIds) && membership.permittedBranchIds.length > 0 && branchId) {
      const isPermitted = membership.permittedBranchIds.some(
        (b) => b.toString() === branchId.toString()
      );
      if (!isPermitted) {
        return null;
      }
    }

    return membership;
  }

  /**
   * 10. VALIDATE BENEFICIARIES BEFORE PURCHASE
   */
  async validateBeneficiaries(planId, payerCustomerId, beneficiaryCustomerIds = [], organizationId, branchId) {
    const plan = await MembershipPlan.findOne({
      _id: planId,
      organizationId,
      isActive: true,
      isDeleted: false,
    });
    if (!plan) {
      throw new AppError("Active membership plan not found", 404);
    }

    if (branchId && Array.isArray(plan.permittedBranchIds) && plan.permittedBranchIds.length > 0) {
      const isPermitted = plan.permittedBranchIds.some(
        (b) => b.toString() === branchId.toString()
      );
      if (!isPermitted) {
        throw new AppError(`Membership plan '${plan.name}' is not permitted at branch '${branchId}'`, 403);
      }
    }

    // Validate payer exists in organization
    const payer = await Customer.findOne({
      _id: payerCustomerId,
      organizationId,
      isDeleted: false,
    });
    if (!payer) {
      throw new AppError("Payer customer not found in organization", 404);
    }

    // Default to payer if no beneficiaries provided
    const targetBeneficiaryIds =
      Array.isArray(beneficiaryCustomerIds) && beneficiaryCustomerIds.length > 0
        ? beneficiaryCustomerIds
        : [payerCustomerId];

    // Check duplicate beneficiaries in single purchase
    const uniqueIds = Array.from(new Set(targetBeneficiaryIds.map((id) => id.toString())));
    if (uniqueIds.length !== targetBeneficiaryIds.length) {
      throw new AppError("Duplicate beneficiaries detected in membership purchase", 400);
    }

    // Check max beneficiaries configured on plan
    const maxBeneficiaries = plan.maxBeneficiaries || 1;
    if (uniqueIds.length > maxBeneficiaries) {
      throw new AppError(
        `Plan '${plan.name}' allows at most ${maxBeneficiaries} beneficiaries, but ${uniqueIds.length} were provided`,
        400
      );
    }

    // Validate all beneficiaries exist in authenticated organization
    const beneficiaries = await Customer.find({
      _id: { $in: uniqueIds },
      organizationId,
      isDeleted: false,
    });

    if (beneficiaries.length !== uniqueIds.length) {
      throw new AppError("One or more beneficiaries not found in organization", 404);
    }

    return {
      plan,
      payer,
      beneficiaries,
      targetBeneficiaryIds: uniqueIds,
    };
  }

  /**
   * 10. ADD BENEFICIARY TO EXISTING MEMBERSHIP PURCHASE
   * Transactionally adds a new beneficiary member to an existing membership purchase group,
   * provided current active/enrolled beneficiaries have not reached plan maxBeneficiaries.
   */
  async addBeneficiaryToMembership(
    existingMembershipId,
    { customerId, benefitsOverride },
    organizationId,
    userId
  ) {
    return await runInTransaction(async (session) => {
      // 1. Load reference membership
      const referenceMembership = await CustomerMembership.findOne({
        _id: existingMembershipId,
        organizationId,
        isDeleted: false,
      }).session(session);

      if (!referenceMembership) {
        throw new AppError("Reference customer membership not found", 404);
      }

      if (["cancelled", "expired"].includes(referenceMembership.status)) {
        throw new AppError(
          `Cannot add members to a membership with status '${referenceMembership.status}'`,
          400
        );
      }

      // 2. Fetch all memberships sharing this membershipPurchaseId
      const purchaseId = referenceMembership.membershipPurchaseId;
      const enrolledMembers = await CustomerMembership.find({
        organizationId,
        membershipPurchaseId: purchaseId,
        isDeleted: false,
        status: { $in: ["active", "pending_payment", "suspended"] },
      }).session(session);

      // 3. Resolve max capacity from planSnapshot or original plan
      let maxCapacity = referenceMembership.planSnapshot?.maxBeneficiaries;
      if (!maxCapacity) {
        const originalPlan = await MembershipPlan.findById(
          referenceMembership.membershipPlanId
        ).session(session);
        maxCapacity = originalPlan?.maxBeneficiaries || 1;
      }

      // Check capacity
      if (enrolledMembers.length >= maxCapacity) {
        throw new AppError(
          `Membership capacity reached (${enrolledMembers.length} of ${maxCapacity} members). Cannot add more beneficiaries.`,
          400
        );
      }

      // 4. Validate candidate customer exists in organization
      const candidateCustomer = await Customer.findOne({
        _id: customerId,
        organizationId,
        isDeleted: false,
      }).session(session);

      if (!candidateCustomer) {
        throw new AppError("Customer to add not found in organization", 404);
      }

      // 5. Prevent duplicate customer within the same membership purchase
      const alreadyEnrolled = enrolledMembers.some(
        (m) => m.customerId.toString() === customerId.toString()
      );
      if (alreadyEnrolled) {
        throw new AppError(
          "Customer is already an enrolled beneficiary of this membership",
          400
        );
      }

      // 6. Inherit planSnapshot, dates, branches and payer from reference membership
      const newIndex = enrolledMembers.length + 1;
      const memCode = `MEM-${Date.now().toString().slice(-6)}-${Math.floor(100 + Math.random() * 900)}-${newIndex}`;

      const effectiveBenefits = benefitsOverride
        ? {
            ...referenceMembership.planSnapshot.benefits,
            ...benefitsOverride,
          }
        : referenceMembership.planSnapshot.benefits;

      const newBeneficiaryMembership = new CustomerMembership({
        organizationId,
        customerId: candidateCustomer._id,
        payerCustomerId: referenceMembership.payerCustomerId,
        membershipPurchaseId: purchaseId,
        membershipPlanId: referenceMembership.membershipPlanId,
        attribution: referenceMembership.attribution || {},
        membershipCode: memCode,
        planSnapshot: {
          name: referenceMembership.planSnapshot.name,
          tier: referenceMembership.planSnapshot.tier || "Standard",
          price: referenceMembership.planSnapshot.price || 0,
          validityMonths: referenceMembership.planSnapshot.validityMonths || 12,
          maxBeneficiaries: maxCapacity,
          benefits: effectiveBenefits,
        },
        status: referenceMembership.status, // matches primary status (active or pending_payment)
        startDate: referenceMembership.startDate,
        endDate: referenceMembership.endDate,
        permittedBranchIds: referenceMembership.permittedBranchIds || [],
        invoiceId: referenceMembership.invoiceId || null,
        notes: `Beneficiary added to membership purchase #${purchaseId.toString().slice(-6)} by user #${userId}`,
      });

      await newBeneficiaryMembership.save({ session });
      return newBeneficiaryMembership;
    });
  }

  /**
   * 11. GET MEMBERSHIP PURCHASE GROUP
   * Returns all beneficiary customer memberships belonging to the same purchase group,
   * along with capacity metadata.
   */
  async getMembershipPurchaseGroup(membershipId, organizationId) {
    const target = await CustomerMembership.findOne({
      _id: membershipId,
      organizationId,
      isDeleted: false,
    });

    if (!target) {
      throw new AppError("Customer membership not found", 404);
    }

    const purchaseId = target.membershipPurchaseId;
    const allMembers = await CustomerMembership.find({
      organizationId,
      membershipPurchaseId: purchaseId,
      isDeleted: false,
    })
      .populate("customerId", "name phone email")
      .populate("payerCustomerId", "name phone email")
      .sort({ createdAt: 1 });

    const activeOrEnrolled = allMembers.filter((m) =>
      ["active", "pending_payment", "suspended"].includes(m.status)
    );

    let maxCapacity = target.planSnapshot?.maxBeneficiaries;
    if (!maxCapacity) {
      const originalPlan = await MembershipPlan.findById(target.membershipPlanId);
      maxCapacity = originalPlan?.maxBeneficiaries || 1;
    }

    return {
      membershipPurchaseId: purchaseId,
      referenceMembershipId: target._id,
      membershipPlanId: target.membershipPlanId,
      planName: target.planSnapshot?.name,
      tier: target.planSnapshot?.tier,
      maxBeneficiaries: maxCapacity,
      enrolledCount: activeOrEnrolled.length,
      availableSlots: Math.max(0, maxCapacity - activeOrEnrolled.length),
      isCapacityReached: activeOrEnrolled.length >= maxCapacity,
      members: allMembers,
    };
  }
}

export const membershipService = new MembershipService();
