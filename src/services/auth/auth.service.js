import jwt from "jsonwebtoken";
import crypto from "crypto";
import bcrypt from "bcryptjs";
import { UserRepository } from "../../repositories/users/user.repository.js";
import { StaffRepository } from "../../repositories/staff/staff.repository.js";
import { RoleRepository } from "../../repositories/roles/role.repository.js";
import { SessionRepository } from "../../repositories/auth/session.repository.js";
import { AppError } from "../../utils/errors.js";
import { env } from "../../config/env.js";
import { emailQueue, smsQueue } from "../../queues/client.js";
import {
  normalizeUsername as normalizeUserUsername,
  isValidUsername,
} from "../../utils/userIdentity.js";

import { logger } from "../../utils/logger.js";
import { AuditLogService } from "../audit/auditLog.service.js";

export class AuthService {
  constructor(userRepo = null, roleRepo = null, sessionRepo = null, auditLogService = null, staffRepo = null) {
    this.userRepo = userRepo || new UserRepository();
    this.roleRepo = roleRepo || new RoleRepository();
    this.sessionRepo = sessionRepo || new SessionRepository();
    this.auditLogService = auditLogService || new AuditLogService();
    this.staffRepo = staffRepo || new StaffRepository();
  }

  async validateStaffLinkage(user) {
    const roleName = user.role?.name?.toLowerCase() || "";
    const adminRoles = ["owner", "admin", "super_admin", "superadmin"];
    if (adminRoles.includes(roleName) || user.hasOrgWideAccess === true) {
      return;
    }

    let staff = null;
    if (typeof this.staffRepo.findOne === "function") {
      try {
        staff = await this.staffRepo.findOne(
          { userId: user._id, isDeleted: false },
          user.organizationId
        );
      } catch (err) {
        staff = null;
      }
    }

    if (!staff || staff.status !== "active") {
      throw new AppError("This account is not linked to an active staff profile. Please contact an administrator.", 403);
    }
  }

  normalizeUsername(value) {
    return normalizeUserUsername(value);
  }

  generateAccessToken(user) {
    return jwt.sign(
      {
        id: user._id,
        email: user.email,
        role: user.role?.name || "",
      },
      env.JWT_SECRET,
      { expiresIn: env.JWT_ACCESS_EXPIRATION },
    );
  }

  generateRefreshToken(user) {
    return jwt.sign(
      {
        id: user._id,
      },
      env.JWT_REFRESH_SECRET,
      { expiresIn: env.JWT_REFRESH_EXPIRATION },
    );
  }

  async register(data) {
    const {
      name,
      email,
      phone,
      password,
      roleName = "customer",
      username,
    } = data;

    const normalizedUsername = normalizeUserUsername(username || name);
    if (!isValidUsername(normalizedUsername)) {
      throw new AppError(
        "Username must be between 3 and 30 characters and contain only letters, numbers, dots, underscores, or hyphens",
        400,
      );
    }

    const existingUser = await this.userRepo.findByEmailOrPhone(email, phone);
    if (existingUser) {
      throw new AppError("Email or phone number already registered", 400);
    }

    if (typeof this.userRepo.findByUsername === "function") {
      const existingUsername =
        await this.userRepo.findByUsername(normalizedUsername);
      if (existingUsername) {
        throw new AppError(
          "Username already exists. Please choose another username.",
          400,
        );
      }
    }

    const role = await this.roleRepo.findByName(roleName);
    if (!role) {
      throw new AppError(
        `Role '${roleName}' does not exist. Please seed roles first.`,
        400,
      );
    }

    const verificationToken = crypto.randomBytes(32).toString("hex");
    const verificationExpires = new Date(Date.now() + 24 * 60 * 60 * 1000);

    const user = await this.userRepo.create({
      name,
      username: normalizedUsername,
      email,
      phone,
      password,
      role: role._id,
      emailVerificationToken: verificationToken,
      emailVerificationExpires: verificationExpires,
    });

    await emailQueue.add("sendVerificationEmail", {
      email: user.email,
      token: verificationToken,
      name: user.name,
    });

    return {
      id: user._id,
      username: user.username,
      name: user.name,
      email: user.email,
    };
  }

