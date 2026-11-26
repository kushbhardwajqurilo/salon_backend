import { z } from "zod";
import mongoose from "mongoose";

/**
 * Verified event types backed by existing service triggers/operations.
 */
export const VERIFIED_EVENT_TYPES = Object.freeze([
  // Auth & Users (auth.service.js, user.controller.js)
  "auth.email_verification",
  "auth.password_reset",
  "auth.otp_requested",
  "user.welcome_credentials",

  // Appointments (appointment.service.js)
  "appointment.reminder_due",
  "appointment.rescheduled",
  "appointment.service_completed",
  "appointment.created",
  "appointment.cancelled",
  "appointment.no_show",

  // Billing & Payments (billing.service.js)
  "invoice.created",
  "invoice.payment_recorded",
  "invoice.partial_payment",
  "invoice.settled",
  "invoice.payment_reversed",
  "invoice.refunded",
  "invoice.voided",

  // Subscriptions & Memberships (subscription.service.js, membership.service.js)
  "subscription.created",
  "subscription.redemption_otp",
  "subscription.redeemed",
  "membership.activated",
]);

/**
 * Provisional event types for planned integrations.
 * New event types must be reviewed and added here before use.
 */
export const PROVISIONAL_EVENT_TYPES = Object.freeze([
  "loyalty.points_earned",
  "loyalty.points_redeemed",
  "payroll.payslip_published",
  "leave.status_updated",
]);

export const NOTIFICATION_EVENT_TYPES = Object.freeze([
  ...VERIFIED_EVENT_TYPES,
  ...PROVISIONAL_EVENT_TYPES,
]);

export const SENSITIVE_PAYLOAD_KEYS = Object.freeze([
  "otp",
  "passcode",
  "pin",
  "password",
  "temppassword",
  "token",
  "authtoken",
  "accesstoken",
  "refreshtoken",
  "resettoken",
  "verificationtoken",
  "jwt",
  "bearer",
  "secret",
  "clientsecret",
  "privatekey",
  "apikey",
  "salary",
  "netpay",
  "grosspay",
  "ctc",
  "bankaccount",
  "pan",
  "aadhaar",
]);

export const MAX_PAYLOAD_BYTES = 16 * 1024; // 16 KB

const objectIdSchema = z
  .union([z.string(), z.instanceof(mongoose.Types.ObjectId)])
  .refine((val) => mongoose.Types.ObjectId.isValid(val), {
    message: "Invalid ObjectId",
  })
  .transform((val) => new mongoose.Types.ObjectId(val));

function isPlainObject(obj) {
  if (typeof obj !== "object" || obj === null) return false;
  const proto = Object.getPrototypeOf(obj);
  return proto === Object.prototype || proto === null;
}

/**
 * Recursively checks that a payload contains only JSON-safe primitives, arrays,
 * and plain objects, with no circular references, sensitive keys, or JWT/Bearer strings.
 */
function assertSafePayload(value, path = "payload", seen = new WeakSet()) {
  if (value === null || value === undefined) return;
  const t = typeof value;
  if (t === "function" || t === "symbol" || t === "bigint") {
    throw new Error(`Unsupported value type "${t}" at ${path}`);
  }
  if (t === "string") {
    if (
      /^Bearer\s+[A-Za-z0-9\-_]+\.[A-Za-z0-9\-_]+/i.test(value) ||
      /^eyJ[A-Za-z0-9\-_]+\.[A-Za-z0-9\-_]+\.[A-Za-z0-9\-_]+$/.test(value)
    ) {
      throw new Error(
        `Sensitive token-like string is not permitted at ${path}`,
      );
    }
    return;
  }
  if (t !== "object") return;

  if (seen.has(value)) {
    throw new Error(`Circular reference detected at ${path}`);
  }
  seen.add(value);

  if (Array.isArray(value)) {
    value.forEach((item, idx) =>
      assertSafePayload(item, `${path}[${idx}]`, seen),
    );
    return;
  }

  if (!isPlainObject(value)) {
    throw new Error(`Unsupported non-plain object at ${path}`);
  }

  for (const [key, val] of Object.entries(value)) {
    if (SENSITIVE_PAYLOAD_KEYS.includes(key.toLowerCase())) {
      throw new Error(
        `Sensitive field "${key}" is not permitted in outbox event payload`,
      );
    }
    assertSafePayload(val, `${path}.${key}`, seen);
  }
}

const outboxEventInputSchema = z.object({
  organizationId: objectIdSchema,
  branchId: objectIdSchema.nullable().optional().default(null),
  eventType: z.enum(NOTIFICATION_EVENT_TYPES),
  idempotencyKey: z
    .string()
    .trim()
    .min(1, "idempotencyKey must be non-empty")
    .max(200, "idempotencyKey must not exceed 200 characters"),
  schemaVersion: z.number().int().min(1).optional().default(1),
  payload: z.record(z.string(), z.unknown()).optional().default({}),
  availableAt: z.coerce.date().optional(),
});

/**
 * Validates and normalizes an outbox event input contract.
 */
export function validateOutboxEventInput(input) {
  const parsed = outboxEventInputSchema.parse(input);
  assertSafePayload(parsed.payload);

  const serializedBytes = Buffer.byteLength(
    JSON.stringify(parsed.payload),
    "utf8",
  );
  if (serializedBytes > MAX_PAYLOAD_BYTES) {
    throw new Error(
      `Outbox payload exceeds maximum size of ${MAX_PAYLOAD_BYTES} bytes`,
    );
  }

  return parsed;
}

/**
 * Redacts common secret/token/OTP patterns from error text before persistence/logging.
 */
export function redactSensitiveText(text) {
  if (!text || typeof text !== "string") return "";
  return text
    .replace(/Bearer\s+[A-Za-z0-9\-_.]+/gi, "Bearer [REDACTED]")
    .replace(
      /(otp|password|token|secret|apikey)\s*[:=]\s*\S+/gi,
      "$1=[REDACTED]",
    )
    .slice(0, 500);
}
