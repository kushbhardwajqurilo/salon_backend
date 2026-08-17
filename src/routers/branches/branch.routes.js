import { Router } from "express";
import { authenticate } from "../../middleware/auth.js";
import { authorize } from "../../middleware/rbac.js";
import * as branchController from "../../controllers/branches/branch.controller.js";

const router = Router();

router.use(authenticate);

router.get("/", authorize("branches.view"), branchController.getBranches);
router.get("/:id", authorize("branches.view"), branchController.getBranchById);
router.post("/", authorize("branches.create"), branchController.createBranch);
router.patch("/:id", authorize("branches.update"), branchController.updateBranch);
router.delete("/:id", authorize("branches.delete"), branchController.deleteBranch);

export default router;
