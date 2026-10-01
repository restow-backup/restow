import { type KeyObject, createHash, verify } from "node:crypto";
import { type KeyedEdition, isKeyedEdition } from "./editions.js";

/**
 * License token format, version 1, and its offline verification. This build
 * only verifies keys: issuing them is the business of the private
 * restow-license repository, whose signing key never enters this one (tests
 * sign with a throwaway key, ../testing/test-signer.mjs).
 *
 *   restow-license-v1.<payload>.<signature>
 *
 * `<payload>` is the base64url encoded JSON object
 *
 *   { "edition", "mailbox_limit", "multi_tenant", "licensee", "installation_id", "issued_at" }
 *
 * (`mailbox_limit` is a reserved member of the v1 format: Restow has no mailbox
 * limit, newly issued keys carry `null`, and a value in an older key is accepted
 * and has no effect) and `<signature>` the base64url Ed25519 signature over the ASCII text
 * `restow-license-v1.<payload>` (prefix included, so a signature can never be
 * replayed into a future format). Tokens carry no expiry: a key is valid for
 * the lifetime of the installation, and verification never consults a clock or
 * a server. Whitespace (line breaks from mail clients) is ignored.
 */

export const LICENSE_TOKEN_PREFIX = "restow-license-v1";

/** The signed payload, in its documented wire spelling. */
export interface LicensePayload {
  edition: KeyedEdition;
  /** Reserved. Always null in issued keys; read, validated and ignored on verification. */
  mailbox_limit: number | null;
  multi_tenant: boolean;
  /** Name of the operator the key was issued to. */
  licensee: string;
  /** The installation the key is bound to (shown on the license page). */
  installation_id: string;
  /** ISO-8601 UTC timestamp of issue; informational, never an expiry. */
  issued_at: string;
}

/** A license whose signature and payload have been verified. */
export interface VerifiedLicense {
  edition: KeyedEdition;
  multiTenant: boolean;
  licensee: string;
  installationId: string;
  issuedAt: Date;
  /** The Ed25519 signature, base64url. */
  signature: string;
  /** Short identifier derived from the signature, for support conversations. */
  keyId: string;
}

/** Why a token was not accepted. */
export type LicenseRejection =
  | "malformed"
  | "bad_signature"
  | "invalid_payload"
  | "installation_mismatch";

export type LicenseVerification =
  | { ok: true; license: VerifiedLicense }
  | { ok: false; reason: "installation_mismatch"; license: VerifiedLicense }
  | { ok: false; reason: Exclude<LicenseRejection, "installation_mismatch"> };

export const MAX_LICENSEE_LENGTH = 200;
export const MAX_INSTALLATION_ID_LENGTH = 200;
/** Far above any real token; bounds the work done on pasted input. */
export const MAX_LICENSE_TOKEN_LENGTH = 8192;

/** The documented payload members, in their wire order. */
const PAYLOAD_KEYS = [
  "edition",
  "mailbox_limit",
  "multi_tenant",
  "licensee",
  "installation_id",
  "issued_at",
] as const satisfies readonly (keyof LicensePayload)[];

const ISO_UTC_PATTERN = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?Z$/;
const BASE64URL_PATTERN = /^[A-Za-z0-9_-]+$/;
const SIGNATURE_BYTES = 64;

function isBoundedText(value: unknown, maxLength: number): value is string {
  return typeof value === "string" && value.trim().length > 0 && value.length <= maxLength;
}

function isIsoTimestamp(value: unknown): value is string {
  return (
    typeof value === "string" &&
    ISO_UTC_PATTERN.test(value) &&
    !Number.isNaN(new Date(value).getTime())
  );
}

function isMailboxLimit(value: unknown): value is number | null {
  return value === null || (Number.isSafeInteger(value) && (value as number) > 0);
}

/**
 * Validate a decoded payload strictly: exactly the documented members, each
 * well-typed, and a tenancy flag that matches the edition (only Service
 * Provider is multi-tenant), so a verified key can never state a contradiction.
 */