  async login(identifier, password, ipAddress, deviceInfo) {
    const normalizedIdentifier = normalizeUserUsername(identifier);
    let user = null;
    if (typeof this.userRepo.findByEmailOrUsername === "function") {
      user = await this.userRepo.findByEmailOrUsername(
        identifier.includes("@") ? identifier : normalizedIdentifier,
      );
    } else if (typeof this.userRepo.findByEmail === "function") {
      user = await this.userRepo.findByEmail(
        identifier.includes("@") ? identifier : normalizedIdentifier,
      );
    }
    if (!user) {
      throw new AppError("Invalid email or password", 401);
    }

    if (user.status === "suspended") {
      throw new AppError("Your account has been suspended.", 403);
    }

    if (user.status === "locked") {
      if (user.lockUntil && user.lockUntil > new Date()) {
        const remainingMinutes = Math.ceil(
          (user.lockUntil - new Date()) / 60000,
        );
        throw new AppError(
          `Account locked. Try again in ${remainingMinutes} minutes.`,
          403,
        );
      }
      user.status = "active";
      user.failedLoginAttempts = 0;
      user.lockUntil = null;
      await user.save();
    }

    const isMatch = await user.comparePassword(password);
    if (!isMatch) {
      user.failedLoginAttempts += 1;
      if (user.failedLoginAttempts >= 5) {
        user.status = "locked";
        user.lockUntil = new Date(Date.now() + 15 * 60 * 1000);
        await this.sessionRepo.invalidateAllUserSessions(user._id);
      }
      await user.save();
      throw new AppError("Invalid email or password", 401);
    }

    await this.validateStaffLinkage(user);

    if (user.isFirstLogin === true) {
      const activationToken = jwt.sign(
        {
          sub: user._id,
          scope: "activation",
        },
        env.JWT_SECRET,
        { expiresIn: "5m" },
      );
      return {
        requireActivation: true,
        activationToken,
      };
    }

    user.failedLoginAttempts = 0;
    user.lockUntil = null;

    const accessToken = this.generateAccessToken(user);
    const refreshToken = this.generateRefreshToken(user);

    const hashedToken = crypto
      .createHash("sha256")
      .update(refreshToken)
      .digest("hex");
    const expiresAt = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000);
    await this.sessionRepo.create({
      user: user._id,
      refreshToken: hashedToken,
      ipAddress,
      deviceInfo,
      expiresAt,
    });

