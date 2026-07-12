import crypto from "node:crypto";

function getSecretKey() {
  const secret = process.env.CREDENTIALS_SECRET || process.env.JWT_SECRET;
  if (!secret) throw new Error("JWT_SECRET (or CREDENTIALS_SECRET) is not set");
  return crypto.createHash("sha256").update(String(secret)).digest();
}

/** AES-256-GCM encrypt → base64(iv|tag|ciphertext) */
export function encryptSecret(plainText) {
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv("aes-256-gcm", getSecretKey(), iv);
  const enc = Buffer.concat([cipher.update(String(plainText || ""), "utf8"), cipher.final()]);
  const tag = cipher.getAuthTag();
  return Buffer.concat([iv, tag, enc]).toString("base64");
}

export function decryptSecret(payload) {
  const buf = Buffer.from(String(payload || ""), "base64");
  if (buf.length < 28) throw new Error("Invalid encrypted payload");
  const iv = buf.subarray(0, 12);
  const tag = buf.subarray(12, 28);
  const data = buf.subarray(28);
  const decipher = crypto.createDecipheriv("aes-256-gcm", getSecretKey(), iv);
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(data), decipher.final()]).toString("utf8");
}

export function maskUsername(username) {
  const value = String(username || "").trim();
  if (!value) return "";
  if (value.includes("@")) {
    const [local, domain] = value.split("@");
    const shown = local.slice(0, Math.min(2, local.length));
    return `${shown}${"*".repeat(Math.max(1, local.length - shown.length))}@${domain}`;
  }
  if (value.length <= 2) return "*".repeat(value.length);
  return `${value.slice(0, 2)}${"*".repeat(value.length - 2)}`;
}
