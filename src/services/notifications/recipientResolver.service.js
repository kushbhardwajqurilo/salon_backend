import { Customer } from "../../models/customers/customer.model.js";
import { User } from "../../models/users/user.model.js";

/**
 * Checks whether a customer/recipient is eligible for a given purpose & channel.
 */
export function evaluateConsentAndChannel({ recipient, purpose, channel }) {
  if (!recipient) {
    return { eligible: false, reason: "Recipient not found" };
  }

  // Global opt-out blocks reminders and marketing; transactional security/payment bypasses
  if (recipient.doNotContact && (purpose === "marketing" || purpose === "reminder")) {
    return { eligible: false, reason: "Recipient opted out (doNotContact)" };
  }

  if (purpose === "marketing") {
    const prefs = recipient.marketingPreferences || {};
    if (!prefs.promotions || !prefs[channel]) {
      return { eligible: false, reason: `Marketing consent disabled for ${channel}` };
    }
  }

  if (channel === "email" && !recipient.email) {
    return { eligible: false, reason: "Missing email address" };
  }
  if (channel === "sms" && !recipient.phone) {
    return { eligible: false, reason: "Missing phone number" };
  }

  return { eligible: true, reason: null };
}

/**
 * Resolves recipients for an outbox event strictly within `organizationId` (and `branchId`).
 */
export async function resolveRecipientsForEvent(event) {
  const { organizationId, eventType, payload = {} } = event;
  const resolved = [];

  if (eventType.startsWith("payroll.")) {
    if (payload.employeeUserId) {
      const user = await User.findOne({
        _id: payload.employeeUserId,
        organizationId,
        isActive: true,
      });
      if (user) {
        resolved.push({
          recipientType: "employee",
          recipientId: user._id,
          recipient: user,
          purpose: "payroll",
          channels: ["email"],
        });
      }
    }
    return resolved;
  }

  // Distinguish payer vs beneficiary when both are present
  if (payload.payerCustomerId) {
    const payer = await Customer.findOne({
      _id: payload.payerCustomerId,
      organizationId,
      isDeleted: false,
    });
    if (payer) {
      resolved.push({
        recipientType: "payer",
        recipientId: payer._id,
        recipient: payer,
        purpose: "transactional",
        channels: ["sms", "email"],
      });
    }
  }

  if (payload.beneficiaryCustomerId && String(payload.beneficiaryCustomerId) !== String(payload.payerCustomerId)) {
    const beneficiary = await Customer.findOne({
      _id: payload.beneficiaryCustomerId,
      organizationId,
      isDeleted: false,
    });
    if (beneficiary) {
      resolved.push({
        recipientType: "beneficiary",
        recipientId: beneficiary._id,
        recipient: beneficiary,
        purpose: "transactional",
        channels: ["sms", "email"],
      });
    }
  }

  if (payload.customerId && !payload.payerCustomerId && !payload.beneficiaryCustomerId) {
    const customer = await Customer.findOne({
      _id: payload.customerId,
      organizationId,
      isDeleted: false,
    });
    if (customer) {
      const purpose = eventType.includes("reminder") ? "reminder" : "transactional";
      resolved.push({
        recipientType: "customer",
        recipientId: customer._id,
        recipient: customer,
        purpose,
        channels: ["sms", "email"],
      });
    }
  }

  return resolved;
}
