import { generateKeyPairSync } from "node:crypto";
import { readFileSync } from "node:fs";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createTestLicenseSigner } from "../testing/test-signer.mjs";
import { keyringOf, licenseSigningKeyId } from "./keyring.js";
import { EMBEDDED_LICENSE_PUBLIC_KEY, parseLicensePublicKey } from "./public-key.js";
import {
  LICENSE_TOKEN_PREFIX,
  type LicensePayload,
  licenseKeyId,
  normalizeLicenseToken,
  PAYLOAD_KEYS,
  parseLicensePayload,
  verifyLicenseToken,
} from "./token.js";

const vendor = createTestLicenseSigner();
const stranger = createTestLicenseSigner();
const vendorKey = vendor.publicKeyObject;
const INSTALLATION = "7d3c1f0e-8a4b-4c2d-9e6f-1a2b3c4d5e6f";

function businessPayload(patch: Partial<LicensePayload> = {}): LicensePayload {
  return {
    ...(vendor.payload({
      edition: "business",
      licensee: "Example GmbH",
      installationId: INSTALLATION,
      issuedAt: new Date("2026-09-01T08:00:00.000Z"),
    }) as LicensePayload),
    ...patch,
  };
}

/** A token over a payload object, signed by the vendor's test key. */
function signed(payload: LicensePayload): string {
  return vendor.signPayload({ ...payload });
}

/** Sign arbitrary payload text, bypassing every check. */
function signRaw(payloadText: string): string {
  return vendor.signRaw(payloadText);
}

function flipCharacter(text: string, index: number): string {
  const current = text[index];
  const replacement = current === "A" ? "B" : "A";
  return `${text.slice(0, index)}${replacement}${text.slice(index + 1)}`;
}

afterEach(() => {
  vi.useRealTimers();
});

describe("verifyLicenseToken: valid keys", () => {
  it("accepts a key signed by the vendor and returns its terms", () => {
    const token = signed(businessPayload());
    const result = verifyLicenseToken(token, vendorKey, { installationId: INSTALLATION });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.license).toMatchObject({
      edition: "business",
      multiTenant: false,
      licensee: "Example GmbH",
      installationId: INSTALLATION,
    });
    expect(result.license.issuedAt.toISOString()).toBe("2026-09-01T08:00:00.000Z");
    expect(result.license.keyId).toMatch(/^[0-9A-F]{4}(-[0-9A-F]{4}){3}$/);
    expect(result.license.keyId).toBe(licenseKeyId(result.license.signature));
  });

  it("carries multi-tenancy for Service Provider", () => {
    const token = vendor.sign({
      edition: "service_provider",
      licensee: "MSP",
      installationId: INSTALLATION,
    });
    const result = verifyLicenseToken(token, vendorKey);

    expect(result.ok && result.license).toMatchObject({
      edition: "service_provider",
      multiTenant: true,
    });
  });

  it("accepts the reserved mailbox_limit member as null, as keys are issued today", () => {
    expect(businessPayload().mailbox_limit).toBeNull();
    expect(verifyLicenseToken(signed(businessPayload()), vendorKey).ok).toBe(true);
  });

  it("still accepts a key an older issuer gave a mailbox_limit, and the value has no effect", () => {
    const token = signed(businessPayload({ mailbox_limit: 250 }));
    const result = verifyLicenseToken(token, vendorKey, { installationId: INSTALLATION });

    expect(result.ok).toBe(true);
    expect(result.ok && "mailboxLimit" in result.license).toBe(false);
  });

  it("ignores whitespace a mail client wrapped into the key", () => {
    const token = signed(businessPayload());
    const wrapped = `  ${token.slice(0, 40)}\n${token.slice(40, 90)}\r\n\t${token.slice(90)}  `;

    expect(normalizeLicenseToken(wrapped)).toBe(token);
    expect(verifyLicenseToken(wrapped, vendorKey).ok).toBe(true);
  });

  it("never expires: an old key verifies with the clock far in the future", () => {
    const token = signed(businessPayload({ issued_at: "2019-01-01T00:00:00Z" }));
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2099-12-31T23:59:59Z"));

    expect(verifyLicenseToken(token, vendorKey).ok).toBe(true);
  });

  it("does not reject a key dated after the local clock (no time checks at all)", () => {
    const token = signed(businessPayload({ issued_at: "2030-06-01T00:00:00.000Z" }));
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-01-01T00:00:00Z"));

    expect(verifyLicenseToken(token, vendorKey).ok).toBe(true);
  });
});

