import { Router } from "express";
import { authenticate } from "../../middleware/auth.js";
import { authorize } from "../../middleware/rbac.js";
import * as branchController from "../../controllers/branches/branch.controller.js";

const router = Router();

router.use(authenticate);

router.get("/", branchController.getBranches);
router.get("/:id", branchController.getBranchById);
router.post("/", authorize("branches.manage"), branchController.createBranch);
router.patch("/:id", authorize("branches.manage"), branchController.updateBranch);
router.delete("/:id", authorize("branches.manage"), branchController.deleteBranch);

export default router;
