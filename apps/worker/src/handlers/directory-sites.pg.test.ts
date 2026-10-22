/**
 * The directory sync's SharePoint sites against Postgres: {@link PgDirectoryRepository}
 * writes `site` objects without a user, keeps them out of the users' plan (a full
 * enumeration orphans objects without an owner, sites must not be among them),
 * orphans a site the tenant listing no longer has, and applies the sites mode.
 *
 * Graph is a hand-written stub: an empty users delta and a `getAllSites` listing.
 * Runs when RESTOW_TEST_DATABASE_URL points at a Postgres server (a database named
 * `restow_worker_directory_sites_test` is dropped and recreated there, then migrated).
 */
import { randomUUID } from "node:crypto";
import { type GraphClient, noopLogger, syncDirectory, writeRules } from "@restow/core";
import { createDb, type Database, protectedObjects, providers, sources, tenants } from "@restow/db";
import { runMigrations } from "@restow/db/migrate";
import { eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { PgDirectoryRepository } from "./directory.js";
import { tenantRunner } from "./framework.js";

const adminUrl = process.env.RESTOW_TEST_DATABASE_URL;
const TEST_DB = "restow_worker_directory_sites_test";

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

interface StubSite {
  id: string;
  displayName: string;
  webUrl: string;
}

/** Users delta: nothing; sites: whatever `sites` holds when asked. */
function graphStub(sites: { current: StubSite[] }): GraphClient {
  return {
    async request<T>(req: { url: string }) {
      if (req.url.startsWith("/sites/getAllSites")) {
        return { status: 200, headers: {}, body: { value: sites.current } as T };
      }
      return { status: 404, headers: {}, body: { error: { code: "notFound" } } as T };
    },
    async stream() {
      throw new Error("not used");
    },
    async batch() {
      return [];
    },
    async *delta<T>() {
      yield {
        value: [] as T[],
        deltaLink: "https://graph.microsoft.com/v1.0/users/delta?$deltatoken=U1",
      };
    },
  };
}

describe.skipIf(!adminUrl)("directory sync of SharePoint sites against Postgres", () => {
  let db: Database;

  beforeAll(async () => {
    db = createDb(await recreateTestDatabase(adminUrl as string));
  }, 60_000);

  afterAll(async () => {
    await db?.$client.end();
  });

  async function tenantWithSource() {
    const [provider] = await db.insert(providers).values({ name: "Sites provider" }).returning();
    const [tenant] = await db
      .insert(tenants)
      .values({
        providerId: provider?.id as string,
        name: "Sites",
        slug: `sites-${randomUUID().slice(0, 8)}`,
      })
      .returning();
    const tenantId = tenant?.id as string;
    const [source] = await db
      .insert(sources)
      .values({ tenantId, kind: "m365", name: "Contoso 365", status: "active" })
      .returning();
    return { tenantId, sourceId: source?.id as string };
  }

  async function siteRows(sourceId: string) {
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

  it("writes sites without a user, survives full syncs and orphans vanished sites", async () => {
    const { tenantId, sourceId } = await tenantWithSource();
    const run = tenantRunner(db, tenantId);
    const repository = new PgDirectoryRepository(run, tenantId, sourceId, noopLogger);
    const sites = {
      current: [
        { id: "host,1,1", displayName: "Sales", webUrl: "https://contoso/sites/sales" },
        { id: "host,2,2", displayName: "HR", webUrl: "https://contoso/sites/hr" },
      ],
    };
    const first = await syncDirectory({
      client: graphStub(sites),
      repository,
      sites: true,
      full: true,
    });
    expect(first.newlyActive).toEqual([
      { externalId: "host,1,1", kind: "site" },
      { externalId: "host,2,2", kind: "site" },
    ]);
    expect(await siteRows(sourceId)).toEqual([
      {
        externalId: "host,1,1",
        kind: "site",
        status: "active",
        userId: null,
        displayName: "Sales",
      },
      { externalId: "host,2,2", kind: "site", status: "active", userId: null, displayName: "HR" },
    ]);

    // A full enumeration again: the sites have no owner, but they are not orphaned.
    sites.current = [sites.current[0] as StubSite];
    await syncDirectory({ client: graphStub(sites), repository, sites: true, full: true });
    expect((await siteRows(sourceId)).map((row) => [row.externalId, row.status])).toEqual([
      ["host,1,1", "active"],
      ["host,2,2", "orphaned"],
    ]);
  });

  it("protects only included sites once the sites mode is selected", async () => {
    const { tenantId, sourceId } = await tenantWithSource();
    const [source] = await db.select().from(sources).where(eq(sources.id, sourceId));
    const config = writeRules(source?.config ?? {}, {
      mode: "all",
      groupId: null,
      groupName: null,
      exclude: [],
      includeSharedMailboxes: true,
      sites: "selected",
      groups: "selected",
    });
    await db.update(sources).set({ config }).where(eq(sources.id, sourceId));
    const run = tenantRunner(db, tenantId);
    const repository = new PgDirectoryRepository(run, tenantId, sourceId, noopLogger);
    const result = await syncDirectory({
      client: graphStub({
        current: [{ id: "host,9,9", displayName: "Board", webUrl: "https://contoso/sites/board" }],
      }),
      repository,
      sites: true,
    });
    expect(result.newlyActive).toEqual([]);
    expect((await siteRows(sourceId)).map((row) => [row.externalId, row.status])).toEqual([
      ["host,9,9", "excluded"],
    ]);
  });
});
