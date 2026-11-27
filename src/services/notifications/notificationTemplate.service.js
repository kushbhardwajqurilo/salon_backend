import { NotificationTemplate } from "../../models/notifications/notificationTemplate.model.js";
import { OrganizationSettings } from "../../models/settings/organizationSettings.model.js";
import { SENSITIVE_PAYLOAD_KEYS } from "./notificationEventContract.js";

export function wrapEmailHtml({ brandName, title, bodyHtml, contactEmail, contactPhone }) {
  const safeBrand = escapeHtml(brandName || "Saloon ERP");
  const safeTitle = escapeHtml(title || "");
  const contactParts = [
    contactEmail ? `Email: ${escapeHtml(contactEmail)}` : "",
    contactPhone ? `Phone: ${escapeHtml(contactPhone)}` : "",
  ].filter(Boolean);
  const contactLine = contactParts.length
    ? `<div style="margin-top:6px;color:#52525b;">${contactParts.join(" &bull; ")}</div>`
    : "";

  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <title>${safeTitle}</title>
</head>
<body style="margin:0;padding:0;background-color:#f4f4f5;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif;color:#18181b;">
  <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background-color:#f4f4f5;padding:32px 16px;">
    <tr>
      <td align="center">
        <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="max-width:600px;background-color:#ffffff;border-radius:14px;overflow:hidden;border:1px solid #e4e4e7;box-shadow:0 1px 3px rgba(0,0,0,0.05);">
          <tr>
            <td style="background-color:#18181b;padding:24px 28px;border-bottom:3px solid #d4af37;">
              <div style="font-size:20px;font-weight:700;color:#ffffff;letter-spacing:-0.01em;">${safeBrand}</div>
              <div style="font-size:12px;color:#d4d4d8;margin-top:4px;">Client &amp; Team Communications</div>
            </td>
          </tr>
          <tr>
            <td style="padding:28px;font-size:15px;line-height:1.65;color:#27272a;">
              ${bodyHtml}
              <div style="margin-top:24px;padding-top:16px;border-top:1px solid #f4f4f5;color:#3f3f46;">
                Warm regards,<br />
                <strong>The ${safeBrand} Team</strong>
              </div>
            </td>
          </tr>
          <tr>
            <td style="background-color:#fafafa;padding:18px 28px;border-top:1px solid #e4e4e7;font-size:12px;color:#71717a;line-height:1.5;">
              <div>This is an automated message from ${safeBrand}. Please do not reply directly to this email.</div>
              ${contactLine}
            </td>
          </tr>
        </table>
      </td>
    </tr>
  </table>
</body>
</html>`;
}

const BUILTIN_DEFAULTS = {
  "auth.email_verification": {
    email: {
      subject: "{{brandName}} — Verify Your Email Address",
      body: "<p>Hello {{customerName}},</p><p>Please verify your email address to activate your {{brandName}} account.</p>",
      allowedVariables: ["brandName", "customerName"],
    },
    sms: {
      subject: "",
      body: "{{brandName}}: Please verify your email address to activate your account.",
      allowedVariables: ["brandName"],
    },
  },
  "auth.password_reset": {
    email: {
      subject: "{{brandName}} — Password Reset Request",
      body: "<p>Hello,</p><p>We received a request to reset your {{brandName}} password. If you did not request this, you can safely ignore this email.</p>",
      allowedVariables: ["brandName"],
    },
    sms: {
      subject: "",
      body: "{{brandName}}: A password reset was requested for your account.",
      allowedVariables: ["brandName"],
    },
  },
  "auth.otp_requested": {
    email: {
      subject: "{{brandName}} — One-Time Verification",
      body: "<p>A one-time verification code was requested for your {{brandName}} account. For your security, never share verification codes with anyone.</p>",
      allowedVariables: ["brandName"],
    },
    sms: {
      subject: "",
      body: "{{brandName}}: A verification code was requested for your account.",
      allowedVariables: ["brandName"],
    },
  },
  "user.welcome_credentials": {
    email: {
      subject: "Welcome to {{brandName}}",
      body: "<p>Hello {{staffName}},</p><p>Your {{brandName}} staff account has been created. Please sign in to the portal and update your password on first login.</p>",
      allowedVariables: ["brandName", "staffName"],
    },
    sms: {
      subject: "",
      body: "Welcome to {{brandName}}, {{staffName}}! Your staff account is ready.",
      allowedVariables: ["brandName", "staffName"],
    },
  },
  "appointment.reminder_due": {
    email: {
      subject: "{{brandName}} — Appointment Reminder ({{appointmentCode}})",
      body: "<p>Hello {{customerName}},</p><p>This is a friendly reminder for your upcoming appointment <strong>{{appointmentCode}}</strong> scheduled for <strong>{{startAt}}</strong>.</p><p>We look forward to seeing you!</p>",
      allowedVariables: ["brandName", "customerName", "appointmentCode", "startAt"],
    },
    sms: {
      subject: "",
      body: "{{brandName}}: Reminder for appointment {{appointmentCode}} on {{startAt}}.",
      allowedVariables: ["brandName", "appointmentCode", "startAt"],
    },
  },
  "appointment.rescheduled": {
    email: {
      subject: "{{brandName}} — Appointment Rescheduled ({{appointmentCode}})",
      body: "<p>Hello {{customerName}},</p><p>Your appointment <strong>{{appointmentCode}}</strong> has been rescheduled to <strong>{{startAt}}</strong>.</p>",
      allowedVariables: ["brandName", "customerName", "appointmentCode", "startAt"],
    },
    sms: {
      subject: "",
      body: "{{brandName}}: Appointment {{appointmentCode}} rescheduled to {{startAt}}.",
      allowedVariables: ["brandName", "appointmentCode", "startAt"],
    },
  },
  "appointment.service_completed": {
    email: {
      subject: "{{brandName}} — Thank You for Visiting!",
      body: "<p>Hello {{customerName}},</p><p>Thank you for visiting {{brandName}} for appointment <strong>{{appointmentCode}}</strong>. We hope you enjoyed your service!</p>",
      allowedVariables: ["brandName", "customerName", "appointmentCode"],
    },
    sms: {
      subject: "",
      body: "{{brandName}}: Thank you for visiting! Appointment {{appointmentCode}} is complete.",
      allowedVariables: ["brandName", "appointmentCode"],
    },
  },
  "appointment.created": {
    email: {
      subject: "{{brandName}} — Appointment Confirmed ({{appointmentCode}})",
      body: "<p>Hello {{customerName}},</p><p>Your appointment <strong>{{appointmentCode}}</strong> is confirmed for <strong>{{startAt}}</strong>.</p>",
      allowedVariables: ["brandName", "customerName", "appointmentCode", "startAt"],
    },
    sms: {
      subject: "",
      body: "{{brandName}}: Appointment {{appointmentCode}} confirmed for {{startAt}}.",
      allowedVariables: ["brandName", "appointmentCode", "startAt"],
    },
  },
  "appointment.cancelled": {
    email: {
      subject: "{{brandName}} — Appointment Cancelled ({{appointmentCode}})",
      body: "<p>Hello {{customerName}},</p><p>Your appointment <strong>{{appointmentCode}}</strong> has been cancelled. Please contact {{brandName}} if you would like to rebook.</p>",
      allowedVariables: ["brandName", "customerName", "appointmentCode"],
    },
    sms: {
      subject: "",
      body: "{{brandName}}: Appointment {{appointmentCode}} has been cancelled.",
      allowedVariables: ["brandName", "appointmentCode"],
    },
  },
  "appointment.no_show": {
    email: {
      subject: "{{brandName}} — Missed Appointment ({{appointmentCode}})",
      body: "<p>Hello {{customerName}},</p><p>We missed you at your appointment <strong>{{appointmentCode}}</strong>. Reach out to {{brandName}} anytime to reschedule.</p>",
      allowedVariables: ["brandName", "customerName", "appointmentCode"],
    },
    sms: {
      subject: "",
      body: "{{brandName}}: We missed you for appointment {{appointmentCode}}. Contact us to rebook.",
      allowedVariables: ["brandName", "appointmentCode"],
    },
  },
  "invoice.created": {
    email: {
      subject: "{{brandName}} — Invoice {{invoiceNumber}}",
      body: "<p>Hello {{customerName}},</p><p>A new invoice <strong>{{invoiceNumber}}</strong> for <strong>{{amount}}</strong> has been generated.</p>",
      allowedVariables: ["brandName", "customerName", "invoiceNumber", "amount"],
    },
    sms: {
      subject: "",
      body: "{{brandName}}: Invoice {{invoiceNumber}} for {{amount}} has been generated.",
      allowedVariables: ["brandName", "invoiceNumber", "amount"],
    },
  },
  "invoice.payment_recorded": {
    email: {
      subject: "{{brandName}} — Payment Received ({{invoiceNumber}})",
      body: "<p>Hello {{customerName}},</p><p>We have recorded your payment of <strong>{{amount}}</strong> for invoice <strong>{{invoiceNumber}}</strong>. Thank you!</p>",
      allowedVariables: ["brandName", "customerName", "invoiceNumber", "amount"],
    },
    sms: {
      subject: "",
      body: "{{brandName}}: Payment of {{amount}} received for invoice {{invoiceNumber}}.",
      allowedVariables: ["brandName", "invoiceNumber", "amount"],
    },
  },
  "invoice.partial_payment": {
    email: {
      subject: "{{brandName}} — Partial Payment Received ({{invoiceNumber}})",
      body: "<p>Hello {{customerName}},</p><p>A partial payment of <strong>{{amount}}</strong> has been recorded for invoice <strong>{{invoiceNumber}}</strong>.</p>",
      allowedVariables: ["brandName", "customerName", "invoiceNumber", "amount"],
    },
    sms: {
      subject: "",
      body: "{{brandName}}: Partial payment of {{amount}} recorded for invoice {{invoiceNumber}}.",
      allowedVariables: ["brandName", "invoiceNumber", "amount"],
    },
  },
  "invoice.settled": {
    email: {
      subject: "{{brandName}} — Invoice Settled ({{invoiceNumber}})",
      body: "<p>Hello {{customerName}},</p><p>Your invoice <strong>{{invoiceNumber}}</strong> is now fully settled. Thank you for your business!</p>",
      allowedVariables: ["brandName", "customerName", "invoiceNumber"],
    },
    sms: {
      subject: "",
      body: "{{brandName}}: Invoice {{invoiceNumber}} is now fully settled. Thank you!",
      allowedVariables: ["brandName", "invoiceNumber"],
    },
  },
  "invoice.payment_reversed": {
    email: {
      subject: "{{brandName}} — Payment Reversed ({{invoiceNumber}})",
      body: "<p>Hello {{customerName}},</p><p>A payment reversal of <strong>{{amount}}</strong> was processed for invoice <strong>{{invoiceNumber}}</strong>.</p>",
      allowedVariables: ["brandName", "customerName", "invoiceNumber", "amount"],
    },
    sms: {
      subject: "",
      body: "{{brandName}}: Payment of {{amount}} reversed for invoice {{invoiceNumber}}.",
      allowedVariables: ["brandName", "invoiceNumber", "amount"],
    },
  },
  "invoice.refunded": {
    email: {
      subject: "{{brandName}} — Refund Processed ({{invoiceNumber}})",
      body: "<p>Hello {{customerName}},</p><p>A refund of <strong>{{amount}}</strong> has been processed for invoice <strong>{{invoiceNumber}}</strong>.</p>",
      allowedVariables: ["brandName", "customerName", "invoiceNumber", "amount"],
    },
    sms: {
      subject: "",
      body: "{{brandName}}: Refund of {{amount}} processed for invoice {{invoiceNumber}}.",
      allowedVariables: ["brandName", "invoiceNumber", "amount"],
    },
  },
  "invoice.voided": {
    email: {
      subject: "{{brandName}} — Invoice Voided ({{invoiceNumber}})",
      body: "<p>Hello {{customerName}},</p><p>Invoice <strong>{{invoiceNumber}}</strong> has been voided.</p>",
      allowedVariables: ["brandName", "customerName", "invoiceNumber"],
    },
    sms: {
      subject: "",
      body: "{{brandName}}: Invoice {{invoiceNumber}} has been voided.",
      allowedVariables: ["brandName", "invoiceNumber"],
    },
  },
  "subscription.created": {
    email: {
      subject: "{{brandName}} — Subscription Activated",
      body: "<p>Hello {{customerName}},</p><p>Your subscription <strong>{{planName}}</strong> is now active at {{brandName}}.</p>",
      allowedVariables: ["brandName", "customerName", "planName"],
    },
    sms: {
      subject: "",
      body: "{{brandName}}: Your subscription {{planName}} is now active.",
      allowedVariables: ["brandName", "planName"],
    },
  },
  "subscription.redemption_otp": {
    email: {
      subject: "{{brandName}} — Subscription Redemption Verification",
      body: "<p>Hello {{customerName}},</p><p>A subscription redemption was initiated at {{brandName}}. Please confirm with our front desk.</p>",
      allowedVariables: ["brandName", "customerName"],
    },
    sms: {
      subject: "",
      body: "{{brandName}}: Subscription redemption verification requested.",
      allowedVariables: ["brandName"],
    },
  },
  "subscription.redeemed": {
    email: {
      subject: "{{brandName}} — Subscription Redeemed",
      body: "<p>Hello {{customerName}},</p><p>Your subscription <strong>{{planName}}</strong> has been redeemed.</p>",
      allowedVariables: ["brandName", "customerName", "planName"],
    },
    sms: {
      subject: "",
      body: "{{brandName}}: Subscription {{planName}} redeemed.",
      allowedVariables: ["brandName", "planName"],
    },
  },
  "membership.activated": {
    email: {
      subject: "{{brandName}} — Membership Activated",
      body: "<p>Hello {{customerName}},</p><p>Welcome! Your <strong>{{planName}}</strong> membership at {{brandName}} is now active.</p>",
      allowedVariables: ["brandName", "customerName", "planName"],
    },
    sms: {
      subject: "",
      body: "{{brandName}}: Your {{planName}} membership is now active!",
      allowedVariables: ["brandName", "planName"],
    },
  },
  "coupon.redeemed": {
    email: {
      subject: "{{brandName}} — Coupon Redeemed",
      body: "<p>Hello {{customerName}},</p><p>Your coupon <strong>{{couponCode}}</strong> was redeemed on invoice <strong>{{invoiceNumber}}</strong>.</p>",
      allowedVariables: ["brandName", "customerName", "couponCode", "invoiceNumber"],
    },
    sms: {
      subject: "",
      body: "{{brandName}}: Coupon {{couponCode}} redeemed on invoice {{invoiceNumber}}.",
      allowedVariables: ["brandName", "couponCode", "invoiceNumber"],
    },
  },
  "coupon.usage_limit_exhausted": {
    email: {
      subject: "{{brandName}} — Coupon Usage Limit Reached",
      body: "<p>Hello,</p><p>Coupon <strong>{{couponCode}}</strong> has reached its configured usage limit.</p>",
      allowedVariables: ["brandName", "couponCode"],
    },
    sms: {
      subject: "",
      body: "{{brandName}}: Coupon {{couponCode}} has reached its usage limit.",
      allowedVariables: ["brandName", "couponCode"],
    },
  },
  "expense.submitted": {
    email: {
      subject: "{{brandName}} — Expense Submitted for Approval",
      body: "<p>Hello,</p><p>Expense <strong>{{expenseCode}}</strong> is awaiting approval.</p>",
      allowedVariables: ["brandName", "expenseCode"],
    },
  },
  "expense.approved": {
    email: {
      subject: "{{brandName}} — Expense Approved",
      body: "<p>Hello {{employeeName}},</p><p>Expense <strong>{{expenseCode}}</strong> has been approved.</p>",
      allowedVariables: ["brandName", "employeeName", "expenseCode"],
    },
  },
  "expense.rejected": {
    email: {
      subject: "{{brandName}} — Expense Rejected",
      body: "<p>Hello {{employeeName}},</p><p>Expense <strong>{{expenseCode}}</strong> was rejected.</p>",
      allowedVariables: ["brandName", "employeeName", "expenseCode"],
    },
  },
  "expense.payout_reversed": {
    email: {
      subject: "{{brandName}} — Petty Cash Payout Reversed",
      body: "<p>Hello,</p><p>A reversal was recorded for petty cash expense <strong>{{expenseCode}}</strong>.</p>",
      allowedVariables: ["brandName", "expenseCode"],
    },
  },
  "finance.day_closure_submitted": {
    email: {
      subject: "{{brandName}} — Day Closure Submitted",
      body: "<p>Hello,</p><p>A day closure for <strong>{{businessDate}}</strong> was submitted.</p>",
      allowedVariables: ["brandName", "businessDate"],
    },
  },
  "finance.day_closure_approved": {
    email: {
      subject: "{{brandName}} — Day Closure Approved",
      body: "<p>Hello,</p><p>The day closure for <strong>{{businessDate}}</strong> was approved.</p>",
      allowedVariables: ["brandName", "businessDate"],
    },
  },
  "customer.created": {
    email: {
      subject: "Welcome to {{brandName}}!",
      body: "<p>Hello {{customerName}},</p><p>Thank you for joining {{brandName}}. We are delighted to have you with us!</p>",
      allowedVariables: ["brandName", "customerName"],
    },
    sms: {
      subject: "",
      body: "Welcome to {{brandName}}, {{customerName}}! Thank you for joining us.",
      allowedVariables: ["brandName", "customerName"],
    },
  },
  "leave.approved": {
    email: {
      subject: "{{brandName}} — Leave Request Approved",
      body: "<p>Hello {{staffName}},</p><p>Your leave request for <strong>{{leaveDates}}</strong> has been approved.</p>",
      allowedVariables: ["brandName", "staffName", "leaveDates"],
    },
    sms: {
      subject: "",
      body: "{{brandName}}: Your leave request ({{leaveDates}}) has been approved.",
      allowedVariables: ["brandName", "leaveDates"],
    },
  },
  "leave.rejected": {
    email: {
      subject: "{{brandName}} — Leave Request Declined",
      body: "<p>Hello {{staffName}},</p><p>Your leave request for <strong>{{leaveDates}}</strong> could not be approved at this time.</p>",
      allowedVariables: ["brandName", "staffName", "leaveDates"],
    },
    sms: {
      subject: "",
      body: "{{brandName}}: Your leave request ({{leaveDates}}) was declined.",
      allowedVariables: ["brandName", "leaveDates"],
    },
  },
  "leave.cancelled": {
    email: {
      subject: "{{brandName}} — Leave Request Cancelled",
      body: "<p>Hello {{staffName}},</p><p>Your leave request for <strong>{{leaveDates}}</strong> has been cancelled.</p>",
      allowedVariables: ["brandName", "staffName", "leaveDates"],
    },
    sms: {
      subject: "",
      body: "{{brandName}}: Your leave request ({{leaveDates}}) was cancelled.",
      allowedVariables: ["brandName", "leaveDates"],
    },
  },
  "payroll.payslip_published": {
    email: {
      subject: "{{brandName}} — Your Payslip is Available",
      body: "<p>Your payslip is now available.</p><p>Please log in to the <strong>{{brandName}}</strong> portal to view it securely.</p>",
      allowedVariables: ["brandName"],
    },
    sms: {
      subject: "",
      body: "{{brandName}}: Your payslip is available in the portal.",
      allowedVariables: ["brandName"],
    },
  },
  "attendance.marked": {
    email: {
      subject: "{{brandName}} — Attendance Recorded",
      body: "<p>Hello {{staffName}},</p><p>Your attendance for <strong>{{attendanceDate}}</strong> has been recorded as <strong>{{status}}</strong>.</p>",
      allowedVariables: ["brandName", "staffName", "attendanceDate", "status"],
    },
    sms: {
      subject: "",
      body: "{{brandName}}: Attendance for {{attendanceDate}} recorded ({{status}}).",
      allowedVariables: ["brandName", "attendanceDate", "status"],
    },
  },
  "attendance.corrected": {
    email: {
      subject: "{{brandName}} — Attendance Updated",
      body: "<p>Hello {{staffName}},</p><p>Your attendance record for <strong>{{attendanceDate}}</strong> has been updated to <strong>{{status}}</strong>.</p>",
      allowedVariables: ["brandName", "staffName", "attendanceDate", "status"],
    },
    sms: {
      subject: "",
      body: "{{brandName}}: Attendance for {{attendanceDate}} updated to {{status}}.",
      allowedVariables: ["brandName", "attendanceDate", "status"],
    },
  },
  "inventory.low_stock": {
    email: {
      subject: "{{brandName}} — Low Stock Alert: {{itemName}}",
      body: "<p>Hello,</p><p><strong>{{itemName}}</strong> ({{stockDomain}}) at <strong>{{branchName}}</strong> is running low with <strong>{{quantity}}</strong> remaining. Please review replenishment.</p>",
      allowedVariables: ["brandName", "itemName", "stockDomain", "branchName", "quantity"],
    },
    sms: {
      subject: "",
      body: "{{brandName}}: Low stock for {{itemName}} ({{stockDomain}}) at {{branchName}}: {{quantity}} left.",
      allowedVariables: ["brandName", "itemName", "stockDomain", "branchName", "quantity"],
    },
  },
  "inventory.out_of_stock": {
    email: {
      subject: "{{brandName}} — Out of Stock: {{itemName}}",
      body: "<p>Hello,</p><p><strong>{{itemName}}</strong> ({{stockDomain}}) is now out of stock at <strong>{{branchName}}</strong>. Immediate restocking is recommended.</p>",
      allowedVariables: ["brandName", "itemName", "stockDomain", "branchName"],
    },
    sms: {
      subject: "",
      body: "{{brandName}}: Out of stock — {{itemName}} ({{stockDomain}}) at {{branchName}}.",
      allowedVariables: ["brandName", "itemName", "stockDomain", "branchName"],
    },
  },
  "inventory.stock_received": {
    email: {
      subject: "{{brandName}} — Stock Received: {{itemName}}",
      body: "<p>Hello,</p><p><strong>{{quantity}}</strong> units of <strong>{{itemName}}</strong> ({{stockDomain}}) have been received at <strong>{{branchName}}</strong>.</p>",
      allowedVariables: ["brandName", "itemName", "stockDomain", "branchName", "quantity"],
    },
    sms: {
      subject: "",
      body: "{{brandName}}: Received {{quantity}} of {{itemName}} at {{branchName}}.",
      allowedVariables: ["brandName", "itemName", "branchName", "quantity"],
    },
  },
  "inventory.stock_adjusted": {
    email: {
      subject: "{{brandName}} — Stock Adjusted: {{itemName}}",
      body: "<p>Hello,</p><p>Stock for <strong>{{itemName}}</strong> ({{stockDomain}}) at <strong>{{branchName}}</strong> was adjusted to <strong>{{quantity}}</strong>.</p>",
      allowedVariables: ["brandName", "itemName", "stockDomain", "branchName", "quantity"],
    },
    sms: {
      subject: "",
      body: "{{brandName}}: Stock adjusted for {{itemName}} at {{branchName}} ({{quantity}}).",
      allowedVariables: ["brandName", "itemName", "branchName", "quantity"],
    },
  },
  "procurement.po_created": {
    email: {
      subject: "{{brandName}} — Purchase Order Created ({{poNumber}})",
      body: "<p>Hello,</p><p>Purchase Order <strong>{{poNumber}}</strong> for supplier <strong>{{supplierName}}</strong> at <strong>{{branchName}}</strong> has been created.</p>",
      allowedVariables: ["brandName", "poNumber", "supplierName", "branchName"],
    },
    sms: {
      subject: "",
      body: "{{brandName}}: PO {{poNumber}} created for {{supplierName}}.",
      allowedVariables: ["brandName", "poNumber", "supplierName"],
    },
  },
  "procurement.po_submitted": {
    email: {
      subject: "{{brandName}} — Purchase Order Awaiting Approval ({{poNumber}})",
      body: "<p>Hello,</p><p>Purchase Order <strong>{{poNumber}}</strong> for <strong>{{supplierName}}</strong> ({{branchName}}) is awaiting your approval.</p>",
      allowedVariables: ["brandName", "poNumber", "supplierName", "branchName"],
    },
    sms: {
      subject: "",
      body: "{{brandName}}: PO {{poNumber}} ({{supplierName}}) is awaiting approval.",
      allowedVariables: ["brandName", "poNumber", "supplierName"],
    },
  },
  "procurement.po_approved": {
    email: {
      subject: "{{brandName}} — Purchase Order Approved ({{poNumber}})",
      body: "<p>Hello,</p><p>Purchase Order <strong>{{poNumber}}</strong> for <strong>{{supplierName}}</strong> has been approved.</p>",
      allowedVariables: ["brandName", "poNumber", "supplierName"],
    },
    sms: {
      subject: "",
      body: "{{brandName}}: PO {{poNumber}} for {{supplierName}} approved.",
      allowedVariables: ["brandName", "poNumber", "supplierName"],
    },
  },
  "procurement.po_rejected": {
    email: {
      subject: "{{brandName}} — Purchase Order Declined ({{poNumber}})",
      body: "<p>Hello,</p><p>Purchase Order <strong>{{poNumber}}</strong> for <strong>{{supplierName}}</strong> was declined.</p>",
      allowedVariables: ["brandName", "poNumber", "supplierName"],
    },
    sms: {
      subject: "",
      body: "{{brandName}}: PO {{poNumber}} for {{supplierName}} was declined.",
      allowedVariables: ["brandName", "poNumber", "supplierName"],
    },
  },
  "procurement.goods_received": {
    email: {
      subject: "{{brandName}} — Goods Received ({{poNumber}})",
      body: "<p>Hello,</p><p>Goods have been received against Purchase Order <strong>{{poNumber}}</strong> from <strong>{{supplierName}}</strong> at <strong>{{branchName}}</strong>.</p>",
      allowedVariables: ["brandName", "poNumber", "supplierName", "branchName"],
    },
    sms: {
      subject: "",
      body: "{{brandName}}: Goods received for PO {{poNumber}} ({{supplierName}}).",
      allowedVariables: ["brandName", "poNumber", "supplierName"],
    },
  },
};

export function escapeHtml(str) {
  return String(str)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

/**
 * Safely interpolates {{varName}} placeholders using an explicit allowlist.
 * Rejects/ignores sensitive keys and escapes HTML when rendering email content.
 */
export function renderTemplateString(
  templateStr,
  variables = {},
  allowedVariables = [],
  { escapeHtmlValues = false } = {},
) {
  if (!templateStr || typeof templateStr !== "string") return "";
  const allowSet = new Set(
    (allowedVariables || []).filter(
      (k) => !SENSITIVE_PAYLOAD_KEYS.includes(String(k).toLowerCase()),
    ),
  );

  return templateStr.replace(/\{\{\s*([a-zA-Z0-9_]+)\s*\}\}/g, (_match, key) => {
    if (!allowSet.has(key)) return "";
    const raw = variables[key];
    if (raw === null || raw === undefined) return "";
    const str = String(raw);
    return escapeHtmlValues ? escapeHtml(str) : str;
  });
}

/**
 * Resolves org override -> global default -> builtin default, applies org branding,
 * and renders subject/body safely.
 */
export async function resolveAndRenderNotificationTemplate({
  organizationId,
  eventType,
  channel,
  variables = {},
}) {
  let template = await NotificationTemplate.findOne({
    organizationId,
    eventType,
    channel,
    isActive: true,
  }).lean();
  let source = "org_override";

  if (!template) {
    template = await NotificationTemplate.findOne({
      organizationId: null,
      eventType,
      channel,
      isActive: true,
    }).lean();
    source = "global_default";
  }

  if (!template) {
    const builtin = BUILTIN_DEFAULTS[eventType]?.[channel];
    if (!builtin) {
      return {
        subject: "",
        body: "",
        source: "none",
      };
    }
    template = builtin;
    source = "builtin_default";
  }

  const settings = organizationId
    ? await OrganizationSettings.findOne({ organizationId }).lean()
    : null;
  const brandName =
    settings?.profile?.displayName || settings?.businessName || "Saloon ERP";

  const mergedVars = {
    ...variables,
    brandName,
  };

  // Never allow payroll confidential variables
  const allowed =
    eventType.startsWith("payroll.")
      ? (template.allowedVariables || []).filter((v) => v === "brandName")
      : template.allowedVariables || [];

  const escapeHtmlValues = channel === "email";
  const renderedSubject = renderTemplateString(
    template.subject || "",
    mergedVars,
    allowed,
    { escapeHtmlValues: false },
  );
  const renderedBody = renderTemplateString(
    template.body || "",
    mergedVars,
    allowed,
    { escapeHtmlValues },
  );

  const finalBody =
    channel === "email" &&
    renderedBody &&
    !renderedBody.trim().startsWith("<!DOCTYPE") &&
    !renderedBody.trim().startsWith("<html")
      ? wrapEmailHtml({
          brandName,
          title: renderedSubject,
          bodyHtml: renderedBody,
          contactEmail: settings?.profile?.email,
          contactPhone: settings?.profile?.phone,
        })
      : renderedBody;

  return {
    subject: renderedSubject,
    body: finalBody,
    html: channel === "email" ? finalBody : undefined,
    source,
  };
}
