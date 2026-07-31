import { Router } from "express";
import { authenticate } from "../../middleware/auth.js";
import { requireBranchScope, requireOrganizationScope } from "../../middleware/branchScope.js";
import { authorize } from "../../middleware/rbac.js";
import { validate } from "../../middleware/validate.js";
import * as serviceController from "../../controllers/services/service.controller.js";
import * as categoryController from "../../controllers/services/serviceCategory.controller.js";
import * as serviceValidation from "../../validation/services/service.validation.js";

const router = Router();

// Enforce authentication across all service operations
router.use(authenticate);

// --- Category Routes ---
router.post(
  "/categories",
  requireBranchScope,
  authorize("services.create"),
  validate(serviceValidation.createServiceCategorySchema),
  categoryController.createCategory
);

router.get(
  "/categories",
  requireBranchScope,
  authorize("services.view"),
  validate(serviceValidation.queryServiceCategorySchema),
  categoryController.listCategories
);

router.get(
  "/categories/:id",
  requireOrganizationScope,
  authorize("services.view"),
  categoryController.getCategoryById
);

router.put(
  "/categories/:id",
  requireOrganizationScope,
  authorize("services.edit"),
  validate(serviceValidation.updateServiceCategorySchema),
  categoryController.updateCategory
);

router.delete(
  "/categories/:id",
  requireOrganizationScope,
  authorize("services.delete"),
  categoryController.deleteCategory
);

// --- Service Routes ---
router.post(
  "/",
  requireBranchScope,
  authorize("services.create"),
  validate(serviceValidation.createServiceSchema),
  serviceController.createService
);

router.get(
  "/",
  requireBranchScope,
  authorize("services.view"),
  validate(serviceValidation.queryServiceSchema),
  serviceController.listServices
);

router.get(
  "/:id",
  requireOrganizationScope,
  authorize("services.view"),
  serviceController.getServiceById
);

router.put(
  "/:id",
  requireOrganizationScope,
  authorize("services.edit"),
  validate(serviceValidation.updateServiceSchema),
  serviceController.updateService
);

router.patch(
  "/:id/status",
  requireOrganizationScope,
  authorize("services.edit"),
  validate(serviceValidation.serviceStatusUpdateSchema),
  serviceController.toggleServiceStatus
);

router.delete(
  "/:id",
  requireOrganizationScope,
  authorize("services.delete"),
  serviceController.deleteService
);

export default router;
