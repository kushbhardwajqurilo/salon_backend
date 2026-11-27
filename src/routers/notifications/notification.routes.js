import { Router } from "express";
import { authenticate } from "../../middleware/auth.js";
import { requireOrganizationScope } from "../../middleware/branchScope.js";
import { authorize } from "../../middleware/rbac.js";
import * as notificationController from "../../controllers/notifications/notification.controller.js";

const router = Router();

router.use(authenticate);
router.use(requireOrganizationScope);

// Notification logs
router.get(
  "/",
  authorize("logs.view"),
  notificationController.listNotifications,
);
router.get(
  "/templates",
  authorize("notifications.templates.view"),
  notificationController.listTemplates,
);
router.post(
  "/templates",
  authorize("notifications.templates.update"),
  notificationController.upsertOrgTemplate,
);
router.post(
  "/templates/preview",
  authorize("notifications.templates.view"),
  notificationController.previewTemplate,
);

// Automations (safely restricted: no automation permission exists in permissions.js yet)
router.get(
  "/automations",
  authorize("notifications.automations.manage"),
  notificationController.listAutomations,
);
router.post(
  "/automations",
  authorize("notifications.automations.manage"),
  notificationController.createAutomationHandler,
);
router.patch(
  "/automations/:id/toggle",
  authorize("notifications.automations.manage"),
  notificationController.toggleAutomationHandler,
);
router.patch(
  "/automations/:id/schedule",
  authorize("notifications.automations.manage"),
  notificationController.updateAutomationScheduleHandler,
);
router.delete(
  "/automations/:id",
  authorize("notifications.automations.manage"),
  notificationController.deleteAutomationHandler,
);

// Authenticated user's in-app inbox
router.get("/inbox", notificationController.getMyInbox);
router.patch("/inbox/read-all", notificationController.markAllInboxRead);
router.patch("/inbox/:id/read", notificationController.markInboxItemRead);

router.get(
  "/:id",
  authorize("logs.view"),
  notificationController.getNotificationById,
);

export default router;
