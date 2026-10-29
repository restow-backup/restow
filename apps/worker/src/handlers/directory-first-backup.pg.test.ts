/**
 * Postgres-backed tests of {@link pgFirstBackupStore} and
 * {@link enqueueFirstBackupsAfterSync}: the worker's own SQL, RLS scoping and
 * the audit-chain path, none of which the fake-store unit tests in
 * directory.test.ts can prove. In particular: the pg-boss send, the `jobs`
 * row and the audit entry commit together in one transaction (a failure
 * partway through leaves none of them, never an unaudited job).
 *
 * Runs when RESTOW_TEST_DATABASE_URL points at a Postgres server (a database
 * named `restow_worker_first_backup_test` is dropped and recreated there on
 * every run, then migrated). Without it the suite is skipped.
 */
import { randomUUID } from "node:crypto";
import {
  DEFAULT_PROTECTION_RULES,
  type DirectoryUserRecord,
  noopLogger,
  planDirectory,
  type UserProbe,
} from "@restow/core";
import {
  auditLog,
  createDb,
  type Database,
  jobs,
  protectedObjects,
  providers,
  snapshots,
  sources,
  tenants,
} from "@restow/db";
import { runMigrations } from "@restow/db/migrate";
import { and, eq, sql } from "drizzle-orm";
import PgBoss from "pg-boss";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { alertOverdueBackups } from "../overdue.js";
import {
  enqueueFirstBackupsAfterSync,
  PgDirectoryRepository,
  pgFirstBackupStore,
} from "./directory.js";
import { tenantRunner } from "./framework.js";

const adminUrl = process.env.RESTOW_TEST_DATABASE_URL;
const TEST_DB = "restow_worker_first_backup_test";

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

async function tenant(db: Database, name: string) {
  const [provider] = await db
    .insert(providers)
    .values({ name: `${name} provider` })
    .returning();
  const [row] = await db
    .insert(tenants)
    .values({
      providerId: provider?.id as string,
      name,
      slug: `${name.toLowerCase()}-${randomUUID().slice(0, 8)}`,
    })
    .returning();
  const tenantId = row?.id as string;
  const [source] = await db
    .insert(sources)
    .values({ tenantId, kind: "m365", name: `${name} 365`, status: "active" })
    .returning();
  return { tenantId, sourceId: source?.id as string };
}

async function activeObject(db: Database, tenantId: string, sourceId: string, externalId: string) {
  const [row] = await db
    .insert(protectedObjects)
    .values({ tenantId, sourceId, kind: "mailbox", status: "active", externalId })
    .returning();
  return row?.id as string;
}

