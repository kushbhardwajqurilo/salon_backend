import { Router } from "express";
import { authenticate } from "../../middleware/auth.js";
import {
  requireBranchScope,
  requireOrganizationScope,
} from "../../middleware/branchScope.js";
import { authorize } from "../../middleware/rbac.js";
import { validate } from "../../middleware/validate.js";
import * as subscriptionController from "../../controllers/subscriptions/subscription.controller.js";
import * as subscriptionValidation from "../../validation/subscriptions/subscription.validation.js";

const router = Router();

// Enforce authentication across all subscription operations
router.use(authenticate);

// 1. Create Customer-Specific Subscription
router.post(
  "/",
  requireOrganizationScope,
  authorize("subscriptions.sell"),
  validate(subscriptionValidation.createSubscriptionSchema),
  subscriptionController.createSubscription
);

// 2. List Subscriptions
router.get(
  "/",
  requireOrganizationScope,
  authorize("subscriptions.view"),
  validate(subscriptionValidation.querySubscriptionSchema),
  subscriptionController.listSubscriptions
);

// 3. Get Subscription by ID
router.get(
  "/:id",
  requireOrganizationScope,
  authorize("subscriptions.view"),
  subscriptionController.getSubscriptionById
);

// 4. Update Subscription
router.put(
  "/:id",
  requireOrganizationScope,
  authorize("subscriptions.configure"),
  validate(subscriptionValidation.updateSubscriptionSchema),
  subscriptionController.updateSubscription
);

// 5. Cancel Subscription
router.patch(
  "/:id/cancel",
  requireOrganizationScope,
  authorize("subscriptions.configure"),
  validate(subscriptionValidation.cancelSubscriptionSchema),
  subscriptionController.cancelSubscription
);

// 6. Send Redemption OTP (Branch-scoped)
router.post(
  "/:id/send-otp",
  requireBranchScope,
  authorize("subscriptions.redeem"),
  validate(subscriptionValidation.sendOtpSchema),
  subscriptionController.sendRedemptionOTP
);

// 7. Verify OTP & Redeem Entitlements (Branch-scoped)
router.post(
  "/:id/redeem",
  requireBranchScope,
  authorize("subscriptions.redeem"),
  validate(subscriptionValidation.redeemSubscriptionSchema),
  subscriptionController.redeemSubscription
);

// 8. Subscription Usage / Redemption History
router.get(
  "/:id/usage",
  requireOrganizationScope,
  authorize("subscriptions.view"),
  subscriptionController.getSubscriptionUsage
);

export default router;
