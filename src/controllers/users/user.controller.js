import mongoose from "mongoose";
import crypto from "node:crypto";
import { UserRepository } from "../../repositories/users/user.repository.js";
import { UserService } from "../../services/users/user.service.js";
import { Role } from "../../models/roles/role.model.js";
import { Branch } from "../../models/branches/branch.model.js";
import { sendResponse } from "../../utils/response.js";
import { asyncHandler, AppError } from "../../utils/errors.js";
import { toUserResponseDTO } from "../../utils/userResponse.js";
import { normalizeUsername } from "../../utils/userIdentity.js";
import { emailQueue } from "../../queues/client.js";
import { logger } from "../../utils/logger.js";

import { assertCanManageBranches } from "../../utils/branchAuthorization.js";
import { validateUserUpdate } from "../../utils/userValidation.js";

const userRepo = new UserRepository();
const userService = new UserService();

export const listUsers = asyncHandler(async (req, res) => {
  const organizationId = req.organizationId;
  const { page, limit, sort, search } = req.query;

  const options = {
    page,
    limit,
    sort,
    search,
    searchFields: ["name", "username", "email", "phone"],
  };

  const result = await userRepo.find({}, options, organizationId, ["role"]);
  const serializedUsers = result.data.map((user) => toUserResponseDTO(user));

  return sendResponse(
    res,
    200,
    "Users listed successfully",
    serializedUsers,
    result.meta,
  );
});

export const getUserById = asyncHandler(async (req, res) => {
  const organizationId = req.organizationId;
  const user = await userRepo.findById(req.params.id, organizationId, ["role"]);

  if (!user) {
    throw new AppError("User not found", 404);
  }

  return sendResponse(
    res,
    200,
    "User retrieved successfully",
    toUserResponseDTO(user),
  );
});

export const createUser = asyncHandler(async (req, res) => {
  const organizationId = req.organizationId;
  const {
    name,
    username,
    email,
    phone,
    roleId,
    branchAccess = [],
    hasOrgWideAccess = false,
  } = req.body;
  const normalizedUsername = normalizeUsername(username || name);

  if (!normalizedUsername) {
    throw new AppError("Username is required", 400);
  }

  // 0. Prevent privilege escalation
  if (hasOrgWideAccess === true && !req.user.hasOrgWideAccess) {
    throw new AppError(
      "Access denied. You cannot grant organization-wide access.",
      403,
    );
  }

  // 1. Verify identity uniqueness
  const existingUser = await userRepo.findByEmailOrPhone(email, phone);
  if (existingUser) {
    throw new AppError("Email or phone number already registered", 400);
  }

  const existingUsername = await userRepo.findByUsername(
    normalizedUsername,
    organizationId,
  );
  if (existingUsername) {
    throw new AppError(
      "Username already exists. Please choose another username.",
      400,
    );
  }

  // 2. Validate caller's branch management authority & resolve branch names
  let formattedBranchAccess = [];
  if (branchAccess.length > 0) {
    const branchIds = branchAccess.map((b) => b.branchId);
    await assertCanManageBranches(req.user, branchIds, organizationId);

    const dbBranches = await Branch.find({
      _id: { $in: branchIds },
      organizationId,
    });
    if (dbBranches.length !== branchIds.length) {
      throw new AppError(
        "Invalid branch reference(s) for organization context",
        400,
      );
    }
    const branchMap = new Map(
      dbBranches.map((b) => [b._id.toString(), b.name]),
    );
    formattedBranchAccess = branchAccess.map((b) => ({
      branchId: b.branchId,
      branchName: b.branchName || branchMap.get(b.branchId.toString()) || "",
      isActive: b.isActive !== undefined ? b.isActive : true,
    }));
  }

  // 3. Role existence verification
  const role = await Role.findById(roleId).populate("permissions");
  if (!role) {
    throw new AppError("Role not found", 404);
  }

  // 4. Role delegation guard
  const adminRoleObj = await mongoose
    .model("Role")
    .findOne({ name: req.user.role.toLowerCase() })
    .populate("permissions");
  const adminPermissions = adminRoleObj
    ? adminRoleObj.permissions.map((p) => p.name)
    : [];
  const targetPermissions = role.permissions.map((p) => p.name);
  const hasAllPermissions = targetPermissions.every((p) =>
    adminPermissions.includes(p),
  );
  if (!hasAllPermissions) {
    throw new AppError(
      "Access denied. You cannot assign a role with permissions you do not possess.",
      403,
    );
  }

  // 5. Generate temporary password
  const tempPassword = crypto.randomBytes(8).toString("hex");

  // 6. Create user
  const user = await userRepo.create({
    name,
    username: normalizedUsername,
    email,
    phone,
    password: tempPassword, // will be hashed automatically by userSchema.pre("save")
    role: roleId,
    organizationId,
    branchAccess: formattedBranchAccess,
    hasOrgWideAccess,
    isFirstLogin: true,
    isVerified: false,
    status: "active",
  });

  // 7. Production-grade Credential Delivery: Dispatch welcome credentials via background queues
  try {
    await emailQueue.add("sendWelcomeCredentialsEmail", {
      email: user.email,
      name: user.name,
      username: user.username,
      tempPassword,
      phone: user.phone,
    });

    logger.info(
      `[SECURITY] WELCOME_CREDENTIALS_QUEUED for user ${user._id} (${user.email})`,
    );
  } catch (queueErr) {
    logger.warn(
      `[QUEUE_WARNING] Failed to queue welcome credentials for user ${user._id}: ${queueErr.message}`,
    );
  }

  return sendResponse(
    res,
    201,
    "User created successfully. Welcome credentials dispatched.",
    toUserResponseDTO(user),
  );
});

