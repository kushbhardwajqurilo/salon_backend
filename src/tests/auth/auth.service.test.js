import { jest } from "@jest/globals";
import { AuthService } from "../../services/auth/auth.service.js";
import { AppError } from "../../utils/errors.js";
import jwt from "jsonwebtoken";
import crypto from "crypto";

describe("AuthService", () => {
  let authService;
  let mockUserRepo;
  let mockRoleRepo;
  let mockSessionRepo;

  let mockStaffRepo;

  beforeEach(() => {
    mockUserRepo = {
      findByEmailOrPhone: jest.fn(),
      findByEmail: jest.fn(),
      findByPhone: jest.fn(),
      create: jest.fn(),
      findById: jest.fn(),
    };

    mockRoleRepo = {
      findByName: jest.fn(),
    };

    mockSessionRepo = {
      create: jest.fn(),
      findByToken: jest.fn(),
      invalidateAllUserSessions: jest.fn(),
      invalidateSession: jest.fn(),
    };

    mockStaffRepo = {
      findOne: jest.fn().mockResolvedValue({ status: "active" }),
    };

    authService = new AuthService(mockUserRepo, mockRoleRepo, mockSessionRepo, null, mockStaffRepo);
  });

  describe("register", () => {
    it("should throw an error if the email/phone is already registered", async () => {
      mockUserRepo.findByEmailOrPhone.mockResolvedValue({ id: "existing-user" });

      await expect(
        authService.register({
          name: "Test User",
          email: "test@example.com",
          phone: "+1234567890",
          password: "Password123!",
        })
      ).rejects.toThrow(new AppError("Email or phone number already registered", 400));
    });

    it("should throw an error if the specified role does not exist", async () => {
      mockUserRepo.findByEmailOrPhone.mockResolvedValue(null);
      mockRoleRepo.findByName.mockResolvedValue(null);

      await expect(
        authService.register({
          name: "Test User",
          email: "test@example.com",
          phone: "+1234567890",
          password: "Password123!",
          roleName: "custom_role",
        })
      ).rejects.toThrow(new AppError("Role 'custom_role' does not exist. Please seed roles first.", 400));
    });
  });

  describe("login", () => {
    it("should throw an error if user does not exist", async () => {
      mockUserRepo.findByEmail.mockResolvedValue(null);

      await expect(
        authService.login("test@example.com", "Password123!", "127.0.0.1", "agent")
      ).rejects.toThrow(new AppError("Invalid email or password", 401));
    });

    it("should lock account after 5 failed login attempts and invalidate sessions", async () => {
      const mockUser = {
        _id: "user-id",
        email: "test@example.com",
        password: "hashedpassword",
        status: "active",
        failedLoginAttempts: 4,
        comparePassword: jest.fn().mockResolvedValue(false),
        save: jest.fn().mockResolvedValue(true),
      };

      mockUserRepo.findByEmail.mockResolvedValue(mockUser);

      await expect(
        authService.login("test@example.com", "WrongPassword", "127.0.0.1", "agent")
      ).rejects.toThrow(new AppError("Invalid email or password", 401));

      expect(mockUser.failedLoginAttempts).toBe(5);
      expect(mockUser.status).toBe("locked");
      expect(mockUser.lockUntil).toBeDefined();
      expect(mockSessionRepo.invalidateAllUserSessions).toHaveBeenCalledWith("user-id");
    });

    it("should not lock account or invalidate sessions on failed attempts 1-4", async () => {
      const mockUser = {
        _id: "user-id",
        email: "test@example.com",
        password: "hashedpassword",
        status: "active",
        failedLoginAttempts: 2,
        comparePassword: jest.fn().mockResolvedValue(false),
        save: jest.fn().mockResolvedValue(true),
      };

      mockUserRepo.findByEmail.mockResolvedValue(mockUser);

      await expect(
        authService.login("test@example.com", "WrongPassword", "127.0.0.1", "agent")
      ).rejects.toThrow(new AppError("Invalid email or password", 401));

      expect(mockUser.failedLoginAttempts).toBe(3);
      expect(mockUser.status).toBe("active");
      expect(mockSessionRepo.invalidateAllUserSessions).not.toHaveBeenCalled();
    });

    it("should successfully log in and create hashed token in session", async () => {
      const mockUser = {
        _id: "user-id",
        email: "test@example.com",
        password: "hashedpassword",
        status: "active",
        comparePassword: jest.fn().mockResolvedValue(true),
        save: jest.fn().mockResolvedValue(true),
      };

      mockUserRepo.findByEmail.mockResolvedValue(mockUser);

      const result = await authService.login("test@example.com", "Password123!", "127.0.0.1", "agent");
      expect(result.accessToken).toBeDefined();
      expect(result.refreshToken).toBeDefined();

      // Verify raw token is NOT stored directly in Session, but hashed
      const expectedHash = crypto.createHash("sha256").update(result.refreshToken).digest("hex");
      expect(mockSessionRepo.create).toHaveBeenCalledWith(
        expect.objectContaining({
          user: "user-id",
          refreshToken: expectedHash,
        })
      );
    });
  });

  describe("OTP Authentication", () => {
    it("should successfully verify OTP, login, and create session without crashing", async () => {
      const mockUser = {
        _id: "user-id",
        phone: "+919999988888",
        otp: "123456",
        otpExpires: new Date(Date.now() + 5 * 60 * 1000),
        status: "active",
        isVerified: false,
        save: jest.fn().mockResolvedValue(true),
      };

      mockUserRepo.findByPhone.mockResolvedValue(mockUser);

      const result = await authService.verifyOTP("+919999988888", "123456", "127.0.0.1", "agent");
      expect(result.accessToken).toBeDefined();
      expect(result.refreshToken).toBeDefined();

      // Verify raw token is NOT stored directly in Session, but hashed
      const expectedHash = crypto.createHash("sha256").update(result.refreshToken).digest("hex");
      expect(mockSessionRepo.create).toHaveBeenCalledWith(
        expect.objectContaining({
          user: "user-id",
          refreshToken: expectedHash,
        })
      );
    });
  });

  describe("refresh & logout", () => {
    it("should refresh password/OTP session and rotate refresh token", async () => {
      const mockUser = {
        _id: "user-id",
        email: "test@example.com",
        status: "active",
        role: { name: "admin" },
      };

      const mockSession = {
        user: mockUser,
        refreshToken: "some-hashed-token",
        isValid: true,
        expiresAt: new Date(Date.now() + 2 * 24 * 60 * 60 * 1000),
        save: jest.fn().mockResolvedValue(true),
      };

      mockSessionRepo.findByToken.mockResolvedValue(mockSession);

      const result = await authService.refresh("old-refresh-token", "127.0.0.1", "agent");
      expect(result.accessToken).toBeDefined();
      expect(result.refreshToken).toBeDefined();

      // Check if session updated token hash to preserve rotation
      const newHash = crypto.createHash("sha256").update(result.refreshToken).digest("hex");
      expect(mockSession.refreshToken).toBe(newHash);
      expect(mockSession.save).toHaveBeenCalled();
    });

    it("should throw an error on invalid or non-existent refresh token", async () => {
      mockSessionRepo.findByToken.mockResolvedValue(null);

      await expect(
        authService.refresh("invalid-token", "127.0.0.1", "agent")
      ).rejects.toThrow(new AppError("Session not found or invalid", 401));
    });

    it("should invalidate session on logout", async () => {
      await authService.logout("refresh-token-to-invalidate");
      expect(mockSessionRepo.invalidateSession).toHaveBeenCalledWith("refresh-token-to-invalidate");
    });

    it("should invalidate all sessions on logoutAllDevices", async () => {
      await authService.logoutAllDevices("user-id");
      expect(mockSessionRepo.invalidateAllUserSessions).toHaveBeenCalledWith("user-id");
    });
  });
});
