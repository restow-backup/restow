/**
 * Postgres-backed test of the operator's own organisation through the real
 * application (apps/api/src/app.ts), with real sessions (password, then the
 * mandatory authenticator app) on the application and installation roles Row
 * Level Security binds:
 *
 *   - a setup whose last step fails (the own organisation cannot be created)
 *     still completes: the response says so, the failure is logged and written
 *     to the installation audit chain without the error's message, and no
 *     tenant exists;
 *   - `POST /api/v1/tenants/internal` creates the own organisation, only for
 *     provider administrators of the administrator role who reach every tenant,
 *     and only once;
 *   - `POST /api/v1/tenants/:id/internal` marks an existing tenant, moves the
 *     mark only with `confirmSwitch`, under the same rule;
 *   - `DELETE /api/v1/tenants/:id` refuses the own organisation (409, its own
 *     problem type), and the provider team rules still hold (an owner deletes);
 *   - `GET /api/v1/tenants` and `GET /api/v1/me` carry kind and customer
 *     number and list the own organisation first, for provider admins and for
 *     members alike.
 *
 * The tests build on each other (one installation, first run to running), so
 * they run in file order. Runs when RESTOW_TEST_DATABASE_URL points at a
 * Postgres server; without it the suite is skipped.
 */
import { randomBytes, randomUUID } from "node:crypto";
import {
  type Database,
  type ProviderRole,
  account,
  auditLog,
  createDb,
  member,
  providerMemberTenants,
  providerMembers,
  reportRules,
  tenants,
  twoFactor,
  user,
} from "@restow/db";
import { symmetricDecrypt } from "better-auth/crypto";
import { asc, eq, isNull } from "drizzle-orm";
import type { Hono } from "hono";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { registerApiExtension, resetExtensionsForTesting } from "../../extensions.js";
import { type TestDatabaseRoles, provisionTestRoles } from "../../testing/database-roles.js";
import {
  dropDatabase,
  recreateDatabase,
  testDatabaseAdminUrl,
} from "../snapshots/testing/explorer-fixture.js";

const DATABASE = "restow_api_internal_routes_test";
const PUBLIC_URL = "http://localhost:3000";
const OWNER_EMAIL = "owner@example.com";
const PASSWORD = "correct-horse-battery-1";
const SETUP_TOKEN = "7QKMZ-RT4VX-9HBNP-2WCAE";
const PROVIDER_NAME = "Operator Own GmbH";

interface Problem {
  type: string;
  status: number;
  title?: string;
  tenantId?: string;
  reason?: string;
  requiredProviderRole?: string;
}

interface TenantItem {
  id: string;
  name: string;
  slug: string;
  kind: string;
  status: string;
  customerNumber: string | null;
}