describe("verifyLicenseToken: tampering", () => {
  const token = signed(businessPayload());
  const [prefix, payload, signature] = token.split(".") as [string, string, string];

  it("rejects a payload altered after signing", () => {
    const upgraded = Buffer.from(
      JSON.stringify({ ...businessPayload(), mailbox_limit: 100000 }),
      "utf8",
    ).toString("base64url");

    expect(verifyLicenseToken(`${prefix}.${upgraded}.${signature}`, vendorKey)).toEqual({
      ok: false,
      reason: "bad_signature",
    });
  });

  it("rejects a single flipped character in the payload", () => {
    const tampered = `${prefix}.${flipCharacter(payload, 10)}.${signature}`;
    expect(verifyLicenseToken(tampered, vendorKey)).toEqual({
      ok: false,
      reason: "bad_signature",
    });
  });

  it("rejects a flipped character in the signature", () => {
    const tampered = `${prefix}.${payload}.${flipCharacter(signature, 5)}`;
    expect(verifyLicenseToken(tampered, vendorKey)).toEqual({
      ok: false,
      reason: "bad_signature",
    });
  });

  it("rejects a key signed by anyone else", () => {
    const forged = stranger.signPayload({ ...businessPayload() });
    expect(verifyLicenseToken(forged, vendorKey)).toEqual({
      ok: false,
      reason: "bad_signature",
    });
  });

  it("binds the signature to the format prefix", () => {
    const replayed = `restow-license-v2.${payload}.${signature}`;
    expect(verifyLicenseToken(replayed, vendorKey)).toEqual({
      ok: false,
      reason: "malformed",
    });
  });
});

describe("verifyLicenseToken: malformed input", () => {
  const token = signed(businessPayload());
  const [, payload, signature] = token.split(".") as [string, string, string];

  it.each([
    ["an empty string", ""],
    ["random text", "hello world"],
    ["a missing prefix", `${payload}.${signature}`],
    ["an extra segment", `${token}.extra`],
    ["a non-base64url payload", `${LICENSE_TOKEN_PREFIX}.pay+load/.${signature}`],
    ["a truncated signature", `${LICENSE_TOKEN_PREFIX}.${payload}.${signature.slice(0, 40)}`],
    ["an oversized input", `${LICENSE_TOKEN_PREFIX}.${"A".repeat(9000)}.${signature}`],
  ])("rejects %s as malformed", (_label, input) => {
    expect(verifyLicenseToken(input, vendorKey)).toEqual({ ok: false, reason: "malformed" });
  });
});

describe("verifyLicenseToken: payload rules", () => {
  it("rejects a correctly signed payload that is not JSON", () => {
    expect(verifyLicenseToken(signRaw("not json"), vendorKey)).toEqual({
      ok: false,
      reason: "invalid_payload",
    });
  });

  it("ignores members it does not know (a later issuer may add some; the payload is signed)", () => {
    const text = JSON.stringify({
      ...businessPayload(),
      expires_at: "2027-01-01T00:00:00Z",
      seats: { kind: "unlimited" },
    });
    const result = verifyLicenseToken(signRaw(text), vendorKey);
    expect(result.ok).toBe(true);
    expect(result.ok && result.license).not.toHaveProperty("expires_at");
  });

  it("still requires every one of the six members", () => {
    for (const key of PAYLOAD_KEYS) {
      const { [key]: _dropped, ...rest } = businessPayload();
      expect(verifyLicenseToken(signRaw(JSON.stringify(rest)), vendorKey)).toEqual({
        ok: false,
        reason: "invalid_payload",
      });
    }
  });

  it("rejects a Community key (Community needs none)", () => {
    const text = JSON.stringify({ ...businessPayload(), edition: "community" });
    expect(verifyLicenseToken(signRaw(text), vendorKey)).toEqual({
      ok: false,
      reason: "invalid_payload",
    });
  });

  it("rejects a tenancy flag that contradicts the edition", () => {
    const text = JSON.stringify({ ...businessPayload(), multi_tenant: true });
    expect(verifyLicenseToken(signRaw(text), vendorKey)).toEqual({
      ok: false,
      reason: "invalid_payload",
    });
  });

  it("accepts the members in any order when the signature matches", () => {
    const { issued_at, ...rest } = businessPayload();
    const text = JSON.stringify({ issued_at, ...rest });
    expect(verifyLicenseToken(signRaw(text), vendorKey).ok).toBe(true);
  });
});

