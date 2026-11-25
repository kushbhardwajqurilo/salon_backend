import { AppError, asyncHandler } from "../../utils/errors.js";
import { sendResponse } from "../../utils/response.js";
import { Branch } from "../../models/branches/branch.model.js";
import { Organization } from "../../models/organizations/organization.model.js";
import { AuditLogService, buildBeforeAfterMetadata, extractAuditContext } from "../../services/audit/auditLog.service.js";
import { AUDIT_ACTIONS } from "../../models/audit/auditLog.model.js";

const auditLogService = new AuditLogService();

const mapBranchObj = (b) => ({
  id: b._id,
  name: b.name,
  organizationId: b.organizationId,
  address: b.address,
  phone: b.phone,
  isActive: b.isActive,
  createdAt: b.createdAt,
  updatedAt: b.updatedAt,
});

export const getBranches = asyncHandler(async (req, res) => {
  const { organizationId, branchAccess, hasOrgWideAccess } = req.user;

  const org = await Organization.findOne({
    _id: organizationId,
    isActive: true,
  });
  if (!org) {
    throw new AppError("Organization not found", 404);
  }

  let branches = [];
  if (hasOrgWideAccess === true) {
    // Return all active branches belonging to organization
    branches = await Branch.find({ organizationId, isActive: true });
  } else {
    // Return only active branches explicitly present in user's branchAccess
    const assignedIds = (branchAccess || [])
      .filter((b) => b.isActive)
      .map((b) => b.branchId.toString());

    if (assignedIds.length > 0) {
      branches = await Branch.find({
        _id: { $in: assignedIds },
        organizationId,
        isActive: true,
      });
    }
  }

  return sendResponse(res, 200, "Branches retrieved successfully", {
    organization: {
      id: org._id,
      name: org.name,
      logo: org.logo,
    },
    branches: branches.map(mapBranchObj),
  });
});

export const getBranchById = asyncHandler(async (req, res) => {
  const { id } = req.params;
  const { organizationId, branchAccess, hasOrgWideAccess } = req.user;

  const branch = await Branch.findOne({ _id: id, organizationId });
  if (!branch) {
    throw new AppError("Branch not found", 404);
  }
  const beforeState = {
    name: branch.name,
    address: branch.address,
    phone: branch.phone,
    isActive: branch.isActive,
  };

  // Check access
  let hasAccess = false;
  if (hasOrgWideAccess === true) {
    hasAccess = true;
  } else {
    hasAccess = branchAccess.some(
      (b) => b.branchId.toString() === id.toString() && b.isActive,
    );
  }

  if (!hasAccess) {
    throw new AppError(
      "Access denied. You do not have access to this branch.",
      403,
    );
  }

  return sendResponse(
    res,
    200,
    "Branch retrieved successfully",
    mapBranchObj(branch),
  );
});

export const createBranch = asyncHandler(async (req, res) => {
  const { organizationId } = req.user;
  const { name, address, phone } = req.body;

  if (!name) {
    throw new AppError("Name is required", 400);
  }

  const existingBranch = await Branch.findOne({
    organizationId,
    name: name.trim(),
  });
  if (existingBranch) {
    throw new AppError(
      "A branch with this name already exists in your organization.",
      409,
    );
  }

  const newBranch = await Branch.create({
    organizationId,
    name: name.trim(),
    address,
    phone,
  });

  await auditLogService.createAuditLog(
    {
      action: AUDIT_ACTIONS.BRANCH_CREATED,
      entityType: "Branch",
      entityId: newBranch._id,
      branchId: newBranch._id,
      description: `Branch '${newBranch.name}' created`,
      ...extractAuditContext(req),
      metadata: { name: newBranch.name, phone: newBranch.phone },
    },
    organizationId,
    req.user?.userId || req.user?._id
  );

  return sendResponse(
    res,
    201,
    "Branch created successfully",
    mapBranchObj(newBranch),
  );
});

export const updateBranch = asyncHandler(async (req, res) => {
  const { id } = req.params;
  const { organizationId } = req.user;
  const { name, address, phone, isActive } = req.body;

  const branch = await Branch.findOne({ _id: id, organizationId });
  if (!branch) {
    throw new AppError("Branch not found", 404);
  }
  const beforeState = {
    name: branch.name,
    address: branch.address,
    phone: branch.phone,
    isActive: branch.isActive,
  };

  if (name && name.trim() !== branch.name) {
    const existingBranch = await Branch.findOne({
      _id: { $ne: id },
      organizationId,
      name: name.trim(),
    });
    if (existingBranch) {
      throw new AppError(
        "A branch with this name already exists in your organization.",
        409,
      );
    }
    branch.name = name.trim();
  }

  if (address !== undefined) branch.address = address;
  if (phone !== undefined) branch.phone = phone;
  if (isActive !== undefined) {
    // If deactivating, make sure it's not the last active branch
    if (isActive === false && branch.isActive === true) {
      const activeCount = await Branch.countDocuments({
        organizationId,
        isActive: true,
      });
      if (activeCount <= 1) {
        throw new AppError("Cannot deactivate the last active branch", 400);
      }
    }
    branch.isActive = isActive;
  }

  await branch.save();

  await auditLogService.createAuditLog(
    {
      action: AUDIT_ACTIONS.BRANCH_UPDATED,
      entityType: "Branch",
      entityId: branch._id,
      branchId: branch._id,
      description: `Branch '${branch.name}' updated`,
      ...extractAuditContext(req),
      metadata: buildBeforeAfterMetadata(beforeState, {
        name: branch.name,
        address: branch.address,
        phone: branch.phone,
        isActive: branch.isActive,
      }),
    },
    organizationId,
    req.user?.userId || req.user?._id
  );

  return sendResponse(
    res,
    200,
    "Branch updated successfully",
    mapBranchObj(branch),
  );
});

export const deleteBranch = asyncHandler(async (req, res) => {
  const { id } = req.params;
  const { organizationId } = req.user;

  const branch = await Branch.findOne({ _id: id, organizationId });
  if (!branch) {
    throw new AppError("Branch not found", 404);
  }
  const beforeState = {
    name: branch.name,
    address: branch.address,
    phone: branch.phone,
    isActive: branch.isActive,
  };

  // Soft delete logic
  const activeCount = await Branch.countDocuments({
    organizationId,
    isActive: true,
  });
  if (branch.isActive && activeCount <= 1) {
    throw new AppError("Cannot deactivate the last active branch", 400);
  }

  branch.isActive = false;
  await branch.save();

  await auditLogService.createAuditLog(
    {
      action: AUDIT_ACTIONS.BRANCH_UPDATED,
      entityType: "Branch",
      entityId: branch._id,
      branchId: branch._id,
      description: `Branch '${branch.name}' updated`,
      ...extractAuditContext(req),
      metadata: buildBeforeAfterMetadata(beforeState, {
        name: branch.name,
        address: branch.address,
        phone: branch.phone,
        isActive: branch.isActive,
      }),
    },
    organizationId,
    req.user?.userId || req.user?._id
  );

  return sendResponse(res, 200, "Branch deactivated successfully");
});
