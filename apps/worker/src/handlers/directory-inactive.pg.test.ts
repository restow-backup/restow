/**
 * Disabled and unlicensed mailboxes against Postgres (docs/MICROSOFT.md "Disabled and
 * unlicensed accounts"): {@link PgDirectoryRepository} writes the orphan reason the plan gives,
 * reads it back on the next run, and an object the sync finds again turns `active` with the
 * reason cleared (migration 0069's trigger clears it on any write that leaves `orphaned`).
 * The confirmation lifecycle of the same trigger (amber until confirmed, cleared on the way
 * back), the one-time notices (inactive-notices.ts) and a locked OneDrive the sync must not
 * turn active blindly.
 *
 * Runs when RESTOW_TEST_DATABASE_URL points at a Postgres server (a database named
 * `restow_worker_directory_inactive_test` is dropped and recreated there, then migrated).
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
  createDb,
  type Database,
  notifications,
  protectedObjects,
  providers,
  sources,
  tenants,
} from "@restow/db";
import { runMigrations } from "@restow/db/migrate";
import { and, eq, sql } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { raiseInactiveNotices } from "../inactive-notices.js";
import { PgDirectoryRepository } from "./directory.js";
import { tenantRunner } from "./framework.js";

const adminUrl = process.env.RESTOW_TEST_DATABASE_URL;
const TEST_DB = "restow_worker_directory_inactive_test";

async function recreateTestDatabase(base: string): Promise<string> {
  const admin = createDb(base);
  try {
    await admin.$client.query(`DROP DATABASE IF EXISTS ${TEST_DB} WITH (FORCE)`);
    await admin.$client.query(`CREATE DATABASE ${TEST_DB}`);
  } finally {
    await admin.$client.end();
  }
  const url = new URL(base);
  url.pathname = `/${TEST_DB}`;
  await runMigrations(url.toString());
  return url.toString();
}

const alice: DirectoryUserRecord = {
  entraObjectId: "user-1",
  email: "alice@contoso.example",
  upn: "alice@contoso.example",
  mail: "alice@contoso.example",
  displayName: "Alice",
  accountEnabled: true,
  userType: "Member",
  mailAddresses: null,
};

describe.skipIf(!adminUrl)("disabled and unlicensed mailboxes against Postgres", () => {
  let db: Database;

  beforeAll(async () => {
    db = createDb(await recreateTestDatabase(adminUrl as string));
  }, 60_000);

  afterAll(async () => {
    await db?.$client.end();
  });

  async function tenantWithSource() {
    const [provider] = await db.insert(providers).values({ name: "Inactive provider" }).returning();
    const [tenant] = await db
      .insert(tenants)
      .values({
        providerId: provider?.id as string,
        name: "Inactive",
        slug: `inactive-${randomUUID().slice(0, 8)}`,
      })
      .returning();
    const tenantId = tenant?.id as string;
    const [source] = await db
      .insert(sources)
      .values({ tenantId, kind: "m365", name: "Contoso 365", status: "active" })
      .returning();
    return { tenantId, sourceId: source?.id as string };
  }

  async function mailbox(sourceId: string) {
    const [row] = await db
      .select({
        status: protectedObjects.status,
        statusReason: protectedObjects.statusReason,
        activeSince: protectedObjects.activeSince,
      })
      .from(protectedObjects)
      .where(eq(protectedObjects.sourceId, sourceId));
    return row;
  }

  /** One incremental run that sees `user` with the given mailbox probe answer. */
  async function sync(
    repository: PgDirectoryRepository,
    user: DirectoryUserRecord,
    probe: UserProbe,
    lockState?: ReadonlyMap<string, "locked" | "unlocked">,
  ) {
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
      lockState,
    });
    await repository.commit(
      {
        plan,
        deltaLink: "https://graph.microsoft.com/v1.0/users/delta?$deltatoken=x",
        fullSyncAt: null,
      },
      snapshot.version,
    );
    return plan;
  }

  it("stores the reason, changes it, and clears it when the mailbox comes back", async () => {
    const { tenantId, sourceId } = await tenantWithSource();
    const repository = new PgDirectoryRepository(
      tenantRunner(db, tenantId),
      tenantId,
      sourceId,
      noopLogger,
    );
    await sync(repository, alice, { mailbox: true });
    expect(await mailbox(sourceId)).toMatchObject({ status: "active", statusReason: null });

    // Sign-in blocked and Exchange answers "no mailbox": not backed up, account disabled.
    await sync(repository, { ...alice, accountEnabled: false }, { mailbox: false });
    expect(await mailbox(sourceId)).toMatchObject({
      status: "orphaned",
      statusReason: "account_disabled",
    });
    expect((await repository.load()).known[0]?.statusReason).toBe("account_disabled");

    // Re-enabled but still without a licence: only the reason changes.
    await sync(repository, alice, { mailbox: false });
    expect(await mailbox(sourceId)).toMatchObject({
      status: "orphaned",
      statusReason: "no_license",
    });

    // Licensed again: active, the clock restarts, the reason is gone.
    await sync(repository, alice, { mailbox: true });
    const back = await mailbox(sourceId);
    expect(back).toMatchObject({ status: "active", statusReason: null });
    expect(back?.activeSince).not.toBeNull();
  });

  it("never keeps a reason on an object that is not orphaned", async () => {
    const { tenantId, sourceId } = await tenantWithSource();
    const [row] = await db
      .insert(protectedObjects)
      .values({
        tenantId,
        sourceId,
        kind: "mailbox",
        status: "orphaned",
        statusReason: "no_license",
        externalId: "user-9",
      })
      .returning();
    await db
      .update(protectedObjects)
      .set({ status: "excluded" })
      .where(eq(protectedObjects.id, row?.id as string));
    expect(await mailbox(sourceId)).toMatchObject({ status: "excluded", statusReason: null });
    await expect(
      db
        .update(protectedObjects)
        .set({ status: "orphaned", statusReason: "gone" as "no_license" })
        .where(eq(protectedObjects.id, row?.id as string)),
    ).rejects.toThrow();
  });

  async function objectRow(sourceId: string, externalId: string) {
    const [row] = await db
      .select()
      .from(protectedObjects)
      .where(
        and(eq(protectedObjects.sourceId, sourceId), eq(protectedObjects.externalId, externalId)),
      );
    return row;
  }

  async function events(tenantId: string) {
    return db
      .select({
        event: notifications.event,
        level: notifications.level,
        details: notifications.details,
      })
      .from(notifications)
      .where(eq(notifications.tenantId, tenantId));
  }

  it("starts unconfirmed on every transition into orphaned and drops the confirmation on the way back", async () => {
    const { tenantId, sourceId } = await tenantWithSource();
    const repository = new PgDirectoryRepository(
      tenantRunner(db, tenantId),
      tenantId,
      sourceId,
      noopLogger,
    );
    await sync(repository, alice, { mailbox: true });
    expect(await objectRow(sourceId, "user-1")).toMatchObject({
      inactiveSince: null,
      statusConfirmedAt: null,
    });
    await sync(repository, alice, { mailbox: false });
    const orphaned = await objectRow(sourceId, "user-1");
    expect(orphaned?.inactiveSince).toBeInstanceOf(Date);
    expect(orphaned?.statusConfirmedAt).toBeNull();

    // Confirmed by an admin; a reason change keeps the confirmation and the date.
    await db
      .update(protectedObjects)
      .set({ statusConfirmedAt: sql`now()`, statusConfirmedBy: "admin@contoso.example" })
      .where(eq(protectedObjects.id, orphaned?.id as string));
    await sync(repository, { ...alice, accountEnabled: false }, { mailbox: false });
    const changed = await objectRow(sourceId, "user-1");
    expect(changed).toMatchObject({
      statusReason: "account_disabled",
      statusConfirmedBy: "admin@contoso.example",
    });
    expect(changed?.inactiveSince?.getTime()).toBe(orphaned?.inactiveSince?.getTime());

    // Licensed again: active, every inactive column cleared.
    await sync(repository, alice, { mailbox: true });
    expect(await objectRow(sourceId, "user-1")).toMatchObject({
      status: "active",
      statusReason: null,
      inactiveSince: null,
      inactiveNotifiedAt: null,
      statusConfirmedAt: null,
      statusConfirmedBy: null,
    });

    // Inactive again later: asks again.
    await sync(repository, alice, { mailbox: false });
    expect(await objectRow(sourceId, "user-1")).toMatchObject({
      status: "orphaned",
      statusConfirmedAt: null,
      inactiveNotifiedAt: null,
    });
  });

  it("refuses a confirmation without its author", async () => {
    const { tenantId, sourceId } = await tenantWithSource();
    await expect(
      db.insert(protectedObjects).values({
        tenantId,
        sourceId,
        kind: "mailbox",
        status: "orphaned",
        externalId: "user-x",
        statusConfirmedAt: new Date(),
      }),
    ).rejects.toThrow();
  });

  it("raises one notice per object once, and one warning when many go at once", async () => {
    const { tenantId, sourceId } = await tenantWithSource();
    const run = tenantRunner(db, tenantId);
    // 60 active objects, so 1 of them is far below the share for a mass warning.
    await db.insert(protectedObjects).values(
      Array.from({ length: 60 }, (_, index) => ({
        tenantId,
        sourceId,
        kind: "mailbox" as const,
        status: "active" as const,
        externalId: `user-${index}`,
        displayName: `User ${index}`,
      })),
    );
    await db
      .update(protectedObjects)
      .set({ status: "orphaned", statusReason: "no_license" })
      .where(
        and(eq(protectedObjects.sourceId, sourceId), eq(protectedObjects.externalId, "user-0")),
      );
    expect(await run((tx) => raiseInactiveNotices(tx, tenantId))).toBe(1);
    expect(await run((tx) => raiseInactiveNotices(tx, tenantId))).toBe(0);
    expect(await events(tenantId)).toEqual([
      expect.objectContaining({
        event: "object.inactive",
        level: "info",
        details: expect.objectContaining({ reason: "no_license", kind: "mailbox" }),
      }),
    ]);

    // Eleven more at once: one warning, no notice per object.
    await db
      .update(protectedObjects)
      .set({ status: "orphaned" })
      .where(
        and(
          eq(protectedObjects.sourceId, sourceId),
          sql`${protectedObjects.externalId} in (${sql.join(
            Array.from({ length: 11 }, (_, index) => sql`${`user-${index + 1}`}`),
            sql`, `,
          )})`,
        ),
      );
    expect(await run((tx) => raiseInactiveNotices(tx, tenantId))).toBe(11);
    const raised = await events(tenantId);
    expect(raised.map((row) => row.event).sort()).toEqual([
      "object.inactive",
      "object.inactive_many",
    ]);
    expect(raised.find((row) => row.event === "object.inactive_many")).toMatchObject({
      level: "warning",
      details: expect.objectContaining({ count: 12 }),
    });
    // A confirmed object is never told about (the transition itself starts unconfirmed, so the
    // confirmation is a second write).
    const user30 = and(
      eq(protectedObjects.sourceId, sourceId),
      eq(protectedObjects.externalId, "user-30"),
    );
    await db.update(protectedObjects).set({ status: "orphaned" }).where(user30);
    await db
      .update(protectedObjects)
      .set({ statusConfirmedAt: sql`now()`, statusConfirmedBy: "admin" })
      .where(user30);
    expect(await run((tx) => raiseInactiveNotices(tx, tenantId))).toBe(0);

    // An excluded object that leaves the source was never backed up: no notice, no warning.
    const user40 = and(
      eq(protectedObjects.sourceId, sourceId),
      eq(protectedObjects.externalId, "user-40"),
    );
    await db.update(protectedObjects).set({ status: "excluded" }).where(user40);
    await db.update(protectedObjects).set({ status: "orphaned" }).where(user40);
    expect(await run((tx) => raiseInactiveNotices(tx, tenantId))).toBe(0);
  });

  it("keeps a locked OneDrive orphaned until its lock probe answers 200, then resumes it", async () => {
    const { tenantId, sourceId } = await tenantWithSource();
    const repository = new PgDirectoryRepository(
      tenantRunner(db, tenantId),
      tenantId,
      sourceId,
      noopLogger,
    );
    await sync(repository, alice, { mailbox: true, driveId: "b!drive-1" });
    // A backup met the lock (backup.ts markInactive).
    await db
      .update(protectedObjects)
      .set({ status: "orphaned", statusReason: "locked" })
      .where(
        and(eq(protectedObjects.sourceId, sourceId), eq(protectedObjects.externalId, "b!drive-1")),
      );
    expect((await repository.load()).known.find((o) => o.kind === "onedrive")?.statusReason).toBe(
      "locked",
    );

    // Still listed by the drive probe, lock probe unknown or locked: stays locked.
    await sync(repository, alice, { mailbox: true, driveId: "b!drive-1" });
    await sync(
      repository,
      alice,
      { mailbox: true, driveId: "b!drive-1" },
      new Map([["b!drive-1", "locked"]]),
    );
    expect(await objectRow(sourceId, "b!drive-1")).toMatchObject({
      status: "orphaned",
      statusReason: "locked",
    });

    const plan = await sync(
      repository,
      alice,
      { mailbox: true, driveId: "b!drive-1" },
      new Map([["b!drive-1", "unlocked"]]),
    );
    expect(plan.objects.map((o) => [o.externalId, o.status])).toEqual([["b!drive-1", "active"]]);
    expect(await objectRow(sourceId, "b!drive-1")).toMatchObject({
      status: "active",
      statusReason: null,
      inactiveSince: null,
    });
  });
});
