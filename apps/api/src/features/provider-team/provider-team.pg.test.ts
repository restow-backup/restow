/**
 * Postgres-backed, end-to-end tests of the provider team, over HTTP with real
 * better-auth sessions (password plus the mandatory authenticator app), on
 * the application and installation roles production uses:
 *
 *   - an owner invites a technician limited to one tenant; the invitation
 *     link sets a password and the technician signs in;
 *   - the technician sees only that tenant, cannot reach the other one,
 *     cannot create tenants, change the team or the installation settings;
 *   - the owner widens the technician to read-only on every tenant: both
 *     tenants become visible, still no changes;
 *   - the last owner can neither step down nor leave; with a second owner
 *     the first may;
 *   - removing a member ends their session and deletes the account;
 *   - every change is in the installation's audit log;
 *   - without the gated feature `providerTeam.tenantScope` (Community and
 *     Business) a member gets every tenant; an existing limit stays as it is;
 *   - an owner resets an active member's access: password, authenticator app
 *     and sessions gone, a fresh link to hand over; the member chooses a new
 *     password and sets up the authenticator app again. Nobody resets
 *     themselves, and an owner without a team row (the setup's first admin)
 *     can be reset too;
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
import { registerApiExtension, resetExtensionsForTesting } from "../../extensions.js";
import { dropDatabase } from "../../features/snapshots/testing/explorer-fixture.js";
import { provisionTestRoles } from "../../testing/database-roles.js";

const DATABASE = `restow_provider_team_test_${randomBytes(4).toString("hex")}`;
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
  let authModule: typeof import("../../auth.js");
  let accounts: typeof import("../../features/accounts/service.js");
  let sharedDb: Database;
  let tenantA: string;
  let tenantB: string;
  let ownerCookie: string;
  let ownerId: string;
  /** Whether the test feature gate opens `providerTeam.tenantScope` (Service Provider). */
  let tenantScopeOn = true;

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
    // The team is the core's. Limiting a member to chosen tenants is the gated
    // feature `providerTeam.tenantScope`: a test feature gate opens it while
    // `tenantScopeOn` says so (in the full build ee/ decides by the license).
    registerApiExtension({
      name: "test-tenant-scope",
      featureGate: {
        isEnabled: async (_db, feature) => feature === "providerTeam.tenantScope" && tenantScopeOn,
      },
    });

    authModule = await import("../../auth.js");
    accounts = await import("../../features/accounts/service.js");
    const shared = await import("../../db.js");
    sharedDb = shared.db as Database;
    const { buildApp } = await import("../../app.js");
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
    const shared = await import("../../db.js");
    await Promise.all([shared.db.$client.end(), shared.providerDb.$client.end()]);
    await appRole?.$client.end();
    await owner?.$client.end();
    await dropDatabase(testDatabaseAdminUrl as string, DATABASE);
  });

  let tech: { userId: string; cookie: string };
  let secondOwner: { userId: string; cookie: string };

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
    // Installation-wide routes: the settings (every tenant) and their change (owners).
    expect((await call("GET", "/settings", tech.cookie)).status).toBe(403);
    expect((await call("PATCH", "/settings", tech.cookie, {})).status).toBe(403);
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
    expect((await call("GET", "/settings", tech.cookie)).status).toBe(200);
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

    secondOwner = await inviteAndSignIn("owner2@provider.example", {
      role: "owner",
      allTenants: true,
    });
    expect(secondOwner.userId).toBeTruthy();
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

  it("gives every member every tenant where the tenant scope is not offered", async () => {
    tenantScopeOn = false;
    try {
      const limited = await call("POST", "/provider-team", ownerCookie, {
        email: "limited@provider.example",
        name: "Limited",
        role: "technician",
        allTenants: false,
        tenantIds: [tenantA],
      });
      expect(limited.status).toBe(403);
      expect(((await limited.json()) as { type: string }).type).toBe(
        "urn:restow:problem:feature-unavailable",
      );
      const everyTenant = await call("POST", "/provider-team", ownerCookie, {
        email: "ops@provider.example",
        name: "Ops",
        role: "technician",
        allTenants: true,
      });
      expect(everyTenant.status).toBe(201);
      const ops = ((await everyTenant.json()) as { member: { userId: string } }).member.userId;
      expect(
        (
          await call("PATCH", `/provider-team/${ops}`, ownerCookie, {
            role: "technician",
            allTenants: false,
            tenantIds: [tenantA],
          })
        ).status,
      ).toBe(403);
      expect(
        (
          await call("PATCH", `/provider-team/${ops}`, ownerCookie, {
            role: "administrator",
            allTenants: true,
          })
        ).status,
      ).toBe(200);
    } finally {
      tenantScopeOn = true;
    }
  });

  it("keeps an existing limit when only the role changes, and widens it on request", async () => {
    const invited = await call("POST", "/provider-team", ownerCookie, {
      email: "scoped@provider.example",
      name: "Scoped",
      role: "technician",
      allTenants: false,
      tenantIds: [tenantA],
    });
    expect(invited.status).toBe(201);
    const scoped = ((await invited.json()) as { member: { userId: string } }).member.userId;
    tenantScopeOn = false;
    try {
      const roleOnly = await call("PATCH", `/provider-team/${scoped}`, ownerCookie, {
        role: "read_only",
        allTenants: false,
        tenantIds: [tenantA],
      });
      expect(roleOnly.status).toBe(200);
      expect(await roleOnly.json()).toMatchObject({
        role: "read_only",
        allTenants: false,
        tenantIds: [tenantA],
      });
      const other = await call("PATCH", `/provider-team/${scoped}`, ownerCookie, {
        role: "read_only",
        allTenants: false,
        tenantIds: [tenantB],
      });
      expect(other.status).toBe(403);
      const widened = await call("PATCH", `/provider-team/${scoped}`, ownerCookie, {
        role: "read_only",
        allTenants: true,
      });
      expect(widened.status).toBe(200);
    } finally {
      tenantScopeOn = true;
    }
  });

  it("refuses to reset your own access, or a member who has not signed in yet", async () => {
    const self = await call(
      "POST",
      `/provider-team/${secondOwner.userId}/reset-access`,
      secondOwner.cookie,
    );
    expect(self.status).toBe(409);
    expect(((await self.json()) as { type: string }).type).toBe(
      "urn:restow:problem:provider-team-reset-self",
    );
    const [pending] = await owner
      .select({ id: user.id })
      .from(user)
      .where(eq(user.email, "ops@provider.example"));
    const notActive = await call(
      "POST",
      `/provider-team/${pending?.id}/reset-access`,
      secondOwner.cookie,
    );
    expect(notActive.status).toBe(409);
    expect(((await notActive.json()) as { type: string }).type).toBe(
      "urn:restow:problem:provider-team-not-active",
    );
  });

  it("resets an active member's access: sign-in methods gone, a fresh link, a new start", async () => {
    // The first owner (no team row) resets the second owner.
    const reset = await call(
      "POST",
      `/provider-team/${secondOwner.userId}/reset-access`,
      ownerCookie,
    );
    expect(reset.status).toBe(200);
    const result = (await reset.json()) as {
      member: { status: string; email: string };
      setPasswordToken: string | null;
      mailOutcome: string;
    };
    expect(result.mailOutcome).toBe("not_configured");
    expect(result.setPasswordToken).toBeTruthy();
    expect(result.member).toMatchObject({ status: "invited", email: "owner2@provider.example" });

    // Every session of the member ended, the password and the authenticator app are gone.
    expect((await call("GET", "/me", secondOwner.cookie)).status).toBe(401);
    const passwords = await owner
      .select({ id: account.id })
      .from(account)
      .where(eq(account.userId, secondOwner.userId));
    expect(passwords).toEqual([]);
    const factors = await owner
      .select({ id: twoFactor.id })
      .from(twoFactor)
      .where(eq(twoFactor.userId, secondOwner.userId));
    expect(factors).toEqual([]);
    const [row] = await owner
      .select({ twoFactorEnabled: user.twoFactorEnabled })
      .from(user)
      .where(eq(user.id, secondOwner.userId));
    expect(row?.twoFactorEnabled).toBe(false);

    // The link sets a new password; the member sets up the authenticator app again.
    const password = `pw-${randomBytes(12).toString("hex")}`;
    await accounts.redeemSetPasswordToken(
      sharedDb,
      { token: result.setPasswordToken as string, password },
      { ip: "203.0.113.9" },
    );
    secondOwner = {
      userId: secondOwner.userId,
      cookie: await signIn(secondOwner.userId, "owner2@provider.example", password),
    };
    expect((await call("GET", "/provider-team", secondOwner.cookie)).status).toBe(200);

    const [entry] = await owner
      .select({ actor: auditLog.actor, details: auditLog.details })
      .from(auditLog)
      .where(eq(auditLog.action, "provider_team.access_reset"));
    expect(entry).toMatchObject({
      actor: "owner@provider.example",
      details: {
        email: "owner2@provider.example",
        role: "owner",
        passwordRemoved: true,
        authenticatorRemoved: true,
        sessionsEnded: expect.any(Number),
      },
    });
  });

  it("resets the setup's first owner, who has no team row, so the link still works", async () => {
    const reset = await call("POST", `/provider-team/${ownerId}/reset-access`, secondOwner.cookie);
    expect(reset.status).toBe(200);
    const result = (await reset.json()) as { setPasswordToken: string | null };
    expect((await call("GET", "/me", ownerCookie)).status).toBe(401);
    const password = `pw-${randomBytes(12).toString("hex")}`;
    await accounts.redeemSetPasswordToken(
      sharedDb,
      { token: result.setPasswordToken as string, password },
      { ip: "203.0.113.9" },
    );
    ownerCookie = await signIn(ownerId, "owner@provider.example", password);
    const me = (await (await call("GET", "/me", ownerCookie)).json()) as {
      provider: { role: string; allTenants: boolean };
    };
    expect(me.provider).toEqual({ role: "owner", allTenants: true });
  });

  it("keeps the team tables out of the tenant role's reach", async () => {
    await expect(appRole.$client.query("select * from provider_members")).rejects.toThrow(
      /permission denied/,
    );
  });
});
