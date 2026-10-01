import type { Database } from "@restow/db";
import { Hono } from "hono";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { errorHandler } from "../../problem.js";
import { type ScriptedDb, scriptedDb } from "../../routes/v1/testing/scripted-db.js";

/**
 * RBAC at the real HTTP route (not the service layer): a plain member of the
 * tenant is refused the endpoints that start or cancel a storage migration
 * ("replace the primary", docs/STORAGE.md), the same way every other
 * `tenant_admin`-only endpoint of this feature already is (routes.ts).
 * better-auth's session lookup and the database are replaced at their module
 * boundary (the same pattern as features/tenants/routes.test.ts): the test
 * states what the signed-in person is and what the two RBAC queries
 * (memberships, then the tenant) return, and proves the request never
 * reaches the service layer by checking nothing else was queried.
 */

const state = vi.hoisted(() => ({ getSession: vi.fn(), db: null as unknown }));
vi.mock("../../auth.js", () => ({ auth: { api: { getSession: state.getSession } } }));
vi.mock("../../db.js", () => {
  // Both pools answer from the script of the running test.
  const pool = new Proxy(
    {},
    { get: (_target, property) => (state.db as Record<PropertyKey, unknown>)[property] },
  );
  return { db: pool, providerDb: pool };
});

const { storageRoutes } = await import("./routes.js");

const TENANT = "5a0c7c1e-8d2b-4c3a-9f1e-2b3c4d5e6f70";
const ORGANIZATION = "org-contoso";
const MEMBER_USER = { id: "member-user-id", email: "member@contoso.example", role: "user" };

function signedIn(user: { id: string; email: string; role: string | null }) {
  state.getSession.mockResolvedValue({
    session: {
      id: "session-id",
      userId: user.id,
      activeOrganizationId: null,
      authMethod: "passkey",
      impersonatedBy: null,
    },
    user: { ...user, name: user.email, banned: false, twoFactorEnabled: false },
  });
}

function tenantRow(status: "active" | "suspended" = "active") {
  const at = new Date("2026-01-01T00:00:00.000Z");
  return {
    id: TENANT,
    providerId: "provider-id",
    organizationId: ORGANIZATION,
    name: "Contoso",
    slug: "contoso",
    status,
    mailboxCap: null,
    scheduleDefaultsAppliedAt: null,
    createdAt: at,
    updatedAt: at,
  };
}

function app(results: unknown[][]): { app: Hono; script: ScriptedDb } {
  const script = scriptedDb(results);
  state.db = script.db;
  const hono = new Hono();
  hono.onError(errorHandler);
  hono.route("/storage", storageRoutes);
  return { app: hono, script };
}

const headers = { "content-type": "application/json", "x-restow-tenant": TENANT };

beforeEach(() => {
  vi.clearAllMocks();
});

describe("storage migration endpoints refuse a plain tenant member", () => {
  it("refuses to start a replacement (POST /targets with migrationMode)", async () => {
    signedIn(MEMBER_USER);
    const { app: hono, script } = app([
      // The member's memberships, then the tenant named by the header.
      [{ organizationId: ORGANIZATION, role: "member" }],
      [tenantRow()],
    ]);
    const res = await hono.request("/storage/targets", {
      method: "POST",
      headers,
      body: JSON.stringify({
        kind: "local",
        name: "New primary",
        role: "primary",
        config: { basePath: "/mnt/new-primary" },
        migrationMode: "move",
      }),
    });
    expect(res.status).toBe(403);
    expect(((await res.json()) as { title: string }).title).toBe("Insufficient role");
    // The request never reached the service layer: both scripted results were
    // for the RBAC check alone, and nothing else was queried.
    expect(script.pending()).toBe(0);
  });

  it("refuses to cancel a migration (POST /targets/:id/migration/cancel)", async () => {
    signedIn(MEMBER_USER);
    const { app: hono, script } = app([
      [{ organizationId: ORGANIZATION, role: "member" }],
      [tenantRow()],
    ]);
    const migrationTargetId = "8f14e45f-ceea-4b7f-8b3a-9c1a5b6d0e11";
    const res = await hono.request(`/storage/targets/${migrationTargetId}/migration/cancel`, {
      method: "POST",
      headers,
      body: "{}",
    });
    expect(res.status).toBe(403);
    expect(((await res.json()) as { title: string }).title).toBe("Insufficient role");
    expect(script.pending()).toBe(0);
  });

  it("refuses to retry a migration (POST /targets/:id/migration/retry)", async () => {
    signedIn(MEMBER_USER);
    const { app: hono, script } = app([
      [{ organizationId: ORGANIZATION, role: "member" }],
      [tenantRow()],
    ]);
    const migrationTargetId = "8f14e45f-ceea-4b7f-8b3a-9c1a5b6d0e11";
    const res = await hono.request(`/storage/targets/${migrationTargetId}/migration/retry`, {
      method: "POST",
      headers,
      body: "{}",
    });
    expect(res.status).toBe(403);
    expect(((await res.json()) as { title: string }).title).toBe("Insufficient role");
    expect(script.pending()).toBe(0);
  });

  it("still lets the tenant's own admin reach the service layer (role check passes)", async () => {
    signedIn(MEMBER_USER);
    const { app: hono, script } = app([
      [{ organizationId: ORGANIZATION, role: "admin" }],
      [tenantRow()],
    ]);
    const migrationTargetId = "8f14e45f-ceea-4b7f-8b3a-9c1a5b6d0e11";
    const res = await hono.request(`/storage/targets/${migrationTargetId}/migration/cancel`, {
      method: "POST",
      headers,
      body: "{}",
    });
    // Past the RBAC gate now: the service layer's own lookup runs (and, with
    // no result scripted for it, the scripted db rejects), proving the 403
    // above was really the role check and not something else refusing early.
    expect(res.status).toBe(500);
    expect(script.pending()).toBe(0);
  });
});