export const updateUser = asyncHandler(async (req, res) => {
  const organizationId = req.organizationId;
  const { name, username, phone, branchAccess, hasOrgWideAccess } = req.body;

  // Check if user exists
  const existingUser = await userRepo.findById(req.params.id, organizationId);
  if (!existingUser) {
    throw new AppError("User not found", 404);
  }

  // Validate user update for privilege escalation and branch authorization
  await validateUserUpdate(req.user, existingUser, req.body);

  // Self-modification of hasOrgWideAccess protection
  if (hasOrgWideAccess !== undefined) {
    if (req.params.id === req.user.id.toString()) {
      throw new AppError(
        "Self-modification of hasOrgWideAccess is prohibited.",
        403,
      );
    }
  }

  const updateData = {};
  // Cross-tenant branch references protection and branchName resolution
  if (branchAccess !== undefined) {
    if (branchAccess.length > 0) {
      const branchIds = branchAccess.map((b) => b.branchId);
      await assertCanManageBranches(req.user, branchIds, organizationId);
      const dbBranches = await mongoose.model("Branch").find({
        _id: { $in: branchIds },
        organizationId,
      });
      if (dbBranches.length !== branchIds.length) {
        throw new AppError(
          "Invalid branch reference(s) for organization context",
          400,
        );
      }
      const branchMap = new Map(
        dbBranches.map((b) => [b._id.toString(), b.name]),
      );
      updateData.branchAccess = branchAccess.map((b) => ({
        branchId: b.branchId,
        branchName: b.branchName || branchMap.get(b.branchId.toString()) || "",
        isActive: b.isActive !== undefined ? b.isActive : true,
      }));
    } else {
      updateData.branchAccess = [];
    }
  }

  if (name !== undefined) updateData.name = name;
  if (username !== undefined) {
    const normalized = normalizeUsername(username);
    if (!normalized) {
      throw new AppError("Username is required", 400);
    }
    const duplicateUsername = await userRepo.findByUsername(
      normalized,
      organizationId,
    );
    if (
      duplicateUsername &&
      duplicateUsername._id.toString() !== req.params.id.toString()
    ) {
      throw new AppError(
        "Username already exists. Please choose another username.",
        400,
      );
    }
    updateData.username = normalized;
  }
  if (phone !== undefined) updateData.phone = phone;
  if (hasOrgWideAccess !== undefined)
    updateData.hasOrgWideAccess = hasOrgWideAccess;

  const updatedUser = await userRepo.updateById(
    req.params.id,
    updateData,
    organizationId,
    req.user.id,
  );
  return sendResponse(
    res,
    200,
    "User updated successfully",
    toUserResponseDTO(updatedUser),
  );
});

export const updateUserStatus = asyncHandler(async (req, res) => {
  const organizationId = req.organizationId;
  const { status } = req.body;

  const updatedUser = await userService.updateUserStatus(
    req.params.id,
    status,
    organizationId,
    req.user.id,
  );

  return sendResponse(
    res,
    200,
    `User status updated to ${status} successfully`,
    toUserResponseDTO(updatedUser),
  );
});
