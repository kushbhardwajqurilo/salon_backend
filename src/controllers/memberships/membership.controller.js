import { membershipService } from "../../services/memberships/membership.service.js";
import { AppError } from "../../utils/errors.js";
import { AuditLogService } from "../../services/audit/auditLog.service.js";
import { AUDIT_ACTIONS } from "../../models/audit/auditLog.model.js";

const auditLogService = new AuditLogService();
const logMembershipAudit = (req, payload) =>
  auditLogService
    .createAuditLog(
      {
        branchId: req.branchId || req.activeBranch?._id || req.body?.branchId || null,
        ...payload,
      },
      req.user.organizationId,
      req.user?._id || req.user?.id
    )
    .catch(() => {});

export const createPlan = async (req, res, next) => {
  try {
    const userId = req.user?._id || req.user?.id;
    const plan = await membershipService.createPlan(
      req.body,
      req.user.organizationId,
      userId
    );
    await logMembershipAudit(req, {
      action: AUDIT_ACTIONS.MEMBERSHIP_PLAN_CREATED,
      entityType: "MembershipPlan",
      entityId: plan?._id || null,
      description: `Created membership plan ${plan?.name || req.body?.name || ""}`,
      metadata: req.body,
    });
    res.status(201).json({
      success: true,
      message: "Membership plan created successfully",
      data: plan,
    });
  } catch (error) {
    next(error);
  }
};

export const listPlans = async (req, res, next) => {
  try {
    const result = await membershipService.listPlans(
      req.query,
      req.user.organizationId
    );
    res.status(200).json({
      success: true,
      data: result.plans,
      pagination: {
        total: result.total,
        page: result.page,
        totalPages: result.totalPages,
      },
    });
  } catch (error) {
    next(error);
  }
};

export const getPlanById = async (req, res, next) => {
  try {
    const plan = await membershipService.getPlanById(
      req.params.id,
      req.user.organizationId
    );
    res.status(200).json({
      success: true,
      data: plan,
    });
  } catch (error) {
    next(error);
  }
};

export const updatePlan = async (req, res, next) => {
  try {
    const userId = req.user?._id || req.user?.id;
    const plan = await membershipService.updatePlan(
      req.params.id,
      req.body,
      req.user.organizationId,
      userId
    );
    await logMembershipAudit(req, {
      action: AUDIT_ACTIONS.MEMBERSHIP_PLAN_UPDATED,
      entityType: "MembershipPlan",
      entityId: req.params.id,
      description: `Updated membership plan ${req.params.id}`,
      metadata: req.body,
    });
    res.status(200).json({
      success: true,
      message: "Membership plan updated successfully",
      data: plan,
    });
  } catch (error) {
    next(error);
  }
};

export const deletePlan = async (req, res, next) => {
  try {
    const userId = req.user?._id || req.user?.id;
    const result = await membershipService.deletePlan(
      req.params.id,
      req.user.organizationId,
      userId
    );
    await logMembershipAudit(req, {
      action: AUDIT_ACTIONS.MEMBERSHIP_PLAN_DELETED,
      entityType: "MembershipPlan",
      entityId: req.params.id,
      description: `Deleted membership plan ${req.params.id}`,
    });
    res.status(200).json({
      success: true,
      message: result.message,
    });
  } catch (error) {
    next(error);
  }
};

export const duplicatePlan = async (req, res, next) => {
  try {
    const userId = req.user?._id || req.user?.id;
    const plan = await membershipService.duplicatePlan(
      req.params.id,
      req.user.organizationId,
      userId
    );
    await logMembershipAudit(req, {
      action: AUDIT_ACTIONS.MEMBERSHIP_PLAN_CREATED,
      entityType: "MembershipPlan",
      entityId: plan?._id || null,
      description: `Duplicated membership plan from ${req.params.id}`,
      metadata: { sourcePlanId: req.params.id },
    });
    res.status(201).json({
      success: true,
      message: "Membership plan duplicated successfully",
      data: plan,
    });
  } catch (error) {
    next(error);
  }
};

export const listCustomerMemberships = async (req, res, next) => {
  try {
    const result = await membershipService.listCustomerMemberships(
      req.query,
      req.user.organizationId
    );
    res.status(200).json({
      success: true,
      data: result.memberships,
      pagination: {
        total: result.total,
        page: result.page,
        totalPages: result.totalPages,
      },
    });
  } catch (error) {
    next(error);
  }
};

export const getCustomerMembershipById = async (req, res, next) => {
  try {
    const membership = await membershipService.getCustomerMembershipById(
      req.params.id,
      req.user.organizationId
    );
    res.status(200).json({
      success: true,
      data: membership,
    });
  } catch (error) {
    next(error);
  }
};

export const cancelBeneficiaryMembership = async (req, res, next) => {
  try {
    const userId = req.user?._id || req.user?.id;
    const membership = await membershipService.cancelBeneficiaryMembership(
      req.params.id,
      req.body,
      req.user.organizationId,
      userId
    );
    await logMembershipAudit(req, {
      action: AUDIT_ACTIONS.MEMBERSHIP_CANCELLED,
      entityType: "CustomerMembership",
      entityId: req.params.id,
      description: `Cancelled customer membership ${req.params.id}`,
      metadata: req.body,
    });
    res.status(200).json({
      success: true,
      message: "Customer membership cancelled successfully",
      data: membership,
    });
  } catch (error) {
    next(error);
  }
};

