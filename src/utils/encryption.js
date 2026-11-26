import crypto from "crypto";

const ALGORITHM = "aes-256-gcm";

function getEncryptionKey() {
  const secret = process.env.CREDENTIALS_ENCRYPTION_KEY || process.env.JWT_SECRET;
  if (!secret) {
    throw new Error("CREDENTIALS_ENCRYPTION_KEY is not configured.");
  }
  return crypto.createHash("sha256").update(secret).digest();
}

/**
 * Encrypts a JSON-serializable object using AES-256-GCM.
 */
export function encryptCredentials(data) {
  if (!data || typeof data !== "object") return data;
  const key = getEncryptionKey();
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv(ALGORITHM, key, iv);
  const plaintext = JSON.stringify(data);
  const encrypted = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
  const tag = cipher.getAuthTag();

  return {
    __encrypted: true,
    iv: iv.toString("base64"),
    tag: tag.toString("base64"),
    data: encrypted.toString("base64"),
  };
}

/**
 * Decrypts credentials encrypted by encryptCredentials.
 * Returns legacy unencrypted objects as-is.
 */
export function decryptCredentials(payload) {
  if (!payload || typeof payload !== "object" || !payload.__encrypted) {
    return payload;
  }
  const key = getEncryptionKey();
  const decipher = crypto.createDecipheriv(
    ALGORITHM,
    key,
    Buffer.from(payload.iv, "base64"),
  );
  decipher.setAuthTag(Buffer.from(payload.tag, "base64"));
  const decrypted = Buffer.concat([
    decipher.update(Buffer.from(payload.data, "base64")),
    decipher.final(),
  ]);
  return JSON.parse(decrypted.toString("utf8"));
}
