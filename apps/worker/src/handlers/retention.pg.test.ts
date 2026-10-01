import { randomUUID } from "node:crypto";
/**
 * Postgres-backed parity test: {@link pgRetentionStore} run for real through
 * {@link createSnapshotRetentionTask}, against the exact fixture
 * apps/api/src/features/retention/retention.pg.test.ts previews (the retired
 * "parity test" there only copied the loader queries — it never ran the
 * worker's own SQL). This proves the worker's projection stays in step with
 * the preview's full-row read: in particular the plain `years` column and a
 * legacy row's own `keepLast`, which a narrower `loadPolicies` projection
 * could silently drop (@restow/core `parseSnapshotPolicy`).
 *
 * Runs when RESTOW_TEST_DATABASE_URL points at a Postgres server (a database
 * named `restow_worker_retention_test` is dropped and recreated there on
 * every run, then migrated). Without it the suite is skipped.
 */
import type { Readable } from "node:stream";
import {
  type HeadResult,
  Keyring,
  MemoryChunkIndex,
  type StorageBackend,
  createMemoryJobContext,
  generateDek,
} from "@restow/core";
import {
  type Database,
  createDb,
  legalHolds,
  protectedObjects,
  providers,
  retentionPolicies,
  snapshots,
  sources,
  tenants,
  verifyReports,
} from "@restow/db";
import { runMigrations } from "@restow/db/migrate";
import { describe, expect, it } from "vitest";
import type { WorkerJobContext } from "./framework.js";
import { pgRetentionStore, retentionTasks } from "./retention.js";

/** A storage backend that is never actually touched: dry runs never prune. */
class UnusedStorage implements StorageBackend {
  async put(): Promise<void> {
    throw new Error("not used by a dry run");
  }
  async get(): Promise<Buffer> {
    throw new Error("not used by a dry run");
  }
  async getStream(): Promise<Readable> {
    throw new Error("not used by a dry run");
  }
  async head(): Promise<HeadResult | null> {
    return null;
  }
  async list(): Promise<string[]> {
    return [];
  }
  async delete(): Promise<void> {}
}

function jobContext(db: Database, tenantId: string): WorkerJobContext {
  const base = createMemoryJobContext({
    tenantId,
    jobId: randomUUID(),
    queue: "retention",
    keys: new Keyring(tenantId, [generateDek(1)]),
    storage: { primary: new UnusedStorage(), copies: [] },
    chunkIndex: new MemoryChunkIndex(),
    now: () => NOW,
  });
  return { ...base, db, protectedObject: null };
}

const adminUrl = process.env.RESTOW_TEST_DATABASE_URL;
const TEST_DB = "restow_worker_retention_test";
const NOW = new Date("2026-06-01T12:00:00.000Z");

function daysAgo(days: number): Date {
  return new Date(NOW.getTime() - days * 24 * 60 * 60 * 1000);
}

function testDatabaseUrl(base: string): string {
  const url = new URL(base);
  url.pathname = `/${TEST_DB}`;
  return url.toString();
}

async function recreateTestDatabase(base: string): Promise<string> {
  const admin = createDb(base);
  try {
    await admin.$client.query(`DROP DATABASE IF EXISTS ${TEST_DB} WITH (FORCE)`);
    await admin.$client.query(`CREATE DATABASE ${TEST_DB}`);
  } finally {
    await admin.$client.end();
  }
  const url = testDatabaseUrl(base);
  await runMigrations(url);
  return url;
}