export const suspendBeneficiaryMembership = async (req, res, next) => {
  try {
    const userId = req.user?._id || req.user?.id;
    const membership = await membershipService.suspendBeneficiaryMembership(
      req.params.id,
      req.body,
      req.user.organizationId,
      userId
    );
    await logMembershipAudit(req, {
      action: AUDIT_ACTIONS.MEMBERSHIP_SUSPENDED,
      entityType: "CustomerMembership",
      entityId: req.params.id,
      description: `Suspended customer membership ${req.params.id}`,
      metadata: req.body,
    });
    res.status(200).json({
      success: true,
      message: "Customer membership suspended successfully",
      data: membership,
    });
  } catch (error) {
    next(error);
  }
};

export const reactivateBeneficiaryMembership = async (req, res, next) => {
  try {
    const userId = req.user?._id || req.user?.id;
    const membership = await membershipService.reactivateBeneficiaryMembership(
      req.params.id,
      req.user.organizationId,
      userId
    );
    await logMembershipAudit(req, {
      action: AUDIT_ACTIONS.MEMBERSHIP_REACTIVATED,
      entityType: "CustomerMembership",
      entityId: req.params.id,
      description: `Reactivated customer membership ${req.params.id}`,
    });
    res.status(200).json({
      success: true,
      message: "Customer membership reactivated successfully",
      data: membership,
    });
  } catch (error) {
    next(error);
  }
};

export const addBeneficiaryToMembership = async (req, res, next) => {
  try {
    const userId = req.user?._id || req.user?.id;
    const newBeneficiary = await membershipService.addBeneficiaryToMembership(
      req.params.id,
      req.body,
      req.user.organizationId,
      userId
    );
    await logMembershipAudit(req, {
      action: AUDIT_ACTIONS.MEMBERSHIP_BENEFICIARY_ADDED,
      entityType: "CustomerMembership",
      entityId: req.params.id,
      description: `Added beneficiary to membership ${req.params.id}`,
      metadata: req.body,
    });
    res.status(201).json({
      success: true,
      message: "Beneficiary added to membership successfully",
      data: newBeneficiary,
    });
  } catch (error) {
    next(error);
  }
};

export const getMembershipPurchaseGroup = async (req, res, next) => {
  try {
    const group = await membershipService.getMembershipPurchaseGroup(
      req.params.id,
      req.user.organizationId
    );
    res.status(200).json({
      success: true,
      data: group,
    });
  } catch (error) {
    next(error);
  }
};

export const getMembershipReports = async (req, res, next) => {
  try {
    const stats = await membershipService.getMembershipReports(
      req.query,
      req.user.organizationId
    );
    res.status(200).json({
      success: true,
      data: stats,
    });
  } catch (error) {
    next(error);
  }
};

export const resolveCustomerBenefits = async (req, res, next) => {
  try {
    const customerId = req.params.customerId;
    const branchId = req.query.branchId || req.headers["x-branch-id"];
    const membership = await membershipService.resolveActiveMembershipForCustomer(
      customerId,
      branchId,
      req.user.organizationId
    );
    res.status(200).json({
      success: true,
      data: membership ? {
        hasActiveMembership: true,
        membershipId: membership._id,
        status: membership.status,
        membershipCode: membership.membershipCode,
        planSnapshot: membership.planSnapshot,
        startDate: membership.startDate,
        endDate: membership.endDate,
        permittedBranchIds: membership.permittedBranchIds,
      } : {
        hasActiveMembership: false,
        membershipId: null,
      },
    });
  } catch (error) {
    next(error);
  }
};

export const sellMembership = async (req, res, next) => {
  try {
    const branchId =
      req.body.branchId ||
      req.activeBranch?._id ||
      req.branchId ||
      req.headers["x-branch-id"] ||
      null;

    const userId = req.user?._id || req.user?.id;

    const result = await membershipService.sellMembership(
      req.body,
      req.user.organizationId,
      branchId,
      userId
    );

    await logMembershipAudit(req, {
      action: AUDIT_ACTIONS.MEMBERSHIP_CREATED,
      entityType: "CustomerMembership",
      entityId: result?._id || result?.membership?._id || null,
      branchId,
      description: `Sold customer membership for plan ${req.body?.planId || ""}`,
      metadata: { planId: req.body?.planId, customerId: req.body?.customerId },
    });

    res.status(201).json({
      success: true,
      message: "Customer membership sold successfully",
      data: result,
    });
  } catch (error) {
    next(error);
  }
};

export const getMembershipUsageHistory = async (req, res, next) => {
  try {
    const membershipId = req.params.id;
    const result = await membershipService.getMembershipUsageHistory(
      membershipId,
      req.user.organizationId,
      req.query
    );
    res.status(200).json({
      success: true,
      data: result,
    });
  } catch (error) {
    next(error);
  }
};

export const triggerRenewalReminder = async (req, res, next) => {
  try {
    const membershipId = req.params.id;
    const result = await membershipService.triggerRenewalReminder(
      membershipId,
      req.user.organizationId,
      req.body
    );
    await logMembershipAudit(req, {
      action: AUDIT_ACTIONS.MEMBERSHIP_UPDATED,
      entityType: "CustomerMembership",
      entityId: membershipId,
      description: `Triggered renewal reminder for membership ${membershipId}`,
      metadata: { renewalReminder: true, ...req.body },
    });
    res.status(200).json({
      success: true,
      message: "Membership renewal reminder processed",
      data: result,
    });
  } catch (error) {
    next(error);
  }
};
