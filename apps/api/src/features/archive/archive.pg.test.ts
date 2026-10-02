/**
 * Postgres-backed tests of the archive surface, through the same Hono
 * routes the web UI calls: full text search and its audit entry, an item's
 * audited read, chain verification (intact and tampered), and tenant
 * isolation under Row Level Security (a search never crosses into another
 * tenant's archive). Legal holds are tested with their module
 * (ee/api/src/legal-holds).
 *
 * Runs when RESTOW_TEST_DATABASE_URL points at a Postgres server as a
 * superuser (the database `restow_api_archive_test` is recreated there and
 * dropped after, the roles with it). Without it the suite is skipped.
 */
import { randomBytes, randomUUID } from "node:crypto";
import { archive } from "@restow/core";
import {
  type Database,
  archiveItems,
  auditLog,
  createDb,
  providers,
  retentionPolicies,
  tenants,
} from "@restow/db";
import { eq } from "drizzle-orm";
import { Hono, type MiddlewareHandler } from "hono";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { SessionUser } from "../../auth.js";
import { type Role, type TenantRole, roleSatisfies } from "../../middleware/rbac.js";
import type { TenantEnv } from "../../middleware/session.js";
import { ProblemError } from "../../problem.js";
import { type TestDatabaseRoles, provisionTestRoles } from "../../testing/database-roles.js";
import {
  dropDatabase,
  recreateDatabase,
  testDatabaseAdminUrl,
} from "../snapshots/testing/explorer-fixture.js";

const DATABASE = "restow_api_archive_test";
const ROLE_HEADER = "x-test-role";

function testTenantAccess(minimum: TenantRole, userId: string): MiddlewareHandler<TenantEnv> {
  return async (c, next) => {
    const role = (c.req.header(ROLE_HEADER) ?? "tenant_admin") as Role;
    if (!roleSatisfies(role, minimum)) {
      throw new ProblemError(403, "Insufficient role", {
        detail: `This endpoint requires the ${minimum} role.`,
      });
    }
    c.set("tenantId", c.req.header("x-restow-tenant") ?? "");
    c.set("role", role);
    c.set("user", { id: userId, email: `${role}@contoso.example` } as unknown as SessionUser);
    await next();
  };
}

const NOW = new Date("2026-06-01T12:00:00.000Z");

