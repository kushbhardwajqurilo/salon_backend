import { z } from "zod";

const passwordPolicy = z
  .string()
  .min(8, "Password must be at least 8 characters long")
  .regex(/[a-z]/, "Password must contain at least one lowercase letter")
  .regex(/[A-Z]/, "Password must contain at least one uppercase letter")
  .regex(/[0-9]/, "Password must contain at least one number")
  .regex(
    /[^a-zA-Z0-9]/,
    "Password must contain at least one special character",
  );

const usernameRegex = /^[a-z0-9._-]{3,30}$/;

export const registerSchema = z.object({
  body: z.object({
    name: z.string().min(2, "Name must be at least 2 characters long").trim(),
    username: z
      .string()
      .trim()
      .min(3, "Username must be at least 3 characters")
      .max(30, "Username must be at most 30 characters")
      .regex(
        usernameRegex,
        "Username can only contain lowercase letters, numbers, dots, underscores, or hyphens",
      )
      .optional(),
    email: z.string().email("Invalid email address").trim().toLowerCase(),
    phone: z
      .string()
      .regex(/^\+?[1-9]\d{1,14}$/, "Invalid phone number format (E.164)"),
    password: passwordPolicy,
    roleName: z.string().optional(),
  }),
});

export const loginSchema = z.object({
  body: z.object({
    email: z.string().email("Invalid email address").trim().toLowerCase(),
    password: z.string().min(1, "Password is required"),
  }),
});

export const forgotPasswordSchema = z.object({
  body: z.object({
    email: z.string().email("Invalid email address").trim().toLowerCase(),
  }),
});

export const resetPasswordSchema = z.object({
  params: z.object({
    token: z.string().min(1, "Reset token is required"),
  }),
  body: z.object({
    password: passwordPolicy,
  }),
});

export const verifyEmailSchema = z.object({
  query: z.object({
    token: z.string().min(1, "Verification token is required"),
  }),
});

export const sendOtpSchema = z.object({
  body: z.object({
    phone: z
      .string()
      .regex(/^\+?[1-9]\d{1,14}$/, "Invalid phone number format (E.164)"),
  }),
});

export const verifyOtpSchema = z.object({
  body: z.object({
    phone: z
      .string()
      .regex(/^\+?[1-9]\d{1,14}$/, "Invalid phone number format (E.164)"),
    otp: z.string().length(6, "OTP must be exactly 6 digits"),
  }),
});

export const verifyActivationOtpSchema = z.object({
  body: z.object({
    otp: z.string().length(6, "OTP must be exactly 6 digits"),
  }),
});

export const activateChangePasswordSchema = z.object({
  body: z.object({
    password: passwordPolicy,
  }),
});
