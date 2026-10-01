/**
 * Postgres-backed tests of the message date in the archive: imported mail is
 * captured today but was written years ago, so search results carry `sentAt`,
 * and the date filters and the ordering use `coalesce(sent_at, received_at)`.
 * Retention keeps counting from the capture time (`received_at`), which the
 * results still show.
 *
 * Runs when RESTOW_TEST_DATABASE_URL points at a Postgres server as a
 * superuser (the database `restow_api_archive_sent_at_test` is recreated there
 * and dropped after, the roles with it). Without it the suite is skipped.
 */
import { randomBytes, randomUUID } from "node:crypto";
import { type Database, archiveItems, createDb, providers, tenants } from "@restow/db";
import { Hono, type MiddlewareHandler } from "hono";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { SessionUser } from "../../auth.js";
import type { TenantEnv } from "../../middleware/session.js";
import { type TestDatabaseRoles, provisionTestRoles } from "../../testing/database-roles.js";
import {
  dropDatabase,
  recreateDatabase,
  testDatabaseAdminUrl,
} from "../snapshots/testing/explorer-fixture.js";

const DATABASE = "restow_api_archive_sent_at_test";

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
  subject: string | null;
  receivedAt: string;
  sentAt: string | null;
}

describe.skipIf(!testDatabaseAdminUrl)("archive message dates against Postgres", () => {
  let owner: Database;
  let appDb: Database;
  let roles: TestDatabaseRoles | undefined;
  let app: Hono;
  let tenantId: string;
  const ids: Record<"old" | "recent" | "middle", string> = { old: "", recent: "", middle: "" };

  async function search(query: string): Promise<{ items: Hit[]; total: number }> {
    const res = await app.request(`/archive/search${query}`, {
      headers: { "x-restow-tenant": tenantId },
    });
    expect(res.status).toBe(200);
    return (await res.json()) as { items: Hit[]; total: number };
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
      subject: string,
      receivedAt: string,
      sentAt: string | null,
    ): Promise<void> {
      const [row] = await owner
        .insert(archiveItems)
        .values({
          tenantId,
          messageId: `msg-${label}`,
          itemHash: `hash-${label}`,
          chainHash: `chain-${label}`,
          receivedAt: new Date(receivedAt),
          sentAt: sentAt ? new Date(sentAt) : null,
          capturedVia: "file_import",
          storagePath: `tenants/${tenantId}/archive/${label}`,
          subject,
          envelope: { from: "sender@contoso.example", to: ["anna@contoso.example"] },
        })
        .returning({ id: archiveItems.id });
      ids[label] = row?.id ?? "";
    }
    // Captured in September 2026; written in 2010 (import), never dated (journal), in January 2026 (import).
    await seed("old", "Old letter", "2026-09-01T00:00:00Z", "2010-05-01T09:00:00Z");
    await seed("recent", "Recent mail", "2026-08-15T00:00:00Z", null);
    await seed("middle", "Middle mail", "2026-09-10T00:00:00Z", "2026-01-01T09:00:00Z");

    app = new Hono();
    app.onError(errorHandler);
    app.route("/archive", buildArchiveRoutes({ db: appDb, requireAdmin: asAdmin(randomUUID()) }));
  }, 60_000);

  afterAll(async () => {
    const shared = await import("../../db.js");
    await Promise.all([shared.db.$client.end(), shared.providerDb.$client.end()]);
    await appDb?.$client.end();
    await owner?.$client.end();
    await dropDatabase(testDatabaseAdminUrl as string, DATABASE);
    if (roles) {
      await roles.drop(testDatabaseAdminUrl as string);
    }
  }, 60_000);

  it("returns the message's own date next to the capture time, or null", async () => {
    const { items } = await search("");
    const byId = new Map(items.map((item) => [item.id, item]));
    expect(byId.get(ids.old)).toMatchObject({
      receivedAt: "2026-09-01T00:00:00.000Z",
      sentAt: "2010-05-01T09:00:00.000Z",
    });
    expect(byId.get(ids.recent)).toMatchObject({
      receivedAt: "2026-08-15T00:00:00.000Z",
      sentAt: null,
    });
  });

  it("orders by the message date, falling back to the capture time", async () => {
    // Ordering by capture time alone would give middle, old, recent.
    const { items } = await search("");
    expect(items.map((item) => item.id)).toEqual([ids.recent, ids.middle, ids.old]);
  });

  it("filters the start of a date range by the message date", async () => {
    const { items, total } = await search("?dateFrom=2026-01-01T00:00:00Z");
    // The 2010 letter was captured in September 2026 but is not from 2026.
    expect(items.map((item) => item.id).sort()).toEqual([ids.middle, ids.recent].sort());
    expect(total).toBe(2);
  });

  it("filters the end of a date range by the message date", async () => {
    const { items } = await search("?dateTo=2011-01-01T00:00:00Z");
    expect(items.map((item) => item.id)).toEqual([ids.old]);
    const none = await search("?dateFrom=2012-01-01T00:00:00Z&dateTo=2025-12-31T00:00:00Z");
    expect(none.items).toEqual([]);
    expect(none.total).toBe(0);
  });

  it("falls back to the capture time for an item without a message date", async () => {
    const { items } = await search("?dateFrom=2026-08-01T00:00:00Z&dateTo=2026-08-31T00:00:00Z");
    expect(items.map((item) => item.id)).toEqual([ids.recent]);
  });

  it("combines the date filter with full text search", async () => {
    const { items } = await search("?q=mail&dateFrom=2026-01-01T00:00:00Z");
    expect(items.map((item) => item.id)).toEqual([ids.recent, ids.middle]);
    const old = await search("?q=letter&dateTo=2011-01-01T00:00:00Z");
    expect(old.items.map((item) => item.id)).toEqual([ids.old]);
  });

  it("pages through the ordered results", async () => {
    const first = await search("?limit=2&offset=0");
    const second = await search("?limit=2&offset=2");
    expect(first.items.map((item) => item.id)).toEqual([ids.recent, ids.middle]);
    expect(second.items.map((item) => item.id)).toEqual([ids.old]);
    expect(second.total).toBe(3);
  });

  it("returns sentAt when one item is read", async () => {
    const read = async (id: string) => {
      const res = await app.request(`/archive/items/${id}`, {
        headers: { "x-restow-tenant": tenantId },
      });
      expect(res.status).toBe(200);
      return (await res.json()) as { id: string; sentAt: string | null; receivedAt: string };
    };
    expect(await read(ids.old)).toMatchObject({
      id: ids.old,
      sentAt: "2010-05-01T09:00:00.000Z",
      receivedAt: "2026-09-01T00:00:00.000Z",
    });
    expect((await read(ids.recent)).sentAt).toBeNull();
  });
});