describe("verifyLicenseToken: installation binding", () => {
  const token = signed(businessPayload());

  it("rejects a key issued for another installation and says which one", () => {
    const result = verifyLicenseToken(token, vendorKey, {
      installationId: "00000000-0000-4000-8000-000000000000",
    });
    expect(result.ok).toBe(false);
    if (result.ok || result.reason !== "installation_mismatch") {
      throw new Error("expected an installation mismatch");
    }
    expect(result.license.installationId).toBe(INSTALLATION);
  });

  it("compares installation ids without regard to letter case", () => {
    const result = verifyLicenseToken(token, vendorKey, {
      installationId: INSTALLATION.toUpperCase(),
    });
    expect(result.ok).toBe(true);
  });

  it("skips the binding when no installation id is given", () => {
    expect(verifyLicenseToken(token, vendorKey).ok).toBe(true);
  });
});

describe("parseLicensePayload", () => {
  it.each([
    ["a zero mailbox limit", { mailbox_limit: 0 }],
    ["a fractional mailbox limit", { mailbox_limit: 2.5 }],
    ["an empty licensee", { licensee: "   " }],
    ["an empty installation id", { installation_id: "" }],
    ["a date without time zone", { issued_at: "2026-09-01T08:00:00" }],
    ["an impossible date", { issued_at: "2026-13-45T08:00:00Z" }],
  ])("rejects %s", (_label, patch) => {
    expect(parseLicensePayload({ ...businessPayload(), ...patch })).toBeNull();
  });

  it("rejects non-objects", () => {
    expect(parseLicensePayload(null)).toBeNull();
    expect(parseLicensePayload([businessPayload()])).toBeNull();
    expect(parseLicensePayload("business")).toBeNull();
  });
});

describe("verifyLicenseToken: verification key", () => {
  it("refuses a private key or a non-Ed25519 key for verification", () => {
    const token = signed(businessPayload());
    const rsa = generateKeyPairSync("rsa", { modulusLength: 1024 });
    const ed = generateKeyPairSync("ed25519");
    expect(() => verifyLicenseToken(token, ed.privateKey)).toThrow(TypeError);
    expect(() => verifyLicenseToken(token, rsa.publicKey)).toThrow(TypeError);
  });
});

describe("verifyLicenseToken: update terms (0.4.5)", () => {
  it("reads a key of before 0.4.5 as a beta licence: series 1, no update period, original key", () => {
    const result = verifyLicenseToken(signed(businessPayload()), vendorKey);
    expect(result.ok && result.license).toMatchObject({
      series: "1",
      updatesUntil: null,
      signingKeyId: null,
    });
  });

  it("reads series and updates_until of a key issued after 1.0", () => {
    const token = vendor.sign({
      edition: "business",
      licensee: "Example GmbH",
      installationId: INSTALLATION,
      series: "1",
      updatesUntil: "2027-11-30",
    });
    const result = verifyLicenseToken(token, vendorKey, { installationId: INSTALLATION });
    expect(result.ok && result.license).toMatchObject({ series: "1", updatesUntil: "2027-11-30" });
  });

  it("treats null optional members as absent", () => {
    const text = JSON.stringify({
      ...businessPayload(),
      series: null,
      updates_until: null,
      kid: null,
    });
    const result = verifyLicenseToken(signRaw(text), vendorKey);
    expect(result.ok && result.license).toMatchObject({
      series: "1",
      updatesUntil: null,
      signingKeyId: null,
    });
  });

  it.each([
    ["a numeric series", { series: 1 }],
    ["a series that is no major version", { series: "1.x" }],
    ["a series with a leading zero", { series: "01" }],
    ["an update period with a time", { updates_until: "2027-11-30T00:00:00Z" }],
    ["an impossible day", { updates_until: "2027-02-30" }],
    ["a numeric update period", { updates_until: 20271130 }],
    ["a kid that is no text", { kid: 7 }],
  ])("rejects %s", (_label, patch) => {
    expect(parseLicensePayload({ ...businessPayload(), ...patch })).toBeNull();
  });
});

