import mongoose from "mongoose";
import { Staff } from "../../models/staff/staff.model.js";
import { StaffBranch } from "../../models/staff/staffBranch.model.js";
import { AppError } from "../../utils/errors.js";

export async function resolveStaffAttribution(
  staffId,
  organizationId,
  branchId,
  session = null,
) {
  if (staffId === undefined || staffId === null || staffId === "") return null;

  if (!mongoose.isValidObjectId(staffId) || !branchId) {
    throw new AppError("Staff attribution is invalid for this branch", 400);
  }

  let staffQuery = Staff.findOne({
    _id: staffId,
    organizationId,
    status: "active",
    isDeleted: false,
  });
  if (session) staffQuery = staffQuery.session(session);
  const staff = await staffQuery.exec();

  if (!staff) {
    throw new AppError("Staff attribution is invalid for this organization or branch", 400);
  }

  let assignmentQuery = StaffBranch.findOne({
    organizationId,
    staffId: staff._id,
    branchId,
    isActive: true,
  });
  if (session) assignmentQuery = assignmentQuery.session(session);
  const assignment = await assignmentQuery.exec();

  if (!assignment) {
    throw new AppError("Staff member is not assigned to the selected branch", 400);
  }

  return {
    staffId: staff._id,
    name: staff.name,
    staffCode: staff.staffCode,
  };
}

export async function loadStaffAttributionSnapshot(
  staffId,
  organizationId,
  session = null,
) {
  if (!staffId || !mongoose.isValidObjectId(staffId)) return null;

  let query = Staff.findOne({ _id: staffId, organizationId })
    .setOptions({ includeDeleted: true })
    .select("_id name staffCode");
  if (session) query = query.session(session);
  const staff = await query.exec();
  if (!staff) return null;

  return {
    staffId: staff._id,
    name: staff.name,
    staffCode: staff.staffCode,
  };
}
