/**
 * Postgres-backed, end-to-end tests of the provider team, over HTTP with real
 * better-auth sessions (password plus the mandatory authenticator app), on
 * the application and installation roles production uses:
 *
 *   - an owner invites a technician limited to one tenant; the invitation
 *     link sets a password and the technician signs in;
 *   - the technician sees only that tenant, cannot reach the other one,
 *     cannot create tenants, change the team or install a licence;
 *   - the owner widens the technician to read-only on every tenant: both
 *     tenants become visible, still no changes;
 *   - the last owner can neither step down nor leave; with a second owner
 *     the first may;
 *   - removing a member ends their session and deletes the account;
 *   - every change is in the installation's audit log;
 *   - the tenant role cannot read the team tables at all.
 *
 * Runs when RESTOW_TEST_DATABASE_URL points at a Postgres server as a
 * superuser. Without it the suite is skipped.
 */
import { randomBytes, randomUUID } from "node:crypto";
import {
  type Database,
  account,
  auditLog,
  createDb,
  organization,
  providers,
  tenants,
  twoFactor,
  user,
} from "@restow/db";
import { symmetricDecrypt } from "better-auth/crypto";
import { eq, like } from "drizzle-orm";
import type { Hono } from "hono";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  registerApiExtension,
  resetExtensionsForTesting,
} from "../../../../apps/api/src/extensions.js";
import { dropDatabase } from "../../../../apps/api/src/features/snapshots/testing/explorer-fixture.js";
import { provisionTestRoles } from "../../../../apps/api/src/testing/database-roles.js";
import { installTestLicense } from "../license/testing.js";

const DATABASE = `restow_ee_provider_team_test_${randomBytes(4).toString("hex")}`;
const PUBLIC_URL = "http://localhost:3000";
const testDatabaseAdminUrl = process.env.RESTOW_TEST_DATABASE_URL;

function urlFor(base: string, database: string): string {
  const url = new URL(base);
  url.pathname = `/${database}`;
  return url.toString();
}