describe.skipIf(!testDatabaseAdminUrl)("the operator's own organisation through the API", () => {
  let owner: Database;
  let roles: TestDatabaseRoles | undefined;
  let app: Hono;
  let authModule: typeof import("../../auth.js");
  let version: string;
  /** What the test gate answers for every gated function: several tenants allowed when true. */
  let featuresOn = false;
  let ownerSession: { cookie: string; userId: string };
  let ipCounter = 0;

  beforeAll(async () => {
    const url = await recreateDatabase(testDatabaseAdminUrl as string, DATABASE);
    roles = await provisionTestRoles(url);
    process.env.DATABASE_URL = roles.appUrl;
    process.env.DATABASE_PROVIDER_URL = roles.providerUrl;
    process.env.RESTOW_MASTER_KEY = randomBytes(32).toString("base64");
    process.env.BETTER_AUTH_SECRET = randomBytes(32).toString("base64");
    process.env.RESTOW_PUBLIC_URL = PUBLIC_URL;
    process.env.RESTOW_SETUP_TOKEN = SETUP_TOKEN;
    registerApiExtension({
      name: "test-gate",
      featureGate: { isEnabled: async () => featuresOn },
    });
    owner = createDb(url);
    ({ app } = await import("../../app.js"));
    authModule = await import("../../auth.js");
    ({ DISCLAIMER_VERSION: version } = await import("../../lib/disclaimer.js"));
  }, 60_000);

  afterAll(async () => {
    vi.restoreAllMocks();
    resetExtensionsForTesting();
    const shared = await import("../../db.js");
    await Promise.all([shared.db.$client.end(), shared.providerDb.$client.end()]);
    await owner?.$client.end();
    Reflect.deleteProperty(process.env, "RESTOW_SETUP_TOKEN");
    await dropDatabase(testDatabaseAdminUrl as string, DATABASE);
    await roles?.drop(testDatabaseAdminUrl as string);
  }, 30_000);

  function call(
    method: string,
    path: string,
    options: { body?: unknown; cookie?: string; headers?: Record<string, string> } = {},
  ): Promise<Response> {
    return Promise.resolve(
      app.fetch(
        new Request(`${PUBLIC_URL}${path}`, {
          method,
          headers: {
            origin: PUBLIC_URL,
            ...(options.body !== undefined ? { "content-type": "application/json" } : {}),
            ...(options.cookie ? { cookie: options.cookie } : {}),
            ...options.headers,
          },
          body: options.body !== undefined ? JSON.stringify(options.body) : undefined,
        }),
      ),
    );
  }

  function nextIp(): string {
    ipCounter += 1;
    return `198.51.100.${ipCounter}`;
  }

  function authPost(path: string, body: Record<string, unknown>, cookie?: string, ip = nextIp()) {
    return authModule.auth.handler(
      new Request(`${PUBLIC_URL}/api/auth${path}`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          origin: PUBLIC_URL,
          "x-forwarded-for": ip,
          ...(cookie ? { cookie } : {}),
        },
        body: JSON.stringify(body),
      }),
    );
  }

  function sessionCookieOf(response: Response): string {
    const cookie = response.headers
      .getSetCookie()
      .map((line) => line.split(";")[0] ?? "")
      .find((pair) => pair.includes("session_token="));
    if (!cookie) {
      throw new Error(`the response set no session cookie (status ${response.status})`);
    }
    return cookie;
  }

  /** Sign in with the password and enrol the mandatory authenticator app; the fully assured cookie. */
  async function signIn(email: string): Promise<{ cookie: string; userId: string }> {
    const ip = nextIp();
    const response = await authPost("/sign-in/email", { email, password: PASSWORD }, undefined, ip);
    expect(response.status).toBe(200);
    const passwordOnly = sessionCookieOf(response);
    const enable = await authPost("/two-factor/enable", { password: PASSWORD }, passwordOnly, ip);
    expect(enable.status).toBe(200);
    const [row] = await owner.select({ id: user.id }).from(user).where(eq(user.email, email));
    const context = await authModule.auth.$context;
    const [stored] = await owner
      .select({ secret: twoFactor.secret })
      .from(twoFactor)
      .where(eq(twoFactor.userId, row?.id as string));
    const rawSecret = await symmetricDecrypt({
      key: context.secretConfig,
      data: stored?.secret as string,
    });
    const { code } = await authModule.auth.api.generateTOTP({ body: { secret: rawSecret } });
    const verify = await authPost("/two-factor/verify-totp", { code }, passwordOnly, ip);
    expect(verify.status).toBe(200);
    return { cookie: sessionCookieOf(verify), userId: row?.id as string };
  }

  /** An account with a password that can sign in; `admin` makes it a provider admin. */
  async function createAccount(email: string, role: "admin" | "user"): Promise<string> {
    const context = await authModule.auth.$context;
    const userId = randomUUID();
    await owner.insert(user).values({ id: userId, name: email, email, emailVerified: false, role });
    await owner.insert(account).values({
      id: randomUUID(),
      accountId: userId,
      providerId: "credential",
      userId,
      password: await context.password.hash(PASSWORD),
    });
    return userId;
  }

  const teamSessions = new Map<string, Promise<{ cookie: string; userId: string }>>();

  /** A provider admin with a team role, reaching every tenant or only `tenantIds`; one session per kind. */
  function teamMember(
    role: ProviderRole,
    scope: { allTenants: true } | { allTenants: false; tenantIds: string[] },
  ) {
    const email = scope.allTenants
      ? `${role}-all@example.com`
      : `${role}-some-${scope.tenantIds.length}@example.com`;
    let session = teamSessions.get(email);
    if (!session) {
      session = (async () => {
        const userId = await createAccount(email, "admin");
        await owner.insert(providerMembers).values({ userId, role, allTenants: scope.allTenants });
        if (!scope.allTenants) {
          for (const tenantId of scope.tenantIds) {
            await owner.insert(providerMemberTenants).values({ userId, tenantId });
          }
        }
        return signIn(email);
      })();
      teamSessions.set(email, session);
    }
    return session;
  }

  /** A tenant member (no provider admin) of the tenants named, with the organization role given. */
  async function tenantMember(email: string, memberships: { tenantId: string; role: string }[]) {
    const userId = await createAccount(email, "user");
    for (const { tenantId, role } of memberships) {
      const [row] = await owner
        .select({ organizationId: tenants.organizationId })
        .from(tenants)
        .where(eq(tenants.id, tenantId));
      await owner.insert(member).values({
        id: randomUUID(),
        organizationId: row?.organizationId as string,
        userId,
        role,
        createdAt: new Date(),
      });
    }
    return signIn(email);
  }

  const tenantRows = () => owner.select().from(tenants);
  const installationChain = () =>
    owner
      .select()
      .from(auditLog)
      .where(isNull(auditLog.tenantId))
      .orderBy(asc(auditLog.createdAt), asc(auditLog.id));

  async function listAs(cookie: string): Promise<TenantItem[]> {
    const response = await call("GET", "/api/v1/tenants", { cookie });
    expect(response.status).toBe(200);
    return ((await response.json()) as { items: TenantItem[] }).items;
  }

  async function meTenantsAs(cookie: string): Promise<TenantItem[]> {
    const response = await call("GET", "/api/v1/me", { cookie });
    expect(response.status).toBe(200);
    return ((await response.json()) as { tenants: TenantItem[] }).tenants;
  }

  // --- A setup whose last step fails ----------------------------------------------------------

  it("completes the setup when the own organisation cannot be created, and says so", async () => {
    const failure = vi
      .spyOn(authModule.auth.api, "createOrganization")
      .mockRejectedValueOnce(new Error("organization service down: secret-looking-detail"));
    const logged = vi.spyOn(console, "error").mockImplementation(() => undefined);

    const response = await call("POST", "/api/v1/setup", {
      headers: { "x-restow-setup-token": SETUP_TOKEN },
      body: {
        disclaimer: { version, accepted: true },
        operatingMode: "local",
        providerName: PROVIDER_NAME,
        firstAdmin: { name: "Owner", email: OWNER_EMAIL, password: PASSWORD },
        mail: {
          transport: "smtp",
          smtp: {
            host: "mail.example.com",
            port: 587,
            security: "starttls",
            from: "r@example.com",
          },
        },
        sendTest: false,
      },
    });
    expect(response.status).toBe(201);
    expect(await response.json()).toMatchObject({ ok: true, ownOrganisation: { created: false } });
    expect(failure).toHaveBeenCalledTimes(1);

    // The installation is configured all the same, and has no tenant.
    const state = (await (await call("GET", "/api/v1/setup/state")).json()) as {
      configured: boolean;
    };
    expect(state.configured).toBe(true);
    expect(await tenantRows()).toEqual([]);

    // The failure is audited on the installation chain and logged, naming the error but not its message.
    const chain = await installationChain();
    expect(chain.map((entry) => entry.action)).toEqual([
      "settings.disclaimer_accepted",
      "setup.completed",
      "setup.internal_tenant_failed",
    ]);
    expect(chain[2]).toMatchObject({ actor: OWNER_EMAIL, targetType: "installation" });
    expect(chain[2]?.details).toEqual({ name: PROVIDER_NAME, reason: "Error" });
    const lines = logged.mock.calls.map((callArgs) => String(callArgs[0]));
    expect(lines.some((line) => line.includes('"component":"setup"'))).toBe(true);
    expect(lines.join("\n")).not.toContain("secret-looking-detail");
    logged.mockRestore();
    failure.mockRestore();

    ownerSession = await signIn(OWNER_EMAIL);
    expect(await listAs(ownerSession.cookie)).toEqual([]);
    expect(await meTenantsAs(ownerSession.cookie)).toEqual([]);
  });

  // --- Creating the own organisation -----------------------------------------------------

  it("refuses everyone but an administrator who reaches every tenant to create the own organisation", async () => {
    const body = { name: "Should Not Exist" };
    const unauthenticated = await call("POST", "/api/v1/tenants/internal", { body });
    expect(unauthenticated.status).toBe(401);

    await createAccount("plain@example.com", "user");
    const plain = await signIn("plain@example.com");
    const asPlain = await call("POST", "/api/v1/tenants/internal", { body, cookie: plain.cookie });
    expect(asPlain.status).toBe(403);
    expect(((await asPlain.json()) as Problem).title).toBe("Provider admin required");

    for (const role of ["technician", "read_only"] as const) {
      const session = await teamMember(role, { allTenants: true });
      const response = await call("POST", "/api/v1/tenants/internal", {
        body,
        cookie: session.cookie,
      });
      expect(response.status, role).toBe(403);
      expect(await response.json()).toMatchObject({
        type: "urn:restow:problem:provider-role-required",
        reason: "role",
        requiredProviderRole: "administrator",
      });
    }

    // An administrator limited to some tenants: creating spans the installation.
    const limited = await teamMember("administrator", { allTenants: false, tenantIds: [] });
    const asLimited = await call("POST", "/api/v1/tenants/internal", {
      body,
      cookie: limited.cookie,
    });
    expect(asLimited.status).toBe(403);
    expect(((await asLimited.json()) as Problem).reason).toBe("scope");

    // A body the schema refuses.
    for (const bad of [{}, { name: "" }, { name: "x", slug: "Not A Slug" }]) {
      const response = await call("POST", "/api/v1/tenants/internal", {
        body: bad,
        cookie: ownerSession.cookie,
      });
      expect(response.status, JSON.stringify(bad)).toBe(422);
    }
    expect(await tenantRows()).toEqual([]);
  });

  it("creates the own organisation for an administrator, named as given, and only once", async () => {
    const admin = await teamMember("administrator", { allTenants: true });
    const response = await call("POST", "/api/v1/tenants/internal", {
      body: { name: PROVIDER_NAME },
      cookie: admin.cookie,
    });
    expect(response.status).toBe(201);
    const created = (await response.json()) as TenantItem;
    expect(created).toMatchObject({
      name: PROVIDER_NAME,
      slug: "operator-own-gmbh",
      kind: "internal",
      status: "active",
      customerNumber: null,
    });

    const [row] = await tenantRows();
    expect(row).toMatchObject({ id: created.id, kind: "internal" });
    // The administrator who created it hears about failed jobs and unproven restores.
    const rules = await owner
      .select()
      .from(reportRules)
      .where(eq(reportRules.tenantId, created.id));
    expect(rules.map((rule) => rule.emailRecipients)).toEqual([
      ["administrator-all@example.com"],
      ["administrator-all@example.com"],
    ]);
    expect(await listAs(ownerSession.cookie)).toMatchObject([{ id: created.id, kind: "internal" }]);

    const again = await call("POST", "/api/v1/tenants/internal", {
      body: { name: "A Second One" },
      cookie: admin.cookie,
    });
    expect(again.status).toBe(409);
    expect(await again.json()).toMatchObject({
      type: "urn:restow:problem:internal-tenant-exists",
      tenantId: created.id,
    });
    expect(await tenantRows()).toHaveLength(1);
  });

  // --- Lists carry kind and customer number, the own organisation first ----------------------

  it("lists the own organisation first with kind and customer number, in the tenant list and in the profile", async () => {
    featuresOn = true;
    for (const customer of [
      { name: "Zulu Customer", slug: "zulu", customer: { customerNumber: "K-9" } },
      { name: "Alpha Customer", slug: "alpha" },
    ]) {
      const response = await call("POST", "/api/v1/tenants", {
        body: customer,
        cookie: ownerSession.cookie,
      });
      expect(response.status).toBe(201);
      expect(((await response.json()) as TenantItem).kind).toBe("customer");
    }

    const expected = [
      ["Operator Own GmbH", "internal", null],
      ["Alpha Customer", "customer", null],
      ["Zulu Customer", "customer", "K-9"],
    ];
    const summary = (items: TenantItem[]) =>
      items.map((item) => [item.name, item.kind, item.customerNumber]);
    expect(summary(await listAs(ownerSession.cookie))).toEqual(expected);
    expect(summary(await meTenantsAs(ownerSession.cookie))).toEqual(expected);

    // A member sees the tenants of their memberships, in the same order.
    const ids = Object.fromEntries((await tenantRows()).map((row) => [row.slug, row.id]));
    const member1 = await tenantMember("member1@example.com", [
      { tenantId: ids.zulu as string, role: "admin" },
      { tenantId: ids["operator-own-gmbh"] as string, role: "member" },
      { tenantId: ids.alpha as string, role: "admin" },
    ]);
    expect(summary(await meTenantsAs(member1.cookie))).toEqual(expected);
  });

  // --- Marking an existing tenant -----------------------------------------------------------

  it("marks a tenant only for administrators who reach every tenant, and moves the mark only with the confirmation", async () => {
    const rows = await tenantRows();
    const idOf = (slug: string) => rows.find((row) => row.slug === slug)?.id as string;
    const alpha = idOf("alpha");
    const operator = idOf("operator-own-gmbh");
    const path = `/api/v1/tenants/${alpha}/internal`;

    expect((await call("POST", path, { body: {} })).status).toBe(401);

    const alphaAdmin = await tenantMember("alpha-admin@example.com", [
      { tenantId: alpha, role: "admin" },
    ]);
    const asTenantAdmin = await call("POST", path, {
      body: { confirmSwitch: true },
      cookie: alphaAdmin.cookie,
    });
    expect(asTenantAdmin.status).toBe(403);
    expect(((await asTenantAdmin.json()) as Problem).title).toBe("Provider admin required");

    for (const role of ["technician", "read_only"] as const) {
      const session = await teamMember(role, { allTenants: true });
      const response = await call("POST", path, {
        body: { confirmSwitch: true },
        cookie: session.cookie,
      });
      expect(response.status, role).toBe(403);
      expect(((await response.json()) as Problem).reason).toBe("role");
    }
    // Moving the mark can demote a tenant outside a limited administrator's scope: not for them.
    const scoped = await teamMember("administrator", { allTenants: false, tenantIds: [alpha] });
    const asScoped = await call("POST", path, {
      body: { confirmSwitch: true },
      cookie: scoped.cookie,
    });
    expect(asScoped.status).toBe(403);
    expect(((await asScoped.json()) as Problem).reason).toBe("scope");

    const kinds = async () =>
      Object.fromEntries((await tenantRows()).map((row) => [row.slug, row.kind]));
    expect(await kinds()).toMatchObject({ "operator-own-gmbh": "internal", alpha: "customer" });

    const admin = await teamMember("administrator", { allTenants: true });
    // Without the confirmation: refused, naming the tenant that is the own organisation.
    for (const body of [undefined, {}, { confirmSwitch: false }]) {
      const refused = await call("POST", path, { body, cookie: admin.cookie });
      expect(refused.status).toBe(409);
      expect(await refused.json()).toMatchObject({
        type: "urn:restow:problem:internal-tenant-exists",
        tenantId: operator,
      });
    }
    expect(
      (await call("POST", path, { body: { confirmSwitch: "yes" }, cookie: admin.cookie })).status,
    ).toBe(422);
    expect(
      (
        await call("POST", `/api/v1/tenants/${randomUUID()}/internal`, {
          body: {},
          cookie: admin.cookie,
        })
      ).status,
    ).toBe(404);
    expect(
      (
        await call("POST", "/api/v1/tenants/not-a-uuid/internal", {
          body: {},
          cookie: admin.cookie,
        })
      ).status,
    ).toBe(422);
    expect(await kinds()).toMatchObject({ "operator-own-gmbh": "internal", alpha: "customer" });

    const moved = await call("POST", path, { body: { confirmSwitch: true }, cookie: admin.cookie });
    expect(moved.status).toBe(200);
    expect(await moved.json()).toMatchObject({ id: alpha, kind: "internal" });
    expect(await kinds()).toMatchObject({ "operator-own-gmbh": "customer", alpha: "internal" });

    // The list follows: the new own organisation first.
    expect((await listAs(ownerSession.cookie)).map((item) => item.name)).toEqual([
      "Alpha Customer",
      "Operator Own GmbH",
      "Zulu Customer",
    ]);

    // Both changes are in the tenants' own audit chains.
    const actions = async (tenantId: string) =>
      (
        await owner
          .select({ action: auditLog.action })
          .from(auditLog)
          .where(eq(auditLog.tenantId, tenantId))
          .orderBy(asc(auditLog.createdAt))
      ).map((entry) => entry.action);
    expect(await actions(alpha)).toEqual(["tenant.created", "tenant.internal.marked"]);
    expect(await actions(operator)).toEqual(["tenant.created", "tenant.internal.unmarked"]);

    // Marking it again changes nothing.
    const same = await call("POST", path, { body: {}, cookie: admin.cookie });
    expect(same.status).toBe(200);
    expect(await actions(alpha)).toEqual(["tenant.created", "tenant.internal.marked"]);
  });

  // --- Deleting -----------------------------------------------------------------------------------

  it("refuses to delete the own organisation, whoever asks; the owner still deletes a customer", async () => {
    const rows = await tenantRows();
    const idOf = (slug: string) => rows.find((row) => row.slug === slug)?.id as string;
    const alpha = idOf("alpha");

    // Deleting needs the owner role; an administrator is turned away before the guard.
    const administrator = await teamMember("administrator", { allTenants: true });
    const asAdministrator = await call("DELETE", `/api/v1/tenants/${alpha}`, {
      cookie: administrator.cookie,
    });
    expect(asAdministrator.status).toBe(403);
    expect(((await asAdministrator.json()) as Problem).requiredProviderRole).toBe("owner");

    const refused = await call("DELETE", `/api/v1/tenants/${alpha}`, {
      cookie: ownerSession.cookie,
    });
    expect(refused.status).toBe(409);
    expect(await refused.json()).toMatchObject({
      type: "urn:restow:problem:internal-tenant-protected",
    });
    const [still] = await owner.select().from(tenants).where(eq(tenants.id, alpha));
    expect(still).toMatchObject({ status: "active", kind: "internal" });

    // The former own organisation is a customer again and can be deleted.
    const operator = idOf("operator-own-gmbh");
    const deleted = await call("DELETE", `/api/v1/tenants/${operator}`, {
      cookie: ownerSession.cookie,
    });
    expect(deleted.status).toBe(202);
    expect(await deleted.json()).toMatchObject({
      id: operator,
      status: "deleting",
      kind: "customer",
    });
  });
});
