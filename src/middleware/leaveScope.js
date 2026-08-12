import { StaffRepository } from "../repositories/staff/staff.repository.js";
import { requirePermission } from "./rbac.js";
import { asyncHandler } from "../utils/errors.js";

const staffRepo = new StaffRepository();

export const requireOnBehalfManage = asyncHandler(async (req, res, next) => {
  if (!req.body?.staffId) {
    return next();
  }

  const actorStaff = await staffRepo.findOne(
    { userId: req.user.id, isDeleted: false },
    req.organizationId
  );

  if (actorStaff && req.body.staffId === actorStaff._id.toString()) {
    return next();
  }

  return requirePermission("employees.leaves.manage")(req, res, next);
});
