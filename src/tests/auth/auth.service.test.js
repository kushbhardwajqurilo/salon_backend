import { jest } from "@jest/globals";
import { AuthService } from "../../services/auth/auth.service.js";
import { AppError } from "../../utils/errors.js";

describe("AuthService", () => {
  let authService;
  let mockUserRepo;
  let mockRoleRepo;
  let mockSessionRepo;

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

    authService = new AuthService(mockUserRepo, mockRoleRepo, mockSessionRepo);
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

    it("should lock account after 5 failed login attempts", async () => {
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
    });
  });

  describe("refresh", () => {
    it("should populate role when fetching user and generate access token with role", async () => {
      const jwt = (await import("jsonwebtoken")).default;
      const bcrypt = (await import("bcryptjs")).default;

      const refreshToken = jwt.sign({ id: "user-id" }, process.env.JWT_REFRESH_SECRET || "refresh_secret");
      const hashedRefreshToken = await bcrypt.hash(refreshToken, 10);

      const mockUser = {
        _id: "user-id",
        email: "test@example.com",
        status: "active",
        refreshToken: hashedRefreshToken,
        role: { name: "admin" },
        save: jest.fn().mockResolvedValue(true),
      };

      mockUserRepo.findById.mockResolvedValue(mockUser);

      const result = await authService.refresh(refreshToken, "127.0.0.1", "agent");

      expect(mockUserRepo.findById).toHaveBeenCalledWith("user-id", ["role"]);
      expect(result.accessToken).toBeDefined();
      expect(result.refreshToken).toBeDefined();

      const decoded = jwt.decode(result.accessToken);
      expect(decoded.role).toBe("admin");
    });
  });
});
