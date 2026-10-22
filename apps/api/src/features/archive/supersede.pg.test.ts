/**
 * Postgres-backed tests of one mail captured by several ways (0.4.4, docs/ARCHIVE.md
 * "Erfassungswege"): the search hides an item a stronger capture superseded unless asked,
 * every result names the other ways that captured the same mail again, and the detail links
 * both directions of a supersede and lists the capture rows.
 *
 * Runs when RESTOW_TEST_DATABASE_URL points at a Postgres server as a superuser (the
 * database `restow_api_archive_supersede_test` is recreated there and dropped after, the
 * roles with it). Without it the suite is skipped.
 */
import { randomBytes, randomUUID } from "node:crypto";
import {
  archiveItemCaptures,
  archiveItems,
  createDb,
  type Database,
  providers,
  tenants,
} from "@restow/db";
import { Hono, type MiddlewareHandler } from "hono";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { SessionUser } from "../../auth.js";
import type { TenantEnv } from "../../middleware/session.js";
import { provisionTestRoles, type TestDatabaseRoles } from "../../testing/database-roles.js";
import {
  dropDatabase,
  recreateDatabase,
  testDatabaseAdminUrl,
} from "../snapshots/testing/explorer-fixture.js";

const DATABASE = "restow_api_archive_supersede_test";

const asAdmin =
  (userId: string): MiddlewareHandler<TenantEnv> =>
  async (c, next) => {
    c.set("tenantId", c.req.header("x-restow-tenant") ?? "");
    c.set("role", "tenant_admin");
    c.set("user", { id: userId, email: "admin@contoso.example" } as unknown as SessionUser);
    await next();
  };

interface Hit {
  id: string;
  source: string;
  supersedesItemId: string | null;
  superseded: boolean;
  alsoCapturedVia: string[];
}

describe.skipIf(!testDatabaseAdminUrl)("archive captures of one mail against Postgres", () => {
  let owner: Database;
  let appDb: Database;
  let roles: TestDatabaseRoles | undefined;
  let app: Hono;
  let tenantId: string;
  const ids = { synced: "", journal: "", forwarded: "" };

  async function get<T>(path: string): Promise<T> {
    const res = await app.request(path, { headers: { "x-restow-tenant": tenantId } });
    expect(res.status).toBe(200);
    return (await res.json()) as T;
  }

  beforeAll(async () => {
    const url = await recreateDatabase(testDatabaseAdminUrl as string, DATABASE);
    roles = await provisionTestRoles(url);
    process.env.DATABASE_URL = roles.appUrl;
    process.env.DATABASE_PROVIDER_URL = roles.providerUrl;
    process.env.RESTOW_MASTER_KEY = randomBytes(32).toString("base64");
    owner = createDb(url);
    appDb = createDb(roles.appUrl);

    const { buildArchiveRoutes } = await import("./routes.js");
    const { errorHandler } = await import("../../problem.js");

    const [provider] = await owner.insert(providers).values({ name: "Provider" }).returning();
    const [tenant] = await owner
      .insert(tenants)
      .values({ providerId: provider?.id ?? "", name: "Contoso", slug: "contoso" })
      .returning();
    tenantId = tenant?.id ?? "";

    async function seed(
      label: keyof typeof ids,
      capturedVia: "graph_sync" | "journal" | "smtp_forward",
      receivedAt: string,
      supersedesItemId: string | null,
    ): Promise<string> {
      const [row] = await owner
        .insert(archiveItems)
        .values({
          tenantId,
          messageId: `msg-${label}`,
          itemHash: `hash-${label}`,
          chainHash: `chain-${label}`,
          receivedAt: new Date(receivedAt),
          capturedVia,
          supersedesItemId,
          storagePath: `tenants/${tenantId}/archive/${label}`,
          subject: `Subject ${label}`,
          envelope: { from: "sender@contoso.example", to: ["anna@contoso.example"] },
        })
        .returning({ id: archiveItems.id });
      ids[label] = row?.id ?? "";
      return ids[label];
    }
    // Graph captured a mail first; the journal report of the same mail arrived later and
    // superseded it. A forwarded copy was archived, and IMAP sync captured it again.
    await seed("synced", "graph_sync", "2026-09-01T10:00:00Z", null);
    await seed("journal", "journal", "2026-09-01T10:00:05Z", ids.synced);
    await seed("forwarded", "smtp_forward", "2026-09-02T08:00:00Z", null);
    await owner.insert(archiveItemCaptures).values([
      {
        tenantId,
        archiveItemId: ids.forwarded,
        capturedVia: "imap_sync",
        itemHash: "hash-forwarded-imap",
        receivedAt: new Date("2026-09-02T08:01:00Z"),
      },
      {
        tenantId,
        archiveItemId: ids.forwarded,
        capturedVia: "imap_sync",
        itemHash: "hash-forwarded-imap-2",
        receivedAt: new Date("2026-09-02T08:02:00Z"),
      },
    ]);

    app = new Hono();
    app.onError(errorHandler);
    app.route("/archive", buildArchiveRoutes({ db: appDb, requireAdmin: asAdmin(randomUUID()) }));
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
    if (roles) {
      await roles.drop(testDatabaseAdminUrl as string);
    }
  }, 60_000);

  it("hides a superseded item from the search unless asked for it", async () => {
    const hidden = await get<{ items: Hit[]; total: number }>("/archive/search");
    expect(hidden.items.map((item) => item.id).sort()).toEqual([ids.journal, ids.forwarded].sort());
    expect(hidden.total).toBe(2);

    const all = await get<{ items: Hit[]; total: number }>(
      "/archive/search?includeSuperseded=true",
    );
    expect(all.total).toBe(3);
    const byId = new Map(all.items.map((item) => [item.id, item]));
    expect(byId.get(ids.synced)).toMatchObject({ superseded: true, supersedesItemId: null });
    expect(byId.get(ids.journal)).toMatchObject({
      superseded: false,
      supersedesItemId: ids.synced,
    });
  });

  it("names the other ways that captured the same mail again, each once", async () => {
    const { items } = await get<{ items: Hit[] }>("/archive/search");
    const forwarded = items.find((item) => item.id === ids.forwarded);
    expect(forwarded).toMatchObject({ source: "smtp_forward", alsoCapturedVia: ["imap_sync"] });
    expect(items.find((item) => item.id === ids.journal)?.alsoCapturedVia).toEqual([]);
  });

  it("links both directions of a supersede and lists the captures in the detail", async () => {
    const older = await get<{ supersededBy: string | null; captures: unknown[] }>(
      `/archive/items/${ids.synced}`,
    );
    expect(older).toMatchObject({ supersededBy: ids.journal, captures: [] });

    const newer = await get<{ supersedesItemId?: string; supersededBy: string | null }>(
      `/archive/items/${ids.journal}`,
    );
    expect(newer).toMatchObject({ supersedesItemId: ids.synced, supersededBy: null });

    const forwarded = await get<{
      captures: { via: string; receivedAt: string; protectedObjectId: string | null }[];
    }>(`/archive/items/${ids.forwarded}`);
    expect(forwarded.captures).toEqual([
      { via: "imap_sync", receivedAt: "2026-09-02T08:01:00.000Z", protectedObjectId: null },
      { via: "imap_sync", receivedAt: "2026-09-02T08:02:00.000Z", protectedObjectId: null },
    ]);
  });
});
