import jwt from "jsonwebtoken";
import mongoose from "mongoose";
import { env } from "../config/env.js";
import { AppError } from "../utils/errors.js";
import { UserRepository } from "../repositories/users/user.repository.js";
import { asyncHandler } from "../utils/errors.js";

const userRepo = new UserRepository();

export const authenticate = asyncHandler(async (req, res, next) => {
  console.log(`🔑 [AUTH ENTRY] ${req.method} ${req.originalUrl} | Header: ${req.headers.authorization ? "Present" : "Missing"}`);
  let token;

  if (req.headers.authorization && req.headers.authorization.startsWith("Bearer")) {
    token = req.headers.authorization.split(" ")[1];
  } else if (req.cookies?.accessToken) {
    token = req.cookies.accessToken;
  }

  if (!token) {
    throw new AppError("Access denied. No token provided.", 401);
  }

  try {
    const decoded = jwt.verify(token, env.JWT_SECRET);

    if (decoded.scope === "activation" || decoded.scope === "password-change") {
      throw new AppError("Access denied. Invalid token scope.", 401);
    }

    // Double check if user exists and is active
    const user = await userRepo.findById(decoded.id);
    if (!user) {
      throw new AppError("The user belonging to this token no longer exists.", 401);
    }

    if (user.status !== "active") {
      throw new AppError("Your account has been deactivated or locked.", 403);
    }

    let branchAccess = user.branchAccess || [];
    const hasOrgWideAccess = user.hasOrgWideAccess || false;

    if (hasOrgWideAccess) {
      const dbBranches = await mongoose.model("Branch").find({ organizationId: user.organizationId });
      branchAccess = dbBranches.map(b => ({
        branchId: b._id,
        branchName: b.name,
        isActive: b.isActive
      }));
    }

    let roleName = "owner";
    if (user.role && typeof user.role === "object" && user.role.name) {
      roleName = user.role.name;
    } else if (user.role && mongoose.Types.ObjectId.isValid(user.role)) {
      const dbRole = await mongoose.model("Role").findById(user.role);
      if (dbRole) roleName = dbRole.name;
    } else if (typeof user.role === "string") {
      roleName = user.role;
    }

    // Attach user context to request
    req.user = {
      id: user._id,
      email: user.email,
      role: roleName,
      organizationId: user.organizationId,
      branchAccess,
      hasOrgWideAccess,
    };

    next();
  } catch (error) {
    if (error.name === "TokenExpiredError") {
      throw new AppError("Your token has expired! Please log in again.", 401);
    }
    if (error instanceof AppError) {
      throw error;
    }
    throw new AppError("Invalid or expired token.", 401);
  }
});
