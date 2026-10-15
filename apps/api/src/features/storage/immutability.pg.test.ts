/**
 * Immutable backups on a repository against Postgres (docs/STORAGE.md,
 * "Immutable backups"): who may raise and who may lower the setting, the
 * refusal of a bucket without Object Lock, the history that keeps a lowered
 * setting from reaching back, the audit entries, the list's view of it, and a
 * restore point's protection as the storage reports it.
 *
 * Runs on the application role under Row Level Security; skipped without
 * RESTOW_TEST_DATABASE_URL.
 */
import { randomBytes, randomUUID } from "node:crypto";
import { Readable } from "node:stream";
import {
  changeImmutability,
  type HeadResult,
  ImmutableStorageBackend,
  type ObjectLockCapability,
  type ObjectRetention,
  type StorageBackend,
} from "@restow/core";
import {
  auditLog,
  createDb,
  type Database,
  immutabilityDeferredDeletions,
  protectedObjects,
  providers,
  snapshots,
  sources,
  storageTargets,
  tenants,
} from "@restow/db";
import { and, eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { provisionTestRoles, type TestDatabaseRoles } from "../../testing/database-roles.js";
import {
  dropDatabase,
  recreateDatabase,
  testDatabaseAdminUrl,
} from "../snapshots/testing/explorer-fixture.js";

const DATABASE = "restow_api_storage_immutability_test";

const enabled: ObjectLockCapability = {
  status: "enabled",
  mode: null,
  defaultRetentionDays: null,
  defaultRetentionYears: null,
  reason: null,
  detail: null,
  checkedAt: new Date().toISOString(),
};
const disabled: ObjectLockCapability = { ...enabled, status: "disabled" };

/** A bucket that reports a fixed retention for every object it has. */
class ReportingBucket implements StorageBackend {
  constructor(
    private readonly keys: Set<string>,
    private readonly mode: "COMPLIANCE" | "GOVERNANCE",
    private readonly until: Date,
  ) {}
  async put(): Promise<void> {}
  async get(): Promise<Buffer> {
    return Buffer.alloc(0);
  }
  async getStream(): Promise<Readable> {
    return Readable.from([]);
  }
  async head(key: string): Promise<HeadResult | null> {
    return this.keys.has(key) ? { size: 1, lastModified: new Date() } : null;
  }
  async list(): Promise<string[]> {
    return [...this.keys];
  }
  async delete(): Promise<void> {}
  async retention(key: string): Promise<ObjectRetention | null> {
    return this.keys.has(key)
      ? { mode: this.mode, retainUntil: this.until, lastModified: new Date(), size: 1 }
      : null;
  }
  async deleteAllVersions(): Promise<void> {}
}

describe.skipIf(!testDatabaseAdminUrl)("immutable backups on a repository", () => {
  let owner: Database;
  let appDb: Database;
  let roles: TestDatabaseRoles | undefined;
  let tenantId: string;
  let service: typeof import("./immutability.js");
  let storageService: typeof import("./service.js");

  const actor = (overrides: Record<string, unknown> = {}) => ({
    id: randomUUID(),
    email: "admin@contoso.example",
    ip: null,
    isProviderAdmin: false,
    isProviderOwner: false,
    session: { createdAt: new Date(), authMethod: "passkey" },
    ...overrides,
  });

  beforeAll(async () => {
    const url = await recreateDatabase(testDatabaseAdminUrl as string, DATABASE);
    roles = await provisionTestRoles(url);
    process.env.DATABASE_URL = roles.appUrl;
    process.env.DATABASE_PROVIDER_URL = roles.providerUrl;
    process.env.RESTOW_MASTER_KEY = randomBytes(32).toString("base64");
    owner = createDb(url);
    appDb = createDb(roles.appUrl);
    service = await import("./immutability.js");
    storageService = await import("./service.js");
    const [provider] = await owner.insert(providers).values({ name: "Provider" }).returning();
    const [tenant] = await owner
      .insert(tenants)
      .values({ providerId: provider?.id ?? "", name: "Contoso", slug: "contoso" })
      .returning();
    tenantId = tenant?.id ?? "";
  }, 60_000);

  afterAll(async () => {
    const shared = await import("../../db.js");
    await Promise.all([
      shared.db.$client.end(),
      shared.providerDb.$client.end(),
      shared.authDb.$client.end(),
    ]);
    await appDb?.$client.end();
    await owner?.$client.end();
    await dropDatabase(testDatabaseAdminUrl as string, DATABASE);
    await roles?.drop(testDatabaseAdminUrl as string);
  });

  async function target(kind: "s3" | "local"): Promise<string> {
    const [row] = await owner
      .insert(storageTargets)
      .values({
        tenantId,
        kind,
        role: "copy",
        config:
          kind === "s3"
            ? { bucket: `contoso-${randomUUID().slice(0, 8)}` }
            : { basePath: "/srv/backup" },
      })
      .returning();
    return row?.id ?? "";
  }

  async function auditActions(targetId: string) {
    return (
      await owner
        .select({ action: auditLog.action, details: auditLog.details })
        .from(auditLog)
        .where(and(eq(auditLog.tenantId, tenantId), eq(auditLog.target, targetId)))
    ).map((row) => ({ action: row.action, details: row.details as Record<string, unknown> }));
  }

  it("turns Object Lock on for a tenant admin, refuses a bucket without it", async () => {
    const id = await target("s3");
    await expect(
      service.setImmutability(appDb, tenantId, id, { mode: "compliance", days: 30 }, actor(), {
        detect: async () => disabled,
      }),
    ).rejects.toMatchObject({
      status: 409,
      extensions: { reason: "object-lock-unavailable" },
    });
    const result = await service.setImmutability(
      appDb,
      tenantId,
      id,
      { mode: "compliance", days: 30 },
      actor(),
      { detect: async () => enabled },
    );
    expect(result.immutability).toMatchObject({
      mode: "compliance",
      days: 30,
      kind: "object_lock",
    });
    const [row] = await owner.select().from(storageTargets).where(eq(storageTargets.id, id));
    expect(row?.immutability?.history).toHaveLength(1);
    expect(await auditActions(id)).toEqual([
      expect.objectContaining({
        action: "storage.target.immutability_changed",
        details: expect.objectContaining({
          lowered: false,
          after: { mode: "compliance", days: 30 },
        }),
      }),
    ]);
    // A directory mode on S3 is refused.
    await expect(
      service.setImmutability(appDb, tenantId, id, { mode: "delayed_deletion", days: 30 }, actor()),
    ).rejects.toMatchObject({ status: 422 });
  });

  it("lets only the provider owner lower it, with a recent sign-in, and keeps the history", async () => {
    const id = await target("s3");
    await service.setImmutability(appDb, tenantId, id, { mode: "compliance", days: 30 }, actor(), {
      detect: async () => enabled,
    });
    // A tenant admin and a provider administrator may raise, not lower.
    await expect(
      service.setImmutability(appDb, tenantId, id, { mode: "compliance", days: 7 }, actor()),
    ).rejects.toMatchObject({ status: 403, extensions: { reason: "lowering-forbidden" } });
    await expect(
      service.setImmutability(
        appDb,
        tenantId,
        id,
        { mode: null, days: 0 },
        actor({ isProviderAdmin: true }),
      ),
    ).rejects.toMatchObject({ status: 403 });
    await expect(
      service.setImmutability(appDb, tenantId, id, { mode: "governance", days: 60 }, actor()),
    ).rejects.toMatchObject({ status: 403 });
    // The owner with a session older than ten minutes is asked to confirm.
    const stale = { createdAt: new Date(Date.now() - 3_600_000), authMethod: "passkey" };
    await expect(
      service.setImmutability(
        appDb,
        tenantId,
        id,
        { mode: null, days: 0 },
        actor({ isProviderAdmin: true, isProviderOwner: true, session: stale }),
      ),
    ).rejects.toMatchObject({ status: 403, type: "urn:restow:problem:recent-sign-in-required" });
    const lowered = await service.setImmutability(
      appDb,
      tenantId,
      id,
      { mode: null, days: 0 },
      actor({ isProviderAdmin: true, isProviderOwner: true }),
    );
    expect(lowered.immutability).toMatchObject({ mode: null, days: 0, canLower: true });
    expect(lowered.immutability.history.map((entry) => entry.days)).toEqual([0, 30]);
    const actions = await auditActions(id);
    expect(actions.at(-1)?.details).toMatchObject({ lowered: true, before: { days: 30 } });
  });

  it("offers a directory only the deletion delay, and only to a provider admin", async () => {
    const id = await target("local");
    await expect(
      service.setImmutability(appDb, tenantId, id, { mode: "delayed_deletion", days: 14 }, actor()),
    ).rejects.toMatchObject({ status: 403 });
    await expect(
      service.setImmutability(
        appDb,
        tenantId,
        id,
        { mode: "compliance", days: 14 },
        actor({ isProviderAdmin: true }),
      ),
    ).rejects.toMatchObject({ status: 422 });
    const result = await service.setImmutability(
      appDb,
      tenantId,
      id,
      { mode: "delayed_deletion", days: 14 },
      actor({ isProviderAdmin: true }),
    );
    expect(result.immutability).toMatchObject({ mode: "delayed_deletion", kind: "deletion_delay" });
  });

  it("shows the setting, the renewal and the deferred deletions in the repository list", async () => {
    const id = await target("s3");
    await service.setImmutability(appDb, tenantId, id, { mode: "governance", days: 10 }, actor(), {
      detect: async () => enabled,
    });
    await owner.insert(immutabilityDeferredDeletions).values([
      { tenantId, targetId: id, key: "endpoints/e/data/aa/1" },
      { tenantId, targetId: id, key: "endpoints/e/data/aa/2" },
    ]);
    const list = await storageService.listTargets(appDb, tenantId, {
      isProviderAdmin: false,
      isProviderOwner: false,
    });
    const item = list.items.find((entry) => entry.id === id);
    expect(item?.immutability).toMatchObject({
      mode: "governance",
      days: 10,
      deferredDeletions: 2,
      renewedAt: null,
      renewalOverdue: false,
      canLower: false,
    });
  });

  it("reports a restore point green only for a COMPLIANCE retention the storage confirms", async () => {
    const [source] = await owner
      .insert(sources)
      .values({ tenantId, kind: "m365", name: "M365", status: "active" })
      .returning();
    const [object] = await owner
      .insert(protectedObjects)
      .values({
        tenantId,
        sourceId: source?.id ?? "",
        kind: "mailbox",
        externalId: "alice@contoso.example",
        displayName: "Alice",
      })
      .returning();
    const manifest = `tenants/${tenantId}/manifests/${randomUUID()}.json.zst`;
    const [snapshot] = await owner
      .insert(snapshots)
      .values({
        tenantId,
        protectedObjectId: object?.id ?? "",
        sequence: 1,
        manifestPath: manifest,
        completedAt: new Date(),
      })
      .returning();
    const viewer = {
      role: "tenant_admin" as const,
      userId: randomUUID(),
      email: "admin@contoso.example",
    };
    const until = new Date(Date.now() + 30 * 86_400_000);
    const settings = changeImmutability(null, { mode: "compliance", days: 30 }, new Date());
    const locked = (mode: "COMPLIANCE" | "GOVERNANCE") =>
      new ImmutableStorageBackend(new ReportingBucket(new Set([manifest]), mode, until), {
        settings,
        targetId: "t1",
      });
    const plain = new ReportingBucket(new Set(), "COMPLIANCE", until);

    const green = await service.restorePointImmutability(
      appDb,
      tenantId,
      viewer,
      snapshot?.id ?? "",
      {
        storage: async () => ({ primary: plain, copies: [locked("COMPLIANCE")] }),
      },
    );
    expect(green).toMatchObject({ state: "immutable", until: until.toISOString() });
    const governance = await service.restorePointImmutability(
      appDb,
      tenantId,
      viewer,
      snapshot?.id ?? "",
      {
        storage: async () => ({ primary: locked("GOVERNANCE"), copies: [] }),
      },
    );
    expect(governance.state).toBe("governance");
    const none = await service.restorePointImmutability(
      appDb,
      tenantId,
      viewer,
      snapshot?.id ?? "",
      {
        storage: async () => ({ primary: plain, copies: [] }),
      },
    );
    expect(none).toMatchObject({ state: "none", until: null, targets: [] });
  });
});
