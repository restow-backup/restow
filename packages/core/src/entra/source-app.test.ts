import { describe, expect, it } from "vitest";
import { buildSourceApp, parseSourceAppSecret, serializeSourceAppDocument } from "./source-app.js";

const tenant = "4F87BBA3-94BE-4E93-B8CC-8AAC907AAF54";
const client = "486a2769-5d9c-402a-8a83-c3bc9b980e47";

describe("buildSourceApp", () => {
  it("builds a secret app and lower-cases the ids", () => {
    const built = buildSourceApp({
      tenantId: ` ${tenant} `,
      clientId: client.toUpperCase(),
      credentialKind: "secret",
      clientSecret: " s3cret ",
    });
    expect(built).toMatchObject({
      ok: true,
      tenantId: tenant.toLowerCase(),
      document: { version: 1, clientId: client, credentialKind: "secret", clientSecret: "s3cret" },
      credentials: { clientId: client, credential: { type: "secret", clientSecret: "s3cret" } },
    });
  });

  it.each([
    [{ tenantId: "contoso.com" }, "tenant_id"],
    [{ clientId: "not-a-guid" }, "client_id"],
    [{ clientSecret: "  " }, "credential"],
    [{ authorityHost: "https://evil.example" }, "authority_host"],
  ])("refuses %j", (override, problem) => {
    const built = buildSourceApp({
      tenantId: tenant,
      clientId: client,
      credentialKind: "secret",
      clientSecret: "x",
      ...override,
    });
    expect(built).toEqual({ ok: false, problem });
  });

  it("refuses a certificate that is not a PEM with key and certificate", () => {
    expect(
      buildSourceApp({
        tenantId: tenant,
        clientId: client,
        credentialKind: "certificate",
        certificatePem: "garbage",
      }),
    ).toEqual({ ok: false, problem: "certificate" });
  });
});

describe("parseSourceAppSecret", () => {
  it("reads a sealed document back", () => {
    const text = serializeSourceAppDocument({
      version: 1,
      clientId: client,
      credentialKind: "secret",
      clientSecret: "s3cret",
      authorityHost: "https://login.microsoftonline.us",
    });
    expect(parseSourceAppSecret(text)).toEqual({
      clientId: client,
      credential: { type: "secret", clientSecret: "s3cret" },
      authorityHost: "https://login.microsoftonline.us",
    });
  });

  it("answers null for the older plain client secret", () => {
    expect(parseSourceAppSecret("plain-secret-value")).toBeNull();
    expect(parseSourceAppSecret("{not json")).toBeNull();
  });

  it("names a damaged document without quoting it", () => {
    expect(() => parseSourceAppSecret(JSON.stringify({ version: 1, clientId: client }))).toThrow(
      "lacks its credential",
    );
    expect(() => parseSourceAppSecret(JSON.stringify({ version: 1 }))).toThrow("no client id");
  });
});
