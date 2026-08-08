import { jest } from "@jest/globals";
import { AuthService } from "../../services/auth/auth.service.js";
import { User } from "../../models/users/user.model.js";

describe("User identity and username handling", () => {
  it("logs in by username when email is unavailable", async () => {
    const userRepo = {
      findByEmailOrUsername: jest.fn().mockResolvedValue({
        _id: "user-1",
        email: "rahul@example.com",
        status: "active",
        role: { name: "staff" },
        comparePassword: jest.fn().mockResolvedValue(true),
        save: jest.fn().mockResolvedValue(true),
      }),
    };
    const sessionRepo = {
      create: jest.fn().mockResolvedValue({}),
      invalidateAllUserSessions: jest.fn().mockResolvedValue({}),
    };
    const staffRepo = {
      findOne: jest.fn().mockResolvedValue({ status: "active" }),
    };

    const authService = new AuthService(userRepo, null, sessionRepo, null, staffRepo);
    const result = await authService.login(
      "rahul.sharma",
      "Password123!",
      "127.0.0.1",
      "jest",
    );

    expect(userRepo.findByEmailOrUsername).toHaveBeenCalledWith("rahul.sharma");
    expect(result.accessToken).toBeDefined();
    expect(result.refreshToken).toBeDefined();
  });

  it("normalizes usernames to lowercase and preserves uniqueness-safe formatting", () => {
    const authService = new AuthService();
    const normalized = authService.normalizeUsername(" Rahul.Sharma  ");

    expect(normalized).toBe("rahul.sharma");
  });

  it("keeps display names non-unique while usernames remain unique", () => {
    expect(User.schema.paths.name.options.unique).toBeUndefined();
    expect(User.schema.paths.username.options.unique).toBe(true);
  });
});
