import { createHmac, randomBytes } from "node:crypto";
import { type RandomSource, randomBase62 } from "../apikeys/tokens.js";

/**
 * One-time join tokens of worker nodes (service.ts): `rsj_<40 base62>`, drawn like an API key
 * (apikeys/tokens.ts). Stored only as a keyed hash (HMAC-SHA256 with a key derived from
 * BETTER_AUTH_SECRET, which no node ever receives): a row that was not written by the api's
 * `createJoinToken`, e.g. one planted with the SHA-256 of a chosen token by a role that can
 * write the table, matches no token and cannot be redeemed. The token carries no secret
 * material of the installation: it authenticates one request for the node's configuration
 * over TLS.
 */

export const JOIN_TOKEN_PREFIX = "rsj_";
const TOKEN = /^rsj_[0-9A-Za-z]{40}$/;
/** Characters of the token shown in the list, to recognise it. */
const SHOWN = 8;
/** Domain separation of the hash key: a new scheme gets a new label. */
const KEY_LABEL = "restow/cluster-join-token/v1";

export interface GeneratedJoinToken {
  /** Shown to the owner once, never stored. */
  readonly token: string;
  readonly prefix: string;
  readonly hash: string;
}

/** The key the token hashes are made with, from BETTER_AUTH_SECRET; null when it is not set. */
export function joinTokenKey(env: Record<string, string | undefined>): Buffer | null {
  const secret = env.BETTER_AUTH_SECRET?.trim();
  if (!secret) {
    return null;
  }
  return createHmac("sha256", Buffer.from(secret, "utf8")).update(KEY_LABEL, "utf8").digest();
}

export function generateJoinToken(
  key: Buffer,
  random: RandomSource = randomBytes,
): GeneratedJoinToken {
  const token = `${JOIN_TOKEN_PREFIX}${randomBase62(40, random)}`;
  return {
    token,
    prefix: token.slice(0, JOIN_TOKEN_PREFIX.length + SHOWN),
    hash: hashJoinToken(token, key),
  };
}

export function hashJoinToken(token: string, key: Buffer): string {
  return createHmac("sha256", key).update(token, "utf8").digest("hex");
}

export function isWellFormedJoinToken(token: string): boolean {
  return TOKEN.test(token);
}
