import { AuthService } from "../../services/auth/auth.service.js";
import { sendResponse } from "../../utils/response.js";
import { asyncHandler } from "../../utils/errors.js";

const authService = new AuthService();

const setRefreshTokenCookie = (res, token) => {
  const cookieOptions = {
    httpOnly: true,
    secure: process.env.NODE_ENV === "production",
    sameSite: "strict",
    maxAge: 7 * 24 * 60 * 60 * 1000,
  };
  res.cookie("refreshToken", token, cookieOptions);
};

export const register = asyncHandler(async (req, res) => {
  const result = await authService.register(req.body);
  return sendResponse(res, 201, "Registration successful. Please verify your email.", result);
});

export const login = asyncHandler(async (req, res) => {
  const ipAddress = req.ip || req.headers["x-forwarded-for"] || "Unknown";
  const deviceInfo = req.headers["user-agent"] || "Unknown";

  const { user, accessToken, refreshToken } = await authService.login(
    req.body.email,
    req.body.password,
    ipAddress,
    deviceInfo
  );

  setRefreshTokenCookie(res, refreshToken);

  return sendResponse(res, 200, "Login successful", { user, accessToken });
});

export const refresh = asyncHandler(async (req, res) => {
  const token = req.cookies?.refreshToken || req.body.refreshToken;
  const ipAddress = req.ip || req.headers["x-forwarded-for"] || "Unknown";
  const deviceInfo = req.headers["user-agent"] || "Unknown";

  const { accessToken, refreshToken } = await authService.refresh(token, ipAddress, deviceInfo);

  setRefreshTokenCookie(res, refreshToken);

  return sendResponse(res, 200, "Token refreshed successfully", { accessToken });
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
