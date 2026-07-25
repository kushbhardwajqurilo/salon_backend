import jwt from "jsonwebtoken";
import crypto from "crypto";
import bcrypt from "bcryptjs";
import { UserRepository } from "../../repositories/users/user.repository.js";
import { RoleRepository } from "../../repositories/roles/role.repository.js";
import { SessionRepository } from "../../repositories/auth/session.repository.js";
import { AppError } from "../../utils/errors.js";
import { env } from "../../config/env.js";
import { emailQueue, smsQueue } from "../../queues/client.js";

export class AuthService {
  constructor(userRepo = null, roleRepo = null, sessionRepo = null) {
    this.userRepo = userRepo || new UserRepository();
    this.roleRepo = roleRepo || new RoleRepository();
    this.sessionRepo = sessionRepo || new SessionRepository();
  }

  generateAccessToken(user) {
    return jwt.sign(
      {
        id: user._id,
        email: user.email,
        role: user.role?.name || "",
      },
      env.JWT_SECRET,
      { expiresIn: env.JWT_ACCESS_EXPIRATION }
    );
  }

  generateRefreshToken(user) {
    return jwt.sign(
      {
        id: user._id,
      },
      env.JWT_REFRESH_SECRET,
      { expiresIn: env.JWT_REFRESH_EXPIRATION }
    );
  }

  async register(data) {
    const { name, email, phone, password, roleName = "customer" } = data;

    const existingUser = await this.userRepo.findByEmailOrPhone(email, phone);
    if (existingUser) {
      throw new AppError("Email or phone number already registered", 400);
    }

    const role = await this.roleRepo.findByName(roleName);
    if (!role) {
      throw new AppError(`Role '${roleName}' does not exist. Please seed roles first.`, 400);
    }

    const verificationToken = crypto.randomBytes(32).toString("hex");
    const verificationExpires = new Date(Date.now() + 24 * 60 * 60 * 1000);

    const user = await this.userRepo.create({
      name,
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

    return { id: user._id, name: user.name, email: user.email };
  }

  async login(email, password, ipAddress, deviceInfo) {
    const user = await this.userRepo.findByEmail(email);
    if (!user) {
      throw new AppError("Invalid email or password", 401);
    }

    if (user.status === "suspended") {
      throw new AppError("Your account has been suspended.", 403);
    }

    if (user.status === "locked") {
      if (user.lockUntil && user.lockUntil > new Date()) {
        const remainingMinutes = Math.ceil((user.lockUntil - new Date()) / 60000);
        throw new AppError(`Account locked. Try again in ${remainingMinutes} minutes.`, 403);
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
      }
      await user.save();
      throw new AppError("Invalid email or password", 401);
    }

    user.failedLoginAttempts = 0;
    user.lockUntil = null;

    const accessToken = this.generateAccessToken(user);
    const refreshToken = this.generateRefreshToken(user);

    const salt = await bcrypt.genSalt(10);
    user.refreshToken = await bcrypt.hash(refreshToken, salt);
    await user.save();

    return {
      accessToken,
      refreshToken,
    };
  }

  async refresh(token, ipAddress, deviceInfo) {
    console.log("token", token);
    if (!token) {
      throw new AppError("Session not found or invalid", 401);
    }

    try {
      const decoded = jwt.verify(token, env.JWT_REFRESH_SECRET);
      const user = await this.userRepo.findById(decoded.id);
      console.log("decode", decoded)
      console.log("user", user)
      if (!user || user.status !== "active" || !user.refreshToken) {
        throw new AppError("Session not found or invalid", 401);
      }

      const isMatch = await bcrypt.compare(token, user.refreshToken);
      console.log("isMatch", isMatch);
      if (!isMatch) {
        user.refreshToken = null;
        await user.save();
        throw new AppError("Session not found or invalid", 401);
      }

      const newAccessToken = this.generateAccessToken(user);
      const newRefreshToken = this.generateRefreshToken(user);

      const salt = await bcrypt.genSalt(10);
      user.refreshToken = await bcrypt.hash(newRefreshToken, salt);
      await user.save();

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
      const decoded = jwt.verify(token, env.JWT_REFRESH_SECRET);
      const user = await this.userRepo.findById(decoded.id);
      if (user) {
        user.refreshToken = null;
        await user.save();
      }
    } catch (err) {
      // Ignore errors on logout
    }
  }

  async logoutAllDevices(userId) {
    const user = await this.userRepo.findById(userId);
    if (user) {
      user.refreshToken = null;
      await user.save();
    }
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
      throw new AppError("If that email is registered, a reset link will be sent.", 200);
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
    if (!user || !user.otp || user.otp !== otp || user.otpExpires < new Date()) {
      throw new AppError("Invalid or expired OTP", 400);
    }

    user.otp = null;
    user.otpExpires = null;
    user.isVerified = true;
    await user.save();

    const accessToken = this.generateAccessToken(user);
    const refreshToken = this.generateRefreshToken();
    const expiresAt = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000);

    await this.sessionRepo.create({
      user: user._id,
      refreshToken,
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
}
