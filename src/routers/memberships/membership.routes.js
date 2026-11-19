import { Router } from "express";
import { authenticate } from "../../middleware/auth.js";
import {
  requireBranchScope,
  requireOrganizationScope,
} from "../../middleware/branchScope.js";
import { authorize } from "../../middleware/rbac.js";
import { validate } from "../../middleware/validate.js";
import * as membershipController from "../../controllers/memberships/membership.controller.js";
import * as membershipValidation from "../../validation/memberships/membership.validation.js";

const router = Router();

// Enforce authentication across all membership routes
router.use(authenticate);

// ==========================================
// 1. Membership Plans (Admin / Configuration)
// ==========================================
router.get(
  "/plans",
  requireOrganizationScope,
  authorize("memberships.view"),
  validate(membershipValidation.queryMembershipPlanSchema),
  membershipController.listPlans
);

router.get(
  "/plans/:id",
  requireOrganizationScope,
  authorize("memberships.view"),
  membershipController.getPlanById
);

router.post(
  "/plans",
  requireOrganizationScope,
  authorize("memberships.configure"),
  validate(membershipValidation.createMembershipPlanSchema),
  membershipController.createPlan
);

router.put(
  "/plans/:id",
  requireOrganizationScope,
  authorize("memberships.configure"),
  validate(membershipValidation.updateMembershipPlanSchema),
  membershipController.updatePlan
);

router.delete(
  "/plans/:id",
  requireOrganizationScope,
  authorize("memberships.configure"),
  membershipController.deletePlan
);

router.post(
  "/plans/:id/duplicate",
  requireOrganizationScope,
  authorize("memberships.configure"),
  membershipController.duplicatePlan
);

// ==========================================
// 2. Customer Memberships (Purchases & Beneficiaries)
// ==========================================
router.get(
  "/reports",
  requireOrganizationScope,
  authorize("memberships.view"),
  membershipController.getMembershipReports
);

router.get(
  "/",
  requireOrganizationScope,
  authorize("memberships.view"),
  validate(membershipValidation.queryCustomerMembershipSchema),
  membershipController.listCustomerMemberships
);

router.get(
  "/:id",
  requireOrganizationScope,
  authorize("memberships.view"),
  membershipController.getCustomerMembershipById
);

router.patch(
  "/:id/cancel",
  requireOrganizationScope,
  authorize("memberships.configure"),
  validate(membershipValidation.cancelBeneficiaryMembershipSchema),
  membershipController.cancelBeneficiaryMembership
);

router.patch(
  "/:id/suspend",
  requireOrganizationScope,
  authorize("memberships.configure"),
  membershipController.suspendBeneficiaryMembership
);

router.patch(
  "/:id/reactivate",
  requireOrganizationScope,
  authorize("memberships.configure"),
  membershipController.reactivateBeneficiaryMembership
);

// ==========================================
// 3. Customer Active Benefit Lookup
// ==========================================
router.get(
  "/customer/:customerId/benefits",
  requireOrganizationScope,
  authorize("memberships.view"),
  membershipController.resolveCustomerBenefits
);

export default router;
