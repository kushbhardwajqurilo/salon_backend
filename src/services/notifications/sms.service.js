import { env } from "../../config/env.js";
import { logger } from "../../utils/logger.js";

export class SmsService {
  constructor() {
    this.apiKey = env.AUTOBYSMS_API_KEY || env.SMS_API_KEY || null;
    this.senderId = env.AUTOBYSMS_SENDER_ID || env.SMS_SENDER_ID || "SALOON";
    this.templateId = env.AUTOBYSMS_TEMPLATE_ID || "";
  }

  async sendSms({ phone, message, templateId }) {

    const AUTOBYSMS_API_KEY = this.apiKey;
    const AUTOBYSMS_SENDER_ID = this.senderId;
    const AUTOBYSMS_TEMPLATE_ID = templateId || this.templateId || "";
    const phoneNumber = phone;

    if (AUTOBYSMS_API_KEY) {
      try {
        const url = `https://sms.autobysms.com/app/smsapi/index.php?key=${AUTOBYSMS_API_KEY}&campaign=0&routeid=9&type=text&contacts=${phoneNumber}&senderid=${AUTOBYSMS_SENDER_ID}&msg=${encodeURIComponent(message)}&template_id=${AUTOBYSMS_TEMPLATE_ID}`;

        logger.info(`📱 [SMS_REQUEST] Dispatching SMS to ${phoneNumber} via AutoBySMS`);

        const response = await fetch(url);
        const responseText = await response.text();

        logger.info(`📱 [SMS_RESPONSE] Response from AutoBySMS for ${phoneNumber}: ${responseText}`);
        return { success: true, phone: phoneNumber, message, response: responseText };
      } catch (error) {
        logger.error(`❌ [SMS_ERROR] Failed to send SMS to ${phone} via AutoBySMS: ${error.message}`);
        throw error;
      }
    }

    // Development / Log mode fallback when no API key is provided
    logger.warn(`⚠️ [SMS_DEV_MODE] AUTOBYSMS_API_KEY is not set in .env. SMS dispatch simulated.`);
    logger.info(`━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━`);
    logger.info(`📱 [DEV_SMS_DISPATCH] Phone: ${phone}`);
    logger.info(`Message: ${message}`);
    logger.info(`━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━`);
    return { devMode: true, phone, message };
  }

  async sendOtpSMS({ phone, otp, templateId }) {
    // console.log({ phone, otp, templateId })
    const message = `Your OTP is ${otp} SELECTIAL`;
    return this.sendSms({ phone, message, templateId });
  }
}
