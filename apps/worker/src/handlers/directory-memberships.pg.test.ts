/**
 * The directory sync's memberships of Microsoft 365 groups and their sites (#89) against
 * Postgres: {@link PgDirectoryRepository} stores owners and members of a group on its `group`
 * object and on its group-connected `site` object, skips people not in the directory and
 * communication sites without a group, replaces a group's rows when it is read again (a person
 * who left loses the row, a changed role is updated) also for a group of thousands of members
 * written in slices, records the complete pass and the groups to read again in
 * `sources.config.directory`, and keeps the rows when Graph refuses the membership.
 *
 * Graph is the core package's fake: an empty users delta, a sites listing, `groups/delta` and
 * the membership reads through `$batch`. Runs when RESTOW_TEST_DATABASE_URL points at a Postgres
 * server (a database named `restow_worker_directory_memberships_test` is dropped and recreated
 * there, then migrated).
 */
import { randomUUID } from "node:crypto";
import {
  noopLogger,
  normalizeRules,
  readDirectoryState,
  syncDirectory,
  writeRules,
} from "@restow/core";
import {
  createDb,
  type Database,
  directoryMemberships,
  protectedObjects,
  providers,
  sources,
  tenants,
  users,
} from "@restow/db";
import { runMigrations } from "@restow/db/migrate";
import { eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { FakeGroupDirectory } from "../../../../packages/core/src/backup/groups/testing/fake-group.js";
import { createFakeGraph } from "../../../../packages/core/src/graph/testing/fake-graph.js";
import { FakeMembershipDirectory } from "../../../../packages/core/src/graph/testing/fake-memberships.js";
import { MEMBERSHIP_WRITE_SLICE, PgDirectoryRepository } from "./directory.js";
import { tenantRunner } from "./framework.js";

const adminUrl = process.env.RESTOW_TEST_DATABASE_URL;
const TEST_DB = "restow_worker_directory_memberships_test";

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

const unified = (id: string, displayName: string) => ({
  id,
  displayName,
  mail: `${id}@contoso.example`,
  mailEnabled: true,
  groupTypes: ["Unified"],
  resourceProvisioningOptions: ["Team"],
});

const TEAM_SITE = "contoso.sharepoint.com,team-1,web-1";
const COMMUNICATION_SITE = "contoso.sharepoint.com,news-1,web-2";

function graphFor(groups: FakeGroupDirectory, members: FakeMembershipDirectory) {
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
    {
      url: (u: URL) => u.pathname === "/v1.0/sites/getAllSites",
      respond: {
        status: 200,
        json: {
          value: [
            { id: TEAM_SITE, displayName: "Project", webUrl: "https://contoso/sites/project" },
            { id: COMMUNICATION_SITE, displayName: "News", webUrl: "https://contoso/sites/news" },
          ],
        },
      },
    },
    ...groups.routes(),
    ...members.routes(),
  ]);
}

