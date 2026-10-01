/**
 * RFC 6238 TOTP (SHA-1, 6 digits, 30 seconds), enough to enrol and use the
 * authenticator app of the smoke's admin account. No dependency.
 */
import { createHmac } from "node:crypto";

const BASE32 = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";

export function base32Decode(text) {
  const clean = text.replace(/=+$/u, "").replace(/\s+/gu, "").toUpperCase();
  let bits = 0;
  let value = 0;
  const bytes = [];
  for (const char of clean) {
    const index = BASE32.indexOf(char);
    if (index === -1) {
      throw new Error(`not a base32 character: ${char}`);
    }
    value = (value << 5) | index;
    bits += 5;
    if (bits >= 8) {
      bytes.push((value >>> (bits - 8)) & 0xff);
      bits -= 8;
    }
  }
  return Buffer.from(bytes);
}

/** The code for `secret` (base32) at `atMs` (default now). */
export function totp(secret, atMs = Date.now(), { digits = 6, periodSeconds = 30 } = {}) {
  const counter = Math.floor(atMs / 1000 / periodSeconds);
  const message = Buffer.alloc(8);
  message.writeBigUInt64BE(BigInt(counter));
  const hmac = createHmac("sha1", base32Decode(secret)).update(message).digest();
  const offset = hmac[hmac.length - 1] & 0x0f;
  const binary =
    ((hmac[offset] & 0x7f) << 24) |
    (hmac[offset + 1] << 16) |
    (hmac[offset + 2] << 8) |
    hmac[offset + 3];
  return String(binary % 10 ** digits).padStart(digits, "0");
}

/** The secret of an otpauth:// URI. */
export function secretFromOtpauth(uri) {
  const secret = new URL(uri).searchParams.get("secret");
  if (!secret) {
    throw new Error("the otpauth URI carries no secret");
  }
  return secret;
}
