import { jest } from "@jest/globals";
import mongoose from "mongoose";
import jwt from "jsonwebtoken";
import bcrypt from "bcryptjs";
import crypto from "crypto";
import { AuthService } from "../../services/auth/auth.service.js";
import { AppError } from "../../utils/errors.js";
import { env } from "../../config/env.js";

describe("First-Login Activation & Scoped JWTs (Phase 7)", () => {
  let authService;
  let mockUserRepo;
  let mockRoleRepo;
  let mockSessionRepo;
  let userId;
  let mockUser;

  beforeEach(() => {
    jest.clearAllMocks();

    userId = new mongoose.Types.ObjectId().toString();

    mockUser = {
      _id: userId,
      email: "activation@example.com",
      phone: "+919999988888",
      password: "hashedpassword",
      isFirstLogin: true,
      isVerified: false,
      status: "active",
      failedLoginAttempts: 0,
      lockUntil: null,
      otp: "123456",
      otpExpires: new Date(Date.now() + 5 * 60 * 1000),
      comparePassword: jest.fn().mockResolvedValue(true),
      save: jest.fn().mockResolvedValue(true),
    };

    mockUserRepo = {
      findByEmailOrPhone: jest.fn(),
      findByEmail: jest.fn().mockResolvedValue(mockUser),
      findByPhone: jest.fn().mockResolvedValue(mockUser),
      findById: jest.fn().mockResolvedValue(mockUser),
    };

    mockRoleRepo = {
      findByName: jest.fn(),
    };

    mockSessionRepo = {
      create: jest.fn(),
      invalidateAllUserSessions: jest.fn(),
    };

    const mockStaffRepo = {
      findOne: jest.fn().mockResolvedValue({ status: "active" }),
    };

    authService = new AuthService(mockUserRepo, mockRoleRepo, mockSessionRepo, null, mockStaffRepo);
  });

  describe("Temporary Login", () => {
    it("First-login user receives requireActivation: true and activationToken, but no session", async () => {
      const result = await authService.login(
        "activation@example.com",
        "TempPassword123!",
        "127.0.0.1",
        "agent"
      );

      expect(result.requireActivation).toBe(true);
      expect(result.activationToken).toBeDefined();
      expect(result.accessToken).toBeUndefined();
      expect(result.refreshToken).toBeUndefined();
      expect(mockSessionRepo.create).not.toHaveBeenCalled();

      // Verify token payload and scope
      const decoded = jwt.verify(result.activationToken, env.JWT_SECRET);
      expect(decoded.sub).toBe(userId);
      expect(decoded.scope).toBe("activation");
    });
  });

  describe("Activation OTP & Verification", () => {
    it("should send activation OTP only for valid activation token", async () => {
      const activationToken = jwt.sign(
        { sub: userId, scope: "activation" },
        env.JWT_SECRET,
        { expiresIn: "5m" }
      );

      const result = await authService.sendActivationOTP(activationToken);
      expect(result.message).toBe("Activation OTP sent successfully");
      expect(mockUser.save).toHaveBeenCalled();
    });

    it("should reject activation OTP request if token has invalid scope", async () => {
      const invalidToken = jwt.sign(
        { sub: userId, scope: "access" },
        env.JWT_SECRET,
        { expiresIn: "5m" }
      );

      await expect(
        authService.sendActivationOTP(invalidToken)
      ).rejects.toThrow(new AppError("Access denied. Invalid token scope.", 401));
    });

    it("should verify OTP and return password-change token", async () => {
      const activationToken = jwt.sign(
        { sub: userId, scope: "activation" },
        env.JWT_SECRET,
        { expiresIn: "5m" }
      );

      await authService.sendActivationOTP(activationToken);
      mockUser.otp = crypto.createHash("sha256").update("123456").digest("hex");
      const result = await authService.verifyActivationOTP(activationToken, "123456");
      expect(result.message).toBe("OTP verified successfully");
      expect(result.passwordChangeToken).toBeDefined();

      const decoded = jwt.verify(result.passwordChangeToken, env.JWT_SECRET);
      expect(decoded.sub).toBe(userId);
      expect(decoded.scope).toBe("password-change");
    });

    it("should reject invalid OTP", async () => {
      const activationToken = jwt.sign(
        { sub: userId, scope: "activation" },
        env.JWT_SECRET,
        { expiresIn: "5m" }
      );

      await expect(
        authService.verifyActivationOTP(activationToken, "wrong")
      ).rejects.toThrow(new AppError("Invalid or expired OTP", 400));
    });
  });

  describe("Password Change & Activation Completion", () => {
    it("should change password with password-change scope token and complete activation", async () => {
      const pwdChangeToken = jwt.sign(
        { sub: userId, scope: "password-change" },
        env.JWT_SECRET,
        { expiresIn: "5m" }
      );

      const result = await authService.activateChangePassword(pwdChangeToken, "NewSecurePassword123!");
      expect(result.message).toBe("Password updated and account activated successfully");
      expect(mockUser.isFirstLogin).toBe(false);
      expect(mockUser.isVerified).toBe(true);
      expect(mockUser.failedLoginAttempts).toBe(0);
      expect(mockUser.lockUntil).toBeNull();
      expect(mockUser.password).toBe("NewSecurePassword123!");
    });

    it("should reject password change if token has activation scope", async () => {
      const activationToken = jwt.sign(
        { sub: userId, scope: "activation" },
        env.JWT_SECRET,
        { expiresIn: "5m" }
      );

      await expect(
        authService.activateChangePassword(activationToken, "NewSecurePassword123!")
      ).rejects.toThrow(new AppError("Access denied. Invalid token scope.", 401));
    });
  });
});
