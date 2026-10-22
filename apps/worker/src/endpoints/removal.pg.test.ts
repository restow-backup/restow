/**
 * Postgres-backed tests of `endpoint-removal` (#65, removal.ts): a removed machine's repository
 * is deleted from every target that holds files of it once it is due, never while a legal hold
 * over the tenant or a suspicion hold stands, and only in part while the storage still locks
 * objects (deferred until the lock runs out, recorded for the renewal). Done, the repository
 * password, the samples and the snapshot marks go; the machine's row and runs stay. The job runs
 * on the provisioned application role, so Row Level Security binds it to the payload's tenant.
 *
 * Needs RESTOW_TEST_DATABASE_URL (a superuser; the database `restow_worker_removal_test` is
 * recreated). No restic: the repository is a set of plain files under `endpoints/<id>/`.
 */
import { randomBytes, randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  endpointPrefix,
  ImmutableStorageBackend,
  LocalStorageBackend,
  noopLogger,
  type StorageBackend,
  type StorageTargets,
  type TenantKeyring,
} from "@restow/core";
import {
  auditLog,
  createDb,
  type Database,
  deriveAuthLogin,
  type EndpointRemoval,
  endpointRuns,
  endpointSamples,
  endpointSnapshotFlags,
  endpoints,
  immutabilityDeferredDeletions,
  legalHolds,
  type RoleLogin,
  restorePointSuspicions,
  secrets,
  storageTargets,
} from "@restow/db";
import { runMigrations } from "@restow/db/migrate";
import { and, eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { TenantCache } from "../handlers/framework.js";
import { resticPrefixes } from "../handlers/immutability.js";
import { dropTestDatabase } from "../testing/database.js";
import type { EndpointJobDeps } from "./common.js";
import { endpointRemoval, repositoryTargets } from "./removal.js";

const adminUrl = process.env.RESTOW_TEST_DATABASE_URL;
const TEST_DB = "restow_worker_removal_test";
const HOUR = 60 * 60 * 1000;
const DAY = 24 * HOUR;

/** A repository's files: config, keys, a snapshot, a pack, an index and a lock. */
const REPOSITORY_FILES = [
  "config",
  `keys/${"1".repeat(64)}`,
  `snapshots/${"2".repeat(64)}`,
  `data/33/${"3".repeat(64)}`,
  `index/${"4".repeat(64)}`,
  `locks/${"5".repeat(64)}`,
];

describe.skipIf(!adminUrl)("endpoint removal against Postgres", () => {
  let owner: Database;
  let appDb: Database;
  let providerDb: Database;
  let deps: EndpointJobDeps;
  let work: string;
  let contoso: string;
  let fabrikam: string;
  let clock = new Date();
  const roleNames: string[] = [];
  /** The targets each tenant's jobs see; tests replace them. */
  const targetsOf = new Map<string, StorageTargets & { previous?: StorageBackend[] }>();

  beforeAll(async () => {
    const admin = createDb(adminUrl as string);
    await admin.$client.query(`DROP DATABASE IF EXISTS ${TEST_DB} WITH (FORCE)`);
    await admin.$client.query(`CREATE DATABASE ${TEST_DB}`);
    await admin.$client.end();
    const url = new URL(adminUrl as string);
    url.pathname = `/${TEST_DB}`;
    const suffix = randomBytes(4).toString("hex");
    const tenantLogin: RoleLogin = {
      name: `restow_r_app_${suffix}`,
      password: randomBytes(12).toString("hex"),
    };
    const installationLogin: RoleLogin = {
      name: `restow_r_inst_${suffix}`,
      password: randomBytes(12).toString("hex"),
    };
    roleNames.push(
      tenantLogin.name,
      installationLogin.name,
      deriveAuthLogin(tenantLogin, installationLogin).name,
    );
    await runMigrations(url.toString(), {
      roles: { tenant: tenantLogin, installation: installationLogin },
    });
    owner = createDb(url.toString());
    const asRole = (login: RoleLogin) => {
      const copy = new URL(url);
      copy.username = login.name;
      copy.password = login.password;
      return createDb(copy.toString());
    };
    appDb = asRole(tenantLogin);
    providerDb = asRole(installationLogin);
    work = await mkdtemp(join(tmpdir(), "restow-worker-removal-"));

    const q = <T extends Record<string, unknown>>(text: string, values: unknown[] = []) =>
      owner.$client.query<T>(text, values).then((result) => result.rows);
    const [provider] = await q<{ id: string }>(
      "INSERT INTO providers (name) VALUES ('p') RETURNING id",
    );
    const created = await q<{ id: string }>(
      "INSERT INTO tenants (provider_id, name, slug) VALUES ($1, 'Contoso', 'contoso'), ($1, 'Fabrikam', 'fabrikam') RETURNING id",
      [provider?.id],
    );
    contoso = created[0]?.id ?? "";
    fabrikam = created[1]?.id ?? "";

    deps = {
      db: appDb,
      providerDb,
      runtime: {
        keyrings: new TenantCache<TenantKeyring>(async () => {
          throw new Error("no keys needed");
        }),
        // Read through on every call, so a test's targets apply at once.
        storage: { get: async (tenantId: string) => targetsOf.get(tenantId) } as never,
        logger: noopLogger,
        now: () => clock,
        shutdownSignal: new AbortController().signal,
      },
      maintenanceLockWaitMs: 2000,
    };
  }, 90_000);

  afterAll(async () => {
    await Promise.all([appDb?.$client.end(), providerDb?.$client.end(), owner?.$client.end()]);
    await dropTestDatabase(adminUrl as string, TEST_DB);
    const admin = createDb(adminUrl as string);
    for (const role of roleNames) {
      await admin.$client.query(`DROP ROLE IF EXISTS ${role}`);
    }
    await admin.$client.end();
    if (work) await rm(work, { recursive: true, force: true });
  });

  async function directory(name: string): Promise<LocalStorageBackend> {
    return new LocalStorageBackend(await mkdtemp(join(work, `${name}-`)));
  }

  async function fill(backend: StorageBackend, endpointId: string): Promise<void> {
    for (const file of REPOSITORY_FILES) {
      await backend.put(`${endpointPrefix(endpointId)}${file}`, Buffer.from(file));
    }
  }

  const keysOf = (backend: StorageBackend, endpointId: string) =>
    backend.list(endpointPrefix(endpointId));

  /** A revoked, removed machine with a repository password, a sample, a mark and a run. */
  async function removedMachine(
    tenantId: string,
    removal: Partial<EndpointRemoval> = {},
    dueAt: Date | null = new Date(clock.getTime() - HOUR),
  ): Promise<{ id: string; secretId: string }> {
    const id = randomUUID();
    const [secret] = await owner
      .insert(secrets)
      .values({ tenantId, kind: "endpoint_repository", ciphertext: "sealed" })
      .returning();
    await owner.insert(endpoints).values({
      id,
      tenantId,
      hostname: `host-${id.slice(0, 6)}`,
      os: "linux",
      arch: "amd64",
      profile: "server",
      status: "revoked",
      revokedAt: clock,
      secretHash: "h",
      config: {} as never,
      repositorySecretId: secret?.id ?? null,
      repositoryBytes: 1234,
      lastSnapshotId: "2".repeat(64),
      removedAt: clock,
      removal: {
        mode: "delete",
        state: "scheduled",
        requestedBy: "admin@contoso.example",
        requestedAt: clock.toISOString(),
        ...removal,
      },
      removalDueAt: dueAt,
    });
    const [run] = await owner
      .insert(endpointRuns)
      .values({
        tenantId,
        endpointId: id,
        kind: "backup",
        status: "succeeded",
        startedAt: clock,
        snapshotId: "2".repeat(64),
      })
      .returning();
    await owner.insert(endpointSamples).values({
      tenantId,
      endpointId: id,
      runId: run?.id ?? "",
      snapshotId: "2".repeat(64),
      path: "/etc/hosts",
      sha256: "b".repeat(64),
      size: 5,
    });
    await owner.insert(endpointSnapshotFlags).values({
      tenantId,
      endpointId: id,
      snapshotId: "6".repeat(64),
      reasons: ["unrecorded"],
      storedAt: clock,
    });
    return { id, secretId: secret?.id ?? "" };
  }

  async function row(id: string) {
    const [found] = await owner.select().from(endpoints).where(eq(endpoints.id, id));
    return found;
  }

  async function auditActions(id: string): Promise<string[]> {
    const rows = await owner.select().from(auditLog).where(eq(auditLog.target, id));
    return rows.map((entry) => entry.action);
  }

  it("deletes the repository from the primary, its copies and retired primaries", async () => {
    clock = new Date();
    const primary = await directory("primary");
    const copy = await directory("copy");
    const retired = await directory("retired");
    targetsOf.set(contoso, { primary, copies: [copy], previous: [retired] });
    expect(repositoryTargets({ primary, copies: [copy, primary], previous: [retired] })).toEqual([
      primary,
      copy,
      retired,
    ]);
    const { id, secretId } = await removedMachine(contoso);
    const other = await removedMachine(
      contoso,
      { mode: "expire" },
      new Date(clock.getTime() + DAY),
    );
    for (const backend of [primary, copy, retired]) {
      await fill(backend, id);
    }
    await fill(primary, other.id);

    const outcome = await endpointRemoval(deps, { tenantId: contoso, endpointId: id });
    expect(outcome).toEqual({ state: "done", deleted: 18 });
    for (const backend of [primary, copy, retired]) {
      expect(await keysOf(backend, id)).toEqual([]);
    }
    // Another machine's repository is not touched.
    expect(await keysOf(primary, other.id)).toHaveLength(REPOSITORY_FILES.length);

    const done = await row(id);
    expect(done?.removal).toMatchObject({ state: "done", deletedObjects: 18, lastError: null });
    expect(done?.removalDueAt).toBeNull();
    expect(done?.repositorySecretId).toBeNull();
    expect(done?.repositoryBytes).toBeNull();
    expect(done?.removedAt).not.toBeNull();
    expect(await owner.select().from(secrets).where(eq(secrets.id, secretId))).toEqual([]);
    expect(
      await owner.select().from(endpointSamples).where(eq(endpointSamples.endpointId, id)),
    ).toEqual([]);
    expect(
      await owner
        .select()
        .from(endpointSnapshotFlags)
        .where(eq(endpointSnapshotFlags.endpointId, id)),
    ).toEqual([]);
    // The history stays.
    expect(
      await owner.select().from(endpointRuns).where(eq(endpointRuns.endpointId, id)),
    ).toHaveLength(1);
    expect(await auditActions(id)).toEqual(["endpoint.removal.completed"]);

    // Run again: nothing left to do.
    expect(await endpointRemoval(deps, { tenantId: contoso, endpointId: id })).toEqual({
      state: "skipped",
    });
  });

  it("does nothing before a removal is due, nor for a machine of another tenant", async () => {
    clock = new Date();
    const primary = await directory("early");
    targetsOf.set(contoso, { primary, copies: [] });
    targetsOf.set(fabrikam, { primary, copies: [] });
    const later = await removedMachine(
      contoso,
      { mode: "expire" },
      new Date(clock.getTime() + DAY),
    );
    await fill(primary, later.id);
    expect(await endpointRemoval(deps, { tenantId: contoso, endpointId: later.id })).toEqual({
      state: "skipped",
    });
    // The payload names the wrong tenant: Row Level Security hides the machine.
    const due = await removedMachine(contoso);
    await fill(primary, due.id);
    expect(await endpointRemoval(deps, { tenantId: fabrikam, endpointId: due.id })).toEqual({
      state: "skipped",
    });
    expect(await keysOf(primary, later.id)).toHaveLength(REPOSITORY_FILES.length);
    expect(await keysOf(primary, due.id)).toHaveLength(REPOSITORY_FILES.length);
    expect((await row(due.id))?.removal?.state).toBe("scheduled");
  });

  it("holds the deletion under a legal hold over the tenant, and deletes once it is released", async () => {
    clock = new Date();
    const primary = await directory("legal");
    targetsOf.set(contoso, { primary, copies: [] });
    const { id } = await removedMachine(contoso);
    await fill(primary, id);
    // A hold of one mailbox, or of another tenant, does not cover the machine.
    await owner.insert(legalHolds).values({ tenantId: fabrikam, reason: "Other tenant" });
    const [hold] = await owner
      .insert(legalHolds)
      .values({ tenantId: contoso, reason: "Litigation" })
      .returning();

    expect(await endpointRemoval(deps, { tenantId: contoso, endpointId: id })).toEqual({
      state: "held",
      heldBy: "legal_hold",
    });
    expect(await keysOf(primary, id)).toHaveLength(REPOSITORY_FILES.length);
    const held = await row(id);
    expect(held?.removal).toMatchObject({ state: "held", heldBy: "legal_hold" });
    expect(held?.removalDueAt?.getTime()).toBe(clock.getTime() + DAY);
    // Not due again before the day is over; a second look the next day audits nothing new.
    expect((await endpointRemoval(deps, { tenantId: contoso, endpointId: id })).state).toBe(
      "skipped",
    );
    clock = new Date(clock.getTime() + DAY + HOUR);
    expect((await endpointRemoval(deps, { tenantId: contoso, endpointId: id })).state).toBe("held");
    expect(await auditActions(id)).toEqual(["endpoint.removal.held"]);

    await owner
      .update(legalHolds)
      .set({ active: false, releasedAt: clock })
      .where(eq(legalHolds.id, hold?.id ?? ""));
    clock = new Date(clock.getTime() + DAY + HOUR);
    expect((await endpointRemoval(deps, { tenantId: contoso, endpointId: id })).state).toBe("done");
    expect(await keysOf(primary, id)).toEqual([]);
  });

  it("holds the deletion while a suspicious restore point of the machine is not resolved", async () => {
    clock = new Date();
    const primary = await directory("suspicion");
    targetsOf.set(contoso, { primary, copies: [] });
    const { id } = await removedMachine(contoso);
    await fill(primary, id);
    const [suspicion] = await owner
      .insert(restorePointSuspicions)
      .values({
        tenantId: contoso,
        objectKind: "endpoint",
        objectId: id,
        runId: randomUUID(),
        restorePointId: "7".repeat(64),
        restorePointAt: clock,
        verdict: "suspicious",
        metrics: { itemsChanged: 1, itemsTotal: 1, bytesAdded: 1 },
        signaturesVersion: "1",
      })
      .returning();
    expect(await endpointRemoval(deps, { tenantId: contoso, endpointId: id })).toEqual({
      state: "held",
      heldBy: "suspicion",
    });
    expect(await keysOf(primary, id)).toHaveLength(REPOSITORY_FILES.length);

    // A false alarm ends the hold.
    await owner
      .update(restorePointSuspicions)
      .set({ falseAlarmAt: clock })
      .where(eq(restorePointSuspicions.id, suspicion?.id ?? ""));
    clock = new Date(clock.getTime() + DAY + HOUR);
    expect((await endpointRemoval(deps, { tenantId: contoso, endpointId: id })).state).toBe("done");
  });

  it("defers what the storage still locks until the lock runs out, and keeps it out of the renewal", async () => {
    clock = new Date();
    const inner = await directory("locked");
    const [target] = await owner
      .insert(storageTargets)
      .values({
        tenantId: contoso,
        name: "Locked",
        kind: "local",
        role: "copy",
        config: { path: "/tmp/locked" } as never,
      })
      .returning();
    const since = new Date(clock.getTime() - 30 * DAY).toISOString();
    const locked = new ImmutableStorageBackend(inner, {
      settings: {
        mode: "delayed_deletion",
        days: 7,
        history: [{ since, days: 7, mode: "delayed_deletion" }],
      },
      targetId: target?.id,
      now: () => clock,
    });
    const plain = await directory("unlocked");
    targetsOf.set(contoso, { primary: locked, copies: [plain] });
    const { id } = await removedMachine(contoso);
    await fill(inner, id);
    await fill(plain, id);

    const outcome = await endpointRemoval(deps, { tenantId: contoso, endpointId: id });
    expect(outcome.state).toBe("deferred");
    if (outcome.state !== "deferred") return;
    // config, keys, snapshot and pack are backup objects in their delay; index and lock are not.
    expect(outcome.locked).toBe(4);
    expect(outcome.deleted).toBe(2 + REPOSITORY_FILES.length);
    const lockedUntil = outcome.lockedUntil as Date;
    expect(lockedUntil.getTime()).toBeGreaterThan(clock.getTime() + 6 * DAY);
    expect((await keysOf(inner, id)).sort()).toEqual(
      [
        "config",
        `data/33/${"3".repeat(64)}`,
        `keys/${"1".repeat(64)}`,
        `snapshots/${"2".repeat(64)}`,
      ]
        .map((file) => `${endpointPrefix(id)}${file}`)
        .sort(),
    );
    expect(await keysOf(plain, id)).toEqual([]);

    const deferred = await row(id);
    expect(deferred?.removal).toMatchObject({
      state: "deferred",
      lockedObjects: 4,
      lockedUntil: lockedUntil.toISOString(),
    });
    expect(deferred?.removalDueAt?.getTime()).toBe(lockedUntil.getTime() + HOUR);
    expect(deferred?.repositorySecretId).not.toBeNull();
    const recorded = await owner
      .select()
      .from(immutabilityDeferredDeletions)
      .where(eq(immutabilityDeferredDeletions.targetId, target?.id ?? ""));
    expect(recorded).toHaveLength(4);
    // The renewal no longer keeps this repository's locks.
    expect((await resticPrefixes(appDb, contoso, clock)).prefixes).not.toContain(
      endpointPrefix(id),
    );
    expect(await auditActions(id)).toEqual(["endpoint.removal.deferred"]);

    // Once the delay ran out, the rest goes.
    clock = new Date(lockedUntil.getTime() + 2 * HOUR);
    expect(await endpointRemoval(deps, { tenantId: contoso, endpointId: id })).toEqual({
      state: "done",
      deleted: 4,
    });
    expect(await keysOf(inner, id)).toEqual([]);
    expect((await row(id))?.removal).toMatchObject({ state: "done", deletedObjects: 12 });
    expect((await auditActions(id)).sort()).toEqual([
      "endpoint.removal.completed",
      "endpoint.removal.deferred",
    ]);
  });

  it("keeps renewing a repository kept until it expires, until its expiry has come", async () => {
    clock = new Date();
    const listed = randomUUID();
    await owner.insert(endpoints).values({
      id: listed,
      tenantId: contoso,
      hostname: "listed",
      os: "linux",
      arch: "amd64",
      profile: "server",
      secretHash: "h",
      config: {} as never,
    });
    const keep = await removedMachine(
      contoso,
      { mode: "expire" },
      new Date(clock.getTime() + 30 * DAY),
    );
    const prefixes = (await resticPrefixes(appDb, contoso, clock)).prefixes;
    expect(prefixes).toContain(endpointPrefix(listed));
    expect(prefixes).toContain(endpointPrefix(keep.id));
    expect(
      (await resticPrefixes(appDb, contoso, new Date(clock.getTime() + 31 * DAY))).prefixes,
    ).not.toContain(endpointPrefix(keep.id));
    const rows = await owner
      .select()
      .from(endpoints)
      .where(and(eq(endpoints.tenantId, contoso), eq(endpoints.id, listed)));
    expect(rows).toHaveLength(1);
  });
});
