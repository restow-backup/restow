import { createHash, type KeyObject, verify } from "node:crypto";
import { isKeyedEdition, type KeyedEdition } from "./editions.js";
import { keyringOf, type LicenseKeyring, signingKeyFor } from "./keyring.js";

/**
 * License token format, version 1, and its offline verification. This build
 * only verifies keys: issuing them is the business of the private
 * restow-license repository, whose signing key never enters this one (tests
 * sign with a throwaway key, ../testing/test-signer.mjs).
 *
 *   restow-license-v1.<payload>.<signature>
 *
 * `<payload>` is the base64url encoded JSON object with the six required members
 *
 *   { "edition", "mailbox_limit", "multi_tenant", "licensee", "installation_id", "issued_at" }
 *
 * and the optional members `series`, `updates_until` and `kid` (0.4.5). Any other
 * member is ignored: the payload is signed, so a member a later issuer adds can
 * never have been slipped in, and a key carrying it still verifies on every
 * build from 0.4.5 on. The contract for the issuer is ee/licensing/KEY-FORMAT.md.
 *
 * (`mailbox_limit` is a reserved member of the v1 format: Restow has no mailbox
 * limit, newly issued keys carry `null`, and a value in an older key is accepted
 * and has no effect) and `<signature>` the base64url Ed25519 signature over the ASCII text
 * `restow-license-v1.<payload>` (prefix included, so a signature can never be
 * replayed into a future format). Tokens carry no expiry: a key is valid for
 * the lifetime of the installation, and verification never consults a clock or
 * a server. `updates_until` is no expiry either: it only says which releases the
 * key covers (./entitlement.ts), decided against a release date, never the clock.
 * Whitespace (line breaks from mail clients) is ignored.
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
  /**
   * Optional. The major version series the key covers without an update period
   * (`"1"`: every 1.x release and every 0.x pre-release). Absent or null: `"1"`.
   */
  series?: string | null;
  /**
   * Optional. Last day (`YYYY-MM-DD`, UTC) of the update period: releases made up to the
   * end of that day are covered. Absent or null: no period, the series decides.
   */
  updates_until?: string | null;
  /**
   * Optional. Identifier of the signing key (./keyring.ts `licenseSigningKeyId`).
   * Absent: the original vendor key, the one every key without `kid` is signed with.
   */
  kid?: string | null;
}

/** The series a key without `series` stands for: the beta licences, sold before 1.0. */
export const DEFAULT_LICENSE_SERIES = "1";

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
  /** The major version series the key covers; `"1"` for keys without the member. */
  series: string;
  /** Last day of the update period (`YYYY-MM-DD`), or null (the series decides). */
  updatesUntil: string | null;
  /** The `kid` the key named, or null for the original vendor key. */
  signingKeyId: string | null;
}

/** Why a token was not accepted. */
export type LicenseRejection =
  | "malformed"
  | "bad_signature"
  | "invalid_payload"
  | "installation_mismatch"
  /** The key names a signing key (`kid`) this build does not know: issued for a later release. */
  | "unknown_signing_key";

export type LicenseVerification =
  | { ok: true; license: VerifiedLicense }
  | { ok: false; reason: "installation_mismatch"; license: VerifiedLicense }
  | { ok: false; reason: Exclude<LicenseRejection, "installation_mismatch"> };

export const MAX_LICENSEE_LENGTH = 200;
export const MAX_INSTALLATION_ID_LENGTH = 200;
/** Far above any real token; bounds the work done on pasted input. */
export const MAX_LICENSE_TOKEN_LENGTH = 8192;

/** The required payload members, in their wire order. */
export const PAYLOAD_KEYS = [
  "edition",
  "mailbox_limit",
  "multi_tenant",
  "licensee",
  "installation_id",
  "issued_at",
] as const satisfies readonly (keyof LicensePayload)[];

const SERIES_PATTERN = /^(?:0|[1-9]\d{0,3})$/;
const DATE_PATTERN = /^(\d{4})-(\d{2})-(\d{2})$/;
/** What a `kid` may look like: short, printable, no separators of the token format. */
export const KID_PATTERN = /^[A-Za-z0-9_-]{1,64}$/;
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

