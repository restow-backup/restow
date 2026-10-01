import { X509Certificate, createPrivateKey } from "node:crypto";
import { describe, expect, it } from "vitest";
import {
  describeCertificate,
  inspectCertificatePem,
  normalizePrivateKeyPem,
} from "./certificate.js";
import { createTestCertificate } from "./testing/certificate.js";

const DAY = 24 * 60 * 60 * 1000;

describe("inspectCertificatePem", () => {
  const valid = createTestCertificate({ commonName: "Restow" });

  it("accepts key and certificate in either order and describes the certificate", () => {
    const result = inspectCertificatePem(`${valid.certificatePem}${valid.keyPem}`);
    expect(result.ok).toBe(true);
    if (!result.ok) {
      return;
    }
    const expected = new X509Certificate(valid.certificatePem);
    expect(result.info.thumbprint).toBe(expected.fingerprint.replace(/:/g, ""));
    expect(result.info.subject).toBe("CN=Restow");
    expect(result.info.notAfter).toBe(new Date(expected.validTo).toISOString());
    expect(result.privateKeyPem).toContain("BEGIN PRIVATE KEY");
    expect(result.certificatePem).toContain("BEGIN CERTIFICATE");
  });

  it("names what is missing", () => {
    expect(inspectCertificatePem(valid.keyPem)).toEqual({
      ok: false,
      problem: "certificate_missing",
    });
    expect(inspectCertificatePem(valid.certificatePem)).toEqual({
      ok: false,
      problem: "private_key_missing",
    });
    const encrypted = createPrivateKey(valid.keyPem)
      .export({ type: "pkcs8", format: "pem", cipher: "aes-256-cbc", passphrase: "pass" })
      .toString();
    expect(inspectCertificatePem(`${encrypted}${valid.certificatePem}`)).toEqual({
      ok: false,
      problem: "private_key_encrypted",
    });
  });

  it("rejects garbage, foreign keys and non-RSA keys", () => {
    const garbage = "-----BEGIN CERTIFICATE-----\nAAAA\n-----END CERTIFICATE-----\n";
    expect(inspectCertificatePem(`${valid.keyPem}${garbage}`)).toMatchObject({
      problem: "certificate_invalid",
    });
    const brokenKey = "-----BEGIN PRIVATE KEY-----\nAAAA\n-----END PRIVATE KEY-----\n";
    expect(inspectCertificatePem(`${brokenKey}${valid.certificatePem}`)).toMatchObject({
      problem: "private_key_invalid",
    });
    const other = createTestCertificate();
    expect(inspectCertificatePem(`${other.keyPem}${valid.certificatePem}`)).toMatchObject({
      problem: "key_mismatch",
    });
    const ec = createTestCertificate({ keyType: "ec" });
    expect(inspectCertificatePem(ec.combinedPem)).toMatchObject({
      problem: "unsupported_key_type",
    });
  });

  it("rejects certificates outside their validity", () => {
    const expired = createTestCertificate({
      notBefore: new Date(Date.now() - 400 * DAY),
      notAfter: new Date(Date.now() - DAY),
    });
    expect(inspectCertificatePem(expired.combinedPem)).toMatchObject({ problem: "expired" });
    const future = createTestCertificate({
      notBefore: new Date(Date.now() + 10 * DAY),
      notAfter: new Date(Date.now() + 400 * DAY),
    });
    expect(inspectCertificatePem(future.combinedPem)).toMatchObject({ problem: "not_yet_valid" });
  });

  it("understands validity dates beyond 2049 (GeneralizedTime)", () => {
    const long = createTestCertificate({ notAfter: new Date("2051-01-01T00:00:00Z") });
    const result = inspectCertificatePem(long.combinedPem);
    expect(result.ok && result.info.notAfter).toBe("2051-01-01T00:00:00.000Z");
  });
});

describe("describeCertificate / normalizePrivateKeyPem", () => {
  it("describe what parses and leave the rest alone", () => {
    const certificate = createTestCertificate();
    expect(describeCertificate(certificate.certificatePem)?.thumbprint).toMatch(/^[0-9A-F]{40}$/);
    expect(
      describeCertificate("-----BEGIN CERTIFICATE-----\nAAAA\n-----END CERTIFICATE-----"),
    ).toBe(null);
    const pkcs1 = certificate.privateKey.export({ type: "pkcs1", format: "pem" }).toString();
    expect(normalizePrivateKeyPem(pkcs1)).toContain("BEGIN PRIVATE KEY");
    expect(normalizePrivateKeyPem("not a key")).toBe("not a key");
  });
});
