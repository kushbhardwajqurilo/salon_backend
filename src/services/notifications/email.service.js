import nodemailer from "nodemailer";
import { env } from "../../config/env.js";
import { logger } from "../../utils/logger.js";

export class EmailService {
  constructor() {
    this.transporter = null;
    this.initTransporter();
  }

  initTransporter() {
    if (env.SMTP_HOST && env.SMTP_USER && env.SMTP_PASS) {
      const port = Number(env.SMTP_PORT) || 587;
      const isSecure = port === 465;

      this.transporter = nodemailer.createTransport({
        host: env.SMTP_HOST,
        port: port,
        secure: isSecure,
        auth: {
          user: env.SMTP_USER,
          pass: env.SMTP_PASS,
        },
        tls: {
          rejectUnauthorized: false, // Prevents self-signed cert issues
        },
      });

      logger.info(
        `📧 EmailService initialized with SMTP host: ${env.SMTP_HOST}:${port} (secure: ${isSecure})`,
      );

      // Verify connection configuration on startup
      this.transporter.verify((error) => {
        if (error) {
          logger.error(
            `❌ [SMTP_VERIFY_FAILED] Could not connect to SMTP server: ${error.message}`,
          );
        } else {
          logger.info(
            `✅ [SMTP_VERIFIED] Connection to SMTP server established successfully. Ready to send emails.`,
          );
        }
      });
    } else {
      logger.info(
        "📧 EmailService initialized in Development Log mode (No SMTP_HOST configured). Emails will be logged to console.",
      );
    }
  }

  async sendMail({ to, subject, html, text }) {
    const fromAddress = env.EMAIL_FROM
      ? env.EMAIL_FROM
      : env.SMTP_USER
        ? `Saloon ERP <${env.SMTP_USER}>`
        : "Saloon ERP <no-reply@saloonerp.com>";

    const mailOptions = {
      from: fromAddress,
      to,
      subject,
      html,
      text,
    };

    if (this.transporter) {
      try {
        const info = await this.transporter.sendMail(mailOptions);
        logger.info(`📧 [EMAIL_SENT] MessageId: ${info.messageId} to ${to}`);
        return info;
      } catch (err) {
        logger.error(
          `❌ [SMTP_SEND_FAILED] Failed to send email to ${to}: ${err.message}`,
        );
        throw err;
      }
    }

    // Fallback in development when SMTP is not configured
    logger.info(`━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━`);
    logger.info(`📧 [DEV_EMAIL_DISPATCH] To: ${to}`);
    logger.info(`Subject: ${subject}`);
    logger.info(`Text Content:\n${text}`);
    logger.info(`━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━`);
    return { devMode: true, to, subject };
  }

  async sendWelcomeCredentialsEmail({ email, name, username, tempPassword }) {
    const subject = "Welcome to Saloon ERP — Account Created";
    const html = `
      <!DOCTYPE html>
      <html>
      <head>
        <meta charset="utf-8">
        <style>
          body { font-family: 'Segoe UI', Tahoma, Geneva, Verdana, sans-serif; background-color: #f4f6f9; color: #333; margin: 0; padding: 20px; }
          .container { max-width: 600px; margin: 0 auto; background: #ffffff; border-radius: 8px; overflow: hidden; box-shadow: 0 4px 12px rgba(0,0,0,0.1); }
          .header { background: #4f46e5; color: #ffffff; padding: 24px; text-align: center; }
          .header h1 { margin: 0; font-size: 24px; font-weight: 600; }
          .content { padding: 32px 24px; line-height: 1.6; }
          .credentials-box { background: #f8fafc; border: 1px solid #e2e8f0; border-radius: 6px; padding: 16px 20px; margin: 20px 0; }
          .cred-row { margin-bottom: 10px; font-size: 15px; }
          .cred-row strong { color: #475569; width: 140px; display: inline-block; }
          .cred-value { font-family: monospace; font-size: 16px; color: #0f172a; background: #e2e8f0; padding: 2px 8px; border-radius: 4px; }
          .notice { background: #fffbeb; border-left: 4px solid #f59e0b; padding: 12px 16px; margin: 20px 0; font-size: 14px; color: #92400e; }
          .footer { background: #f1f5f9; padding: 16px; text-align: center; font-size: 12px; color: #64748b; }
        </style>
      </head>
      <body>
        <div class="container">
          <div class="header">
            <h1>Saloon ERP Portal</h1>
          </div>
          <div class="content">
            <h2>Welcome aboard, ${name}!</h2>
            <p>Your staff account has been provisioned on Saloon ERP. Please use the initial credentials below to complete your first-login setup and activate your permanent password.</p>
            
            <div class="credentials-box">
              <div class="cred-row"><strong>Username:</strong> <span class="cred-value">${username}</span></div>
              <div class="cred-row"><strong>Email:</strong> <span class="cred-value">${email}</span></div>
              <div class="cred-row"><strong>Temp Password:</strong> <span class="cred-value">${tempPassword}</span></div>
            </div>

            <div class="notice">
              <strong>Security Requirement:</strong> Upon first login with this temporary password, you will be prompted to verify a 6-digit OTP and set a permanent password.
            </div>

            <p>If you did not request this account, please contact your Organization Administrator immediately.</p>
          </div>
          <div class="footer">
            &copy; ${new Date().getFullYear()} Saloon ERP. All rights reserved.
          </div>
        </div>
      </body>
      </html>
    `;

    const text = `Welcome ${name}!\n\nYour Saloon ERP account has been created.\n\nUsername: ${username}\nEmail: ${email}\nTemp Password: ${tempPassword}\n\nPlease log in and activate your account with a new permanent password.`;

    return this.sendMail({ to: email, subject, html, text });
  }

