/**
 * The recovery ISO behind the login (docs/BAREMETAL.md 26.13), against Postgres: the state and the
 * copy the worker keeps in the store are for the tenant's administrators only, the download is a
 * plain navigation (the tenant as `?tenant=`), and only the file the installation offers, with the
 * hash of its verified line, is ever served.
 *
 * Runs when RESTOW_TEST_DATABASE_URL points at a Postgres server as a superuser. better-auth's
 * session lookup is replaced at its module boundary, as in features/snapshots/routes.pg.test.ts.
 */
import { createHash, randomUUID } from "node:crypto";
import { mkdir, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { member, organization, tenants, user } from "@restow/db";
import { eq } from "drizzle-orm";
import { Hono } from "hono";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { type EndpointFixture, startFixture, testDatabaseAdminUrl } from "./testing/fixture.js";
import { agentRootWithIso } from "./testing/recovery.js";

const sessions = vi.hoisted(() => new Map<string, unknown>());
vi.mock("../../auth.js", () => ({
  auth: {
    api: {
      getSession: async ({ headers }: { headers: Headers }) =>
        sessions.get(headers.get("x-test-user") ?? "") ?? null,
    },
  },
}));

const DATABASE = "restow_api_recovery_iso_test";
const ISO_BYTES = Buffer.from("restow recovery iso for the route test\n");
const FILE = "restow-recovery_0.5.0_amd64.iso";

function sessionOf(userId: string, email: string, role: "user" | "admin") {
  return {
    user: { id: userId, email, name: email, role, banned: false, twoFactorEnabled: false },
    session: {
      id: randomUUID(),
      userId,
      authMethod: "passkey",
      activeOrganizationId: null,
      impersonatedBy: null,
    },
  };
}

describe.skipIf(!testDatabaseAdminUrl)("the recovery ISO routes", () => {
  let fixture: EndpointFixture;
  let app: Hono;
  let appConfig: typeof import("../../config.js")["config"];
  let resetHashes: () => void;
  let root = "";
  let store = "";
  const before = { agentDir: process.env.RESTOW_AGENT_DIR };

  beforeAll(async () => {
    fixture = await startFixture(DATABASE);
    root = await agentRootWithIso(true, createHash("sha256").update(ISO_BYTES).digest("hex"));
    store = join(root, "store");
    process.env.RESTOW_AGENT_DIR = root;
    appConfig = (await import("../../config.js")).config;
    resetHashes = (await import("./recovery-iso.js")).resetRecoveryIsoHashCache;
    const { recoveryIsoRoutes } = await import("./recovery-iso.js");
    const { errorHandler, notFoundHandler } = await import("../../problem.js");
    app = new Hono();
    app.onError(errorHandler);
    app.notFound(notFoundHandler);
    app.route("/api/v1/recovery-iso", recoveryIsoRoutes);

    // The tenant's administrator and an ordinary member, as organization members.
    const organizationId = randomUUID();
    const memberId = randomUUID();
    await fixture.db.insert(user).values({
      id: memberId,
      name: "Member",
      email: "member@contoso.example",
      emailVerified: true,
    });
    await fixture.db.insert(organization).values({
      id: organizationId,
      name: "Contoso",
      slug: `contoso-${organizationId.slice(0, 8)}`,
      createdAt: new Date(),
    });
    await fixture.db
      .update(tenants)
      .set({ organizationId })
      .where(eq(tenants.id, fixture.tenantId));
    await fixture.db.insert(member).values([
      {
        id: randomUUID(),
        organizationId,
        userId: fixture.adminId,
        role: "admin",
        createdAt: new Date(),
      },
      { id: randomUUID(), organizationId, userId: memberId, role: "member", createdAt: new Date() },
    ]);
    sessions.set("admin", sessionOf(fixture.adminId, "admin@contoso.example", "user"));
    sessions.set("member", sessionOf(memberId, "member@contoso.example", "user"));
  }, 90_000);

  afterAll(async () => {
    await fixture?.cleanup();
    if (before.agentDir === undefined) delete process.env.RESTOW_AGENT_DIR;
    else process.env.RESTOW_AGENT_DIR = before.agentDir;
    if (root) await rm(root, { recursive: true, force: true });
  });

  beforeEach(async () => {
    resetHashes();
    appConfig.recoveryIsoDir = null;
    appConfig.recoveryIsoStoreDir = store;
    await rm(store, { recursive: true, force: true });
    await mkdir(join(store, "0.5.0"), { recursive: true });
  });

  const get = (path: string, as?: string, tenant: "query" | "header" | "none" = "query") => {
    const headers: Record<string, string> = {};
    if (as) headers["x-test-user"] = as;
    if (tenant === "header") headers["x-restow-tenant"] = fixture.tenantId;
    const query = tenant === "query" ? `?tenant=${fixture.tenantId}` : "";
    return app.request(`${path}${query}`, { headers });
  };

  it("serves the worker's verified copy to the tenant's administrator, by query or header", async () => {
    await writeFile(join(store, "0.5.0", FILE), ISO_BYTES);
    const response = await get(`/api/v1/recovery-iso/file/${FILE}`, "admin");
    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toBe("application/octet-stream");
    expect(response.headers.get("content-length")).toBe(String(ISO_BYTES.length));
    expect(response.headers.get("content-disposition")).toBe(`attachment; filename="${FILE}"`);
    expect(response.headers.get("cache-control")).toBe("private, max-age=300");
    expect(Buffer.from(await response.arrayBuffer())).toEqual(ISO_BYTES);
    const byHeader = await get(`/api/v1/recovery-iso/file/${FILE}`, "admin", "header");
    expect(byHeader.status).toBe(200);
    await byHeader.arrayBuffer();

    // The state names this copy, behind the same login.
    const state = await get("/api/v1/recovery-iso", "admin", "header");
    expect(state.status).toBe(200);
    expect(await state.json()).toMatchObject({
      verified: true,
      fileName: FILE,
      local: { status: "verified", origin: "store", bytesDone: ISO_BYTES.length },
    });
  });

  it("refuses without a login, for an ordinary member, and without a tenant", async () => {
    await writeFile(join(store, "0.5.0", FILE), ISO_BYTES);
    expect((await get(`/api/v1/recovery-iso/file/${FILE}`)).status).toBe(401);
    expect((await get(`/api/v1/recovery-iso/file/${FILE}`, "member")).status).toBe(403);
    expect((await get("/api/v1/recovery-iso", "member", "header")).status).toBe(403);
    expect((await get(`/api/v1/recovery-iso/file/${FILE}`, "admin", "none")).status).toBe(400);
  });

  it("answers 404 for a copy with other bytes, another file, or a path", async () => {
    await writeFile(join(store, "0.5.0", FILE), Buffer.from("tampered"));
    expect((await get(`/api/v1/recovery-iso/file/${FILE}`, "admin")).status).toBe(404);
    await writeFile(join(store, "0.5.0", "restow-recovery_0.4.0_amd64.iso"), ISO_BYTES);
    for (const path of [
      "/api/v1/recovery-iso/file/restow-recovery_0.4.0_amd64.iso",
      "/api/v1/recovery-iso/file/state.json",
      "/api/v1/recovery-iso/file/..%2F0.5.0%2Frestow-recovery_0.5.0_amd64.iso",
      "/api/v1/recovery-iso/file/%2e%2e",
    ]) {
      expect((await get(path, "admin")).status, path).toBe(404);
    }
  });
});
