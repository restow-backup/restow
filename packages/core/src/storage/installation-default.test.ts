import { randomBytes } from "node:crypto";
import { describe, expect, it } from "vitest";
import { decryptChunk, encryptChunk } from "../crypto.js";
import { keyPrefix, manifestKey, packKey, tenantPrefix, wrappedKeyKey } from "../engine/layout.js";
import { MemorySecretReader } from "../engine/memory.js";
import { generateDek } from "../keyprovider.js";
import { deriveInstallationSecretsKey, sealSecret } from "../secret-seal.js";
import { MemoryStorage } from "../verify/testing.js";
import { resolveStorageTargets } from "./factory.js";
import {
  ENVIRONMENT_DEFAULT_GENERATION,
  InstallationDefaultResolver,
  type StoredInstallationDefaultRow,
  installationDefaultDocument,
  parseInstallationDefaultDocument,
  serializeInstallationDefaultDocument,
} from "./installation-default.js";

const KEY = deriveInstallationSecretsKey(randomBytes(32));
const AT = new Date("2026-10-01T08:00:00.000Z");
const ROW_ID = "3c2b1a09-8f7e-4d6c-9b5a-0f1e2d3c4b5a";

function sealedRow(plaintext: string, updatedAt: Date = AT): StoredInstallationDefaultRow {
  return { id: ROW_ID, ciphertext: sealSecret(KEY, ROW_ID, plaintext), updatedAt };
}

const S3_DOCUMENT = installationDefaultDocument(
  {
    kind: "s3",
    bucket: "restow-default",
    prefix: "prod",
    endpoint: "https://fsn1.your-objectstorage.com",
    region: "fsn1",
    forcePathStyle: false,
  },
  { accessKeyId: "AKIAEXAMPLE", secretAccessKey: "secret-example-key" },
  "owner@example.com",
  AT,
);

describe("installation default document", () => {
  it("round-trips through its JSON form", () => {
    const parsed = parseInstallationDefaultDocument(
      serializeInstallationDefaultDocument(S3_DOCUMENT),
    );
    expect(parsed).toEqual(S3_DOCUMENT);
  });

  it("drops credentials for a local path", () => {
    const document = installationDefaultDocument(
      { kind: "local", basePath: "/srv/restow" },
      { accessKeyId: "x", secretAccessKey: "y" },
      "owner@example.com",
      AT,
    );
    expect(document.credentials).toBeNull();
  });

  it("refuses a malformed document", () => {
    expect(() => parseInstallationDefaultDocument('{"version":2}')).toThrow();
  });
});

describe("InstallationDefaultResolver", () => {
  const env = { STORAGE_TARGET: "local", STORAGE_LOCAL_PATH: "/data/chunks" };

  it("uses the environment when nothing is saved", async () => {
    const resolver = new InstallationDefaultResolver({ env, loadStored: async () => null });
    const resolution = await resolver.resolve();
    expect(resolution).toMatchObject({
      status: "ready",
      source: "environment",
      generation: ENVIRONMENT_DEFAULT_GENERATION,
      storage: { primary: { kind: "local", basePath: "/data/chunks" } },
    });
  });

  it("prefers the saved default over the environment, keeping the environment's copy", async () => {
    const resolver = new InstallationDefaultResolver({
      env: { ...env, STORAGE_COPY_LOCAL_PATH: "/mnt/copy" },
      loadStored: async () => sealedRow(serializeInstallationDefaultDocument(S3_DOCUMENT)),
      installationKey: () => KEY,
    });
    const resolution = await resolver.resolve();
    expect(resolution.status).toBe("ready");
    if (resolution.status !== "ready") {
      return;
    }
    expect(resolution.source).toBe("database");
    expect(resolution.storage.primary).toMatchObject({ kind: "s3", bucket: "restow-default" });
    expect(resolution.storage.credentials?.accessKeyId).toBe("AKIAEXAMPLE");
    expect(resolution.storage.copy).toEqual({ kind: "local", basePath: "/mnt/copy" });
    expect(resolution.generation).toBe(`database:${ROW_ID}:${AT.toISOString()}`);
  });

  it("reports a document it cannot open instead of falling back to the environment", async () => {
    const other = deriveInstallationSecretsKey(randomBytes(32));
    const resolver = new InstallationDefaultResolver({
      env,
      loadStored: async () => sealedRow(serializeInstallationDefaultDocument(S3_DOCUMENT)),
      installationKey: () => other,
    });
    const resolution = await resolver.resolve();
    expect(resolution).toMatchObject({ status: "unusable", source: "database" });
    await expect(resolver.storage()).rejects.toThrow(/RESTOW_MASTER_KEY/);
  });

  it("caches answers and drops them when the stored generation changes", async () => {
    let row: StoredInstallationDefaultRow | null = null;
    let loads = 0;
    const resolver = new InstallationDefaultResolver({
      env,
      loadStored: async () => {
        loads += 1;
        return row;
      },
      installationKey: () => KEY,
      ttlMs: 60_000,
    });
    expect((await resolver.resolve()).source).toBe("environment");
    await resolver.resolve();
    expect(loads).toBe(1);

    row = sealedRow(serializeInstallationDefaultDocument(S3_DOCUMENT));
    // Still cached: the TTL has not run out.
    expect((await resolver.resolve()).source).toBe("environment");
    // A fresh generation read notices the change and drops the cache.
    expect(await resolver.generation()).toContain("database:");
    expect((await resolver.resolve()).source).toBe("database");
  });

  it("forgets its answer on invalidate", async () => {
    let target = "local";
    const resolver = new InstallationDefaultResolver({
      env: {
        get STORAGE_TARGET() {
          return target;
        },
        STORAGE_LOCAL_PATH: "/data/chunks",
      },
      ttlMs: 60_000,
    });
    expect((await resolver.resolve()).status).toBe("ready");
    target = "ftp";
    expect((await resolver.resolve()).status).toBe("ready");
    resolver.invalidate();
    expect((await resolver.resolve()).status).toBe("unusable");
  });
});

