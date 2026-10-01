import { randomBytes, randomUUID } from "node:crypto";
import {
  type EntraAppDocument,
  type EntraAppResolution,
  EntraAppResolver,
  type StoredEntraAppRow,
  deriveInstallationSecretsKey,
  sealSecret,
  serializeEntraAppDocument,
} from "@restow/core";
import { afterEach, describe, expect, it, vi } from "vitest";
import { loadConfig } from "../../config.js";
import { ProblemError } from "../../problem.js";
import {
  entraAppStatus,
  entraCredentialProblems,
  entraEnvironmentOf,
  entraProblems,
  invalidateEntraApp,
  requireEntraApp,
  setEntraAppResolver,
  tokenProviderFor,
} from "./entra.js";

const clientId = "11111111-2222-3333-4444-555555555555";
const origin = "https://restow.example.com";

const ready = (source: "environment" | "database" = "database"): EntraAppResolution => ({
  status: "ready",
  app: {
    source,
    credentials: { clientId, credential: { type: "secret", clientSecret: "x" } },
    credentialKind: "secret",
    expiresAt: null,
    certificate: null,
    homeTenantId: null,
    updatedAt: null,
    updatedBy: null,
    fingerprint: "f",
  },
});

describe("entra configuration status", () => {
  it("names everything that is missing on a bare installation", () => {
    const none: EntraAppResolution = { status: "none", clientId: null };
    expect(entraCredentialProblems(none)).toEqual(["no_client_id", "no_credential"]);
    expect(entraProblems(none, null)).toEqual(["no_client_id", "no_credential", "no_public_url"]);
    expect(entraAppStatus(none, null)).toEqual({
      configured: false,
      source: "none",
      clientId: null,
      credential: null,
      redirectUri: null,
      reasons: ["no_client_id", "no_credential", "no_public_url"],
    });
    expect(entraCredentialProblems({ status: "none", clientId })).toEqual(["no_credential"]);
  });

  it("is configured with a usable registration and a public origin", () => {
    expect(entraAppStatus(ready(), origin)).toEqual({
      configured: true,
      source: "database",
      clientId,
      credential: "secret",
      redirectUri: "https://restow.example.com/api/v1/sources/m365/consent/callback",
      reasons: [],
    });
  });

  it("says when a configured registration cannot be used", () => {
    const unusable: EntraAppResolution = {
      status: "unusable",
      source: "environment",
      clientId,
      reason: "certificate_unreadable",
      detail: "ENTRA_CLIENT_CERT_PATH could not be read (ENOENT).",
    };
    expect(entraAppStatus(unusable, origin)).toMatchObject({
      configured: false,
      source: "environment",
      clientId,
      reasons: ["credential_unusable"],
    });
  });

  it("reads the ENTRA_CLIENT_* values of the configuration", () => {
    const config = loadConfig({
      ENTRA_CLIENT_ID: clientId,
      ENTRA_CLIENT_CERT_PATH: "/etc/restow/entra.pem",
      ENTRA_AUTHORITY_HOST: "https://login.microsoftonline.us",
    });
    expect(entraEnvironmentOf(config)).toEqual({
      clientId,
      clientSecret: undefined,
      certificatePath: "/etc/restow/entra.pem",
      authorityHost: "https://login.microsoftonline.us",
    });
  });
});

describe("the registration in use", () => {
  const key = deriveInstallationSecretsKey(randomBytes(32));
  let stored: StoredEntraAppRow | null = null;
  let now = 0;

  function save(secret: string, at: string): void {
    const id = randomUUID();
    const document: EntraAppDocument = {
      clientId,
      credentialKind: "secret",
      clientSecret: secret,
      secretExpiresAt: null,
      homeTenantId: null,
      authorityHost: null,
      updatedAt: at,
      updatedBy: "admin@provider.test",
    };
    stored = {
      id,
      ciphertext: sealSecret(key, id, serializeEntraAppDocument(document)),
      updatedAt: at,
    };
  }

  function useResolver(): void {
    setEntraAppResolver(
      new EntraAppResolver({
        environment: {},
        loadStored: async () => stored,
        installationKey: () => key,
        ttlMs: 30_000,
        now: () => now,
      }),
    );
  }

  /** The token endpoint hands out a token naming the secret it was paid with. */
  function stubTokenEndpoint() {
    const secrets: string[] = [];
    vi.stubGlobal("fetch", async (_url: string, init?: RequestInit) => {
      const secret = new URLSearchParams(String(init?.body ?? "")).get("client_secret") ?? "";
      secrets.push(secret);
      return new Response(
        JSON.stringify({ access_token: `token-for-${secret}`, expires_in: 3600 }),
        {
          status: 200,
          headers: { "content-type": "application/json" },
        },
      );
    });
    return secrets;
  }

  afterEach(() => {
    vi.unstubAllGlobals();
    stored = null;
    setEntraAppResolver(null);
  });

  it("refuses with the 503 problem while nothing is configured", async () => {
    useResolver();
    const error = await requireEntraApp().catch((e: unknown) => e);
    expect(error).toBeInstanceOf(ProblemError);
    expect((error as ProblemError).status).toBe(503);
    expect((error as ProblemError).extensions).toEqual({
      reasons: ["no_client_id", "no_credential"],
    });
  });

  it("uses a saved change for the next token without a restart", async () => {
    const used = stubTokenEndpoint();
    save("first-secret", "2026-09-20T08:00:00.000Z");
    useResolver();
    const provider = tokenProviderFor("contoso.onmicrosoft.com");
    expect(await provider.getToken()).toBe("token-for-first-secret");
    expect(await provider.getToken()).toBe("token-for-first-secret");
    expect(used).toEqual(["first-secret"]);

    // This process saved the change: the cache is dropped at once.
    save("second-secret", "2026-09-21T08:00:00.000Z");
    invalidateEntraApp();
    expect(await provider.getToken()).toBe("token-for-second-secret");

    // Another process saved it: picked up once the resolver's TTL has passed.
    save("third-secret", "2026-09-22T08:00:00.000Z");
    now += 10_000;
    expect(await provider.getToken()).toBe("token-for-second-secret");
    now += 30_000;
    expect(await provider.getToken()).toBe("token-for-third-secret");
    expect(used).toEqual(["first-secret", "second-secret", "third-secret"]);
  });

  it("fetches a fresh token after invalidate", async () => {
    const used = stubTokenEndpoint();
    save("only-secret", "2026-09-20T08:00:00.000Z");
    useResolver();
    const provider = tokenProviderFor("fabrikam.onmicrosoft.com");
    await provider.getToken();
    provider.invalidate();
    await provider.getToken();
    expect(used).toEqual(["only-secret", "only-secret"]);
  });
});