    return {
      accessToken,
      refreshToken,
    };
  }

  async refresh(token, ipAddress, deviceInfo) {
    if (!token) {
      throw new AppError("Session not found or invalid", 401);
    }

    try {
      const session = await this.sessionRepo.findByToken(token);
      if (!session || !session.user || session.user.status !== "active") {
        throw new AppError("Session not found or invalid", 401);
      }

      if (session.expiresAt && session.expiresAt < new Date()) {
        session.isValid = false;
        await session.save();
        throw new AppError("Session not found or invalid", 401);
      }

      const user = session.user;
      await this.validateStaffLinkage(user);
      const newAccessToken = this.generateAccessToken(user);
      const newRefreshToken = this.generateRefreshToken(user);
      const newHashedToken = crypto
        .createHash("sha256")
        .update(newRefreshToken)
        .digest("hex");

      session.refreshToken = newHashedToken;
      session.expiresAt = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000);
      if (ipAddress) session.ipAddress = ipAddress;
      if (deviceInfo) session.deviceInfo = deviceInfo;
      await session.save();

      return {
        accessToken: newAccessToken,
        refreshToken: newRefreshToken,
      };
    } catch (err) {
      throw new AppError("Session not found or invalid", 401);
    }
  }

  async logout(token) {
    if (!token) return;
    try {
      await this.sessionRepo.invalidateSession(token);
    } catch (err) {
      // Ignore errors on logout
    }
  }

  async logoutAllDevices(userId) {
    await this.sessionRepo.invalidateAllUserSessions(userId);
  }

  async verifyEmail(token) {
    const user = await this.userRepo.findByVerificationToken(token);
    if (!user) {
      throw new AppError("Invalid or expired verification token", 400);
    }

    user.isVerified = true;
    user.emailVerificationToken = null;
    user.emailVerificationExpires = null;
    await user.save();

    return { message: "Email verified successfully" };
  }

  async forgotPassword(email) {
    const user = await this.userRepo.findByEmail(email);
    if (!user) {
      throw new AppError(
        "If that email is registered, a reset link will be sent.",
        200,
      );
    }

    const resetToken = crypto.randomBytes(32).toString("hex");
    user.passwordResetToken = resetToken;
    user.passwordResetExpires = new Date(Date.now() + 10 * 60 * 1000);
    await user.save();

    await emailQueue.add("sendPasswordResetEmail", {
      email: user.email,
      token: resetToken,
      name: user.name,
    });

    return { message: "Reset token sent to email" };
  }

  async resetPassword(token, newPassword) {
    const user = await this.userRepo.findByResetToken(token);
    if (!user) {
      throw new AppError("Invalid or expired password reset token", 400);
    }

    user.password = newPassword;
    user.passwordResetToken = null;
    user.passwordResetExpires = null;
    user.failedLoginAttempts = 0;
    user.status = "active";
    await user.save();

    await this.sessionRepo.invalidateAllUserSessions(user._id);

    return { message: "Password updated successfully" };
  }

  async sendOTP(phone) {
    const user = await this.userRepo.findByPhone(phone);
    if (!user) {
      throw new AppError("Phone number not registered", 404);
    }

    const otp = Math.floor(100000 + Math.random() * 900000).toString();
    user.otp = otp;
    user.otpExpires = new Date(Date.now() + 5 * 60 * 1000);
    await user.save();

    await smsQueue.add("sendOtpSMS", {
      phone: user.phone,
      otp,
    });

    return { message: "OTP sent successfully" };
  }

  async verifyOTP(phone, otp, ipAddress, deviceInfo) {
    const user = await this.userRepo.findByPhone(phone);
    if (
      !user ||
      !user.otp ||
      user.otp !== otp ||
      user.otpExpires < new Date()
    ) {
      throw new AppError("Invalid or expired OTP", 400);
    }

    user.otp = null;
    user.otpExpires = null;
    user.isVerified = true;
    await user.save();

    const accessToken = this.generateAccessToken(user);
    const refreshToken = this.generateRefreshToken(user);
    const hashedToken = crypto
      .createHash("sha256")
      .update(refreshToken)
      .digest("hex");
    const expiresAt = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000);

    await this.sessionRepo.create({
      user: user._id,
      refreshToken: hashedToken,
      ipAddress,
      deviceInfo,
      expiresAt,
    });

    return {
      user: {
        id: user._id,
        name: user.name,
        email: user.email,
        role: user.role?.name,
        isVerified: user.isVerified,
      },
      accessToken,
      refreshToken,
    };
  }

  async sendActivationOTP(token) {
    const decoded = jwt.verify(token, env.JWT_SECRET);
    if (decoded.scope !== "activation") {
      throw new AppError("Access denied. Invalid token scope.", 401);
    }

    const user = await this.userRepo.findById(decoded.sub);
    if (!user) {
      throw new AppError("User not found", 404);
    }

    if (user.status === "suspended") {
      throw new AppError("Your account has been suspended.", 403);
    }

    if (
      user.status === "locked" &&
      user.lockUntil &&
      user.lockUntil > new Date()
    ) {
      throw new AppError("Account locked.", 403);
    }

    // Rate limiting: 60s resend cooldown
    if (user.otpResendUntil && user.otpResendUntil > new Date()) {
      const waitSeconds = Math.ceil((user.otpResendUntil - new Date()) / 1000);
      throw new AppError(
        `Too many OTP requests. Please wait ${waitSeconds} seconds before requesting a new OTP.`,
        429,
      );
    }

    const rawOtp = Math.floor(100000 + Math.random() * 900000).toString();
    const hashedOtp = crypto
      .createHash("sha256")
      .update(rawOtp)
      .digest("hex");

    user.otp = hashedOtp;
    user.otpExpires = new Date(Date.now() + 5 * 60 * 1000);
    user.otpResendUntil = new Date(Date.now() + 60 * 1000);
    user.otpAttempts = 0;
    await user.save();

    try {
      await smsQueue.add("sendOtpSMS", {
        phone: user.phone,
        otp: rawOtp,
      });
    } catch (queueErr) {
      // Log queue warning if Redis queue worker unavailable
    }

    logger.info(`[SECURITY] OTP_SENT for user ${user._id}`);

    return {
      success: true,
      message: "Activation OTP sent successfully",
      expiresIn: 300,
      resendAfter: 60,
    };
  }

  async verifyActivationOTP(token, otp) {
    const decoded = jwt.verify(token, env.JWT_SECRET);
    if (decoded.scope !== "activation") {
      throw new AppError("Access denied. Invalid token scope.", 401);
    }

    const user = await this.userRepo.findById(decoded.sub);
    if (!user) {
      throw new AppError("User not found", 404);
    }

    if (user.status === "suspended") {
      throw new AppError("Your account has been suspended.", 403);
    }

    if (
      user.status === "locked" &&
      user.lockUntil &&
      user.lockUntil > new Date()
    ) {
      throw new AppError("Account locked.", 403);
    }

    if (!user.otp || !user.otpExpires || user.otpExpires < new Date()) {
      throw new AppError("Invalid or expired OTP", 400);
    }

    // Check maximum attempts
    if (user.otpAttempts >= 5) {
      user.otp = null;
      user.otpExpires = null;
      user.otpResendUntil = null;
      await user.save();
      throw new AppError(
        "Too many invalid OTP verification attempts. Please request a new OTP.",
        429,
      );
    }

    const candidateHash = crypto
      .createHash("sha256")
      .update(otp)
      .digest("hex");

    if (candidateHash !== user.otp) {
      user.otpAttempts = (user.otpAttempts || 0) + 1;
      if (user.otpAttempts >= 5) {
        user.otp = null;
        user.otpExpires = null;
        user.otpResendUntil = null;
      }
      await user.save();

      logger.warn(`[SECURITY] OTP_VERIFICATION_FAILED for user ${user._id}, attempts: ${user.otpAttempts}`);

      throw new AppError("Invalid or expired OTP", 400);
    }

    // Successful OTP verification
    user.otp = null;
    user.otpExpires = null;
    user.otpResendUntil = null;
    user.otpAttempts = 0;
    await user.save();

    logger.info(`[SECURITY] OTP_VERIFIED for user ${user._id}`);

    const passwordChangeToken = jwt.sign(
      {
        sub: user._id,
        scope: "password-change",
      },
      env.JWT_SECRET,
      { expiresIn: "5m" },
    );

    return {
      success: true,
      message: "OTP verified successfully",
      passwordChangeToken,
    };
  }

  async activateChangePassword(token, newPassword, ipAddress = "Unknown", deviceInfo = "Unknown") {
    const decoded = jwt.verify(token, env.JWT_SECRET);
    if (decoded.scope !== "password-change") {
      throw new AppError("Access denied. Invalid token scope.", 401);
    }

    const user = await this.userRepo.findById(decoded.sub, null, ["role"]);
    if (!user) {
      throw new AppError("User not found", 404);
    }

    if (user.status === "suspended") {
      throw new AppError("Your account has been suspended.", 403);
    }

    if (
      user.status === "locked" &&
      user.lockUntil &&
      user.lockUntil > new Date()
    ) {
      throw new AppError("Account locked.", 403);
    }

    await this.validateStaffLinkage(user);

    user.password = newPassword;
    user.isFirstLogin = false;
    user.isVerified = true;
    user.failedLoginAttempts = 0;
    user.lockUntil = null;
    user.otp = null;
    user.otpExpires = null;
    user.otpAttempts = 0;
    user.otpResendUntil = null;
    await user.save();

    logger.info(`[SECURITY] PASSWORD_ACTIVATION_COMPLETED for user ${user._id}`);

    // Option A: Establish normal authenticated session
    const accessToken = this.generateAccessToken(user);
    const refreshToken = this.generateRefreshToken(user);

    const hashedToken = crypto
      .createHash("sha256")
      .update(refreshToken)
      .digest("hex");
    const expiresAt = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000);

    await this.sessionRepo.create({
      user: user._id,
      refreshToken: hashedToken,
      ipAddress,
      deviceInfo,
      expiresAt,
    });

    return {
      success: true,
      message: "Password updated and account activated successfully",
      accessToken,
      refreshToken,
    };
  }
}
