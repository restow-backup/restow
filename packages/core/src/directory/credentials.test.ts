import { describe, expect, it } from "vitest";
import { appCredentialsFrom, splitCertificatePem } from "./credentials.js";

// Structural placeholders only: the blocks are never parsed as real key material here.
const KEY = "-----BEGIN PRIVATE KEY-----\nAAAA\n-----END PRIVATE KEY-----";
const CERT = "-----BEGIN CERTIFICATE-----\nBBBB\n-----END CERTIFICATE-----";

describe("splitCertificatePem", () => {
  it("finds key and certificate in either order", () => {
    expect(splitCertificatePem(`${KEY}\n${CERT}\n`)).toEqual({
      privateKeyPem: KEY,
      certificatePem: CERT,
    });
    expect(splitCertificatePem(`${CERT}\n${KEY}`)).toEqual({
      privateKeyPem: KEY,
      certificatePem: CERT,
    });
    expect(splitCertificatePem(CERT)).toBeNull();
  });
});

describe("appCredentialsFrom", () => {
  it("requires a client id", () => {
    expect(
      appCredentialsFrom({ clientId: " ", clientSecret: "s", certificatePem: undefined }),
    ).toMatchObject({ ok: false, problem: "client_id_missing" });
  });

  it("prefers the certificate and hands over the separated blocks", () => {
    const result = appCredentialsFrom({
      clientId: "app",
      clientSecret: "s",
      certificatePem: `${CERT}\n${KEY}`,
      authorityHost: " ",
    });
    expect(result).toEqual({
      ok: true,
      credentials: {
        clientId: "app",
        credential: { type: "certificate", privateKeyPem: KEY, certificatePem: CERT },
        authorityHost: undefined,
      },
    });
  });

  it("explains an unusable certificate file instead of falling back silently", () => {
    const result = appCredentialsFrom({ clientId: "app", clientSecret: "s", certificatePem: CERT });
    expect(result).toMatchObject({ ok: false, problem: "credential_missing" });
    expect(result.ok ? "" : result.detail).toContain("private key");
  });

  it("uses the client secret when no certificate is configured", () => {
    expect(
      appCredentialsFrom({ clientId: "app", clientSecret: "s", certificatePem: undefined }),
    ).toMatchObject({
      ok: true,
      credentials: { credential: { type: "secret", clientSecret: "s" } },
    });
    expect(
      appCredentialsFrom({ clientId: "app", clientSecret: undefined, certificatePem: undefined }),
    ).toMatchObject({ ok: false, problem: "credential_missing" });
  });
});
