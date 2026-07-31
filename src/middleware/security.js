import rateLimit from "express-rate-limit";
import slowDown from "express-slow-down";
import mongoSanitize from "express-mongo-sanitize";
import { AppError } from "../utils/errors.js";

// Rate Limiter: Maximum 100 requests per 15 minutes for standard APIs
export const apiLimiter = rateLimit({
  windowMs: 15 * 60 * 1000, // 15 minutes
  max: 1000,
  message: "Too many requests from this IP, please try again after 15 minutes",
  handler: (req, res, next, options) => {
    next(new AppError(options.message, 429));
  },
  standardHeaders: true,
  legacyHeaders: false,
  validate: false,
});

// Auth Limiter: Stricter limit for login/OTP attempts
export const authLimiter = rateLimit({
  windowMs: 15 * 60 * 1000, // 15 minutes
  max: 100,
  message: "Too many authentication attempts, please try again after 15 minutes",
  handler: (req, res, next, options) => {
    next(new AppError(options.message, 429));
  },
  standardHeaders: true,
  legacyHeaders: false,
  validate: false,
});

// Speed Limiter (Slow Down): Delays responses for excessive requests to prevent spam
export const speedLimiter = slowDown({
  windowMs: 15 * 60 * 1000, // 15 minutes
  delayAfter: 50, // allow 50 requests to go fast, then:
  delayMs: (hits) => (hits - 50) * 100, // add 100ms delay per hit above 50
});

// Sanitize MongoDB Queries (prevents NoSQL injection attacks)
export const sanitizeData = mongoSanitize();