export function parseLicensePayload(value: unknown): LicensePayload | null {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return null;
  }
  const record = value as Record<string, unknown>;
  const keys = Object.keys(record);
  if (keys.length !== PAYLOAD_KEYS.length || !PAYLOAD_KEYS.every((key) => key in record)) {
    return null;
  }
  const { edition, mailbox_limit, multi_tenant, licensee, installation_id, issued_at } = record;
  if (
    !isKeyedEdition(edition) ||
    !isMailboxLimit(mailbox_limit) ||
    typeof multi_tenant !== "boolean" ||
    multi_tenant !== (edition === "service_provider") ||
    !isBoundedText(licensee, MAX_LICENSEE_LENGTH) ||
    !isBoundedText(installation_id, MAX_INSTALLATION_ID_LENGTH) ||
    !isIsoTimestamp(issued_at)
  ) {
    return null;
  }
  return { edition, mailbox_limit, multi_tenant, licensee, installation_id, issued_at };
}

/** Strip whitespace a mail client or terminal may have wrapped into a pasted key. */
export function normalizeLicenseToken(token: string): string {
  return token.replace(/\s+/g, "");
}

/**
 * Short, stable identifier of a key: the first 8 bytes of SHA-256 over the
 * signature, as `XXXX-XXXX-XXXX-XXXX`. Both the operator and the vendor can
 * derive it, without passing the whole key around.
 */
export function licenseKeyId(signature: string): string {
  const hex = createHash("sha256")
    .update(Buffer.from(signature, "base64url"))
    .digest("hex")
    .slice(0, 16)
    .toUpperCase();
  return hex.match(/.{4}/g)?.join("-") ?? hex;
}

function decodePayload(encoded: string): LicensePayload | null {
  try {
    return parseLicensePayload(JSON.parse(Buffer.from(encoded, "base64url").toString("utf8")));
  } catch {
    return null;
  }
}

function signedText(encodedPayload: string): Buffer {
  return Buffer.from(`${LICENSE_TOKEN_PREFIX}.${encodedPayload}`, "ascii");
}

function assertEd25519PublicKey(key: KeyObject): void {
  if (key.type !== "public" || key.asymmetricKeyType !== "ed25519") {
    throw new TypeError("An Ed25519 public key is required.");
  }
}

/**
 * Verify a token offline against `publicKey`. Checks, in order: the format,
 * the Ed25519 signature, the payload, and (when `installationId` is given) the
 * installation binding. Nothing here expires.
 */
export function verifyLicenseToken(
  token: string,
  publicKey: KeyObject,
  options: { installationId?: string } = {},
): LicenseVerification {
  assertEd25519PublicKey(publicKey);
  const normalized = normalizeLicenseToken(token);
  if (normalized.length > MAX_LICENSE_TOKEN_LENGTH) {
    return { ok: false, reason: "malformed" };
  }
  const parts = normalized.split(".");
  const [prefix, encoded, signature] = parts;
  if (
    parts.length !== 3 ||
    prefix !== LICENSE_TOKEN_PREFIX ||
    !encoded ||
    !signature ||
    !BASE64URL_PATTERN.test(encoded) ||
    !BASE64URL_PATTERN.test(signature)
  ) {
    return { ok: false, reason: "malformed" };
  }
  const signatureBytes = Buffer.from(signature, "base64url");
  if (signatureBytes.length !== SIGNATURE_BYTES) {
    return { ok: false, reason: "malformed" };
  }
  if (!verify(null, signedText(encoded), publicKey, signatureBytes)) {
    return { ok: false, reason: "bad_signature" };
  }
  const payload = decodePayload(encoded);
  if (!payload) {
    return { ok: false, reason: "invalid_payload" };
  }
  const license: VerifiedLicense = {
    edition: payload.edition,
    multiTenant: payload.multi_tenant,
    licensee: payload.licensee.trim(),
    installationId: payload.installation_id.trim(),
    issuedAt: new Date(payload.issued_at),
    signature: signatureBytes.toString("base64url"),
    keyId: licenseKeyId(signature),
  };
  if (
    options.installationId !== undefined &&
    !sameInstallation(license.installationId, options.installationId)
  ) {
    return { ok: false, reason: "installation_mismatch", license };
  }
  return { ok: true, license };
}

/** Installation ids are UUIDs; letter case carries no meaning. */
function sameInstallation(a: string, b: string): boolean {
  return a.trim().toLowerCase() === b.trim().toLowerCase();
}
