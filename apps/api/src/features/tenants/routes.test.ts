import type { Database } from "@restow/db";
import { Hono } from "hono";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { errorHandler } from "../../problem.js";
import { type ScriptedDb, scriptedDb } from "../../routes/v1/testing/scripted-db.js";

/**
 * Member, invitation and role management of /api/v1/tenants through the real
 * routes and session middleware: better-auth's session lookup and the
 * database are replaced at their module boundary, so the tests state what the
 * signed-in person is and what each query returns.
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

const { tenantsRoutes } = await import("./routes.js");

const TENANT = "5a0c7c1e-8d2b-4c3a-9f1e-2b3c4d5e6f70";
const ORGANIZATION = "org-contoso";
const MEMBER = "member-user-id";
const INVITATION = "invitation-id";

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

const tenantAdmin = { id: "tenant-admin-id", email: "admin@contoso.example", role: "user" };
const providerAdmin = { id: "provider-admin-id", email: "ops@provider.example", role: "admin" };

function tenantRow(status: "active" | "suspended") {
  const at = new Date("2026-01-01T00:00:00.000Z");
  return {
    id: TENANT,
    providerId: "provider-id",
    organizationId: ORGANIZATION,
    name: "Contoso",
    slug: "contoso",
    kind: "customer",
    customerNumber: null,
    status,
    mailboxCap: null,
    scheduleDefaultsAppliedAt: null,
    createdAt: at,
    updatedAt: at,
  };
}

function app(results: unknown[][]): { app: Hono; script: ScriptedDb } {
  const script = scriptedDb(results);
  state.db = script.db as Database;
  const hono = new Hono();
  hono.onError(errorHandler);
  hono.route("/tenants", tenantsRoutes);
  return { app: hono, script };
}

const json = (body: unknown, method: string): RequestInit => ({
  method,
  headers: { "content-type": "application/json" },
  body: JSON.stringify(body),
});

/** Every member, invitation and role route, with the request it takes. */
const MEMBER_ROUTES: [string, string, RequestInit][] = [
  ["list members", `/tenants/${TENANT}/members`, {}],
  [
    "add a member",
    `/tenants/${TENANT}/members`,
    json({ email: "new@contoso.example", role: "tenant_user" }, "POST"),
  ],
  [
    "change a role",
    `/tenants/${TENANT}/members/${MEMBER}`,
    json({ role: "tenant_admin" }, "PATCH"),
  ],
  ["remove a member", `/tenants/${TENANT}/members/${MEMBER}`, { method: "DELETE" }],
  ["cancel an invitation", `/tenants/${TENANT}/invitations/${INVITATION}`, { method: "DELETE" }],
];

beforeEach(() => {
  vi.clearAllMocks();
});

describe("member management of a suspended tenant", () => {
  it.each(MEMBER_ROUTES)("refuses the tenant's own admin to %s", async (_name, path, init) => {
    signedIn(tenantAdmin);
    const { app: hono, script } = app([
      // The admin's memberships, then the tenant named in the path.
      [{ organizationId: ORGANIZATION, role: "admin" }],
      [tenantRow("suspended")],
    ]);
    const res = await hono.request(path, init);
    expect(res.status).toBe(403);
    expect(((await res.json()) as { title: string }).title).toBe("Tenant suspended");
    expect(script.pending()).toBe(0);
  });

  it("keeps full access for the provider admin", async () => {
    signedIn(providerAdmin);
    const { app: hono, script } = app([
      // The provider team lookup: no row, so an owner.
      [],
      // Provider admins have no memberships to load: the tenant, then members and invitations.
      [tenantRow("suspended")],
      [
        {
          userId: MEMBER,
          name: "Ada",
          email: "ada@contoso.example",
          memberRole: "admin",
          joinedAt: new Date("2026-02-01T00:00:00.000Z"),
        },
      ],
      [],
    ]);
    const res = await hono.request(`/tenants/${TENANT}/members`);
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({
      members: [{ userId: MEMBER, role: "tenant_admin" }],
      invitations: [],
    });
    expect(script.pending()).toBe(0);
  });
});