  async sendVerificationEmail({ email, name, token }) {
    const subject = "Verify Your Saloon ERP Email Address";
    const verificationUrl = `${process.env.APP_URL || "http://localhost:5000"}/api/v1/auth/verify-email?token=${token}`;

    const html = `
      <!DOCTYPE html>
      <html>
      <head>
        <meta charset="utf-8">
        <style>
          body { font-family: 'Segoe UI', sans-serif; background-color: #f4f6f9; color: #333; margin: 0; padding: 20px; }
          .container { max-width: 600px; margin: 0 auto; background: #ffffff; border-radius: 8px; padding: 32px; box-shadow: 0 4px 12px rgba(0,0,0,0.1); }
          .btn { display: inline-block; background-color: #4f46e5; color: #ffffff; text-decoration: none; padding: 12px 24px; border-radius: 6px; font-weight: 600; margin: 20px 0; }
        </style>
      </head>
      <body>
        <div class="container">
          <h2>Email Verification</h2>
          <p>Hello ${name},</p>
          <p>Thank you for registering with Saloon ERP. Please click the button below to verify your email address:</p>
          <a href="${verificationUrl}" class="btn" style="color: #ffffff;">Verify Email Address</a>
          <p>Or copy and paste this link in your browser:<br><code>${verificationUrl}</code></p>
        </div>
      </body>
      </html>
    `;

    const text = `Hello ${name},\n\nPlease verify your email address by visiting this URL: ${verificationUrl}`;

    return this.sendMail({ to: email, subject, html, text });
  }

  async sendPasswordResetEmail({ email, name, token }) {
    const subject = "Password Reset Request — Saloon ERP";
    const resetUrl = `${process.env.APP_URL || "http://localhost:5000"}/reset-password?token=${token}`;

    const html = `
      <!DOCTYPE html>
      <html>
      <head>
        <meta charset="utf-8">
        <style>
          body { font-family: 'Segoe UI', sans-serif; background-color: #f4f6f9; color: #333; margin: 0; padding: 20px; }
          .container { max-width: 600px; margin: 0 auto; background: #ffffff; border-radius: 8px; padding: 32px; box-shadow: 0 4px 12px rgba(0,0,0,0.1); }
          .btn { display: inline-block; background-color: #dc2626; color: #ffffff; text-decoration: none; padding: 12px 24px; border-radius: 6px; font-weight: 600; margin: 20px 0; }
        </style>
      </head>
      <body>
        <div class="container">
          <h2>Password Reset Request</h2>
          <p>Hello ${name},</p>
          <p>We received a request to reset your password. Click the button below to reset it (link expires in 10 minutes):</p>
          <a href="${resetUrl}" class="btn" style="color: #ffffff;">Reset Password</a>
          <p>If you did not request a password reset, please ignore this email.</p>
        </div>
      </body>
      </html>
    `;

    const text = `Hello ${name},\n\nReset your password using this link (expires in 10 min): ${resetUrl}`;

    return this.sendMail({ to: email, subject, html, text });
  }
}