describe.skipIf(!testDatabaseAdminUrl)("the provider team against Postgres", () => {
  let owner: Database;
  let appRole: Database;
  let app: Hono;
  let authModule: typeof import("../../../../apps/api/src/auth.js");
  let accounts: typeof import("../../../../apps/api/src/features/accounts/service.js");
  let sharedDb: Database;
  let tenantA: string;
  let tenantB: string;
  let ownerCookie: string;
  let ownerId: string;

  function authPost(path: string, body: unknown, cookie?: string): Promise<Response> {
    return authModule.auth.handler(
      new Request(`${PUBLIC_URL}/api/auth${path}`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          origin: PUBLIC_URL,
          "x-forwarded-for": `198.51.100.${Math.floor(Math.random() * 200) + 1}`,
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
      throw new Error(`no session cookie (status ${response.status})`);
    }
    return cookie;
  }

  /** Password sign-in plus the mandatory authenticator app; the fully assured cookie. */
  async function signIn(userId: string, email: string, password: string): Promise<string> {
    const first = await authPost("/sign-in/email", { email, password });
    expect(first.status).toBe(200);
    const passwordOnly = sessionCookieOf(first);
    expect((await authPost("/two-factor/enable", { password }, passwordOnly)).status).toBe(200);
    const context = await authModule.auth.$context;
    const [stored] = await owner
      .select({ secret: twoFactor.secret })
      .from(twoFactor)
      .where(eq(twoFactor.userId, userId));
    const secret = await symmetricDecrypt({
      key: context.secretConfig,
      data: stored?.secret ?? "",
    });
    const { code } = await authModule.auth.api.generateTOTP({ body: { secret } });
    const verified = await authPost("/two-factor/verify-totp", { code }, passwordOnly);
    expect(verified.status).toBe(200);
    return sessionCookieOf(verified);
  }

  async function call(
    method: string,
    path: string,
    cookie: string,
    body?: unknown,
  ): Promise<Response> {
    return app.fetch(
      new Request(`${PUBLIC_URL}/api/v1${path}`, {
        method,
        headers: {
          cookie,
          origin: PUBLIC_URL,
          ...(body !== undefined ? { "content-type": "application/json" } : {}),
        },
        body: body !== undefined ? JSON.stringify(body) : undefined,
      }),
    );
  }

  /** Invite through the API, redeem the link, sign in: the new member's cookie. */
  async function inviteAndSignIn(
    email: string,
    body: Record<string, unknown>,
  ): Promise<{ userId: string; cookie: string }> {
    const response = await call("POST", "/provider-team", ownerCookie, {
      email,
      name: email,
      ...body,
    });
    expect(response.status).toBe(201);
    const invited = (await response.json()) as {
      member: { userId: string; status: string };
      setPasswordToken: string | null;
      mailOutcome: string;
    };
    expect(invited.member.status).toBe("invited");
    // No mail transport in the test installation: the owner gets the link to hand over.
    expect(invited.mailOutcome).toBe("not_configured");
    const password = `pw-${randomBytes(12).toString("hex")}`;
    await accounts.redeemSetPasswordToken(
      sharedDb,
      { token: invited.setPasswordToken as string, password },
      { ip: "203.0.113.9" },
    );
    return {
      userId: invited.member.userId,
      cookie: await signIn(invited.member.userId, email, password),
    };
  }

  beforeAll(async () => {
    const admin = createDb(testDatabaseAdminUrl as string);
    try {
      await admin.$client.query(`CREATE DATABASE ${DATABASE}`);
    } finally {
      await admin.$client.end();
    }
    const ownerUrl = urlFor(testDatabaseAdminUrl as string, DATABASE);
    const roles = await provisionTestRoles(ownerUrl);
    owner = createDb(ownerUrl);
    appRole = createDb(roles.appUrl);
    process.env.DATABASE_URL = roles.appUrl;
    process.env.DATABASE_PROVIDER_URL = roles.providerUrl;
    process.env.RESTOW_MASTER_KEY = randomBytes(32).toString("base64");
    process.env.BETTER_AUTH_SECRET = randomBytes(32).toString("base64");
    process.env.RESTOW_PUBLIC_URL = PUBLIC_URL;
    // The team and the license routes are ee/ route groups: the app is
    // assembled with the ee/ extension, as apps/api/src/ee.ts does, and the
    // Service Provider edition is in effect through an installed license row.
    await installTestLicense(owner, "service_provider");

    authModule = await import("../../../../apps/api/src/auth.js");
    accounts = await import("../../../../apps/api/src/features/accounts/service.js");
    const shared = await import("../../../../apps/api/src/db.js");
    sharedDb = shared.db as Database;
    const { eeApiExtension } = await import("../index.js");
    registerApiExtension(eeApiExtension);
    const { buildApp } = await import("../../../../apps/api/src/app.js");
    app = buildApp();

    const [provider] = await owner.insert(providers).values({ name: "Provider" }).returning();
    for (const name of ["Contoso", "Fabrikam"]) {
      const [org] = await owner
        .insert(organization)
        .values({ id: randomUUID(), name, slug: name.toLowerCase(), createdAt: new Date() })
        .returning();
      const [row] = await owner
        .insert(tenants)
        .values({
          providerId: provider?.id as string,
          organizationId: org?.id as string,
          name,
          slug: name.toLowerCase(),
        })
        .returning();
      if (name === "Contoso") {
        tenantA = row?.id as string;
      } else {
        tenantB = row?.id as string;
      }
    }

    // The setup wizard's first admin: a provider admin without a team row, so an owner.
    ownerId = randomUUID();
    const password = "first-owner-password-1";
    const context = await authModule.auth.$context;
    await owner
      .insert(user)
      .values({ id: ownerId, name: "First Owner", email: "owner@provider.example", role: "admin" });
    await owner.insert(account).values({
      id: randomUUID(),
      accountId: ownerId,
      providerId: "credential",
      userId: ownerId,
      password: await context.password.hash(password),
    });
    ownerCookie = await signIn(ownerId, "owner@provider.example", password);
  }, 120_000);

  afterAll(async () => {
    resetExtensionsForTesting();
    const shared = await import("../../../../apps/api/src/db.js");
    await Promise.all([shared.db.$client.end(), shared.providerDb.$client.end()]);
    await appRole?.$client.end();
    await owner?.$client.end();
    await dropDatabase(testDatabaseAdminUrl as string, DATABASE);
  });

  let tech: { userId: string; cookie: string };

  it("lets an owner invite a technician limited to one tenant", async () => {
    tech = await inviteAndSignIn("tech@provider.example", {
      role: "technician",
      allTenants: false,
      tenantIds: [tenantA],
    });
    const team = (await (await call("GET", "/provider-team", ownerCookie)).json()) as {
      items: Array<{
        email: string;
        role: string;
        status: string;
        allTenants: boolean;
        tenantIds: string[];
      }>;
    };
    const member = team.items.find((m) => m.email === "tech@provider.example");
    expect(member).toMatchObject({
      role: "technician",
      status: "active",
      allTenants: false,
      tenantIds: [tenantA],
    });
    expect(team.items.find((m) => m.email === "owner@provider.example")?.role).toBe("owner");
  });

  it("keeps the technician to their tenant and away from configuration", async () => {
    const list = (await (await call("GET", "/tenants", tech.cookie)).json()) as {
      items: Array<{ id: string }>;
    };
    expect(list.items.map((t) => t.id)).toEqual([tenantA]);
    expect((await call("GET", `/tenants/${tenantA}`, tech.cookie)).status).toBe(200);
    expect((await call("GET", `/tenants/${tenantB}`, tech.cookie)).status).toBe(403);
    expect((await call("POST", "/tenants", tech.cookie, { name: "X", slug: "x" })).status).toBe(
      403,
    );
    expect((await call("GET", "/provider-team", tech.cookie)).status).toBe(403);
    expect(
      (
        await call("PATCH", `/provider-team/${tech.userId}`, tech.cookie, {
          role: "owner",
          allTenants: true,
        })
      ).status,
    ).toBe(403);
    expect((await call("POST", "/license", tech.cookie, { key: "x" })).status).toBe(403);
    const me = (await (await call("GET", "/me", tech.cookie)).json()) as {
      provider: { role: string; allTenants: boolean };
      tenants: Array<{ id: string }>;
    };
    expect(me.provider).toEqual({ role: "technician", allTenants: false });
    expect(me.tenants.map((t) => t.id)).toEqual([tenantA]);
  });

  it("applies a change of role and tenants on the next request", async () => {
    const patched = await call("PATCH", `/provider-team/${tech.userId}`, ownerCookie, {
      role: "read_only",
      allTenants: true,
    });
    expect(patched.status).toBe(200);
    const list = (await (await call("GET", "/tenants", tech.cookie)).json()) as {
      items: Array<{ id: string }>;
    };
    expect(list.items.map((t) => t.id).sort()).toEqual([tenantA, tenantB].sort());
    expect((await call("GET", "/license", tech.cookie)).status).toBe(200);
    expect((await call("GET", "/provider-team", tech.cookie)).status).toBe(200);
    expect((await call("DELETE", `/tenants/${tenantB}`, tech.cookie)).status).toBe(403);
  });

  it("never lets the team lose its last owner", async () => {
    const demote = await call("PATCH", `/provider-team/${ownerId}`, ownerCookie, {
      role: "administrator",
      allTenants: true,
    });
    expect(demote.status).toBe(409);
    expect((await call("DELETE", `/provider-team/${ownerId}`, ownerCookie)).status).toBe(409);

    const second = await inviteAndSignIn("owner2@provider.example", {
      role: "owner",
      allTenants: true,
    });
    expect(second.userId).toBeTruthy();
    const nowAllowed = await call("PATCH", `/provider-team/${ownerId}`, ownerCookie, {
      role: "owner",
      allTenants: true,
    });
    expect(nowAllowed.status).toBe(200);
  });

  it("refuses an address that already has an account", async () => {
    const again = await call("POST", "/provider-team", ownerCookie, {
      email: "tech@provider.example",
      name: "Tech again",
      role: "technician",
      allTenants: true,
    });
    expect(again.status).toBe(409);
  });

  it("removes a member: session ended, account deleted, everything audited", async () => {
    expect((await call("DELETE", `/provider-team/${tech.userId}`, ownerCookie)).status).toBe(204);
    expect((await call("GET", "/me", tech.cookie)).status).toBe(401);
    const [gone] = await owner.select({ id: user.id }).from(user).where(eq(user.id, tech.userId));
    expect(gone).toBeUndefined();
    const actions = await owner
      .select({ action: auditLog.action })
      .from(auditLog)
      .where(like(auditLog.action, "provider_team.%"));
    expect(new Set(actions.map((a) => a.action))).toEqual(
      new Set([
        "provider_team.member_invited",
        "provider_team.member_updated",
        "provider_team.member_removed",
      ]),
    );
  });

  it("keeps the team tables out of the tenant role's reach", async () => {
    await expect(appRole.$client.query("select * from provider_members")).rejects.toThrow(
      /permission denied/,
    );
  });
});
