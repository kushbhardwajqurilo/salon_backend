import express from "express";
import { authenticate } from "../../middleware/auth.js";
import { requireOrganizationScope, requireBranchScope } from "../../middleware/branchScope.js";
import { requirePermission } from "../../middleware/rbac.js";
import { validate } from "../../middleware/validate.js";
import {
  updateLoyaltyProgramSchema,
  adjustCustomerPointsSchema,
  listCustomerLedgerSchema,
  previewRedemptionSchema,
} from "../../validation/loyalty/loyalty.validation.js";
import { loyaltyController } from "../../controllers/loyalty/loyalty.controller.js";

const router = express.Router();

// All loyalty routes require authentication and organization scoping
router.use(authenticate);
router.use(requireOrganizationScope);

// 1. Program settings
router.get(
  "/program",
  requirePermission("loyalty.view"),
  loyaltyController.getProgram
);

router.put(
  "/program",
  requirePermission("loyalty.configure"),
  validate(updateLoyaltyProgramSchema),
  loyaltyController.updateProgram
);

// 2. Redemption preview (side-effect free)
router.get(
  "/preview-redemption",
  requirePermission("loyalty.view"),
  validate(previewRedemptionSchema),
  loyaltyController.previewRedemption
);

// 3. Customer Ledger
router.get(
  "/customers/:customerId/ledger",
  requirePermission("loyalty.view"),
  validate(listCustomerLedgerSchema),
  loyaltyController.getCustomerLedger
);

// 4. Manual Adjustment
router.post(
  "/customers/:customerId/adjust",
  requirePermission("loyalty.adjust"),
  validate(adjustCustomerPointsSchema),
  loyaltyController.adjustCustomerPoints
);

export default router;