describe("member management of an active tenant", () => {
  it("lets the tenant's own admin list the members", async () => {
    signedIn(tenantAdmin);
    const { app: hono, script } = app([
      [{ organizationId: ORGANIZATION, role: "admin" }],
      [tenantRow("active")],
      [],
      [],
    ]);
    const res = await hono.request(`/tenants/${TENANT}/members`);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ members: [], invitations: [] });
    expect(script.pending()).toBe(0);
  });

  it("still refuses a plain member", async () => {
    signedIn(tenantAdmin);
    const { app: hono } = app([
      [{ organizationId: ORGANIZATION, role: "member" }],
      [tenantRow("active")],
    ]);
    const res = await hono.request(`/tenants/${TENANT}/members`);
    expect(res.status).toBe(403);
    expect(((await res.json()) as { title: string }).title).toBe("Insufficient role");
  });
});

/**
 * The tenant wizard's customer data, contacts and notification recipient
 * endpoints (provider admin only, unlike the member routes above which the
 * tenant's own admins also reach). Field-level validation (exactly one
 * primary contact, no duplicate recipient address) runs before any query, so
 * those cases queue nothing and `script.pending()` staying at 0 proves it.
 */
describe("customer data, contacts and notification recipients", () => {
  function customerTenantRow(overrides: Record<string, unknown> = {}) {
    return {
      ...tenantRow("active"),
      customerNumber: null,
      vatId: null,
      addressLine1: null,
      addressLine2: null,
      postalCode: null,
      city: null,
      countryCode: null,
      language: null,
      timeZone: null,
      ...overrides,
    };
  }

  const CUSTOMER_ROUTES: [string, string, RequestInit][] = [
    [
      "set the customer data",
      `/tenants/${TENANT}/customer`,
      json({ customerNumber: "K-1" }, "PATCH"),
    ],
    [
      "replace the contacts",
      `/tenants/${TENANT}/contacts`,
      json([{ name: "Alice", isPrimary: true }], "PUT"),
    ],
  ];

  it.each(CUSTOMER_ROUTES)(
    "refuses the tenant's own admin to %s (provider admin only)",
    async (_name, path, init) => {
      signedIn(tenantAdmin);
      // `authenticate()` loads the signed-in user's memberships before
      // `requireProviderAdmin` can even check the role (middleware/session.ts).
      const { app: hono, script } = app([[]]);
      const res = await hono.request(path, init);
      expect(res.status).toBe(403);
      expect(((await res.json()) as { title: string }).title).toBe("Provider admin required");
      expect(script.pending()).toBe(0);
    },
  );

  it("sets the customer number and audits the change", async () => {
    signedIn(providerAdmin);
    const { app: hono, script } = app([
      // The provider team lookup: no row, so an owner.
      [],
      [], // customerNumberTaken (providerDb): no other tenant has it
      [customerTenantRow()], // current row
      [customerTenantRow({ customerNumber: "K-1001" })], // update().returning()
      [], // audit: no prior chain entry
      [{ id: "audit-1" }], // audit: insert().returning()
    ]);
    const res = await hono.request(
      `/tenants/${TENANT}/customer`,
      json({ customerNumber: "K-1001" }, "PATCH"),
    );
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ customerNumber: "K-1001" });
    expect(script.pending()).toBe(0);
  });

  it("refuses a duplicate customer number with a clear 409, without writing anything", async () => {
    signedIn(providerAdmin);
    const { app: hono, script } = app([
      // The provider team lookup: no row, so an owner.
      [],
      [{ id: "some-other-tenant-id" }], // customerNumberTaken: found
    ]);
    const res = await hono.request(
      `/tenants/${TENANT}/customer`,
      json({ customerNumber: "K-1001" }, "PATCH"),
    );
    expect(res.status).toBe(409);
    expect((await res.json()) as { type: string; detail: string }).toMatchObject({
      type: "urn:restow:problem:customer-number-taken",
    });
    expect(script.pending()).toBe(0);
  });

  it("replaces the contact list and returns the new rows", async () => {
    signedIn(providerAdmin);
    const { app: hono, script } = app([
      // The provider team lookup: no row, so an owner.
      [],
      [{ id: TENANT, status: "active" }], // current tenant status
      [], // delete (result unused, still consumed)
      [
        {
          id: "contact-1",
          name: "Alice",
          role: null,
          email: null,
          phone: null,
          isPrimary: true,
        },
      ], // insert().returning()
      [], // audit select
      [{ id: "audit-2" }], // audit insert
    ]);
    const res = await hono.request(
      `/tenants/${TENANT}/contacts`,
      json([{ name: "Alice", isPrimary: true }], "PUT"),
    );
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual([
      { id: "contact-1", name: "Alice", role: null, email: null, phone: null, isPrimary: true },
    ]);
    expect(script.pending()).toBe(0);
  });

  it("refuses two primary contacts (422) before the database is touched", async () => {
    signedIn(providerAdmin);
    const { app: hono, script } = app([
      // The provider team lookup: no row, so an owner.
      [],
    ]);
    const res = await hono.request(
      `/tenants/${TENANT}/contacts`,
      json(
        [
          { name: "Alice", isPrimary: true },
          { name: "Bob", isPrimary: true },
        ],
        "PUT",
      ),
    );
    expect(res.status).toBe(422);
    expect(script.pending()).toBe(0);
  });

  it("replaces the notification recipients and returns the new rows", async () => {
    signedIn(providerAdmin);
    const { app: hono, script } = app([
      // The provider team lookup: no row, so an owner; then the tenant named in the path.
      [],
      [tenantRow("active")],
      [{ id: TENANT, status: "active", language: null, timeZone: null }],
      // The recipients before, then the delete and the insert.
      [],
      [],
      [
        {
          id: "recipient-1",
          email: "ops@contoso.example",
          name: null,
          notifyJobFailures: true,
          notifyWeeklyReport: false,
          notifyReadinessRed: false,
          notifyLicenseUpdates: false,
        },
      ],
      // The rules follow: failed jobs get a rule, readiness has none and needs none.
      [],
      [],
      [],
      // The audit entry: the chain's last hash, then the insert.
      [],
      [{ id: "audit-3" }],
    ]);
    const res = await hono.request(
      `/tenants/${TENANT}/notification-recipients`,
      json([{ email: "ops@contoso.example", categories: ["jobFailures"] }], "PUT"),
    );
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual([
      { id: "recipient-1", email: "ops@contoso.example", name: null, categories: ["jobFailures"] },
    ]);
    expect(script.pending()).toBe(0);
  });

  it("lets the tenant's own admin name the notification recipients, and read the tenant", async () => {
    signedIn(tenantAdmin);
    const { app: hono, script } = app([
      // The admin's memberships, then the tenant named in the path.
      [{ organizationId: ORGANIZATION, role: "admin" }],
      [tenantRow("active")],
      // replaceTenantNotificationRecipients: the tenant, the recipients before, the delete, the insert.
      [{ id: TENANT, status: "active", language: null, timeZone: null }],
      [],
      [],
      [
        {
          id: "recipient-1",
          email: "ops@contoso.example",
          name: null,
          notifyJobFailures: false,
          notifyWeeklyReport: false,
          notifyReadinessRed: true,
          notifyLicenseUpdates: false,
        },
      ],
      // The rules follow: failed jobs have no recipient, readiness gets a rule.
      [],
      [],
      [],
      // The audit entry: the chain's last hash, then the insert.
      [],
      [{ id: "audit-4" }],
    ]);
    const res = await hono.request(
      `/tenants/${TENANT}/notification-recipients`,
      json([{ email: "ops@contoso.example", categories: ["readinessRed"] }], "PUT"),
    );
    expect(res.status).toBe(200);
    expect(script.pending()).toBe(0);
  });

  it.each([
    ["a plain member of the tenant", [{ organizationId: ORGANIZATION, role: "member" }], 403],
    ["a person who is not a member of it", [{ organizationId: "org-other", role: "admin" }], 404],
  ])("refuses the tenant detail and its recipients to %s", async (_who, memberships, status) => {
    for (const [method, path, body] of [
      ["GET", `/tenants/${TENANT}`, undefined],
      [
        "PUT",
        `/tenants/${TENANT}/notification-recipients`,
        [{ email: "ops@contoso.example", categories: ["jobFailures"] }],
      ],
    ] as const) {
      signedIn(tenantAdmin);
      const { app: hono, script } = app([memberships, [tenantRow("active")]]);
      const res = await hono.request(path, body ? json(body, method) : { method });
      expect(res.status, `${method} ${path}`).toBe(status);
      expect(script.pending()).toBe(0);
    }
  });

  it("refuses duplicate recipient addresses (422) before the database is touched", async () => {
    signedIn(providerAdmin);
    const { app: hono, script } = app([
      // The provider team lookup: no row, so an owner.
      [],
      [tenantRow("active")],
    ]);
    const res = await hono.request(
      `/tenants/${TENANT}/notification-recipients`,
      json(
        [
          { email: "ops@contoso.example", categories: [] },
          { email: "OPS@contoso.example", categories: [] },
        ],
        "PUT",
      ),
    );
    expect(res.status).toBe(422);
    expect(script.pending()).toBe(0);
  });
});