describe.skipIf(!adminUrl)("pgRetentionStore against Postgres", () => {
  it("matches the numbers the retention preview API asserts, including a legal hold", async () => {
    const url = await recreateTestDatabase(adminUrl as string);
    const db = createDb(url);
    try {
      const [provider] = await db.insert(providers).values({ name: "Provider" }).returning();
      const [tenant] = await db
        .insert(tenants)
        .values({ providerId: provider?.id as string, name: "Contoso", slug: "contoso" })
        .returning();
      const tenantId = tenant?.id as string;
      const [source] = await db
        .insert(sources)
        .values({ tenantId, kind: "m365", name: "Contoso M365", status: "active" })
        .returning();
      const [mailboxA] = await db
        .insert(protectedObjects)
        .values({
          tenantId,
          sourceId: source?.id as string,
          kind: "mailbox",
          externalId: "anna@contoso.example",
        })
        .returning();
      const [mailboxB] = await db
        .insert(protectedObjects)
        .values({
          tenantId,
          sourceId: source?.id as string,
          kind: "mailbox",
          externalId: "bo@contoso.example",
        })
        .returning();

      await db.insert(retentionPolicies).values({
        tenantId,
        name: "Standard",
        isDefault: true,
        appliesTo: { target: "snapshots", preset: "30d" },
      });
      await db.insert(legalHolds).values({
        tenantId,
        reason: "Litigation",
        protectedObjectId: mailboxB?.id as string,
        active: true,
      });

      // v1: the sole verified restore point, past the 30-day cutoff — must survive.
      // s2: past the cutoff, unverified — due.
      // s3: newest, unverified — always kept.
      // h1: mailboxB, overdue but held. h2: mailboxB, newest, always kept.
      const rows = await db
        .insert(snapshots)
        .values([
          {
            tenantId,
            protectedObjectId: mailboxA?.id as string,
            sequence: 1,
            manifestPath: "v1",
            status: "active",
            byteSize: 1000,
            completedAt: daysAgo(400),
          },
          {
            tenantId,
            protectedObjectId: mailboxA?.id as string,
            sequence: 2,
            manifestPath: "s2",
            status: "active",
            byteSize: 2000,
            completedAt: daysAgo(50),
          },
          {
            tenantId,
            protectedObjectId: mailboxA?.id as string,
            sequence: 3,
            manifestPath: "s3",
            status: "active",
            byteSize: 500,
            completedAt: daysAgo(1),
          },
          {
            tenantId,
            protectedObjectId: mailboxB?.id as string,
            sequence: 1,
            manifestPath: "h1",
            status: "active",
            byteSize: 4000,
            completedAt: daysAgo(400),
          },
          {
            tenantId,
            protectedObjectId: mailboxB?.id as string,
            sequence: 2,
            manifestPath: "h2",
            status: "active",
            byteSize: 4000,
            completedAt: daysAgo(1),
          },
        ])
        .returning({ id: snapshots.id, manifestPath: snapshots.manifestPath });
      const v1 = rows.find((row) => row.manifestPath === "v1");
      await db.insert(verifyReports).values({
        tenantId,
        protectedObjectId: mailboxA?.id as string,
        snapshotId: v1?.id ?? null,
        kind: "verify",
        recoveryReadiness: "green",
        checkedAt: daysAgo(399),
      });

      // The default task builds its own pgRetentionStore from ctx.db /
      // ctx.tenantId, exactly as production does — this exercises that
      // exact code path, not a substitute store.
      const task = retentionTasks.list().find((t) => t.name === "snapshots");
      if (!task) {
        throw new Error("snapshots task not registered");
      }
      const ctx = jobContext(db, tenantId);

      const summary = (await task.run(ctx, { dryRun: true })) as {
        candidates: number;
        held: number;
        bytesLogical: number;
      };

      // Same fixture, same numbers, as the API preview's Postgres test
      // (apps/api/src/features/retention/retention.pg.test.ts): only s2 is
      // due (v1 is the sole verified point, s3 is the newest), and
      // mailboxB's overdue point is held, not counted as due.
      expect(summary.candidates).toBe(1);
      expect(summary.bytesLogical).toBe(2000);
      expect(summary.held).toBe(1);
    } finally {
      await db.$client.end();
    }
  }, 60_000);

  it("reads a legacy row's own years column and keepLast, matching what a full-row read (the API preview) sees", async () => {
    const url = await recreateTestDatabase(adminUrl as string);
    const db = createDb(url);
    try {
      const [provider] = await db.insert(providers).values({ name: "Provider" }).returning();
      const [tenant] = await db
        .insert(tenants)
        .values({ providerId: provider?.id as string, name: "Contoso", slug: "contoso" })
        .returning();
      const tenantId = tenant?.id as string;
      const [source] = await db
        .insert(sources)
        .values({ tenantId, kind: "m365", name: "Contoso M365", status: "active" })
        .returning();
      const [mailbox] = await db
        .insert(protectedObjects)
        .values({
          tenantId,
          sourceId: source?.id as string,
          kind: "mailbox",
          externalId: "carl@contoso.example",
        })
        .returning();

      // A row saved before presets existed: no `preset` key at all, just
      // the plain `years` column plus its own `keepLast` in `applies_to`.
      await db.insert(retentionPolicies).values({
        tenantId,
        name: "Old policy",
        isDefault: true,
        years: 1,
        appliesTo: { target: "snapshots", keepLast: 2 },
      });

      await db.insert(snapshots).values([
        // Past the 1-year cutoff, outside the newest 2: due.
        {
          tenantId,
          protectedObjectId: mailbox?.id as string,
          sequence: 1,
          manifestPath: "l1",
          status: "active",
          byteSize: 100,
          completedAt: daysAgo(500),
        },
        // Past the cutoff too, but within the newest 2: kept by keepLast.
        {
          tenantId,
          protectedObjectId: mailbox?.id as string,
          sequence: 2,
          manifestPath: "l2",
          status: "active",
          byteSize: 100,
          completedAt: daysAgo(400),
        },
        // Newest, within the cutoff anyway.
        {
          tenantId,
          protectedObjectId: mailbox?.id as string,
          sequence: 3,
          manifestPath: "l3",
          status: "active",
          byteSize: 100,
          completedAt: daysAgo(10),
        },
      ]);

      const task = retentionTasks.list().find((t) => t.name === "snapshots");
      if (!task) {
        throw new Error("snapshots task not registered");
      }
      const ctx = jobContext(db, tenantId);

      const summary = (await task.run(ctx, { dryRun: true })) as { candidates: number };

      // Without the years column (or keepLast) reaching parseSnapshotPolicy,
      // this would either keep everything (years dropped: null cutoff) or
      // prune l2 as well (keepLast dropped: only the newest one guarded).
      expect(summary.candidates).toBe(1);

      const store = pgRetentionStore((fn) => db.transaction((tx) => fn(tx)), tenantId);
      const completed = await store.loadCompletedSnapshots();
      expect(completed.map((c) => c.id)).toHaveLength(3);
    } finally {
      await db.$client.end();
    }
  }, 60_000);
});
