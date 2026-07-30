/**
 * Normalizes a phone number to standard format by removing non-numeric/non-plus characters.
 * @param {string} phone 
 * @returns {string}
 */
export function normalizePhone(phone) {
  if (!phone || typeof phone !== "string") return phone;
  let normalized = phone.replace(/[^\d+]/g, "");
  if (normalized.startsWith("00")) {
    normalized = "+" + normalized.substring(2);
  }
  return normalized;
}
