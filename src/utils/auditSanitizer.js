const SENSITIVE_KEY_PATTERNS = [
  /password/i,
  /passcode/i,
  /\botp\b/i,
  /otpcode/i,
  /token/i,
  /secret/i,
  /apikey/i,
  /api_key/i,
  /authorization/i,
  /cookie/i,
  /credential/i,
  /privatekey/i,
  /private_key/i,
  /\bpin\b/i,
  /cvv/i,
  /cvc/i,
  /cardnumber/i,
  /card_number/i,
];

const isSensitiveKey = (key) => {
  const normalized = String(key).replace(/[-_\s]/g, "").toLowerCase();
  return SENSITIVE_KEY_PATTERNS.some(
    (pattern) => pattern.test(key) || pattern.test(normalized)
  );
};

export const sanitizeAuditMetadata = (value, seen = new WeakSet()) => {
  if (value === null || value === undefined) return value;
  if (Array.isArray(value)) return value.map((item) => sanitizeAuditMetadata(item, seen));
  if (value instanceof Date || typeof value !== "object") return value;
  if (seen.has(value)) return "[CIRCULAR]";
  seen.add(value);

  const sanitized = {};
  for (const [key, val] of Object.entries(value)) {
    if (isSensitiveKey(key)) {
      sanitized[key] = "[REDACTED]";
    } else if (val && typeof val === "object" && !(val instanceof Date)) {
      sanitized[key] = sanitizeAuditMetadata(val, seen);
    } else {
      sanitized[key] = val;
    }
  }
  return sanitized;
};
