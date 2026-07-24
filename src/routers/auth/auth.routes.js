import { Router } from "express";
import { validate } from "../../middleware/validate.js";
import { authLimiter } from "../../middleware/security.js";
import { authenticate } from "../../middleware/auth.js";
import * as authController from "../../controllers/auth/auth.controller.js";
import * as authValidation from "../../validation/auth/auth.validation.js";

const router = Router();

router.use(authLimiter);

router.post("/register", validate(authValidation.registerSchema), authController.register);
router.post("/login", validate(authValidation.loginSchema), authController.login);
router.post("/refresh", authController.refresh);
router.post("/logout", authController.logout);
router.get("/verify-email", validate(authValidation.verifyEmailSchema), authController.verifyEmail);
router.post("/forgot-password", validate(authValidation.forgotPasswordSchema), authController.forgotPassword);
router.post("/reset-password/:token", validate(authValidation.resetPasswordSchema), authController.resetPassword);

router.post("/otp/send", validate(authValidation.sendOtpSchema), authController.sendOTP);
router.post("/otp/verify", validate(authValidation.verifyOtpSchema), authController.verifyOTP);

router.post("/logout-all", authenticate, authController.logoutAllDevices);

export default router;
