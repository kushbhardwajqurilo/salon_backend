import { Router } from "express";
import { authenticate } from "../../middleware/auth.js";
import { requireOrganizationScope } from "../../middleware/branchScope.js";
import { authorize } from "../../middleware/rbac.js";
import { validate } from "../../middleware/validate.js";
import * as planController from "../../controllers/subscriptions/subscriptionPlan.controller.js";
import * as planValidation from "../../validation/subscriptions/subscriptionPlan.validation.js";

const router = Router();

// Enforce authentication across all subscription plan operations
router.use(authenticate);

// 1. List Plans (Organization-scoped, no branch filter)
router.get(
  "/",
  requireOrganizationScope,
  authorize("subscriptions.view"),
  validate(planValidation.querySubscriptionPlanSchema),
  planController.listPlans
);

// 2. Get Plan by ID
router.get(
  "/:id",
  requireOrganizationScope,
  authorize("subscriptions.view"),
  planController.getPlanById
);

// 3. Create Plan
router.post(
  "/",
  requireOrganizationScope,
  authorize("subscriptions.configure"),
  validate(planValidation.createSubscriptionPlanSchema),
  planController.createPlan
);

// 4. Update Plan
router.put(
  "/:id",
  requireOrganizationScope,
  authorize("subscriptions.configure"),
  validate(planValidation.updateSubscriptionPlanSchema),
  planController.updatePlan
);

// 5. Delete Plan (Soft delete)
router.delete(
  "/:id",
  requireOrganizationScope,
  authorize("subscriptions.configure"),
  planController.deletePlan
);

export default router;
