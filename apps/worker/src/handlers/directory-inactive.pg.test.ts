/**
 * Disabled and unlicensed mailboxes against Postgres (docs/MICROSOFT.md "Disabled and
 * unlicensed accounts"): {@link PgDirectoryRepository} writes the orphan reason the plan gives,
 * reads it back on the next run, and an object the sync finds again turns `active` with the
 * reason cleared (migration 0069's trigger clears it on any write that leaves `orphaned`).
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
import { createDb, type Database, protectedObjects, providers, sources, tenants } from "@restow/db";
import { runMigrations } from "@restow/db/migrate";
import { eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
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
});
