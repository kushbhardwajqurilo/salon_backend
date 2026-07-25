import { Router } from "express";
import { authenticate } from "../../middleware/auth.js";
import { requireBranchScope, requireOrganizationScope } from "../../middleware/branchScope.js";
import { authorize } from "../../middleware/rbac.js";
import { validate } from "../../middleware/validate.js";
import * as customerController from "../../controllers/customers/customer.controller.js";
import * as customerValidation from "../../validation/customers/customer.validation.js";

const router = Router();

// Enforce authentication across all customer operations
router.use(authenticate);

router.post(
  "/",
  requireBranchScope,
  authorize("customer:create"),
  validate(customerValidation.createCustomerSchema),
  customerController.createCustomer
);

router.get(
  "/",
  requireBranchScope,
  authorize("customer:view"),
  validate(customerValidation.queryCustomerSchema),
  customerController.listCustomers
);

router.get(
  "/:id",
  requireOrganizationScope,
  authorize("customer:view"),
  customerController.getCustomerById
);

router.put(
  "/:id",
  requireOrganizationScope,
  authorize("customer:update"),
  validate(customerValidation.updateCustomerSchema),
  customerController.updateCustomer
);

router.delete(
  "/:id",
  requireOrganizationScope,
  authorize("customer:delete"),
  customerController.deleteCustomer
);

// Notes
router.post(
  "/:id/notes",
  requireOrganizationScope,
  authorize("customer:update"),
  validate(customerValidation.addNoteSchema),
  customerController.addNote
);

// Preferences
router.put(
  "/:id/preferences",
  requireOrganizationScope,
  authorize("customer:update"),
  validate(customerValidation.updatePreferencesSchema),
  customerController.updatePreferences
);

// Visit log
router.post(
  "/:id/visits",
  requireBranchScope,
  authorize("customer:update"),
  validate(customerValidation.addVisitSchema),
  customerController.addVisit
);

// Service log
router.post(
  "/:id/services",
  requireBranchScope,
  authorize("customer:update"),
  validate(customerValidation.addServiceSchema),
  customerController.addService
);

// Membership log
router.post(
  "/:id/memberships",
  requireBranchScope,
  authorize("customer:update"),
  validate(customerValidation.addMembershipSchema),
  customerController.addMembership
);

// Loyalty log
router.post(
  "/:id/loyalty",
  requireOrganizationScope,
  authorize("customer:update"),
  validate(customerValidation.adjustLoyaltySchema),
  customerController.adjustLoyaltyPoints
);

export default router;