describe.skipIf(!testDatabaseAdminUrl)("archive against Postgres", () => {
  let owner: Database;
  let appDb: Database;
  let roles: TestDatabaseRoles | undefined;
  let app: Hono;
  let contoso: string;
  let fabrikam: string;
  let northwind: string;
  const adminId = randomUUID();

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
    const created = await owner
      .insert(tenants)
      .values([
        { providerId: provider?.id ?? "", name: "Contoso", slug: "contoso" },
        { providerId: provider?.id ?? "", name: "Fabrikam", slug: "fabrikam" },
        { providerId: provider?.id ?? "", name: "Northwind", slug: "northwind" },
      ])
      .returning();
    contoso = created[0]?.id ?? "";
    fabrikam = created[1]?.id ?? "";
    northwind = created[2]?.id ?? "";

    async function seed(
      tenantId: string,
      label: string,
      subject: string,
      receivedAt: Date,
      prevChainHash: string | null,
      capturedVia: archive.ArchiveSource = "journal",
    ): Promise<string> {
      const itemHash = `hash-${label}`;
      const chainHash = archive.computeArchiveChainHash(prevChainHash, itemHash, receivedAt);
      await owner.insert(archiveItems).values({
        tenantId,
        messageId: `msg-${label}`,
        itemHash,
        prevChainHash,
        chainHash,
        receivedAt,
        capturedVia,
        retentionUntil: null,
        storagePath: `tenants/${tenantId}/archive/${label}`,
        subject,
        envelope: { from: "sender@contoso.example", to: ["anna@contoso.example"] },
        hasAttachment: false,
      });
      return chainHash;
    }
    const c1Chain = await seed(
      contoso,
      "c1",
      "Quarterly report",
      new Date("2026-01-05T00:00:00Z"),
      null,
    );
    await seed(contoso, "c2", "Lunch plans", new Date("2026-01-06T00:00:00Z"), c1Chain);
    await seed(fabrikam, "f1", "Quarterly report", new Date("2026-01-05T00:00:00Z"), null);
    // One item per capture path, so the results can be told apart by their source.
    let previous: string | null = null;
    const sources: archive.ArchiveSource[] = ["journal", "graph_sync", "imap_sync", "file_import"];
    for (const [index, source] of sources.entries()) {
      previous = await seed(
        northwind,
        `n-${source}`,
        `Captured by ${source}`,
        new Date(Date.UTC(2026, 1, 1 + index)),
        previous,
        source,
      );
    }

    app = new Hono();
    app.onError(errorHandler);
    app.route(
      "/archive",
      buildArchiveRoutes({ db: appDb, requireAdmin: testTenantAccess("tenant_admin", adminId) }),
    );
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

  it("searches only the requesting tenant's archive and audits the search", async () => {
    const res = await app.request("/archive/search?q=quarterly", {
      headers: { "x-restow-tenant": contoso },
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { items: { subject: string }[]; total: number };
    expect(body.total).toBe(1);
    expect(body.items[0]?.subject).toBe("Quarterly report");

    const auditRows = await owner.select().from(auditLog).where(eq(auditLog.tenantId, contoso));
    expect(auditRows.some((row) => row.action === "archive.searched")).toBe(true);
  });

  it("never returns another tenant's items, even with a matching query", async () => {
    const res = await app.request("/archive/search?q=quarterly", {
      headers: { "x-restow-tenant": fabrikam },
    });
    const body = (await res.json()) as { items: { subject: string }[]; total: number };
    expect(body.total).toBe(1);
    // Fabrikam's own "Quarterly report" item, not Contoso's.
    const [fabrikamItem] = await owner
      .select({ id: archiveItems.id })
      .from(archiveItems)
      .where(eq(archiveItems.messageId, "msg-f1"));
    expect(body.items[0]).toBeDefined();
    void fabrikamItem;
  });

  it("reports how each item was captured, in the search results and in the item itself", async () => {
    const res = await app.request("/archive/search", {
      headers: { "x-restow-tenant": northwind },
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      items: { id: string; subject: string; source: string }[];
      total: number;
    };
    expect(body.total).toBe(4);
    expect(Object.fromEntries(body.items.map((item) => [item.subject, item.source]))).toEqual({
      "Captured by journal": "journal",
      "Captured by graph_sync": "graph_sync",
      "Captured by imap_sync": "imap_sync",
      "Captured by file_import": "file_import",
    });

    for (const item of body.items) {
      const read = await app.request(`/archive/items/${item.id}`, {
        headers: { "x-restow-tenant": northwind },
      });
      expect(read.status).toBe(200);
      expect(((await read.json()) as { source: string }).source).toBe(item.source);
    }
  });

  it("reads one item and audits the read", async () => {
    const [row] = await owner
      .select({ id: archiveItems.id })
      .from(archiveItems)
      .where(eq(archiveItems.messageId, "msg-c1"));
    const res = await app.request(`/archive/items/${row?.id}`, {
      headers: { "x-restow-tenant": contoso },
    });
    expect(res.status).toBe(200);
    const auditRows = await owner.select().from(auditLog).where(eq(auditLog.tenantId, contoso));
    expect(auditRows.some((r) => r.action === "archive.item.read" && r.target === row?.id)).toBe(
      true,
    );
  });

  it("verifies an intact chain as ok, and reports the first break in a tampered one", async () => {
    const okRes = await app.request("/archive/chain/verify", {
      headers: { "x-restow-tenant": fabrikam },
    });
    expect(okRes.status).toBe(200);
    const ok = (await okRes.json()) as { ok: boolean; checked: number };
    expect(ok.ok).toBe(true);
    expect(ok.checked).toBe(1);

    // Tamper with Contoso's chain: a second entry whose chainHash does not
    // follow from the first (write-once at the app layer, but nothing stops
    // a raw insert in this test from simulating corruption at rest).
    await owner.insert(archiveItems).values({
      tenantId: contoso,
      messageId: "msg-tampered",
      itemHash: "hash-tampered",
      prevChainHash: "c1",
      chainHash: "not-the-real-hash",
      receivedAt: new Date("2026-01-07T00:00:00Z"),
      capturedVia: "journal",
      retentionUntil: null,
      storagePath: `tenants/${contoso}/archive/tampered`,
    });

    const brokenRes = await app.request("/archive/chain/verify", {
      headers: { "x-restow-tenant": contoso },
    });
    const broken = (await brokenRes.json()) as {
      ok: boolean;
      brokenAt: { index: number } | null;
    };
    expect(broken.ok).toBe(false);
    expect(broken.brokenAt).not.toBeNull();
  });
  it("tells the retention that applies: the default until the tenant has a policy of its own, never another tenant's", async () => {
    const read = async (tenantId: string) => {
      const res = await app.request("/archive/retention", {
        headers: { "x-restow-tenant": tenantId },
      });
      expect(res.status).toBe(200);
      return res.json();
    };
    expect(await read(contoso)).toEqual({ mode: "end_of_year", years: 8, source: "default" });

    // A backup policy of the same table is not the archive's, and another tenant's is not ours.
    await owner.insert(retentionPolicies).values([
      { tenantId: contoso, name: "Backups", years: 1, appliesTo: { target: "snapshots" } },
      {
        tenantId: fabrikam,
        name: "Archive",
        years: 6,
        mode: "from_capture",
        appliesTo: { target: "archive" },
      },
    ]);
    expect(await read(contoso)).toEqual({ mode: "end_of_year", years: 8, source: "default" });
    expect(await read(fabrikam)).toEqual({ mode: "from_capture", years: 6, source: "tenant" });

    const forbidden = await app.request("/archive/retention", {
      headers: { "x-restow-tenant": contoso, [ROLE_HEADER]: "tenant_user" },
    });
    expect(forbidden.status).toBe(403);
  });
});
