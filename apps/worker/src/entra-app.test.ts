import { randomBytes, randomUUID } from "node:crypto";
import {
  EntraAppResolver,
  FetchGraphClient,
  Keyring,
  type StorageBackend,
  createMemoryJobContext,
  deriveInstallationSecretsKey,
  generateDek,
  sealSecret,
  serializeEntraAppDocument,
} from "@restow/core";
import type { Database, Source } from "@restow/db";
import { describe, expect, it } from "vitest";
import { configureEntraApp, processEntraApp } from "./entra-app.js";
import { graphClientForSource } from "./handlers/directory.js";
import { InvalidPayloadError, type WorkerJobContext } from "./handlers/framework.js";

/**
 * The worker's side of the app registration: the process-wide resolver reads
 * the sealed `entra_app` row on the installation pool, and the handlers build
 * their Graph clients from what it resolves at the time of use.
 */

const TENANT = "0f6e4b4e-2f2a-4d9a-9c2b-1a2b3c4d5e6f";
const CLIENT_ID = "11111111-2222-3333-4444-555555555555";
const masterKey = randomBytes(32).toString("base64");

function sealedRow(clientSecret: string) {
  const id = randomUUID();
  const key = deriveInstallationSecretsKey(Buffer.from(masterKey, "base64"));
  const document = serializeEntraAppDocument({
    clientId: CLIENT_ID,
    credentialKind: "secret",
    clientSecret,
    secretExpiresAt: null,
    homeTenantId: null,
    authorityHost: null,
    updatedAt: "2026-09-20T08:00:00.000Z",
    updatedBy: "admin@provider.test",
  });
  return {
    id,
    kind: "entra_app",
    ciphertext: sealSecret(key, id, document),
    keyVersion: 1,
    updatedAt: new Date("2026-09-20T08:00:00.000Z"),
  };
}

/** An installation pool whose select chain answers with `rows` (and records that it ran). */
function installationPool(rows: () => unknown[]) {
  const calls = { selects: 0 };
  const chain = (): unknown =>
    new Proxy(() => undefined, {
      get: (_target, property) =>
        property === "then"
          ? (resolve: (value: unknown) => void) => resolve(rows())
          : () => chain(),
    });
  const db = {
    select: () => {
      calls.selects += 1;
      return chain();
    },
  };
  return { db: db as unknown as Database, calls };
}

function m365Source(overrides: Partial<Source> = {}): Source {
  const at = new Date(Date.UTC(2026, 0, 1));
  return {
    id: randomUUID(),
    tenantId: TENANT,
    kind: "m365",
    name: "Contoso",
    status: "active",
    errorMessage: null,
    failure: null,
    lastSyncAt: null,
    entraTenantId: "contoso.onmicrosoft.com",
    consentGrantedAt: at,
    consentBy: null,
    permissionsVerified: null,
    host: null,
    port: null,
    security: null,
    username: null,
    secretRef: null,
    config: {},
    createdAt: at,
    updatedAt: at,
    ...overrides,
  };
}

function jobContext(): WorkerJobContext {
  const base = createMemoryJobContext({
    tenantId: TENANT,
    jobId: randomUUID(),
    keys: new Keyring(TENANT, [generateDek(1)]),
    // Building a Graph client never touches storage.
    storage: { primary: {} as StorageBackend, copies: [] },
  });
  return { ...base, db: {} as Database, protectedObject: null };
}

describe("the process-wide registration", () => {
  it("opens the registration saved in the web UI from the installation pool", async () => {
    const pool = installationPool(() => [sealedRow("saved-secret")]);
    configureEntraApp({ providerDb: pool.db, masterKey, env: {} });
    const resolution = await processEntraApp.resolve();
    expect(resolution.status === "ready" && resolution.app.credentials).toEqual({
      clientId: CLIENT_ID,
      credential: { type: "secret", clientSecret: "saved-secret" },
    });
    expect(pool.calls.selects).toBe(1);
  });

  it("does not look into the database when the environment configures the app", async () => {
    const pool = installationPool(() => [sealedRow("saved-secret")]);
    configureEntraApp({
      providerDb: pool.db,
      masterKey,
      env: { ENTRA_CLIENT_ID: CLIENT_ID, ENTRA_CLIENT_SECRET: "env-secret" },
    });
    const resolution = await processEntraApp.resolve();
    expect(resolution.status === "ready" && resolution.app.source).toBe("environment");
    expect(pool.calls.selects).toBe(0);
  });
});

describe("directory sync credentials", () => {
  const lookup = (rows: unknown[]) =>
    new EntraAppResolver({
      environment: {},
      loadStored: async () => (rows[0] as never) ?? null,
      installationKey: () => deriveInstallationSecretsKey(Buffer.from(masterKey, "base64")),
    });

  it("builds the Graph client from the resolved registration", async () => {
    const client = await graphClientForSource(
      m365Source(),
      jobContext(),
      () => undefined,
      lookup([sealedRow("saved-secret")]),
    );
    expect(client).toBeInstanceOf(FetchGraphClient);
  });

  it("rejects without retry while no registration exists", async () => {
    const attempt = graphClientForSource(m365Source(), jobContext(), () => undefined, lookup([]));
    await expect(attempt).rejects.toBeInstanceOf(InvalidPayloadError);
    await expect(attempt).rejects.toThrow(/Settings → Microsoft 365/);
  });
});
