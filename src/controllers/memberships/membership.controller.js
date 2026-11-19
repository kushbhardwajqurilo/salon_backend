import { membershipService } from "../../services/memberships/membership.service.js";
import { AppError } from "../../utils/errors.js";

export const createPlan = async (req, res, next) => {
  try {
    const plan = await membershipService.createPlan(
      req.body,
      req.user.organizationId,
      req.user._id
    );
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
    const plan = await membershipService.updatePlan(
      req.params.id,
      req.body,
      req.user.organizationId,
      req.user._id
    );
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
    const result = await membershipService.deletePlan(
      req.params.id,
      req.user.organizationId,
      req.user._id
    );
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
    const plan = await membershipService.duplicatePlan(
      req.params.id,
      req.user.organizationId,
      req.user._id
    );
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
    const membership = await membershipService.cancelBeneficiaryMembership(
      req.params.id,
      req.body,
      req.user.organizationId,
      req.user._id
    );
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
    const membership = await membershipService.suspendBeneficiaryMembership(
      req.params.id,
      req.body,
      req.user.organizationId,
      req.user._id
    );
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
    const membership = await membershipService.reactivateBeneficiaryMembership(
      req.params.id,
      req.user.organizationId,
      req.user._id
    );
    res.status(200).json({
      success: true,
      message: "Customer membership reactivated successfully",
      data: membership,
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
