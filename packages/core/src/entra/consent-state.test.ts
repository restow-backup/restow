import { createHmac } from "node:crypto";
import { describe, expect, it } from "vitest";
import {
  DEFAULT_CONSENT_STATE_TTL_MS,
  SIGN_IN_STATE_TTL_MS,
  consentStateKey,
  signConsentState,
  verifyConsentState,
} from "./consent-state.js";

const secret = "a-long-application-secret-that-is-never-logged";
const ids = {
  tenantId: "0b3f6b2e-9c2d-4c3a-9e7f-1d2c3b4a5f60",
  sourceId: "7d8e9f00-1111-2222-3333-444455556666",
};

describe("signConsentState / verifyConsentState", () => {
  it("round-trips a payload bound to tenant and source", () => {
    const { state, payload } = signConsentState(secret, ids, {
      now: () => 1_000_000,
      nonce: () => "nonce-1",
    });
    expect(payload).toEqual({
      ...ids,
      phase: "consent",
      entraTenantId: null,
      nonce: "nonce-1",
      issuedAt: 1_000_000,
      expiresAt: 1_000_000 + DEFAULT_CONSENT_STATE_TTL_MS,
    });
    const verified = verifyConsentState(secret, state, { now: () => 1_000_001 });
    expect(verified).toEqual({ ok: true, payload });
  });

  it("produces URL-safe states that differ per link", () => {
    const a = signConsentState(secret, ids).state;
    const b = signConsentState(secret, ids).state;
    expect(a).not.toBe(b);
    expect(a).toMatch(/^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/);
  });

  it("rejects a tampered payload", () => {
    const { state } = signConsentState(secret, ids);
    const [encoded, signature] = state.split(".") as [string, string];
    const tampered = JSON.parse(Buffer.from(encoded, "base64url").toString("utf8")) as Record<
      string,
      unknown
    >;
    tampered.sourceId = "00000000-0000-0000-0000-000000000000";
    const forged = `${Buffer.from(JSON.stringify(tampered)).toString("base64url")}.${signature}`;
    expect(verifyConsentState(secret, forged)).toEqual({ ok: false, reason: "bad_signature" });
  });

  it("rejects a state signed with another secret", () => {
    const { state } = signConsentState("other-secret", ids);
    expect(verifyConsentState(secret, state)).toEqual({ ok: false, reason: "bad_signature" });
  });

  it("rejects expired states", () => {
    const { state } = signConsentState(secret, ids, { now: () => 5_000, ttlMs: 1_000 });
    expect(verifyConsentState(secret, state, { now: () => 5_999 }).ok).toBe(true);
    expect(verifyConsentState(secret, state, { now: () => 6_000 })).toEqual({
      ok: false,
      reason: "expired",
    });
  });

  it("rejects malformed input without throwing", () => {
    expect(verifyConsentState(secret, null)).toEqual({ ok: false, reason: "malformed" });
    expect(verifyConsentState(secret, "")).toEqual({ ok: false, reason: "malformed" });
    expect(verifyConsentState(secret, "no-dot")).toEqual({ ok: false, reason: "malformed" });
    expect(verifyConsentState(secret, "trailing.")).toEqual({ ok: false, reason: "malformed" });
    expect(verifyConsentState(secret, "abc.def")).toEqual({ ok: false, reason: "bad_signature" });
  });

  it("rejects a correctly signed but structurally invalid payload", () => {
    const key = consentStateKey(secret);
    const encoded = Buffer.from(JSON.stringify({ tenantId: "t" })).toString("base64url");
    const signature = createHmac("sha256", key).update(encoded).digest("base64url");
    expect(verifyConsentState(secret, `${encoded}.${signature}`)).toEqual({
      ok: false,
      reason: "malformed",
    });
  });

  it("refuses an empty secret", () => {
    expect(() => signConsentState("", ids)).toThrow(/secret/);
  });
});

describe("sign-in leg", () => {
  const entraTenantId = "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee";

  it("carries the claimed Entra tenant and a short lifetime", () => {
    const { state, payload } = signConsentState(
      secret,
      { ...ids, phase: "signin", entraTenantId },
      { now: () => 1_000, nonce: () => "n" },
    );
    expect(payload).toEqual({
      ...ids,
      phase: "signin",
      entraTenantId,
      nonce: "n",
      issuedAt: 1_000,
      expiresAt: 1_000 + SIGN_IN_STATE_TTL_MS,
    });
    expect(verifyConsentState(secret, state, { now: () => 2_000 })).toEqual({ ok: true, payload });
  });

  it("refuses a sign-in state without the claimed tenant", () => {
    expect(() => signConsentState(secret, { ...ids, phase: "signin" })).toThrow(/Entra tenant/);
  });

  it("never lets a consent state carry a tenant", () => {
    const { payload } = signConsentState(secret, { ...ids, entraTenantId });
    expect(payload.entraTenantId).toBeNull();
  });

  function signRaw(body: Record<string, unknown>): string {
    const encoded = Buffer.from(JSON.stringify(body)).toString("base64url");
    const signature = createHmac("sha256", consentStateKey(secret))
      .update(encoded)
      .digest("base64url");
    return `${encoded}.${signature}`;
  }

  it("reads links issued before states named their phase as consent links", () => {
    const legacy = signRaw({ ...ids, nonce: "n", issuedAt: 1, expiresAt: 10 });
    expect(verifyConsentState(secret, legacy, { now: () => 5 })).toEqual({
      ok: true,
      payload: {
        ...ids,
        phase: "consent",
        entraTenantId: null,
        nonce: "n",
        issuedAt: 1,
        expiresAt: 10,
      },
    });
  });

  it("rejects unknown phases and sign-in states without a tenant", () => {
    const base = { ...ids, nonce: "n", issuedAt: 1, expiresAt: 10 };
    expect(
      verifyConsentState(secret, signRaw({ ...base, phase: "other" }), { now: () => 5 }),
    ).toEqual({ ok: false, reason: "malformed" });
    expect(
      verifyConsentState(secret, signRaw({ ...base, phase: "signin" }), { now: () => 5 }),
    ).toEqual({ ok: false, reason: "malformed" });
  });
});
