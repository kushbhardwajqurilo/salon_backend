import { Router } from "express";
import { authenticate } from "../../middleware/auth.js";
import { requirePermission } from "../../middleware/rbac.js";
import * as branchController from "../../controllers/branches/branch.controller.js";

const router = Router();

router.use(authenticate);

router.get("/", branchController.getBranches);
router.get("/:id", branchController.getBranchById);
router.post("/", requirePermission("branches.manage"), branchController.createBranch);
router.patch("/:id", requirePermission("branches.manage"), branchController.updateBranch);
router.delete("/:id", requirePermission("branches.manage"), branchController.deleteBranch);

export default router;
