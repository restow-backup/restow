/**
 * Tokens of the endpoint agent (docs/AGENT.md).
 *
 *   rset_<43 chars>   enrollment token: 32 random bytes, base64url, valid 24
 *                     hours, bound to a tenant and a profile, single use. The
 *                     admin puts it into the install command (never a URL).
 *   rsea_<43 chars>   agent secret: 32 random bytes, base64url. The agent
 *                     authenticates with `endpointId:agentSecret` (HTTP Basic).
 *
 * Both are shown exactly once and stored only as SHA-256. With 256 bits of
 * entropy a plain, unsalted hash is the right tool: there is nothing to
 * brute-force, and the hash doubles as the lookup key of an enrollment token.
 */
import { createHash, randomBytes, timingSafeEqual } from "node:crypto";

export const ENROLLMENT_TOKEN_PREFIX = "rset_";
export const AGENT_SECRET_PREFIX = "rsea_";

/** An enrollment token is valid for 24 hours. */
export const ENROLLMENT_TOKEN_TTL_MS = 24 * 60 * 60 * 1000;

const BODY_LENGTH = 43;
const BODY = `[A-Za-z0-9_-]{${BODY_LENGTH}}`;
const ENROLLMENT_TOKEN_PATTERN = new RegExp(`^${ENROLLMENT_TOKEN_PREFIX}${BODY}$`);
const AGENT_SECRET_PATTERN = new RegExp(`^${AGENT_SECRET_PREFIX}${BODY}$`);

type RandomSource = (size: number) => Buffer;

export interface GeneratedSecret {
  /** The value handed out once; never stored. */
  value: string;
  /** SHA-256 of `value`, hex: what the database keeps. */
  hash: string;
}

/** SHA-256 of a token or secret, hex encoded. */
export function hashSecret(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

function generate(prefix: string, random: RandomSource): GeneratedSecret {
  const value = `${prefix}${random(32).toString("base64url")}`;
  return { value, hash: hashSecret(value) };
}

export function generateEnrollmentToken(random: RandomSource = randomBytes): GeneratedSecret {
  return generate(ENROLLMENT_TOKEN_PREFIX, random);
}

export function generateAgentSecret(random: RandomSource = randomBytes): GeneratedSecret {
  return generate(AGENT_SECRET_PREFIX, random);
}

export function isEnrollmentToken(value: string): boolean {
  return ENROLLMENT_TOKEN_PATTERN.test(value);
}

export function isAgentSecret(value: string): boolean {
  return AGENT_SECRET_PATTERN.test(value);
}

/** Whether `presented` is the secret behind the stored `hash`, in constant time. */
export function secretMatchesHash(presented: string, hash: string): boolean {
  const actual = Buffer.from(hashSecret(presented), "hex");
  const expected = Buffer.from(hash, "hex");
  return expected.length === actual.length && timingSafeEqual(actual, expected);
}

export type EnrollmentTokenState = "valid" | "expired" | "used" | "revoked";

/** The state of a stored enrollment token at `now`. Revocation and use win over expiry. */
export function enrollmentTokenState(
  token: { expiresAt: Date; usedAt: Date | null; revokedAt: Date | null },
  now: Date,
): EnrollmentTokenState {
  if (token.revokedAt) {
    return "revoked";
  }
  if (token.usedAt) {
    return "used";
  }
  return token.expiresAt.getTime() <= now.getTime() ? "expired" : "valid";
}

/** When a token created at `now` stops being valid. */
export function enrollmentTokenExpiry(now: Date): Date {
  return new Date(now.getTime() + ENROLLMENT_TOKEN_TTL_MS);
}

/** The `endpointId:secret` pair of an HTTP Basic `Authorization` header, or null. */
export function parseBasicAuthorization(
  header: string | null | undefined,
): { username: string; password: string } | null {
  if (!header) {
    return null;
  }
  const match = /^Basic\s+([A-Za-z0-9+/=_-]+)\s*$/i.exec(header);
  if (!match) {
    return null;
  }
  let decoded: string;
  try {
    decoded = Buffer.from(match[1] as string, "base64").toString("utf8");
  } catch {
    return null;
  }
  const colon = decoded.indexOf(":");
  if (colon <= 0) {
    return null;
  }
  return { username: decoded.slice(0, colon), password: decoded.slice(colon + 1) };
}
