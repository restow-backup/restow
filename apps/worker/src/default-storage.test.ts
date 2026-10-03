import { randomBytes } from "node:crypto";
import { Readable } from "node:stream";
import {
  type InstallationDefaultDocument,
  InstallationDefaultResolver,
  type StorageBackend,
  type StorageTargets,
  deriveInstallationSecretsKey,
  installationDefaultDocument,
  sealSecret,
  serializeInstallationDefaultDocument,
} from "@restow/core";
import { describe, expect, it } from "vitest";
import { defaultStorageLookup } from "./default-storage.js";
import {
  type ResolvedTenantStorage,
  TenantCache,
  resolveStorageForJob,
} from "./handlers/framework.js";

/**
 * The installation default as the worker resolves it (default-storage.ts): the
 * default saved under Installation, Default storage wins over the environment,
 * and a write-queue job never writes to a default that changed after its
 * tenant's storage was cached (`resolveStorageForJob`).
 */

/** A counting in-memory backend: enough for resolving and one write. */
class MemoryStorageBackend implements StorageBackend {
  readonly objects = new Map<string, Buffer>();
  writes = 0;

  async put(key: string, data: Buffer | Readable): Promise<void> {
    this.writes++;
    this.objects.set(key, Buffer.isBuffer(data) ? data : Buffer.alloc(0));
  }
  async get(key: string): Promise<Buffer> {
    const value = this.objects.get(key);
    if (!value) {
      throw new Error(`not found: ${key}`);
    }
    return value;
  }
  async getStream(key: string): Promise<Readable> {
    return Readable.from(await this.get(key));
  }
  async head(key: string): Promise<{ size: number } | null> {
    const value = this.objects.get(key);
    return value ? { size: value.length } : null;
  }
  async list(prefix: string): Promise<string[]> {
    return [...this.objects.keys()].filter((key) => key.startsWith(prefix)).sort();
  }
  async delete(key: string): Promise<void> {
    this.objects.delete(key);
  }
}

const TENANT = "5b6c7d8e-1a2b-4c3d-9e8f-0a1b2c3d4e5f";
const KEY = deriveInstallationSecretsKey(randomBytes(32));
const ROW = "3c2b1a09-8f7e-4d6c-9b5a-0f1e2d3c4b5a";

function row(document: InstallationDefaultDocument, updatedAt: Date) {
  return {
    id: ROW,
    ciphertext: sealSecret(KEY, ROW, serializeInstallationDefaultDocument(document)),
    updatedAt,
  };
}

describe("defaultStorageLookup", () => {
  it("opens the saved default instead of the environment, and reopens it once it changed", async () => {
    let stored: ReturnType<typeof row> | null = null;
    const lookup = defaultStorageLookup(
      new InstallationDefaultResolver({
        env: { STORAGE_TARGET: "local", STORAGE_LOCAL_PATH: "/data/chunks" },
        loadStored: async () => stored,
        installationKey: () => KEY,
        ttlMs: 60_000,
      }),
    );
    const fromEnvironment = await lookup.current();
    expect(fromEnvironment.generation).toBe("environment");
    expect(await lookup.current()).toBe(fromEnvironment);

    stored = row(
      installationDefaultDocument(
        { kind: "local", basePath: "/srv/restow" },
        null,
        "owner@example.test",
        new Date(0),
      ),
      new Date(1_000),
    );
    // The fresh generation read notices the saved default and drops the resolver's cache.
    expect(await lookup.generation()).toContain("database:");
    const saved = await lookup.current();
    expect(saved.generation).toContain("database:");
    expect(saved.targets.primary).not.toBe(fromEnvironment.targets.primary);
  });

  it("refuses an unusable default instead of falling back to another location", async () => {
    const lookup = defaultStorageLookup(
      new InstallationDefaultResolver({ env: { STORAGE_TARGET: "ftp" } }),
    );
    await expect(lookup.current()).rejects.toThrow(/not usable/);
  });
});

describe("resolveStorageForJob and a changed installation default", () => {
  function onDefault(primary: MemoryStorageBackend, generation: string): ResolvedTenantStorage {
    return {
      primary,
      copies: [],
      previous: [],
      keepGeneration: null,
      defaultGeneration: generation,
    };
  }

  it("reloads a cached tenant on the default once the default's generation changed", async () => {
    const oldDefault = new MemoryStorageBackend();
    const newDefault = new MemoryStorageBackend();
    let current = { primary: oldDefault, generation: "environment" };
    const storage = new TenantCache<StorageTargets>(
      async () => onDefault(current.primary, current.generation),
      5 * 60 * 1000,
      () => 0,
    );
    const job = (generation: string) =>
      resolveStorageForJob({
        tenantId: TENANT,
        queue: "backup",
        storage,
        getLatestKeepSwitchAt: async () => null,
        getDefaultGeneration: async () => generation,
      });

    expect((await job("environment")).primary).toBe(oldDefault);
    current = { primary: newDefault, generation: "database:x:1" };
    const after = await job("database:x:1");
    expect(after.primary).toBe(newDefault);
    await after.primary.put("tenants/x/packs/aa/aa01", Buffer.from("new"));
    expect(oldDefault.writes).toBe(0);
  });

  it("does not look at the default for a tenant with a primary of its own", async () => {
    const own = new MemoryStorageBackend();
    let loads = 0;
    const storage = new TenantCache<StorageTargets>(
      async () => {
        loads += 1;
        return {
          primary: own,
          copies: [],
          previous: [],
          keepGeneration: null,
          defaultGeneration: null,
        };
      },
      5 * 60 * 1000,
      () => 0,
    );
    let asked = 0;
    for (const generation of ["environment", "database:x:1"]) {
      await resolveStorageForJob({
        tenantId: TENANT,
        queue: "backup",
        storage,
        getLatestKeepSwitchAt: async () => null,
        getDefaultGeneration: async () => {
          asked += 1;
          return generation;
        },
      });
    }
    expect(loads).toBe(1);
    expect(asked).toBe(0);
  });
});
