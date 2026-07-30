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

// Create Customer Profile
router.post(
  "/",
  requireBranchScope,
  authorize("customers.create"),
  validate(customerValidation.createCustomerSchema),
  customerController.createCustomer
);

// List Customers
router.get(
  "/",
  requireBranchScope,
  authorize("customers.view"),
  validate(customerValidation.queryCustomerSchema),
  customerController.listCustomers
);

// Get Customer by ID
router.get(
  "/:id",
  requireOrganizationScope,
  authorize("customers.view"),
  customerController.getCustomerById
);

// Update Customer Profile
router.put(
  "/:id",
  requireOrganizationScope,
  authorize("customers.edit"),
  validate(customerValidation.updateCustomerSchema),
  customerController.updateCustomer
);

// Soft Delete Customer Profile
router.delete(
  "/:id",
  requireOrganizationScope,
  authorize("customers.delete"),
  customerController.deleteCustomer
);

// Get Customer Notes
router.get(
  "/:id/notes",
  requireBranchScope,
  authorize("customers.view"),
  validate(customerValidation.queryNotesSchema),
  customerController.getNotes
);

// Create Customer Note
router.post(
  "/:id/notes",
  requireBranchScope,
  authorize("customers.edit"),
  validate(customerValidation.addNoteSchema),
  customerController.addNote
);

// Get Customer Administrative Activity Timeline
router.get(
  "/:id/activity",
  requireBranchScope,
  authorize("customers.view"),
  validate(customerValidation.queryActivitySchema),
  customerController.getActivity
);

router.put(
  "/:id/reactivate",
  requireOrganizationScope,
  authorize("customers.edit"),
  validate(customerValidation.customerStatusUpdateSchema),
  customerController.reactivateCustomer
);

export default router;
