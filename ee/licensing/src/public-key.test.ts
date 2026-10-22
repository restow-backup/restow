import { generateKeyPairSync } from "node:crypto";
import { describe, expect, it } from "vitest";
import { createTestLicenseSigner } from "../testing/test-signer.mjs";
import { licenseSigningKeyId } from "./keyring.js";
import {
  EMBEDDED_LICENSE_PUBLIC_KEY,
  exportRawPublicKey,
  LICENSE_PUBLIC_KEY_ENV,
  LICENSE_PUBLIC_KEY_PLACEHOLDER,
  LicensePublicKeyError,
  parseLicensePublicKey,
  publicKeyFingerprint,
  resolveLicensePublicKey,
} from "./public-key.js";

/** `kid` of the vendor key of 2026-09-24, as KEY-FORMAT.md documents it. */
const EMBEDDED_KID = "9f58f8deb1a097c1";

const { publicKey } = generateKeyPairSync("ed25519");
const raw = exportRawPublicKey(publicKey);

describe("parseLicensePublicKey", () => {
  it("reads the raw key as base64url and as standard base64", () => {
    const standard = Buffer.from(raw, "base64url").toString("base64");
    expect(exportRawPublicKey(parseLicensePublicKey(raw))).toBe(raw);
    expect(exportRawPublicKey(parseLicensePublicKey(standard))).toBe(raw);
  });

  it("reads PEM and base64 DER SubjectPublicKeyInfo", () => {
    const pem = publicKey.export({ format: "pem", type: "spki" }).toString();
    const der = publicKey.export({ format: "der", type: "spki" }).toString("base64");
    expect(exportRawPublicKey(parseLicensePublicKey(pem))).toBe(raw);
    expect(exportRawPublicKey(parseLicensePublicKey(der))).toBe(raw);
  });

  it("rejects text that is no key, a wrong length and non-Ed25519 keys", () => {
    const rsa = generateKeyPairSync("rsa", { modulusLength: 1024 }).publicKey;
    const rsaPem = rsa.export({ format: "pem", type: "spki" }).toString();

    expect(() => parseLicensePublicKey("not a key!")).toThrow(LicensePublicKeyError);
    expect(() => parseLicensePublicKey(Buffer.alloc(16).toString("base64"))).toThrow(
      LicensePublicKeyError,
    );
    expect(() => parseLicensePublicKey(rsaPem)).toThrow(LicensePublicKeyError);
  });
});

describe("publicKeyFingerprint", () => {
  it("uses the OpenSSH SHA256 notation and is stable per key", () => {
    const fingerprint = publicKeyFingerprint(publicKey);
    expect(fingerprint).toMatch(/^SHA256:[A-Za-z0-9+/]{43}$/);
    expect(publicKeyFingerprint(parseLicensePublicKey(raw))).toBe(fingerprint);
  });
});

describe("resolveLicensePublicKey", () => {
  it("reports the placeholder key as unconfigured", () => {
    expect(resolveLicensePublicKey({}, LICENSE_PUBLIC_KEY_PLACEHOLDER)).toEqual({
      status: "unconfigured",
    });
    expect(
      resolveLicensePublicKey({ [LICENSE_PUBLIC_KEY_ENV]: "  " }, LICENSE_PUBLIC_KEY_PLACEHOLDER),
    ).toEqual({ status: "unconfigured" });
  });

  it("embeds the vendor's real verification key in this build", () => {
    expect(EMBEDDED_LICENSE_PUBLIC_KEY).not.toBe(LICENSE_PUBLIC_KEY_PLACEHOLDER);
    expect(resolveLicensePublicKey({})).toMatchObject({ status: "ready", source: "embedded" });
  });

  it("prefers the environment override over the embedded key", () => {
    const embedded = createTestLicenseSigner().publicKey;
    const resolved = resolveLicensePublicKey({ [LICENSE_PUBLIC_KEY_ENV]: raw }, embedded);
    expect(resolved.status === "ready" && resolved.source).toBe("environment");
    expect(resolved.status === "ready" && exportRawPublicKey(resolved.key)).toBe(raw);
  });

  it("uses a real embedded key when no override is set", () => {
    const embedded = createTestLicenseSigner();
    const resolved = resolveLicensePublicKey({}, embedded.publicKey);
    expect(resolved).toMatchObject({
      status: "ready",
      source: "embedded",
      fingerprint: publicKeyFingerprint(embedded.publicKeyObject),
    });
  });

  it("reports an unreadable override instead of falling back silently", () => {
    const embedded = createTestLicenseSigner().publicKey;
    expect(resolveLicensePublicKey({ [LICENSE_PUBLIC_KEY_ENV]: "typo" }, embedded)).toEqual({
      status: "invalid",
      source: "environment",
    });
  });
});

describe("resolveLicensePublicKey: keyring", () => {
  it("gives the embedded key as the default and adds the keys of a rotation", () => {
    const first = generateKeyPairSync("ed25519").publicKey;
    const second = generateKeyPairSync("ed25519").publicKey;
    const resolved = resolveLicensePublicKey({}, exportRawPublicKey(first), [
      exportRawPublicKey(second),
    ]);
    expect(resolved.status).toBe("ready");
    if (resolved.status !== "ready") return;
    expect(resolved.keyring.defaultKey.equals(first)).toBe(true);
    expect(resolved.keyring.byKid.get(licenseSigningKeyId(second))?.equals(second)).toBe(true);
    expect(resolved.keyring.byKid.size).toBe(2);
  });

  it("uses the override alone, without the embedded keys", () => {
    const override = generateKeyPairSync("ed25519").publicKey;
    const resolved = resolveLicensePublicKey({
      RESTOW_LICENSE_PUBLIC_KEY: exportRawPublicKey(override),
    });
    expect(resolved.status === "ready" && resolved.keyring.byKid.size).toBe(1);
  });

  it("names the kid of the embedded vendor key (ee/licensing/KEY-FORMAT.md)", () => {
    expect(licenseSigningKeyId(parseLicensePublicKey(EMBEDDED_LICENSE_PUBLIC_KEY))).toBe(
      EMBEDDED_KID,
    );
  });
});