describe.skipIf(!adminUrl)("pgFirstBackupStore against Postgres", () => {
  let db: Database;
  let boss: PgBoss;

  beforeAll(async () => {
    const url = await recreateTestDatabase(adminUrl as string);
    db = createDb(url);
    boss = new PgBoss({ connectionString: url });
    await boss.start();
    await boss.createQueue("backup");
  }, 60_000);

  afterAll(async () => {
    await boss?.stop({ graceful: false, wait: true });
    await db?.$client.end();
  });

  it("commits the pg-boss send, the jobs row and the audit entry together", async () => {
    const { tenantId, sourceId } = await tenant(db, "Atomic");
    const objectId = await activeObject(db, tenantId, sourceId, "ext-atomic");
    const run = tenantRunner(db, tenantId);

    const queued = await run((tx) =>
      enqueueFirstBackupsAfterSync({
        tenantId,
        newlyActive: [{ externalId: "ext-atomic", kind: "mailbox" }],
        store: pgFirstBackupStore(tx, tenantId, sourceId, boss),
        signal: new AbortController().signal,
        logger: noopLogger,
      }),
    );
    expect(queued).toEqual([objectId]);

    const jobRows = await db
      .select()
      .from(jobs)
      .where(and(eq(jobs.tenantId, tenantId), eq(jobs.protectedObjectId, objectId)));
    expect(jobRows).toHaveLength(1);
    expect(jobRows[0]).toMatchObject({ status: "queued", queue: "backup" });
    expect(jobRows[0]?.pgBossJobId).toEqual(expect.any(String));

    const entries = await db
      .select()
      .from(auditLog)
      .where(and(eq(auditLog.tenantId, tenantId), eq(auditLog.action, "backup.first_queued")));
    expect(entries).toHaveLength(1);
    expect(entries[0]).toMatchObject({
      actor: "system",
      details: expect.objectContaining({ protectedObjectIds: [objectId] }),
    });
    // The chain hash links to nothing before it: the first entry of this tenant's chain.
    expect(entries[0]?.prevHash).toBeNull();
  });

  it("is idempotent: a second call for the same object queues and audits nothing more", async () => {
    const { tenantId, sourceId } = await tenant(db, "Idempotent");
    const objectId = await activeObject(db, tenantId, sourceId, "ext-repeat");
    const run = tenantRunner(db, tenantId);
    const newlyActive = [{ externalId: "ext-repeat", kind: "mailbox" as const }];

    const first = await run((tx) =>
      enqueueFirstBackupsAfterSync({
        tenantId,
        newlyActive,
        store: pgFirstBackupStore(tx, tenantId, sourceId, boss),
        signal: new AbortController().signal,
        logger: noopLogger,
      }),
    );
    expect(first).toEqual([objectId]);

    const second = await run((tx) =>
      enqueueFirstBackupsAfterSync({
        tenantId,
        newlyActive,
        store: pgFirstBackupStore(tx, tenantId, sourceId, boss),
        signal: new AbortController().signal,
        logger: noopLogger,
      }),
    );
    expect(second).toEqual([]);

    const jobRows = await db
      .select()
      .from(jobs)
      .where(and(eq(jobs.tenantId, tenantId), eq(jobs.protectedObjectId, objectId)));
    expect(jobRows).toHaveLength(1);
    const entries = await db
      .select()
      .from(auditLog)
      .where(and(eq(auditLog.tenantId, tenantId), eq(auditLog.action, "backup.first_queued")));
    expect(entries).toHaveLength(1);
  });

  it("never resolves another tenant's object of the same external id (RLS)", async () => {
    const alpha = await tenant(db, "Alpha-Store");
    const beta = await tenant(db, "Beta-Store");
    // Same external id in both tenants, e.g. two separate directories.
    await activeObject(db, alpha.tenantId, alpha.sourceId, "shared-ext");
    const betaObjectId = await activeObject(db, beta.tenantId, beta.sourceId, "shared-ext");
    const run = tenantRunner(db, beta.tenantId);

    const queued = await run((tx) =>
      enqueueFirstBackupsAfterSync({
        tenantId: beta.tenantId,
        newlyActive: [{ externalId: "shared-ext", kind: "mailbox" }],
        store: pgFirstBackupStore(tx, beta.tenantId, beta.sourceId, boss),
        signal: new AbortController().signal,
        logger: noopLogger,
      }),
    );
    // Only Beta's own object, never Alpha's, however similar the external id.
    expect(queued).toEqual([betaObjectId]);
  });

  it("backs up a mailbox back from disabled at once and does not call it overdue", async () => {
    const { tenantId, sourceId } = await tenant(db, "Resumed");
    const run = tenantRunner(db, tenantId);
    const repository = new PgDirectoryRepository(run, tenantId, sourceId, noopLogger);
    const alice: DirectoryUserRecord = {
      entraObjectId: "user-resumed",
      email: "alice@resumed.example",
      upn: "alice@resumed.example",
      mail: "alice@resumed.example",
      displayName: "Alice",
      accountEnabled: true,
      userType: "Member",
      mailAddresses: null,
    };
    const sync = async (user: DirectoryUserRecord, probe: UserProbe) => {
      const snapshot = await repository.load();
      const plan = planDirectory({
        mode: "incremental",
        users: [user],
        removedUserIds: [],
        known: snapshot.known,
        sharedOrBlockedIds: snapshot.sharedOrBlockedIds,
        probes: new Map([[user.entraObjectId, probe]]),
        rules: DEFAULT_PROTECTION_RULES,
        overrides: {},
        groupMemberIds: null,
      });
      await repository.commit(
        {
          plan,
          deltaLink: "https://graph.microsoft.com/v1.0/users/delta?$deltatoken=r",
          fullSyncAt: null,
        },
        snapshot.version,
      );
    };

    await sync(alice, { mailbox: true });
    const [object] = await db
      .select({ id: protectedObjects.id })
      .from(protectedObjects)
      .where(eq(protectedObjects.sourceId, sourceId));
    const objectId = object?.id as string;
    // Backed up three weeks ago, then the account was disabled for two weeks and more.
    const DAY = 24 * 3_600_000;
    const lastBackup = new Date(Date.now() - 21 * DAY);
    await db.insert(snapshots).values({
      tenantId,
      protectedObjectId: objectId,
      sequence: 1,
      manifestPath: "m/resumed/1",
      itemCount: 1,
      byteSize: 1,
      startedAt: lastBackup,
      completedAt: lastBackup,
    });
    await db
      .update(protectedObjects)
      .set({ activeSince: sql`now() - interval '30 days'` })
      .where(eq(protectedObjects.id, objectId));
    await sync({ ...alice, accountEnabled: false }, { mailbox: false });
    const [orphaned] = await db
      .select({ status: protectedObjects.status, statusReason: protectedObjects.statusReason })
      .from(protectedObjects)
      .where(eq(protectedObjects.id, objectId));
    expect(orphaned).toEqual({ status: "orphaned", statusReason: "account_disabled" });

    // Enabled again: active, and the sync reports it as newly active, resumed from orphaned
    // (packages/core's syncDirectory, unit tested there).
    await sync(alice, { mailbox: true });
    const queued = await run((tx) =>
      enqueueFirstBackupsAfterSync({
        tenantId,
        newlyActive: [{ externalId: "user-resumed", kind: "mailbox", resumed: true }],
        store: pgFirstBackupStore(tx, tenantId, sourceId, boss),
        signal: new AbortController().signal,
        logger: noopLogger,
      }),
    );
    // Queued though it has a snapshot: it does not wait for the tenant's schedule.
    expect(queued).toEqual([objectId]);
    const jobRows = await db
      .select({ status: jobs.status })
      .from(jobs)
      .where(and(eq(jobs.tenantId, tenantId), eq(jobs.protectedObjectId, objectId)));
    expect(jobRows).toEqual([{ status: "queued" }]);

    // The queued backup has not started, so it does not mute the check: the mailbox is judged
    // from its return to active, not from its three-week-old snapshot.
    await alertOverdueBackups({ db, providerDb: db, runtime: {} as never }, new Date());
    const overdue = await db.$client.query(
      "SELECT 1 FROM notifications WHERE tenant_id = $1 AND event = 'backup.overdue'",
      [tenantId],
    );
    expect(overdue.rows).toEqual([]);
  });
});
