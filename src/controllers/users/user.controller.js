import mongoose from "mongoose";
import crypto from "crypto";
import { UserRepository } from "../../repositories/users/user.repository.js";
import { sendResponse } from "../../utils/response.js";
import { asyncHandler, AppError } from "../../utils/errors.js";
import { toUserResponseDTO } from "../../utils/userResponse.js";

const userRepo = new UserRepository();

export const listUsers = asyncHandler(async (req, res) => {
  const organizationId = req.organizationId;
  const { page, limit, sort, search } = req.query;

  const options = {
    page,
    limit,
    sort,
    search,
    searchFields: ["name", "email", "phone"],
  };

  const result = await userRepo.find({}, options, organizationId);
  const serializedUsers = result.data.map(user => toUserResponseDTO(user));

  return sendResponse(res, 200, "Users listed successfully", serializedUsers, result.meta);
});

export const getUserById = asyncHandler(async (req, res) => {
  const organizationId = req.organizationId;
  const user = await userRepo.findById(req.params.id, organizationId, ["role"]);
  
  if (!user) {
    throw new AppError("User not found", 404);
  }

  return sendResponse(res, 200, "User retrieved successfully", toUserResponseDTO(user));
});

export const createUser = asyncHandler(async (req, res) => {
  const organizationId = req.organizationId;
  const { name, email, phone, roleId, branchAccess = [] } = req.body;

  // 1. Verify email/phone uniqueness
  const existingUser = await userRepo.findByEmailOrPhone(email, phone);
  if (existingUser) {
    throw new AppError("Email or phone number already registered", 400);
  }

  // 2. Cross-tenant branch references protection
  if (branchAccess.length > 0) {
    const branchIds = branchAccess.map(b => b.branchId);
    const dbBranches = await mongoose.model("Branch").find({
      _id: { $in: branchIds },
      organizationId,
    });
    if (dbBranches.length !== branchIds.length) {
      throw new AppError("Invalid branch reference(s) for organization context", 400);
    }
  }

  // 3. Role existence verification
  const role = await mongoose.model("Role").findById(roleId);
  if (!role) {
    throw new AppError("Role not found", 404);
  }

  // 4. Generate temporary password
  const tempPassword = crypto.randomBytes(8).toString("hex");

  // 5. Create user
  const user = await userRepo.create({
    name,
    email,
    phone,
    password: tempPassword, // will be hashed automatically by userSchema.pre("save")
    role: roleId,
    organizationId,
    branchAccess,
    isFirstLogin: true,
    isVerified: false,
    status: "active",
  });

  return sendResponse(res, 201, "User created successfully", toUserResponseDTO(user));
});

export const updateUser = asyncHandler(async (req, res) => {
  const organizationId = req.organizationId;
  const { name, phone, branchAccess } = req.body;

  // Check if user exists
  const existingUser = await userRepo.findById(req.params.id, organizationId);
  if (!existingUser) {
    throw new AppError("User not found", 404);
  }

  // Cross-tenant branch references protection
  if (branchAccess && branchAccess.length > 0) {
    const branchIds = branchAccess.map(b => b.branchId);
    const dbBranches = await mongoose.model("Branch").find({
      _id: { $in: branchIds },
      organizationId,
    });
    if (dbBranches.length !== branchIds.length) {
      throw new AppError("Invalid branch reference(s) for organization context", 400);
    }
  }

  const updateData = {};
  if (name !== undefined) updateData.name = name;
  if (phone !== undefined) updateData.phone = phone;
  if (branchAccess !== undefined) updateData.branchAccess = branchAccess;

  const updatedUser = await userRepo.updateById(req.params.id, updateData, organizationId, req.user.id);
  return sendResponse(res, 200, "User updated successfully", toUserResponseDTO(updatedUser));
});
