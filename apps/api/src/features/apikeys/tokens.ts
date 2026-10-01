import { createHash, randomBytes } from "node:crypto";

/**
 * API key tokens.
 *
 *   rsk_<tag>_<secret>
 *
 * `tag` names who the key belongs to: a compact form of the tenant slug, or
 * `provider` for a provider key, so an operator who finds a key in an RMM
 * configuration can tell whose it is. `secret` is 40 base62 characters
 * (about 238 bits). The token is shown exactly once; the database keeps its
 * SHA-256 (the lookup key) and a short display prefix (`rsk_<tag>_<8 chars>`).
 * The token's high entropy makes a plain, unsalted hash the right tool: there
 * is nothing to brute-force.
 */

export const API_KEY_PREFIX = "rsk_";
export const PROVIDER_KEY_TAG = "provider";

const BASE62 = "0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz";
/** Largest multiple of 62 that fits a byte; bytes above it would bias the draw. */
const UNBIASED_BYTE_LIMIT = 62 * 4;
const SECRET_LENGTH = 40;
const DISPLAY_SECRET_LENGTH = 8;
const TAG_MAX_LENGTH = 16;
const FALLBACK_TENANT_TAG = "tenant";

const TOKEN_PATTERN = /^rsk_([a-z0-9]{1,16})_([0-9A-Za-z]{40})$/;

export type RandomSource = (size: number) => Buffer;

/** `length` characters drawn uniformly from [0-9A-Za-z]. */
export function randomBase62(length: number, random: RandomSource = randomBytes): string {
  let out = "";
  while (out.length < length) {
    for (const byte of random(length * 2)) {
      if (byte < UNBIASED_BYTE_LIMIT) {
        out += BASE62[byte % 62];
        if (out.length === length) {
          break;
        }
      }
    }
  }
  return out;
}

/**
 * The tag for a tenant's keys: the slug without hyphens, at most 16
 * characters. A tenant whose slug compacts to `provider` gets `tprovider`, so
 * a tenant key never looks like a provider key.
 */
export function tenantKeyTag(slug: string): string {
  const compact = slug
    .toLowerCase()
    .replace(/[^a-z0-9]/g, "")
    .slice(0, TAG_MAX_LENGTH);
  if (compact.length === 0) {
    return FALLBACK_TENANT_TAG;
  }
  return compact === PROVIDER_KEY_TAG ? `t${compact}` : compact;
}

/** SHA-256 of the full token, hex encoded: what `api_keys.key_hash` stores. */
export function hashApiKey(token: string): string {
  return createHash("sha256").update(token, "utf8").digest("hex");
}

export interface GeneratedApiKey {
  /** The full token; returned to the creator once and never stored. */
  token: string;
  /** Public identifier shown in lists (`rsk_<tag>_<first 8 secret chars>`). */
  prefix: string;
  hash: string;
}

export function generateApiKey(tag: string, random: RandomSource = randomBytes): GeneratedApiKey {
  if (!/^[a-z0-9]{1,16}$/.test(tag)) {
    throw new TypeError("api key tag must be 1-16 lowercase letters or digits");
  }
  const secret = randomBase62(SECRET_LENGTH, random);
  const token = `${API_KEY_PREFIX}${tag}_${secret}`;
  return {
    token,
    prefix: `${API_KEY_PREFIX}${tag}_${secret.slice(0, DISPLAY_SECRET_LENGTH)}`,
    hash: hashApiKey(token),
  };
}

/** True when `token` has the shape of a Restow API key (says nothing about validity). */
export function isWellFormedApiKey(token: string): boolean {
  return TOKEN_PATTERN.test(token);
}

/**
 * The token from an `Authorization` header (`Bearer <token>`, scheme matched
 * case-insensitively as RFC 6750 asks), or null when there is none.
 */
export function bearerToken(header: string | undefined): string | null {
  const match = /^\s*Bearer\s+(\S+)\s*$/i.exec(header ?? "");
  return match?.[1] ?? null;
}

/** True when the request presents a Restow API key rather than a session. */
export function isApiKeyAuthorization(header: string | undefined): boolean {
  return bearerToken(header)?.startsWith(API_KEY_PREFIX) ?? false;
}
