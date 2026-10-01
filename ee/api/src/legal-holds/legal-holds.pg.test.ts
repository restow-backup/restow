/**
 * Postgres-backed tests of the legal hold routes, mounted exactly as the api
 * mounts every ee/ route group (behind their license guard, ../license/gate.ts
 * `gateRoutes`): without the Business edition every path answers 404 like an
 * unregistered one; with it a tenant administrator places, lists and
 * releases a hold, each change audited in the tenant's chain.
 *
 * Runs when RESTOW_TEST_DATABASE_URL points at a Postgres server as a
 * superuser (the database `restow_ee_legal_holds_test` is recreated there
 * and dropped after, the roles with it). Without it the suite is skipped.
 */
import { randomBytes, randomUUID } from "node:crypto";
import { type Database, auditLog, createDb, license, providers, tenants, user } from "@restow/db";
import { eq } from "drizzle-orm";
import { Hono, type MiddlewareHandler } from "hono";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { SessionUser } from "../../../../apps/api/src/auth.js";
import {
  dropDatabase,
  recreateDatabase,
  testDatabaseAdminUrl,
} from "../../../../apps/api/src/features/snapshots/testing/explorer-fixture.js";
import type { TenantEnv } from "../../../../apps/api/src/middleware/session.js";
import {
  type TestDatabaseRoles,
  provisionTestRoles,
} from "../../../../apps/api/src/testing/database-roles.js";

const DATABASE = "restow_ee_legal_holds_test";

/** Stand-in for requireTenant("tenant_admin"): the tenant comes from the header. */
function testTenantAdmin(userId: string): MiddlewareHandler<TenantEnv> {
  return async (c, next) => {
    c.set("tenantId", c.req.header("x-restow-tenant") ?? "");
    c.set("role", "tenant_admin");
    c.set("user", { id: userId, email: "admin@contoso.example" } as unknown as SessionUser);
    await next();
  };
}

describe.skipIf(!testDatabaseAdminUrl)("legal holds against Postgres", () => {
  let owner: Database;
  let appDb: Database;
  let roles: TestDatabaseRoles | undefined;
  let app: Hono;
  let contoso: string;
  const adminId = randomUUID();

  beforeAll(async () => {
    const url = await recreateDatabase(testDatabaseAdminUrl as string, DATABASE);
    roles = await provisionTestRoles(url);
    process.env.DATABASE_URL = roles.appUrl;
    process.env.DATABASE_PROVIDER_URL = roles.providerUrl;
    process.env.RESTOW_MASTER_KEY = randomBytes(32).toString("base64");
    owner = createDb(url);
    appDb = createDb(roles.appUrl);

    const { buildLegalHoldRoutes, LEGAL_HOLDS_PATH } = await import("./routes.js");
    const { gateRoutes } = await import("../license/gate.js");
    const { errorHandler, notFoundHandler } = await import("../../../../apps/api/src/problem.js");

    const [provider] = await owner.insert(providers).values({ name: "Provider" }).returning();
    const [tenant] = await owner
      .insert(tenants)
      .values({ providerId: provider?.id ?? "", name: "Contoso", slug: "contoso" })
      .returning();
    contoso = tenant?.id ?? "";
    // A hold records who placed it via a real FK to better-auth `user`.
    await owner.insert(user).values({ id: adminId, name: "Admin", email: "admin@contoso.example" });

    app = new Hono();
    app.onError(errorHandler);
    app.notFound(notFoundHandler);
    app.route(
      LEGAL_HOLDS_PATH,
      gateRoutes(
        appDb,
        "archive.legalHold",
        buildLegalHoldRoutes({ db: appDb, requireAdmin: testTenantAdmin(adminId) }),
      ),
    );
  }, 60_000);

  afterAll(async () => {
    const shared = await import("../../../../apps/api/src/db.js");
    await Promise.all([shared.db.$client.end(), shared.providerDb.$client.end()]);
    await appDb?.$client.end();
    await owner?.$client.end();
    await dropDatabase(testDatabaseAdminUrl as string, DATABASE);
    if (roles) {
      await roles.drop(testDatabaseAdminUrl as string);
    }
  }, 60_000);

  it("answers 404 on the Community edition, as for an unregistered path", async () => {
    for (const [method, path] of [
      ["GET", "/archive/legal-holds"],
      ["POST", "/archive/legal-holds"],
      ["DELETE", `/archive/legal-holds/${randomUUID()}`],
    ] as const) {
      const res = await app.request(path, { method, headers: { "x-restow-tenant": contoso } });
      expect(res.status).toBe(404);
      const body = (await res.json()) as { title: string; detail: string };
      expect(body.title).toBe("Not Found");
      expect(body.detail).toBe(`No handler for ${method} ${path}.`);
    }
  });

  it("lets a Business-edition tenant create, list and release a legal hold, audited", async () => {
    await owner.insert(license).values({
      edition: "business",
      active: true,
      installationId: "test-installation",
    });

    const createRes = await app.request("/archive/legal-holds", {
      method: "POST",
      headers: { "x-restow-tenant": contoso, "content-type": "application/json" },
      body: JSON.stringify({ reason: "Litigation hold" }),
    });
    expect(createRes.status).toBe(201);
    const created = (await createRes.json()) as { id: string; active: boolean };
    expect(created.active).toBe(true);

    const listRes = await app.request("/archive/legal-holds", {
      headers: { "x-restow-tenant": contoso },
    });
    const list = (await listRes.json()) as { items: { id: string }[] };
    expect(list.items.some((item) => item.id === created.id)).toBe(true);

    const releaseRes = await app.request(`/archive/legal-holds/${created.id}`, {
      method: "DELETE",
      headers: { "x-restow-tenant": contoso },
    });
    expect(releaseRes.status).toBe(200);
    const released = (await releaseRes.json()) as { active: boolean };
    expect(released.active).toBe(false);

    const auditRows = await owner.select().from(auditLog).where(eq(auditLog.tenantId, contoso));
    expect(auditRows.some((r) => r.action === "archive.legal_hold.created")).toBe(true);
    expect(auditRows.some((r) => r.action === "archive.legal_hold.released")).toBe(true);
  });
});
