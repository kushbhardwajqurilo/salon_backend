import { Router } from "express";
import { authenticate } from "../../middleware/auth.js";
import { resolveBranchScope } from "../../middleware/branchScope.js";
import { authorize } from "../../middleware/rbac.js";
import { validate } from "../../middleware/validate.js";
import * as customerController from "../../controllers/customers/customer.controller.js";
import * as customerValidation from "../../validation/customers/customer.validation.js";

const router = Router();

// Enforce authentication across all customer operations
router.use(authenticate);
router.use(resolveBranchScope);

router.post(
  "/",
  authorize("customer:create", true),
  validate(customerValidation.createCustomerSchema),
  customerController.createCustomer
);

router.get(
  "/",
  authorize("customer:view"),
  validate(customerValidation.queryCustomerSchema),
  customerController.listCustomers
);

router.get(
  "/:id",
  authorize("customer:view"),
  customerController.getCustomerById
);

router.put(
  "/:id",
  authorize("customer:update"),
  validate(customerValidation.updateCustomerSchema),
  customerController.updateCustomer
);

router.delete(
  "/:id",
  authorize("customer:delete"),
  customerController.deleteCustomer
);

// Notes
router.post(
  "/:id/notes",
  authorize("customer:update"),
  validate(customerValidation.addNoteSchema),
  customerController.addNote
);

// Preferences
router.put(
  "/:id/preferences",
  authorize("customer:update"),
  validate(customerValidation.updatePreferencesSchema),
  customerController.updatePreferences
);

// Visit log
router.post(
  "/:id/visits",
  authorize("customer:update"),
  validate(customerValidation.addVisitSchema),
  customerController.addVisit
);

// Service log
router.post(
  "/:id/services",
  authorize("customer:update"),
  validate(customerValidation.addServiceSchema),
  customerController.addService
);

// Membership log
router.post(
  "/:id/memberships",
  authorize("customer:update"),
  validate(customerValidation.addMembershipSchema),
  customerController.addMembership
);

// Loyalty log
router.post(
  "/:id/loyalty",
  authorize("customer:update"),
  validate(customerValidation.adjustLoyaltySchema),
  customerController.adjustLoyaltyPoints
);

export default router;