describe("verifyLicenseToken: signing keys by kid", () => {
  const rotated = createTestLicenseSigner();
  const keyring = keyringOf(vendorKey, [rotated.publicKeyObject]);

  it("derives the kid from the public key", () => {
    expect(licenseSigningKeyId(vendorKey)).toBe(vendor.kid);
    expect(vendor.kid).toMatch(/^[0-9a-f]{16}$/);
  });

  it("verifies a key without kid against the default key", () => {
    expect(verifyLicenseToken(signed(businessPayload()), keyring).ok).toBe(true);
  });

  it("verifies a key naming a known kid against that key", () => {
    const token = rotated.sign({
      edition: "business",
      licensee: "Example GmbH",
      installationId: INSTALLATION,
      withKid: true,
    });
    const result = verifyLicenseToken(token, keyring);
    expect(result.ok && result.license.signingKeyId).toBe(rotated.kid);
  });

  it("refuses a key of a rotated signing key that names no kid", () => {
    const token = rotated.sign({
      edition: "business",
      licensee: "Example GmbH",
      installationId: INSTALLATION,
    });
    expect(verifyLicenseToken(token, keyring)).toEqual({ ok: false, reason: "bad_signature" });
  });

  it("refuses a kid this build does not know", () => {
    const token = stranger.sign({
      edition: "business",
      licensee: "Example GmbH",
      installationId: INSTALLATION,
      withKid: true,
    });
    expect(verifyLicenseToken(token, keyring)).toEqual({
      ok: false,
      reason: "unknown_signing_key",
    });
  });

  it("cannot be fooled by naming the kid of another key", () => {
    const text = JSON.stringify({ ...businessPayload(), kid: rotated.kid });
    // Signed by the vendor's default key, but claims the rotated one.
    expect(verifyLicenseToken(signRaw(text), keyring)).toEqual({
      ok: false,
      reason: "bad_signature",
    });
  });
});

describe("the contract for the issuer (KEY-FORMAT.md)", () => {
  const contract = readFileSync(new URL("../KEY-FORMAT.md", import.meta.url), "utf8");
  const examples = [...contract.matchAll(/```json\n([\s\S]*?)```/g)].map((match) =>
    JSON.parse(match[1] ?? ""),
  );

  it("has the four examples, and every one of them verifies as documented", () => {
    expect(examples).toHaveLength(4);
    for (const example of examples) {
      // The examples name the vendor's real key; the test signs with a throwaway one.
      if (example.kid) {
        expect(example.kid).toBe(
          licenseSigningKeyId(parseLicensePublicKey(EMBEDDED_LICENSE_PUBLIC_KEY)),
        );
        example.kid = vendor.kid;
      }
      const result = verifyLicenseToken(vendor.signRaw(JSON.stringify(example)), vendorKey);
      expect(result.ok, JSON.stringify(example)).toBe(true);
    }
    const [beta, , period] = examples.map((example) =>
      parseLicensePayload(example),
    ) as LicensePayload[];
    expect(beta?.updates_until).toBeNull();
    expect(beta?.series).toBeNull();
    expect(period?.updates_until).toBe("2029-01-15");
  });

  it("documents the beta key in the form builds up to 0.4.4 accept: exactly the six members", () => {
    expect(Object.keys(examples[0] ?? {}).sort()).toEqual([...PAYLOAD_KEYS].sort());
  });
});