/** A real calendar day `YYYY-MM-DD` (no 2027-02-30). */
export function isCalendarDate(value: unknown): value is string {
  if (typeof value !== "string") {
    return false;
  }
  const match = DATE_PATTERN.exec(value);
  if (!match) {
    return false;
  }
  const [year, month, day] = [Number(match[1]), Number(match[2]), Number(match[3])];
  const date = new Date(Date.UTC(year, month - 1, day));
  return (
    date.getUTCFullYear() === year && date.getUTCMonth() === month - 1 && date.getUTCDate() === day
  );
}

function isMailboxLimit(value: unknown): value is number | null {
  return value === null || (Number.isSafeInteger(value) && (value as number) > 0);
}

/**
 * Validate a decoded payload: the six required members present and well-typed,
 * a tenancy flag that matches the edition (only Service Provider is
 * multi-tenant), so a verified key can never state a contradiction, and the
 * optional members well-typed when present (null counts as absent). Members
 * this build does not know are ignored, so a later issuer can add one without
 * breaking any build from 0.4.5 on.
 */
export function parseLicensePayload(value: unknown): LicensePayload | null {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return null;
  }
  const record = value as Record<string, unknown>;
  if (!PAYLOAD_KEYS.every((key) => Object.hasOwn(record, key))) {
    return null;
  }
  const { edition, mailbox_limit, multi_tenant, licensee, installation_id, issued_at } = record;
  const series = record.series ?? null;
  const updatesUntil = record.updates_until ?? null;
  const kid = record.kid ?? null;
  if (
    (series !== null && (typeof series !== "string" || !SERIES_PATTERN.test(series))) ||
    (updatesUntil !== null && !isCalendarDate(updatesUntil)) ||
    (kid !== null && (typeof kid !== "string" || !KID_PATTERN.test(kid)))
  ) {
    return null;
  }
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
  return {
    edition,
    mailbox_limit,
    multi_tenant,
    licensee,
    installation_id,
    issued_at,
    series,
    updates_until: updatesUntil,
    kid,
  };
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

function decodeJson(encoded: string): unknown {
  try {
    return JSON.parse(Buffer.from(encoded, "base64url").toString("utf8"));
  } catch {
    return undefined;
  }
}

/** The `kid` a payload names, read before its signature is checked (only to pick the key). */
function claimedKid(decoded: unknown): string | null {
  if (typeof decoded !== "object" || decoded === null || Array.isArray(decoded)) {
    return null;
  }
  const kid = (decoded as Record<string, unknown>).kid;
  return typeof kid === "string" ? kid : null;
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
 * Verify a token offline against `keys`: one public key, or a keyring of the
 * known vendor keys (./keyring.ts). The key is the one the payload's `kid`
 * names, else the keyring's default key. Checks, in order: the format, the
 * signing key, the Ed25519 signature, the payload, and (when `installationId` is
 * given) the installation binding. Nothing here expires.
 */
export function verifyLicenseToken(
  token: string,
  keys: KeyObject | LicenseKeyring,
  options: { installationId?: string } = {},
): LicenseVerification {
  const keyring = "defaultKey" in keys ? keys : keyringOf(keys);
  assertEd25519PublicKey(keyring.defaultKey);
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
  const decoded = decodeJson(encoded);
  const publicKey = signingKeyFor(keyring, claimedKid(decoded));
  if (!publicKey) {
    return { ok: false, reason: "unknown_signing_key" };
  }
  assertEd25519PublicKey(publicKey);
  if (!verify(null, signedText(encoded), publicKey, signatureBytes)) {
    return { ok: false, reason: "bad_signature" };
  }
  const payload = decoded === undefined ? null : parseLicensePayload(decoded);
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
    series: payload.series ?? DEFAULT_LICENSE_SERIES,
    updatesUntil: payload.updates_until ?? null,
    signingKeyId: payload.kid ?? null,
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
