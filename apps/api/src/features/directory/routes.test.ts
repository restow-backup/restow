import type { Database } from "@restow/db";
import { Hono } from "hono";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { TENANT_HEADER } from "../../middleware/session.js";
import { errorHandler } from "../../problem.js";
import { type ScriptedDb, scriptedDb } from "../../routes/v1/testing/scripted-db.js";

/**
 * Role gating of the per-mailbox credential endpoints
 * (`POST /objects/:id/credential` and `/objects/:id/credential/test`)
 * through the real routes and session middleware, the same way
 * features/tenants/routes.test.ts proves it for tenant management: better-auth's
 * session lookup and the database are replaced at their module boundary, so
 * the test states what the signed-in person is and what each query returns.
 *
 * Controller finding (low): these endpoints are mounted behind `tenantAdmin`,
 * but nothing proved a plain tenant member (`tenant_user`) is refused.
 */

const state = vi.hoisted(() => ({
  getSession: vi.fn(),
  db: null as unknown,
}));

vi.mock("../../auth.js", () => ({ auth: { api: { getSession: state.getSession } } }));
vi.mock("../../db.js", () => {
  // Both pools answer from the script of the running test.
  const pool = new Proxy(
    {},
    { get: (_target, property) => (state.db as Record<PropertyKey, unknown>)[property] },
  );
  return { db: pool, providerDb: pool };
});

const { directoryRoutes } = await import("./routes.js");

const TENANT = "5a0c7c1e-8d2b-4c3a-9f1e-2b3c4d5e6f70";
const ORGANIZATION = "org-contoso";
const OBJECT = "9c2f3a4b-5d6e-4f70-8a1b-2c3d4e5f6071";

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

const tenantMember = { id: "member-user-id", email: "member@contoso.example", role: "user" };

function tenantRow(status: "active" | "suspended" = "active") {
  const at = new Date("2026-01-01T00:00:00.000Z");
  return {
    id: TENANT,
    name: "Contoso",
    slug: "contoso",
    organizationId: ORGANIZATION,
    status,
    createdAt: at,
    updatedAt: at,
  };
}

function app(results: unknown[][]): { app: Hono; script: ScriptedDb } {
  const script = scriptedDb(results);
  state.db = script.db as Database;
  const hono = new Hono();
  hono.onError(errorHandler);
  hono.route("/directory", directoryRoutes);
  return { app: hono, script };
}

const json = (body: unknown, method: string): RequestInit => ({
  method,
  headers: { "content-type": "application/json", [TENANT_HEADER]: TENANT },
  body: JSON.stringify(body),
});

beforeEach(() => {
  vi.clearAllMocks();
});

describe("per-mailbox credential endpoints: tenant_admin only", () => {
  it("refuses a plain tenant member on set-password", async () => {
    signedIn(tenantMember);
    const { app: hono, script } = app([
      // The member's own memberships, then the tenant named by the header.
      [{ organizationId: ORGANIZATION, role: "member" }],
      [tenantRow()],
    ]);
    const res = await hono.request(
      `/directory/objects/${OBJECT}/credential`,
      json({ password: "s3cret" }, "POST"),
    );
    expect(res.status).toBe(403);
    expect(((await res.json()) as { title: string }).title).toBe("Insufficient role");
    // The role check refuses the request before any service call, so nothing
    // beyond the membership and tenant lookups was ever queried.
    expect(script.pending()).toBe(0);
  });

  it("refuses a plain tenant member on test-login", async () => {
    signedIn(tenantMember);
    const { app: hono, script } = app([
      [{ organizationId: ORGANIZATION, role: "member" }],
      [tenantRow()],
    ]);
    const res = await hono.request(`/directory/objects/${OBJECT}/credential/test`, {
      method: "POST",
      headers: { [TENANT_HEADER]: TENANT },
    });
    expect(res.status).toBe(403);
    expect(((await res.json()) as { title: string }).title).toBe("Insufficient role");
    expect(script.pending()).toBe(0);
  });
});
