import mongoose from "mongoose";
import { AppError } from "../../utils/errors.js";
import { AuthService } from "../../services/auth/auth.service.js";
import { sendResponse } from "../../utils/response.js";
import { asyncHandler } from "../../utils/errors.js";

const authService = new AuthService();

const setRefreshTokenCookie = (res, token) => {
  const cookieOptions = {
    httpOnly: true,
    secure: true,
    sameSite: "none",
    maxAge: 7 * 24 * 60 * 60 * 1000,
  };
  res.cookie("refreshToken", token, cookieOptions);
  // res.header("Access-Control-Allow-Credentials", "true");
};

export const register = asyncHandler(async (req, res) => {
  const result = await authService.register(req.body);
  return sendResponse(res, 201, "Registration successful. Please verify your email.", result);
});

export const login = asyncHandler(async (req, res) => {
  const ipAddress = req.ip || req.headers["x-forwarded-for"] || "Unknown";
  const deviceInfo = req.headers["user-agent"] || "Unknown";

  const result = await authService.login(
    req.body.email,
    req.body.password,
    ipAddress,
    deviceInfo
  );

  if (result.requireActivation) {
    return sendResponse(res, 200, "Activation required", {
      requireActivation: true,
      activationToken: result.activationToken,
    });
  }

  setRefreshTokenCookie(res, result.refreshToken);

  return sendResponse(res, 200, "Login successful", {
    accessToken: result.accessToken,
    refreshToken: result.refreshToken,
  });
});

export const sendActivationOTP = asyncHandler(async (req, res) => {
  const authHeader = req.headers.authorization;
  if (!authHeader || !authHeader.startsWith("Bearer ")) {
    throw new AppError("Access denied. No token provided.", 401);
  }
  const token = authHeader.split(" ")[1];
  const result = await authService.sendActivationOTP(token);
  return sendResponse(res, 200, result.message, result);
});

export const verifyActivationOTP = asyncHandler(async (req, res) => {
  const authHeader = req.headers.authorization;
  if (!authHeader || !authHeader.startsWith("Bearer ")) {
    throw new AppError("Access denied. No token provided.", 401);
  }
  const token = authHeader.split(" ")[1];
  const { otp } = req.body;
  const result = await authService.verifyActivationOTP(token, otp);
  return sendResponse(res, 200, result.message, result);
});

export const activateChangePassword = asyncHandler(async (req, res) => {
  const authHeader = req.headers.authorization;
  if (!authHeader || !authHeader.startsWith("Bearer ")) {
    throw new AppError("Access denied. No token provided.", 401);
  }
  const token = authHeader.split(" ")[1];
  const { password } = req.body;
  const result = await authService.activateChangePassword(token, password);
  return sendResponse(res, 200, result.message, result);
});

export const refresh = asyncHandler(async (req, res) => {
  const token = req.cookies?.refreshToken || req.body.refreshToken;
  const ipAddress = req.ip || req.headers["x-forwarded-for"] || "Unknown";
  const deviceInfo = req.headers["user-agent"] || "Unknown";

  const { accessToken, refreshToken } = await authService.refresh(token, ipAddress, deviceInfo);

  setRefreshTokenCookie(res, refreshToken);

  return sendResponse(res, 200, "Token refreshed successfully", { accessToken, refreshToken });
});

export const me = asyncHandler(async (req, res) => {
  const user = await mongoose.model("User").findById(req.user.id).populate("role");
  if (!user) {
    throw new AppError("User not found", 404);
  }

  let permissions = [];
  if (user.role) {
    const roleObj = await mongoose.model("Role").findById(user.role._id).populate("permissions");
    if (roleObj && roleObj.permissions) {
      permissions = roleObj.permissions.map((p) => p.name);
    }
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
  } else {
    branchAccess = branchAccess.filter(b => b.isActive);
  }

  const roleName = user.role?.name;
  const capitalizedRole = roleName ? roleName.charAt(0).toUpperCase() + roleName.slice(1).toLowerCase() : "";
  return sendResponse(res, 200, "Session details retrieved", {
    id: user._id,
    name: user.name,
    email: user.email,
    phone: user.phone,
    role: capitalizedRole,
    permissions,
    organizationId: user.organizationId,
    branchAccess,
    hasOrgWideAccess,
  });
});

export const logout = asyncHandler(async (req, res) => {
  const token = req.cookies?.refreshToken || req.body.refreshToken;
  if (token) {
    await authService.logout(token);
  }
  res.clearCookie("refreshToken");
  return sendResponse(res, 200, "Logged out successfully");
});

export const verifyEmail = asyncHandler(async (req, res) => {
  const result = await authService.verifyEmail(req.query.token);
  return sendResponse(res, 200, "Email verified successfully", result);
});

export const forgotPassword = asyncHandler(async (req, res) => {
  const result = await authService.forgotPassword(req.body.email);
  return sendResponse(res, 200, "If registered, a password reset link has been sent.", result);
});

export const resetPassword = asyncHandler(async (req, res) => {
  const result = await authService.resetPassword(req.params.token, req.body.password);
  return sendResponse(res, 200, "Password reset successfully", result);
});

export const sendOTP = asyncHandler(async (req, res) => {
  const result = await authService.sendOTP(req.body.phone);
  return sendResponse(res, 200, "OTP sent successfully", result);
});

export const verifyOTP = asyncHandler(async (req, res) => {
  const ipAddress = req.ip || req.headers["x-forwarded-for"] || "Unknown";
  const deviceInfo = req.headers["user-agent"] || "Unknown";

  const { user, accessToken, refreshToken } = await authService.verifyOTP(
    req.body.phone,
    req.body.otp,
    ipAddress,
    deviceInfo
  );

  setRefreshTokenCookie(res, refreshToken);
  return sendResponse(res, 200, "OTP verified and logged in", { user, accessToken });
});

export const logoutAllDevices = asyncHandler(async (req, res) => {
  await authService.logoutAllDevices(req.user.id);
  res.clearCookie("refreshToken");
  return sendResponse(res, 200, "Logged out from all devices");
});
