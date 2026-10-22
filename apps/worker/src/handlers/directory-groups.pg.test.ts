/**
 * The directory sync's Microsoft 365 group mailboxes against Postgres:
 * {@link PgDirectoryRepository} writes `group` objects without a user, keeps
 * them out of the users' plan, stores the groups delta link in
 * `sources.config.directory`, reads only changes on the next run, orphans a
 * removed group, and applies the groups mode (opt-in by default).
 *
 * Graph is the core package's fake: an empty users delta and `groups/delta`.
 * Runs when RESTOW_TEST_DATABASE_URL points at a Postgres server (a database named
 * `restow_worker_directory_groups_test` is dropped and recreated there, then migrated).
 */
import { randomUUID } from "node:crypto";
import {
  noopLogger,
  normalizeRules,
  readDirectoryState,
  syncDirectory,
  writeRules,
} from "@restow/core";
import { createDb, type Database, protectedObjects, providers, sources, tenants } from "@restow/db";
import { runMigrations } from "@restow/db/migrate";
import { eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { FakeGroupDirectory } from "../../../../packages/core/src/backup/groups/testing/fake-group.js";
import { createFakeGraph } from "../../../../packages/core/src/graph/testing/fake-graph.js";
import { PgDirectoryRepository } from "./directory.js";
import { tenantRunner } from "./framework.js";

const adminUrl = process.env.RESTOW_TEST_DATABASE_URL;
const TEST_DB = "restow_worker_directory_groups_test";

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

const unified = (id: string, displayName: string, extra: Record<string, unknown> = {}) => ({
  id,
  displayName,
  mail: `${id}@contoso.example`,
  mailEnabled: true,
  groupTypes: ["Unified"],
  resourceProvisioningOptions: [],
  ...extra,
});

function graphFor(groups: FakeGroupDirectory) {
  return createFakeGraph([
    {
      url: (u: URL) => u.pathname === "/v1.0/users/delta",
      respond: {
        status: 200,
        json: {
          value: [],
          "@odata.deltaLink": "https://graph.microsoft.com/v1.0/users/delta?$deltatoken=U1",
        },
      },
    },
    ...groups.routes(),
  ]);
}

describe.skipIf(!adminUrl)("directory sync of group mailboxes against Postgres", () => {
  let db: Database;

  beforeAll(async () => {
    db = createDb(await recreateTestDatabase(adminUrl as string));
  }, 60_000);

  afterAll(async () => {
    await db?.$client.end();
  });

  async function tenantWithSource(groupsMode: "all" | "selected") {
    const [provider] = await db.insert(providers).values({ name: "Groups provider" }).returning();
    const [tenant] = await db
      .insert(tenants)
      .values({
        providerId: provider?.id as string,
        name: "Groups",
        slug: `groups-${randomUUID().slice(0, 8)}`,
      })
      .returning();
    const tenantId = tenant?.id as string;
    const [source] = await db
      .insert(sources)
      .values({
        tenantId,
        kind: "m365",
        name: "Contoso 365",
        status: "active",
        config: writeRules({}, normalizeRules({ groups: groupsMode })),
      })
      .returning();
    return { tenantId, sourceId: source?.id as string };
  }

  async function groupRows(sourceId: string) {
    const rows = await db
      .select({
        externalId: protectedObjects.externalId,
        kind: protectedObjects.kind,
        status: protectedObjects.status,
        userId: protectedObjects.userId,
        displayName: protectedObjects.displayName,
      })
      .from(protectedObjects)
      .where(eq(protectedObjects.sourceId, sourceId));
    return rows.sort((a, b) => a.externalId.localeCompare(b.externalId));
  }

  it("writes group mailboxes without a user, then reads only the changes", async () => {
    const { tenantId, sourceId } = await tenantWithSource("all");
    const run = tenantRunner(db, tenantId);
    const repository = new PgDirectoryRepository(run, tenantId, sourceId, noopLogger);
    const groups = new FakeGroupDirectory();
    groups.set(unified("g-1", "Sales"));
    groups.set(unified("g-2", "Project", { resourceProvisioningOptions: ["Team"] }));
    groups.set({ id: "g-sec", displayName: "VPN", groupTypes: [], securityEnabled: true });
    const graph = graphFor(groups);

    const first = await syncDirectory({
      client: graph.client(),
      repository,
      groups: true,
      full: true,
    });
    expect(first.newlyActive).toEqual([
      { externalId: "g-1", kind: "group" },
      { externalId: "g-2", kind: "group" },
    ]);
    expect(await groupRows(sourceId)).toEqual([
      { externalId: "g-1", kind: "group", status: "active", userId: null, displayName: "Sales" },
      {
        externalId: "g-2",
        kind: "group",
        status: "active",
        userId: null,
        displayName: "Project",
      },
    ]);
    const [stored] = await db.select().from(sources).where(eq(sources.id, sourceId));
    const link = readDirectoryState(stored?.config).groupsDeltaLink;
    expect(link).toContain("$deltatoken=");

    // The next run continues from the stored link; a full users sync does not orphan groups.
    groups.changes = [{ id: "g-2", "@removed": { reason: "deleted" } }];
    await syncDirectory({ client: graph.client(), repository, groups: true });
    const deltaCalls = graph.calls.filter((call) => call.url.includes("/groups/delta"));
    expect(deltaCalls.at(-1)?.url).toBe(link);
    expect((await groupRows(sourceId)).map((row) => [row.externalId, row.status])).toEqual([
      ["g-1", "active"],
      ["g-2", "orphaned"],
    ]);
  });

  it("keeps group mailboxes unprotected until an admin opts in", async () => {
    const { tenantId, sourceId } = await tenantWithSource("selected");
    const run = tenantRunner(db, tenantId);
    const repository = new PgDirectoryRepository(run, tenantId, sourceId, noopLogger);
    const groups = new FakeGroupDirectory();
    groups.set(unified("g-9", "Board"));
    const result = await syncDirectory({
      client: graphFor(groups).client(),
      repository,
      groups: true,
    });
    expect(result.newlyActive).toEqual([]);
    expect((await groupRows(sourceId)).map((row) => [row.externalId, row.status])).toEqual([
      ["g-9", "excluded"],
    ]);
  });
});