/**
 * Tenant separation on a shared default (docs/STORAGE.md, "Tenant separation on
 * the default"): every tenant without a primary target of its own resolves to
 * the very same backend, so the separation is the key layout plus the
 * per-tenant DEK, never a separate bucket or directory per tenant.
 */
describe("two tenants on the installation default", () => {
  // The second id starts with the first: a prefix check without the trailing slash would mix them.
  const tenantA = "5b6c7d8e-1a2b-4c3d-9e8f-0a1b2c3d4e5f";
  const tenantB = `${tenantA}0`;

  it("share the backend but resolve to disjoint key prefixes", async () => {
    const shared = new MemoryStorage();
    const defaults = { primary: shared, copies: [] };
    const secrets = new MemorySecretReader();
    const [a, b] = await Promise.all([
      resolveStorageTargets([], { secrets, defaults: async () => defaults }),
      resolveStorageTargets([], { secrets, defaults: async () => defaults }),
    ]);
    expect(a.primary).toBe(shared);
    expect(b.primary).toBe(shared);
    expect(a.usesInstallationDefault && b.usesInstallationDefault).toBe(true);

    const prefixA = tenantPrefix(tenantA);
    const prefixB = tenantPrefix(tenantB);
    expect(prefixA.startsWith(prefixB) || prefixB.startsWith(prefixA)).toBe(false);
    for (const key of [
      packKey(tenantA, "ab01"),
      manifestKey(tenantA, "snap-1"),
      wrappedKeyKey(tenantA, 1),
    ]) {
      expect(key.startsWith(prefixA)).toBe(true);
      expect(key.startsWith(prefixB)).toBe(false);
    }

    await shared.put(packKey(tenantA, "ab01"), Buffer.from("a"));
    await shared.put(wrappedKeyKey(tenantA, 1), Buffer.from("wrapped-a"));
    await shared.put(packKey(tenantB, "ab02"), Buffer.from("b"));
    expect(await shared.list(prefixB)).toEqual([packKey(tenantB, "ab02")]);
    expect(await shared.list(keyPrefix(tenantB))).toEqual([]);
  });

  it("cannot open each other's sealed content: every tenant has its own DEK", () => {
    const dekA = generateDek(1);
    const dekB = generateDek(1);
    const chunkId = randomBytes(32);
    const sealed = encryptChunk(dekA, Buffer.from("mail of tenant A"), chunkId);
    expect(decryptChunk(dekA, sealed).toString()).toBe("mail of tenant A");
    expect(() => decryptChunk(dekB, sealed)).toThrow();
  });

  it("refuses tenant ids that could escape their prefix", () => {
    expect(() => tenantPrefix("../other")).toThrow();
    expect(() => tenantPrefix("a/b")).toThrow();
  });
});
