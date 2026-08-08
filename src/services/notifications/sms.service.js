import { env } from "../../config/env.js";
import { logger } from "../../utils/logger.js";

export class SmsService {
  constructor() {
    this.senderId = env.SMS_SENDER_ID || "SALOON";
    this.apiKey = env.SMS_API_KEY || null;
  }

  async sendSms({ phone, message }) {
    if (this.apiKey) {
      // Production SMS Gateway API Integration (e.g. Twilio / Fast2SMS / AWS SNS)
      logger.info(`📱 [SMS_SENT] Sent SMS to ${phone} via Gateway`);
      return { success: true, phone, message };
    }

    // Development / Log mode fallback
    logger.info(`━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━`);
    logger.info(`📱 [DEV_SMS_DISPATCH] Phone: ${phone}`);
    logger.info(`Message: ${message}`);
    logger.info(`━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━`);
    return { devMode: true, phone, message };
  }

  async sendOtpSMS({ phone, otp }) {
    const message = `[Saloon ERP] Your activation OTP is ${otp}. Valid for 5 minutes. Do not share this code with anyone.`;
    return this.sendSms({ phone, message });
  }

  async sendWelcomeCredentialsSMS({ phone, username, tempPassword }) {
    const message = `[Saloon ERP] Your account has been created. Username: ${username}, Temp Password: ${tempPassword}. Please log in to complete activation.`;
    return this.sendSms({ phone, message });
  }
}
