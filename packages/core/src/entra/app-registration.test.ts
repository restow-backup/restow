import { randomBytes, randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import { deriveInstallationSecretsKey, sealSecret } from "../secret-seal.js";
import {
  type EntraAppDocument,
  EntraAppResolver,
  type EntraAppResolverOptions,
  type StoredEntraAppRow,
  appCredentialsFingerprint,
  entraAppCredentialsOf,
  entraAppEnvironmentFrom,
  environmentConfiguresEntraApp,
  environmentPartiallyConfigured,
  parseEntraAppDocument,
  serializeEntraAppDocument,
} from "./app-registration.js";
import { createTestCertificate } from "./testing/certificate.js";

const CLIENT_ID = "11111111-2222-3333-4444-555555555555";
const key = deriveInstallationSecretsKey(randomBytes(32));

function document(overrides: Partial<EntraAppDocument> = {}): EntraAppDocument {
  return {
    clientId: CLIENT_ID,
    credentialKind: "secret",
    clientSecret: "db-secret-value",
    secretExpiresAt: "2027-03-01T00:00:00.000Z",
    homeTenantId: "contoso.onmicrosoft.com",
    authorityHost: null,
    updatedAt: "2026-09-20T08:00:00.000Z",
    updatedBy: "admin@provider.test",
    ...overrides,
  };
}

/** A `secrets` row as the installation pool returns it, sealed like the API seals it. */
function row(doc: EntraAppDocument, updatedAt = new Date("2026-09-20T08:00:00Z")) {
  const id = randomUUID();
  return { id, ciphertext: sealSecret(key, id, serializeEntraAppDocument(doc)), updatedAt };
}

function resolver(
  options: Partial<EntraAppResolverOptions> & { stored?: () => StoredEntraAppRow | null } = {},
) {
  const counts = { loads: 0 };
  const instance = new EntraAppResolver({
    environment: {},
    installationKey: () => key,
    loadStored: async () => {
      counts.loads += 1;
      return options.stored?.() ?? null;
    },
    ...options,
  });
  return { instance, counts };
}

describe("environment", () => {
  it("counts only a client id with a credential as configured", () => {
    const env = entraAppEnvironmentFrom({
      ENTRA_CLIENT_ID: ` ${CLIENT_ID} `,
      ENTRA_CLIENT_SECRET: "",
      ENTRA_AUTHORITY_HOST: "https://login.microsoftonline.us",
    });
    expect(env).toEqual({
      clientId: CLIENT_ID,
      clientSecret: undefined,
      certificatePath: undefined,
      authorityHost: "https://login.microsoftonline.us",
    });
    expect(environmentConfiguresEntraApp(env)).toBe(false);
    expect(environmentPartiallyConfigured(env)).toBe(true);
    expect(environmentConfiguresEntraApp({ clientId: CLIENT_ID, clientSecret: "s" })).toBe(true);
    expect(environmentConfiguresEntraApp({ clientId: CLIENT_ID, certificatePath: "/p" })).toBe(
      true,
    );
    expect(environmentPartiallyConfigured({})).toBe(false);
  });
});

describe("EntraAppResolver precedence", () => {
  it("uses the environment first and never reads the database then", async () => {
    const { instance, counts } = resolver({
      environment: { clientId: CLIENT_ID, clientSecret: "env-secret" },
      stored: () => row(document()),
    });
    const resolution = await instance.resolve();
    expect(resolution.status).toBe("ready");
    if (resolution.status !== "ready") {
      return;
    }
    expect(resolution.app.source).toBe("environment");
    expect(resolution.app.credentials).toEqual({
      clientId: CLIENT_ID,
      credential: { type: "secret", clientSecret: "env-secret" },
    });
    expect(resolution.app.expiresAt).toBeNull();
    expect(counts.loads).toBe(0);
  });

  it("prefers the certificate file over the secret in the environment", async () => {
    const certificate = createTestCertificate();
    const read: string[] = [];
    const { instance } = resolver({
      environment: { clientId: CLIENT_ID, clientSecret: "s", certificatePath: "/run/entra.pem" },
      readTextFile: async (path) => {
        read.push(path);
        return certificate.combinedPem;
      },
    });
    const resolution = await instance.resolve();
    expect(read).toEqual(["/run/entra.pem"]);
    expect(resolution.status === "ready" && resolution.app.credentialKind).toBe("certificate");
    expect(resolution.status === "ready" && resolution.app.certificate?.thumbprint).toMatch(
      /^[0-9A-F]{40}$/,
    );
  });

  it("reports an unreadable or incomplete certificate file without its content", async () => {
    const missing = resolver({
      environment: { clientId: CLIENT_ID, certificatePath: "/nope.pem" },
      readTextFile: async () => {
        throw Object.assign(new Error("ENOENT: no such file"), { code: "ENOENT" });
      },
    });
    expect(await missing.instance.resolve()).toMatchObject({
      status: "unusable",
      source: "environment",
      reason: "certificate_unreadable",
      detail: "ENTRA_CLIENT_CERT_PATH could not be read (ENOENT).",
    });
    const incomplete = resolver({
      environment: { clientId: CLIENT_ID, certificatePath: "/half.pem" },
      readTextFile: async () => createTestCertificate().certificatePem,
    });
    expect(await incomplete.instance.resolve()).toMatchObject({
      status: "unusable",
      reason: "certificate_invalid",
    });
  });

  it("falls back to the saved document", async () => {
    const saved = row(document());
    const { instance } = resolver({ stored: () => saved });
    const resolution = await instance.resolve();
    expect(resolution).toMatchObject({
      status: "ready",
      app: {
        source: "database",
        credentialKind: "secret",
        credentials: {
          clientId: CLIENT_ID,
          credential: { type: "secret", clientSecret: "db-secret-value" },
        },
        expiresAt: "2027-03-01T00:00:00.000Z",
        homeTenantId: "contoso.onmicrosoft.com",
        updatedBy: "admin@provider.test",
      },
    });
  });

  it("resolves a saved certificate with its thumbprint and end of validity", async () => {
    const certificate = createTestCertificate();
    const saved = row(
      document({
        credentialKind: "certificate",
        clientSecret: undefined,
        certificatePem: certificate.combinedPem,
        secretExpiresAt: null,
        authorityHost: "https://login.microsoftonline.us",
      }),
    );
    const resolution = await resolver({ stored: () => saved }).instance.resolve();
    expect(resolution.status).toBe("ready");
    if (resolution.status === "ready") {
      expect(resolution.app.credentials.authorityHost).toBe("https://login.microsoftonline.us");
      expect(resolution.app.credentials.credential.type).toBe("certificate");
      expect(resolution.app.expiresAt).toBe(resolution.app.certificate?.notAfter);
    }
  });

  it("refuses a saved authority host outside the fixed list, even one saved before this check existed", async () => {
    const saved = row(document({ authorityHost: "https://login.example.evil" }));
    const resolution = await resolver({ stored: () => saved }).instance.resolve();
    expect(resolution).toMatchObject({
      status: "unusable",
      source: "database",
      clientId: CLIENT_ID,
      reason: "authority_host_invalid",
    });
    expect(JSON.stringify(resolution)).not.toContain("db-secret-value");
  });

  it("is none without either, keeping a lone ENTRA_CLIENT_ID for per-source secrets", async () => {
    expect(await resolver().instance.resolve()).toEqual({ status: "none", clientId: null });
    expect(await resolver({ environment: { clientId: CLIENT_ID } }).instance.resolve()).toEqual({
      status: "none",
      clientId: CLIENT_ID,
    });
  });

  it("reports a document it cannot open (another master key)", async () => {
    const saved = row(document());
    const other = resolver({
      stored: () => saved,
      installationKey: () => deriveInstallationSecretsKey(randomBytes(32)),
    });
    const resolution = await other.instance.resolve();
    expect(resolution).toMatchObject({ status: "unusable", reason: "document_unreadable" });
    expect(JSON.stringify(resolution)).not.toContain("db-secret-value");
  });
});

describe("EntraAppResolver cache", () => {
  it("reuses an answer within the TTL and notices a saved change after it", async () => {
    let now = 1_000;
    let current = row(document());
    const { instance, counts } = resolver({
      stored: () => current,
      ttlMs: 30_000,
      now: () => now,
    });
    const first = await instance.resolve();
    await instance.resolve();
    expect(counts.loads).toBe(1);

    current = row(document({ clientSecret: "rotated-secret" }), new Date("2026-09-21T08:00:00Z"));
    now += 29_000;
    expect(await instance.resolve()).toBe(first);
    now += 2_000;
    const second = await instance.resolve();
    expect(counts.loads).toBe(2);
    expect(second.status === "ready" && second.app.credentials.credential).toEqual({
      type: "secret",
      clientSecret: "rotated-secret",
    });
    if (first.status === "ready" && second.status === "ready") {
      expect(second.app.fingerprint).not.toBe(first.app.fingerprint);
    }
  });

  it("opens an unchanged row only once and forgets everything on invalidate", async () => {
    let now = 0;
    const saved = row(document());
    let opened = 0;
    const { instance, counts } = resolver({
      stored: () => saved,
      ttlMs: 10,
      now: () => now,
      installationKey: () => {
        opened += 1;
        return key;
      },
    });
    await instance.resolve();
    now += 20;
    await instance.resolve();
    expect(counts.loads).toBe(2);
    expect(opened).toBe(1);

    instance.invalidate();
    await instance.resolve();
    expect(counts.loads).toBe(3);
    expect(opened).toBe(2);
  });

  it("coalesces concurrent lookups", async () => {
    const { instance, counts } = resolver({ stored: () => row(document()) });
    await Promise.all([instance.resolve(), instance.resolve(), instance.resolve()]);
    expect(counts.loads).toBe(1);
  });
});

describe("documents and fingerprints", () => {
  it("round-trip and reject incomplete documents without echoing values", () => {
    const doc = document();
    expect(parseEntraAppDocument(serializeEntraAppDocument(doc))).toEqual(doc);
    expect(() => parseEntraAppDocument("{")).toThrow(/not valid JSON/);
    expect(() =>
      parseEntraAppDocument(JSON.stringify({ ...doc, clientSecret: undefined })),
    ).toThrow(/lacks its credential/);
    try {
      parseEntraAppDocument(JSON.stringify({ ...doc, credentialKind: "password" }));
    } catch (error) {
      expect(String(error)).not.toContain("db-secret-value");
    }
  });

  it("change with any part of the credential", () => {
    const app = {
      clientId: CLIENT_ID,
      credential: { type: "secret" as const, clientSecret: "a" },
    };
    const base = appCredentialsFingerprint(app);
    expect(appCredentialsFingerprint({ ...app })).toBe(base);
    expect(
      appCredentialsFingerprint({ ...app, credential: { type: "secret", clientSecret: "b" } }),
    ).not.toBe(base);
    expect(appCredentialsFingerprint({ ...app, authorityHost: "https://x.example" })).not.toBe(
      base,
    );
    expect(base).not.toContain('a"');
  });

  it("explain a missing registration in operator terms", () => {
    expect(entraAppCredentialsOf({ status: "none", clientId: null })).toEqual({
      ok: false,
      detail: expect.stringContaining("Settings → Microsoft 365"),
    });
  });
});
