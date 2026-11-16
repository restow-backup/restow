/**
 * Postgres-backed coverage of PATCH /storage/targets/:id while restore mode is on (docs/STORAGE.md,
 * "Restore mode and progress markers"): pointing the primary at another location replaces it,
 * like POST /targets with role "primary" and promote, and is refused with 409; a name change and
 * a change of a copy's location are not. The restored database may know no data on the primary
 * (its own rules would then allow the move) while storage holds what was written after the dump.
 *
 * Restore mode comes from a stand-in deletion guard installed for the test; authentication from a
 * stand-in that admits a provider admin (local targets are theirs).
 *
 * Runs when RESTOW_TEST_DATABASE_URL points at a Postgres server as a superuser (the database
 * `restow_api_storage_restore_mode_test` is recreated there and dropped after, the roles with
 * it). Without it the suite is skipped.
 */
import { randomBytes, randomUUID } from "node:crypto";
import { type DeletionGuard, type DeletionRequest, installDeletionEnforcement } from "@restow/core";
import { createDb, type Database, providers, storageTargets, tenants } from "@restow/db";
import { eq } from "drizzle-orm";
import { Hono, type MiddlewareHandler } from "hono";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import type { SessionUser } from "../../auth.js";
import type { TenantEnv } from "../../middleware/session.js";
import { provisionTestRoles, type TestDatabaseRoles } from "../../testing/database-roles.js";
import {
  dropDatabase,
  recreateDatabase,
  testDatabaseAdminUrl,
} from "../snapshots/testing/explorer-fixture.js";

const DATABASE = "restow_api_storage_restore_mode_test";

function providerAdmin(): MiddlewareHandler<TenantEnv> {
  return async (c, next) => {
    c.set("tenantId", c.req.header("x-restow-tenant") ?? "");
    c.set("role", "provider_admin");
    c.set("user", { id: randomUUID(), email: "admin@provider.test" } as unknown as SessionUser);
    await next();
  };
}

describe.skipIf(!testDatabaseAdminUrl)("PATCH /storage/targets/:id in restore mode", () => {
  let owner: Database;
  let appDb: Database;
  let roles: TestDatabaseRoles | undefined;
  let app: Hono;
  let tenantId: string;
  let uninstall: (() => void) | null = null;
  const asked: DeletionRequest[] = [];

  beforeAll(async () => {
    const url = await recreateDatabase(testDatabaseAdminUrl as string, DATABASE);
    roles = await provisionTestRoles(url);
    process.env.DATABASE_URL = roles.appUrl;
    process.env.DATABASE_PROVIDER_URL = roles.providerUrl;
    process.env.RESTOW_MASTER_KEY = randomBytes(32).toString("base64");
    owner = createDb(url);
    appDb = createDb(roles.appUrl);
    const { buildStorageRoutes } = await import("./routes.js");
    const { errorHandler } = await import("../../problem.js");
    const [provider] = await owner.insert(providers).values({ name: "Provider" }).returning();
    const [tenant] = await owner
      .insert(tenants)
      .values({ providerId: provider?.id ?? "", name: "Contoso", slug: "contoso" })
      .returning();
    tenantId = tenant?.id ?? "";
    app = new Hono();
    app.onError(errorHandler);
    app.route("/storage", buildStorageRoutes({ db: appDb, requireAdmin: providerAdmin() }));
  }, 60_000);

  afterEach(async () => {
    uninstall?.();
    uninstall = null;
    asked.length = 0;
    await owner.delete(storageTargets).where(eq(storageTargets.tenantId, tenantId));
  });

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
    await roles?.drop(testDatabaseAdminUrl as string);
  });

  function restoreModeOn(): void {
    const guard: DeletionGuard = {
      decide: async (request) => {
        asked.push(request);
        return { allowed: false, reason: "restore_mode", restoreModeId: null };
      },
      holding: () => true,
    };
    uninstall = installDeletionEnforcement(guard);
  }

  async function seed(role: "primary" | "copy", basePath: string): Promise<string> {
    const [row] = await owner
      .insert(storageTargets)
      .values({ tenantId, kind: "local", role, name: role, config: { basePath } })
      .returning();
    return row?.id ?? "";
  }

  function patch(id: string, body: unknown) {
    return app.request(`/storage/targets/${id}`, {
      method: "PATCH",
      headers: { "content-type": "application/json", "x-restow-tenant": tenantId },
      body: JSON.stringify(body),
    });
  }

  async function basePathOf(id: string): Promise<unknown> {
    const [row] = await owner.select().from(storageTargets).where(eq(storageTargets.id, id));
    return (row?.config as { basePath?: unknown } | undefined)?.basePath;
  }

  it("refuses to point the primary at another location, and leaves it where it was", async () => {
    const id = await seed("primary", "/mnt/primary-a");
    restoreModeOn();
    const response = await patch(id, { config: { basePath: "/mnt/primary-b" } });
    expect(response.status, await response.clone().text()).toBe(409);
    expect(await response.json()).toMatchObject({ type: "urn:restow:problem:restore-mode" });
    expect(asked.map((request) => request.pass)).toEqual(["primary_replacement"]);
    expect(await basePathOf(id)).toBe("/mnt/primary-a");
  });

  it("moves the same primary while restore mode is off (the database knows no data on it)", async () => {
    const id = await seed("primary", "/mnt/primary-a");
    const response = await patch(id, { config: { basePath: "/mnt/primary-b" } });
    expect(response.status, await response.clone().text()).toBe(200);
    expect(await basePathOf(id)).toBe("/mnt/primary-b");
  });

  it("still renames the primary, keeps its location, and moves a copy in restore mode", async () => {
    const primary = await seed("primary", "/mnt/primary-a");
    const copy = await seed("copy", "/mnt/copy-a");
    restoreModeOn();
    const renamed = await patch(primary, {
      name: "Renamed",
      config: { basePath: "/mnt/primary-a" },
    });
    expect(renamed.status, await renamed.clone().text()).toBe(200);
    const moved = await patch(copy, { config: { basePath: "/mnt/copy-b" } });
    expect(moved.status, await moved.clone().text()).toBe(200);
    expect(await basePathOf(copy)).toBe("/mnt/copy-b");
    expect(asked).toEqual([]);
  });
});
