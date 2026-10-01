/**
 * Signed `state` for the admin-consent round trip.
 *
 * The consent link leaves Restow, the customer's Global Admin approves in
 * their tenant, and Entra redirects back with the `state` we sent. The
 * callback is public (no session — the admin who consents is usually not an
 * Restow user), so the state is the only thing binding the callback to the
 * Restow tenant and source that asked for it. It is an HMAC-signed, expiring
 * token; nothing in it is secret, but nothing in it can be forged either.
 *
 * The round trip has two legs, and every state names the one it belongs to:
 *
 *   consent — the admin-consent link. Entra's redirect *claims* a tenant id,
 *             unsigned; nothing is bound on that claim.
 *   signin  — the OIDC sign-in that proves the claim. It carries the claimed
 *             Entra tenant and its nonce, which the id_token must confirm.
 *
 * Format: `base64url(json payload) . base64url(HMAC-SHA256)`.
 */
import { createHmac, hkdfSync, randomBytes, timingSafeEqual } from "node:crypto";

/** Which leg of the consent round trip a state belongs to (see the module comment). */
export type ConsentStatePhase = "consent" | "signin";

export interface ConsentStatePayload {
  /** Restow tenant the source belongs to. */
  tenantId: string;
  /** The `sources` row that is being connected. */
  sourceId: string;
  phase: ConsentStatePhase;
  /** `signin` only: the Entra tenant the admin-consent redirect claimed; null for `consent`. */
  entraTenantId: string | null;
  /**
   * Random per-link value so two links for the same source are distinct; on
   * the `signin` leg it doubles as the OIDC nonce the id_token must echo.
   */
  nonce: string;
  /** Epoch milliseconds. */
  issuedAt: number;
  expiresAt: number;
}

/** A consent link is good for one hour; long enough to forward it to the customer admin. */
export const DEFAULT_CONSENT_STATE_TTL_MS = 60 * 60 * 1000;

/** The sign-in leg follows the consent immediately; ten minutes cover the Microsoft sign-in. */
export const SIGN_IN_STATE_TTL_MS = 10 * 60 * 1000;

const HKDF_INFO = "restow/entra-consent-state/v1";
const HKDF_SALT = "restow";
const KEY_LENGTH = 32;

/** Derive the signing key from an application secret so the raw secret is never used directly. */
export function consentStateKey(secret: string | Buffer): Buffer {
  const material = typeof secret === "string" ? Buffer.from(secret, "utf8") : secret;
  if (material.length === 0) {
    throw new Error("consent state secret must not be empty");
  }
  return Buffer.from(hkdfSync("sha256", material, HKDF_SALT, HKDF_INFO, KEY_LENGTH));
}

function sign(key: Buffer, encodedPayload: string): string {
  return createHmac("sha256", key).update(encodedPayload, "utf8").digest("base64url");
}

export interface SignConsentStateOptions {
  now?: () => number;
  ttlMs?: number;
  /** Injectable nonce source (tests). */
  nonce?: () => string;
}

export interface ConsentStateInput {
  tenantId: string;
  sourceId: string;
  /** Defaults to `consent`. */
  phase?: ConsentStatePhase;
  /** Required for the `signin` phase: the claimed Entra tenant id. */
  entraTenantId?: string | null;
}

/** Create a signed state for a tenant/source pair (and, on the sign-in leg, the claimed tenant). */
export function signConsentState(
  secret: string | Buffer,
  input: ConsentStateInput,
  options: SignConsentStateOptions = {},
): { state: string; payload: ConsentStatePayload } {
  const phase = input.phase ?? "consent";
  const entraTenantId = phase === "signin" ? (input.entraTenantId ?? null) : null;
  if (phase === "signin" && !entraTenantId) {
    throw new Error("a sign-in state must name the claimed Entra tenant");
  }
  const now = options.now?.() ?? Date.now();
  const defaultTtl = phase === "signin" ? SIGN_IN_STATE_TTL_MS : DEFAULT_CONSENT_STATE_TTL_MS;
  const payload: ConsentStatePayload = {
    tenantId: input.tenantId,
    sourceId: input.sourceId,
    phase,
    entraTenantId,
    nonce: options.nonce?.() ?? randomBytes(16).toString("base64url"),
    issuedAt: now,
    expiresAt: now + (options.ttlMs ?? defaultTtl),
  };
  const encoded = Buffer.from(JSON.stringify(payload), "utf8").toString("base64url");
  return { state: `${encoded}.${sign(consentStateKey(secret), encoded)}`, payload };
}

export type ConsentStateFailure = "malformed" | "bad_signature" | "expired";

export type ConsentStateVerification =
  | { ok: true; payload: ConsentStatePayload }
  | { ok: false; reason: ConsentStateFailure };

/**
 * The payload of a verified state, or null when its shape is wrong. Links
 * issued before states named their phase are consent links.
 */
function toPayload(value: unknown): ConsentStatePayload | null {
  if (value === null || typeof value !== "object") {
    return null;
  }
  const { tenantId, sourceId, nonce, issuedAt, expiresAt, ...rest } = value as Record<
    string,
    unknown
  >;
  const phase = rest.phase ?? "consent";
  const entraTenantId = rest.entraTenantId ?? null;
  if (
    !nonEmptyString(tenantId) ||
    !nonEmptyString(sourceId) ||
    !nonEmptyString(nonce) ||
    typeof issuedAt !== "number" ||
    typeof expiresAt !== "number"
  ) {
    return null;
  }
  if (phase === "consent") {
    return { tenantId, sourceId, phase, entraTenantId: null, nonce, issuedAt, expiresAt };
  }
  if (phase === "signin" && nonEmptyString(entraTenantId)) {
    return { tenantId, sourceId, phase, entraTenantId, nonce, issuedAt, expiresAt };
  }
  return null;
}

function nonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.length > 0;
}

/** Verify a state string; the signature is checked before anything is parsed. */
export function verifyConsentState(
  secret: string | Buffer,
  state: string | null | undefined,
  options: { now?: () => number } = {},
): ConsentStateVerification {
  if (typeof state !== "string") {
    return { ok: false, reason: "malformed" };
  }
  const separator = state.lastIndexOf(".");
  if (separator <= 0 || separator === state.length - 1) {
    return { ok: false, reason: "malformed" };
  }
  const encoded = state.slice(0, separator);
  const signature = state.slice(separator + 1);
  const expected = sign(consentStateKey(secret), encoded);
  const given = Buffer.from(signature, "utf8");
  const wanted = Buffer.from(expected, "utf8");
  if (given.length !== wanted.length || !timingSafeEqual(given, wanted)) {
    return { ok: false, reason: "bad_signature" };
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(Buffer.from(encoded, "base64url").toString("utf8"));
  } catch {
    return { ok: false, reason: "malformed" };
  }
  const payload = toPayload(parsed);
  if (!payload) {
    return { ok: false, reason: "malformed" };
  }
  const now = options.now?.() ?? Date.now();
  if (payload.expiresAt <= now) {
    return { ok: false, reason: "expired" };
  }
  return { ok: true, payload };
}
