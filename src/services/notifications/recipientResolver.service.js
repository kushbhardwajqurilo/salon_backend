import { Customer } from "../../models/customers/customer.model.js";
import { User } from "../../models/users/user.model.js";
import { Role } from "../../models/roles/role.model.js";

/**
 * Checks whether a customer/recipient is eligible for a given purpose & channel.
 */
export function evaluateConsentAndChannel({ recipient, purpose, channel, eventType = null }) {
  if (!recipient) {
    return { eligible: false, reason: "Recipient not found" };
  }

  if (
    recipient.doNotContact &&
    typeof eventType === "string" &&
    eventType.startsWith("coupon.")
  ) {
    return { eligible: false, reason: "Recipient opted out (doNotContact)" };
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

async function resolveStaffByPermissions({ organizationId, branchId, permissionNames }) {
  const roles = await Role.find({
    $or: [{ organizationId }, { isSystem: true }],
  })
    .populate("permissions")
    .lean();

  const eligibleRoleIds = roles
    .filter((r) =>
      Array.isArray(r.permissions) &&
      r.permissions.some((p) => permissionNames.includes(p?.name || p?.key || p?.code)),
    )
    .map((r) => r._id);

  if (eligibleRoleIds.length === 0) {
    return [];
  }

  const branchFilter = branchId
    ? {
        $or: [
          { hasOrgWideAccess: true },
          { branchAccess: { $elemMatch: { branchId, isActive: true } } },
        ],
      }
    : { hasOrgWideAccess: true };

  const users = await User.find({
    organizationId,
    status: "active",
    role: { $in: eligibleRoleIds },
    ...branchFilter,
  }).lean();

  return users.map((user) => ({
    recipientType: "staff",
    recipientId: user._id,
    recipient: user,
    purpose: "operational",
    channels: ["in_app", "email"],
  }));
}

/**
 * Resolves recipients for an outbox event strictly within `organizationId` (and `branchId`).
 */
export async function resolveRecipientsForEvent(event) {
  const { organizationId, branchId = null, eventType, payload = {} } = event;
  const resolved = [];

  if (eventType.startsWith("inventory.")) {
    return resolveStaffByPermissions({
      organizationId,
      branchId,
      permissionNames: ["inventory.adjust", "inventory.view"],
    });
  }

  if (eventType.startsWith("procurement.")) {
    return resolveStaffByPermissions({
      organizationId,
      branchId,
      permissionNames: ["procurement.orders.update", "procurement.orders.view"],
    });
  }

  if (eventType === "coupon.usage_limit_exhausted") {
    return resolveStaffByPermissions({
      organizationId,
      branchId,
      permissionNames: ["coupons.view", "coupons.configure"],
    });
  }

  if (
    eventType === "expense.submitted" ||
    eventType === "expense.payout_reversed"
  ) {
    return resolveStaffByPermissions({
      organizationId,
      branchId,
      permissionNames: ["expenses.update", "expenses.view"],
    });
  }

  if (eventType.startsWith("finance.")) {
    return resolveStaffByPermissions({
      organizationId,
      branchId,
      permissionNames: ["finance.edit", "finance.view"],
    });
  }

  if (
    eventType.startsWith("payroll.") ||
    eventType.startsWith("leave.") ||
    eventType.startsWith("attendance.") ||
    eventType === "expense.approved" ||
    eventType === "expense.rejected"
  ) {
    if (payload.employeeUserId) {
      const user = await User.findOne({
        _id: payload.employeeUserId,
        organizationId,
        status: "active",
      });
      if (user) {
        resolved.push({
          recipientType: "employee",
          recipientId: user._id,
          recipient: user,
          purpose: eventType.startsWith("payroll.") ? "payroll" : "operational",
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
