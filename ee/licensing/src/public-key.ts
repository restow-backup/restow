import { type KeyObject, createHash, createPublicKey } from "node:crypto";

/**
 * The Ed25519 public key license keys are verified against, offline.
 *
 * The standard build embeds the vendor's public key. `RESTOW_LICENSE_PUBLIC_KEY`
 * names a different one (a throwaway test key in development, in the tests and
 * in the release smoke).
 */

/** Environment variable that overrides the embedded verification key. */
export const LICENSE_PUBLIC_KEY_ENV = "RESTOW_LICENSE_PUBLIC_KEY";

/**
 * Marker for a build without an embedded vendor verification key (development
 * builds). While it is in place, keys verify only against
 * `RESTOW_LICENSE_PUBLIC_KEY`, and the license page says so instead of
 * reporting every key as forged.
 */
export const LICENSE_PUBLIC_KEY_PLACEHOLDER = "PLACEHOLDER-NO-LICENSE-PUBLIC-KEY-EMBEDDED";

/**
 * The vendor's Ed25519 licence verification key compiled into this build
 * (base64url of the raw 32 bytes). Generated offline by the maintainer on
 * 2026-09-24; the matching private key never leaves the signer.
 */
export const EMBEDDED_LICENSE_PUBLIC_KEY: string = "jTH9dQE90rwOooSYx3Gs2wnuhrxoD5Kcqw1wNR7g9Wk";

/** DER prefix of an Ed25519 SubjectPublicKeyInfo; the raw 32-byte key follows it. */
const ED25519_SPKI_PREFIX = Buffer.from("302a300506032b6570032100", "hex");
const RAW_KEY_BYTES = 32;
const BASE64_PATTERN = /^[A-Za-z0-9+/_-]+={0,2}$/;

/** A verification key that could not be read, or is not an Ed25519 key. */
export class LicensePublicKeyError extends Error {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = "LicensePublicKeyError";
  }
}

function fromBase64(text: string): KeyObject {
  const compact = text.replace(/\s+/g, "");
  if (!BASE64_PATTERN.test(compact)) {
    throw new LicensePublicKeyError("The public key is neither PEM nor base64.");
  }
  const bytes = Buffer.from(compact, "base64");
  if (bytes.length === RAW_KEY_BYTES) {
    return createPublicKey({
      key: { kty: "OKP", crv: "Ed25519", x: bytes.toString("base64url") },
      format: "jwk",
    });
  }
  if (
    bytes.length === ED25519_SPKI_PREFIX.length + RAW_KEY_BYTES &&
    bytes.subarray(0, ED25519_SPKI_PREFIX.length).equals(ED25519_SPKI_PREFIX)
  ) {
    return createPublicKey({ key: bytes, format: "der", type: "spki" });
  }
  throw new LicensePublicKeyError(
    "The public key must be 32 raw bytes or an Ed25519 SubjectPublicKeyInfo.",
  );
}

/**
 * Read an Ed25519 public key from PEM (SPKI), or from base64/base64url of
 * either the raw 32 bytes or the DER SubjectPublicKeyInfo.
 */
export function parseLicensePublicKey(text: string): KeyObject {
  const trimmed = text.trim();
  let key: KeyObject;
  try {
    key = trimmed.startsWith("-----BEGIN") ? createPublicKey(trimmed) : fromBase64(trimmed);
  } catch (cause) {
    if (cause instanceof LicensePublicKeyError) {
      throw cause;
    }
    throw new LicensePublicKeyError("The public key could not be read.", { cause });
  }
  if (key.asymmetricKeyType !== "ed25519") {
    throw new LicensePublicKeyError("License keys are verified with Ed25519 keys only.");
  }
  return key;
}

/** The raw 32-byte public key, base64url encoded (the embeddable form). */
export function exportRawPublicKey(key: KeyObject): string {
  const jwk = key.export({ format: "jwk" });
  if (typeof jwk.x !== "string") {
    throw new LicensePublicKeyError("Not an Ed25519 public key.");
  }
  return jwk.x;
}

/**
 * `SHA256:<base64>` over the raw public key (the OpenSSH convention), so an
 * operator can compare the key in use with the one the vendor publishes.
 */
export function publicKeyFingerprint(key: KeyObject): string {
  const raw = Buffer.from(exportRawPublicKey(key), "base64url");
  const digest = createHash("sha256").update(raw).digest("base64").replace(/=+$/, "");
  return `SHA256:${digest}`;
}

export type LicenseKeySource = "environment" | "embedded";

/** The verification key in effect, or why there is none. */
export type LicenseVerificationKey =
  | { status: "ready"; source: LicenseKeySource; key: KeyObject; fingerprint: string }
  | { status: "unconfigured" }
  | { status: "invalid"; source: LicenseKeySource };

function load(text: string, source: LicenseKeySource): LicenseVerificationKey {
  try {
    const key = parseLicensePublicKey(text);
    return { status: "ready", source, key, fingerprint: publicKeyFingerprint(key) };
  } catch {
    return { status: "invalid", source };
  }
}

/**
 * Resolve the verification key: the environment override first, then the
 * embedded key. An override that cannot be read is reported as invalid rather
 * than silently falling back, so a typo never passes unnoticed.
 */
export function resolveLicensePublicKey(
  env: Readonly<Record<string, string | undefined>> = process.env,
  embedded: string = EMBEDDED_LICENSE_PUBLIC_KEY,
): LicenseVerificationKey {
  const override = env[LICENSE_PUBLIC_KEY_ENV]?.trim();
  if (override) {
    return load(override, "environment");
  }
  const builtIn = embedded.trim();
  if (builtIn === "" || builtIn === LICENSE_PUBLIC_KEY_PLACEHOLDER) {
    return { status: "unconfigured" };
  }
  return load(builtIn, "embedded");
}
