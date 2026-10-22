import { createHash, type KeyObject } from "node:crypto";

/**
 * The vendor's licence verification keys, by key id (`kid`), for a rotation of
 * the signing key without breaking a single issued key:
 *
 * - every key without a `kid` member is verified with the keyring's default key
 *   (the original vendor key of 2026-09-24 in the standard build);
 * - a key with `kid` is verified with the key of that id; an id this build does
 *   not know is refused as `unknown_signing_key` (the key was issued for a later
 *   release that ships the new public key).
 *
 * The id of a public key is derived from the key itself
 * ({@link licenseSigningKeyId}), so the issuer and every build agree on it
 * without a naming convention: the first 16 hex digits of SHA-256 over the raw
 * 32-byte Ed25519 public key.
 */

export interface LicenseKeyring {
  /** The key of every licence key without `kid`. */
  readonly defaultKey: KeyObject;
  /** Every known key by its id, the default key included. */
  readonly byKid: ReadonlyMap<string, KeyObject>;
}

/** `kid` of an Ed25519 public key: 16 lowercase hex digits of SHA-256 over the raw key. */
export function licenseSigningKeyId(key: KeyObject): string {
  const jwk = key.export({ format: "jwk" });
  const raw = Buffer.from(typeof jwk.x === "string" ? jwk.x : "", "base64url");
  return createHash("sha256").update(raw).digest("hex").slice(0, 16);
}

/** A keyring of `defaultKey` and any further known keys. */
export function keyringOf(
  defaultKey: KeyObject,
  others: readonly KeyObject[] = [],
): LicenseKeyring {
  const byKid = new Map<string, KeyObject>();
  for (const key of [defaultKey, ...others]) {
    byKid.set(licenseSigningKeyId(key), key);
  }
  return { defaultKey, byKid };
}

/** The key a payload's `kid` names (the default key without one), or null when it is unknown. */
export function signingKeyFor(keyring: LicenseKeyring, kid: string | null): KeyObject | null {
  if (kid === null) {
    return keyring.defaultKey;
  }
  return keyring.byKid.get(kid) ?? null;
}
