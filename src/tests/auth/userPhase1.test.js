import mongoose from "mongoose";
import { User } from "../../models/users/user.model.js";
import { toUserResponseDTO } from "../../utils/userResponse.js";

describe("User Model & DTO (Phase 1)", () => {
  describe("User Model status Validation & Defaulting", () => {
    it("should accept valid status values", async () => {
      const validStatuses = ["active", "suspended", "locked", "inactive"];
      for (const status of validStatuses) {
        const user = new User({
          name: "Test User",
          email: `${status}@example.com`,
          phone: `+1234${Math.floor(Math.random() * 10000000)}`,
          password: "Password123!",
          role: new mongoose.Types.ObjectId(),
          organizationId: new mongoose.Types.ObjectId(),
          status,
        });
        const err = user.validateSync();
        expect(err).toBeUndefined();
      }
    });

    it("should reject invalid status values", async () => {
      const user = new User({
        name: "Test User",
        email: "invalid@example.com",
        phone: "+1234567890",
        password: "Password123!",
        role: new mongoose.Types.ObjectId(),
        organizationId: new mongoose.Types.ObjectId(),
        status: "pending", // Invalid status value
      });
      const err = user.validateSync();
      expect(err).toBeDefined();
      expect(err.errors.status).toBeDefined();
    });

    it("should default isFirstLogin to false", async () => {
      const user = new User({
        name: "Test User",
        email: "default@example.com",
        phone: "+1234567891",
        password: "Password123!",
        role: new mongoose.Types.ObjectId(),
        organizationId: new mongoose.Types.ObjectId(),
      });
      expect(user.isFirstLogin).toBe(false);
    });
  });

  describe("toUserResponseDTO", () => {
    it("should exclude sensitive authentication fields and keep safe ones", () => {
      const rawUser = {
        _id: new mongoose.Types.ObjectId(),
        name: "Admin User",
        email: "admin@example.com",
        phone: "+919999988888",
        password: "hashedpassword",
        role: {
          _id: new mongoose.Types.ObjectId(),
          name: "Manager",
          description: "Branch manager",
        },
        organizationId: new mongoose.Types.ObjectId(),
        branchAccess: [
          {
            branchId: new mongoose.Types.ObjectId(),
            branchName: "Main Branch",
            isActive: true,
          },
        ],
        isVerified: true,
        isFirstLogin: true,
        status: "active",
        refreshToken: "refreshtokenstring",
        otp: "123456",
        otpExpires: new Date(),
        emailVerificationToken: "verificationtoken",
        passwordResetToken: "resettoken",
        createdAt: new Date(),
        updatedAt: new Date(),
      };

      const dto = toUserResponseDTO(rawUser);

      // Sensitive fields must be undefined
      expect(dto.password).toBeUndefined();
      expect(dto.passwordHash).toBeUndefined();
      expect(dto.refreshToken).toBeUndefined();
      expect(dto.otp).toBeUndefined();
      expect(dto.otpExpires).toBeUndefined();
      expect(dto.emailVerificationToken).toBeUndefined();
      expect(dto.passwordResetToken).toBeUndefined();

      // Safe fields must be populated
      expect(dto.id).toBe(rawUser._id.toString());
      expect(dto.name).toBe(rawUser.name);
      expect(dto.email).toBe(rawUser.email);
      expect(dto.phone).toBe(rawUser.phone);
      expect(dto.role.name).toBe("Manager");
      expect(dto.organizationId).toBe(rawUser.organizationId.toString());
      expect(dto.isVerified).toBe(true);
      expect(dto.isFirstLogin).toBe(true);
      expect(dto.status).toBe("active");
    });

    it("should not mutate the original User object", () => {
      const rawUser = {
        name: "Test User",
        password: "sensitivepassword",
        status: "active",
      };

      const dto = toUserResponseDTO(rawUser);
      expect(dto.password).toBeUndefined();
      expect(rawUser.password).toBe("sensitivepassword"); // Original remains untouched
    });
  });
});