describe.skipIf(!adminUrl)("directory sync of memberships against Postgres", () => {
  let db: Database;

  beforeAll(async () => {
    db = createDb(await recreateTestDatabase(adminUrl as string));
  }, 60_000);

  afterAll(async () => {
    await db?.$client.end();
  });

  async function setup() {
    const [provider] = await db.insert(providers).values({ name: "Members provider" }).returning();
    const [tenant] = await db
      .insert(tenants)
      .values({
        providerId: provider?.id as string,
        name: "Members",
        slug: `members-${randomUUID().slice(0, 8)}`,
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
        config: writeRules({}, normalizeRules({ groups: "selected" })),
      })
      .returning();
    const people = await db
      .insert(users)
      .values(
        ["anna", "ben", "carla"].map((name) => ({
          tenantId,
          entraObjectId: `u-${name}`,
          email: `${name}@contoso.example`,
          displayName: name,
        })),
      )
      .returning({ id: users.id, entraObjectId: users.entraObjectId });
    const userIds = new Map(people.map((row) => [row.entraObjectId as string, row.id]));
    const sourceId = source?.id as string;
    const run = tenantRunner(db, tenantId);
    const repository = new PgDirectoryRepository(run, tenantId, sourceId, noopLogger);
    const groups = new FakeGroupDirectory();
    groups.set(unified("g-project", "Project"));
    groups.set(unified("g-board", "Board"));
    const members = new FakeMembershipDirectory();
    members.set("g-project", {
      owners: ["u-anna"],
      members: ["u-anna", "u-ben", "u-ghost"],
      others: ["device-1"],
      siteId: TEAM_SITE,
    });
    members.set("g-board", { owners: [], members: ["u-ben"], siteId: null });
    return { tenantId, sourceId, repository, groups, members, userIds };
  }

  /** `<object external id> <entra id> <role>`, sorted. */
  async function rows(sourceId: string) {
    const found = await db
      .select({
        object: protectedObjects.externalId,
        person: users.entraObjectId,
        role: directoryMemberships.role,
      })
      .from(directoryMemberships)
      .innerJoin(protectedObjects, eq(protectedObjects.id, directoryMemberships.protectedObjectId))
      .innerJoin(users, eq(users.id, directoryMemberships.userId))
      .where(eq(protectedObjects.sourceId, sourceId));
    return found.map((row) => `${row.object} ${row.person} ${row.role}`).sort();
  }

  it("stores owners and members on the group and its site, then replaces what changed", async () => {
    const { sourceId, repository, groups, members } = await setup();
    const graph = graphFor(groups, members);
    const first = await syncDirectory({
      client: graph.client(),
      repository,
      sites: true,
      groups: true,
      memberships: true,
      now: () => new Date("2026-11-01T10:00:00.000Z"),
    });
    expect(first.warnings).toEqual([]);
    expect(first.membershipsRead).toBe(2);
    // The communication site has no group, so no rows; the unknown member and the device neither.
    expect(await rows(sourceId)).toEqual([
      `${TEAM_SITE} u-anna owner`,
      `${TEAM_SITE} u-ben member`,
      "g-board u-ben member",
      "g-project u-anna owner",
      "g-project u-ben member",
    ]);
    const [stored] = await db.select().from(sources).where(eq(sources.id, sourceId));
    expect(readDirectoryState(stored?.config).membershipsSyncedAt).toBe("2026-11-01T10:00:00.000Z");

    // Ben leaves the project, Carla owns it now, Anna stays a member; only the changed group is read.
    members.set("g-project", {
      owners: ["u-carla"],
      members: ["u-anna", "u-carla"],
      siteId: TEAM_SITE,
    });
    members.set("g-board", { owners: [], members: [], siteId: null });
    groups.changes = [unified("g-project", "Project")];
    const second = await syncDirectory({
      client: graph.client(),
      repository,
      sites: true,
      groups: true,
      memberships: true,
    });
    expect(second.membershipsRead).toBe(1);
    expect(await rows(sourceId)).toEqual([
      `${TEAM_SITE} u-anna member`,
      `${TEAM_SITE} u-carla owner`,
      "g-board u-ben member",
      "g-project u-anna member",
      "g-project u-carla owner",
    ]);

    // A full run reads the board again: Ben is gone there too.
    await syncDirectory({
      client: graph.client(),
      repository,
      sites: true,
      groups: true,
      memberships: true,
      full: true,
    });
    expect(await rows(sourceId)).not.toContain("g-board u-ben member");
  });

  it("keeps the rows and warns when Graph refuses the membership", async () => {
    const { sourceId, repository, groups, members } = await setup();
    const graph = graphFor(groups, members);
    await syncDirectory({ client: graph.client(), repository, groups: true, memberships: true });
    const before = await rows(sourceId);
    expect(before).toHaveLength(3);
    const state = async () => {
      const [stored] = await db.select().from(sources).where(eq(sources.id, sourceId));
      return readDirectoryState(stored?.config);
    };
    // Without the sites listing the Team's site is no object yet: its group is read again.
    expect((await state()).membershipsRetryIds).toEqual(["g-project"]);

    members.refuse = true;
    const result = await syncDirectory({
      client: graph.client(),
      repository,
      groups: true,
      memberships: true,
      full: true,
    });
    expect(result.warnings.map((warning) => warning.kind)).toEqual(["memberships_unavailable"]);
    expect(result.warnings[0]).toMatchObject({ groups: 2, status: 403 });
    expect(await rows(sourceId)).toEqual(before);
    // Both are read again by the next run, not only by the next full one.
    expect([...(await state()).membershipsRetryIds].sort()).toEqual(["g-board", "g-project"]);
    expect((await state()).membershipsSyncedAt).not.toBeNull();
  });

  it("stores a group of thousands of members across Graph pages and write slices", async () => {
    const { tenantId, sourceId, repository, groups, members } = await setup();
    const size = MEMBERSHIP_WRITE_SLICE + 1200;
    const crowd = Array.from({ length: size }, (_, index) => `u-crowd-${index}`);
    for (let i = 0; i < crowd.length; i += 1000) {
      await db.insert(users).values(
        crowd.slice(i, i + 1000).map((entraObjectId) => ({
          tenantId,
          entraObjectId,
          email: `${entraObjectId}@contoso.example`,
        })),
      );
    }
    members.set("g-board", { owners: ["u-crowd-0"], members: crowd, siteId: null });
    const graph = graphFor(groups, members);
    await syncDirectory({ client: graph.client(), repository, groups: true, memberships: true });
    const boardRows = async () =>
      (await rows(sourceId)).filter((row) => row.startsWith("g-board "));
    let board = await boardRows();
    expect(board).toHaveLength(size);
    expect(board).toContain("g-board u-crowd-0 owner");
    expect(board).toContain(`g-board u-crowd-${size - 1} member`);
    // Read 999 at a time: the first page in the batch, the rest on the next links.
    expect(graph.callsTo("GET", "/groups/g-board/members")).toHaveLength(Math.ceil(size / 999) - 1);

    // Most of them leave and someone else owns it: deletes and the role change in slices too.
    members.set("g-board", { owners: ["u-crowd-1"], members: crowd.slice(0, 1500), siteId: null });
    groups.changes = [unified("g-board", "Board")];
    await syncDirectory({ client: graph.client(), repository, groups: true, memberships: true });
    board = await boardRows();
    expect(board).toHaveLength(1500);
    expect(board).toContain("g-board u-crowd-0 member");
    expect(board).toContain("g-board u-crowd-1 owner");
    expect(board).not.toContain("g-board u-crowd-1500 member");
  }, 60_000);

  it("drops the rows of a person who leaves the directory table", async () => {
    const { sourceId, repository, groups, members, userIds } = await setup();
    await syncDirectory({
      client: graphFor(groups, members).client(),
      repository,
      groups: true,
      memberships: true,
    });
    await db.delete(users).where(eq(users.id, userIds.get("u-ben") as string));
    expect(await rows(sourceId)).toEqual(["g-project u-anna owner"]);
  });
});
