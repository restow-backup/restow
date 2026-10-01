/**
 * Postgres-backed tests of account provisioning: a tenant admin creates a
 * sign-in for a person without Microsoft SSO, the person redeems the link
 * exactly once within 72h, a reissue invalidates whatever link came before,
 * every step is audited without ever writing the token or the password, and
 * an invited tenant admin can actually sign in with it, enrol the mandatory
 * authenticator app and reach their tenant. Also proves the account-takeover
 * refusals: a tenant admin can never pull in a provider administrator or an
 * account of a different tenant, an account that already signs in some other
 * way never gets a link issued or reissued for it, and redeeming the same
 * link twice at once never lets a second password win.
 *
 * The suite exercises the real better-auth instance (apps/api/src/auth.ts)
 * on the application and installation roles Row Level Security actually
 * binds (`testing/database-roles.ts`, the same setup `auth.test.ts` uses),
 * not the database owner, so RLS is exercised exactly as in production.
 *
 * Runs when RESTOW_TEST_DATABASE_URL points at a Postgres server. Without it
 * the suite is skipped.
 */
import { randomBytes, randomUUID } from "node:crypto";
import {
  type Database,
  account,
  auditLog,
  createDb,
  member,
  organization,
  passkey,
  providers,
  tenants,
  twoFactor,
  user,
} from "@restow/db";
import { symmetricDecrypt } from "better-auth/crypto";
import { and, asc, eq } from "drizzle-orm";
import { Hono } from "hono";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { ProblemError, errorHandler } from "../../problem.js";
import { provisionTestRoles } from "../../testing/database-roles.js";
import { dropDatabase } from "../snapshots/testing/explorer-fixture.js";

const DATABASE = `restow_api_accounts_test_${randomBytes(4).toString("hex")}`;
const PUBLIC_URL = "http://localhost:3000";
const testDatabaseAdminUrl = process.env.RESTOW_TEST_DATABASE_URL;

type Service = typeof import("./service.js");
type RoutesModule = typeof import("./routes.js");
type SessionModule = typeof import("../../middleware/session.js");
type AuthModule = typeof import("../../auth.js");

function actor(email = "owner@contoso.example", isProviderAdmin = false) {
  return { id: randomUUID(), email, ip: "192.0.2.10", isProviderAdmin };
}

function urlFor(base: string, database: string): string {
  const url = new URL(base);
  url.pathname = `/${database}`;
  return url.toString();
}

describe.skipIf(!testDatabaseAdminUrl)("accounts against Postgres", () => {
  let owner: Database;
  let db: Database;
  let service: Service;
  let routes: RoutesModule;
  let session: SessionModule;
  let authModule: AuthModule;
  let tenantA: { id: string; name: string; organizationId: string; status: "active" };
  let tenantB: { id: string; name: string; organizationId: string; status: "active" };
  let orgAId: string;
  /** The routers wrapped with the real problem-details error handler (app.ts's own), so a thrown ProblemError becomes the same typed JSON response it would in production, not Hono's generic 500. */
  let publicApp: Hono;
  let tenantApp: Hono;

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
    process.env.DATABASE_URL = roles.appUrl;
    process.env.DATABASE_PROVIDER_URL = roles.providerUrl;
    process.env.RESTOW_MASTER_KEY = randomBytes(32).toString("base64");
    process.env.BETTER_AUTH_SECRET = randomBytes(32).toString("base64");
    process.env.RESTOW_PUBLIC_URL = PUBLIC_URL;

    service = await import("./service.js");
    routes = await import("./routes.js");
    session = await import("../../middleware/session.js");
    authModule = await import("../../auth.js");
    const shared = await import("../../db.js");
    db = shared.db;
    publicApp = new Hono().onError(errorHandler).route("/", routes.accountsPublicRoutes);
    tenantApp = new Hono().onError(errorHandler).route("/", routes.accountsRoutes);

    const [provider] = await owner.insert(providers).values({ name: "Provider" }).returning();
    const [orgA] = await owner
      .insert(organization)
      .values({ id: randomUUID(), name: "Contoso", slug: "contoso", createdAt: new Date() })
      .returning();
    const [orgB] = await owner
      .insert(organization)
      .values({ id: randomUUID(), name: "Fabrikam", slug: "fabrikam", createdAt: new Date() })
      .returning();
    orgAId = orgA?.id as string;
    const [tenantARow] = await owner
      .insert(tenants)
      .values({
        providerId: provider?.id as string,
        organizationId: orgAId,
        name: "Contoso",
        slug: "contoso",
      })
      .returning();
    const [tenantBRow] = await owner
      .insert(tenants)
      .values({
        providerId: provider?.id as string,
        organizationId: orgB?.id as string,
        name: "Fabrikam",
        slug: "fabrikam",
      })
      .returning();
    tenantA = {
      id: tenantARow?.id as string,
      name: "Contoso",
      organizationId: orgAId,
      status: "active",
    };
    tenantB = {
      id: tenantBRow?.id as string,
      name: "Fabrikam",
      organizationId: orgB?.id as string,
      status: "active",
    };
  }, 60_000);

  afterAll(async () => {
    const shared = await import("../../db.js");
    await Promise.all([shared.db.$client.end(), shared.providerDb.$client.end()]);
    await owner?.$client.end();
    await dropDatabase(testDatabaseAdminUrl as string, DATABASE);
  }, 30_000);

  async function auditActionsFor(userId: string): Promise<{ action: string; details: unknown }[]> {
    const rows = await owner
      .select({ action: auditLog.action, details: auditLog.details })
      .from(auditLog)
      .where(and(eq(auditLog.tenantId, tenantA.id), eq(auditLog.target, userId)))
      .orderBy(asc(auditLog.createdAt));
    return rows;
  }

  /** No audit detail of `userId` ever contains `secret` (a token or a password). */
  async function expectNeverLeaked(userId: string, secret: string): Promise<void> {
    for (const row of await auditActionsFor(userId)) {
      expect(JSON.stringify(row.details ?? {})).not.toContain(secret);
    }
  }

  // --- Issuing and redeeming a link -------------------------------------------------

  it("provisions a new account, issues a redeemable link, and audits without the token", async () => {
    const who = actor();
    const result = await service.provisionAccount(
      db,
      tenantA,
      { email: "new.admin@contoso.example", role: "tenant_admin" },
      who,
      "en",
    );

    expect(result.created).toBe(true);
    expect(result.linkIssued).toBe(true);
    expect(result.mailOutcome).toBe("not_configured"); // no mail transport configured
    expect((result.setPasswordToken as string).length).toBeGreaterThan(20);

    const [membership] = await owner
      .select()
      .from(member)
      .where(and(eq(member.organizationId, orgAId), eq(member.userId, result.userId)));
    expect(membership?.role).toBe("admin");

    const check = await service.checkSetPasswordToken(db, result.setPasswordToken as string);
    expect(check).toEqual({ status: "valid", emailHint: "n********@contoso.example" });

    const actions = await auditActionsFor(result.userId);
    expect(actions.map((row) => row.action)).toEqual([
      "account.provisioned",
      "account.password_link_issued",
    ]);
    await expectNeverLeaked(result.userId, result.setPasswordToken as string);

    const pending = await service.listPendingAccounts(db, tenantA);
    expect(pending.find((row) => row.userId === result.userId)).toMatchObject({
      email: "new.admin@contoso.example",
      role: "tenant_admin",
      linkStatus: "valid",
      linkExpiresAt: result.linkExpiresAt,
    });
  });

  it("reissuing invalidates the previous link; the new one redeems exactly once", async () => {
    const who = actor();
    const first = await service.provisionAccount(
      db,
      tenantA,
      { email: "reissue.me@contoso.example", role: "tenant_user" },
      who,
      "en",
    );

    const reissued = await service.reissueAccountLink(db, tenantA, first.userId, who, "en");
    expect(reissued.setPasswordToken).not.toBe(first.setPasswordToken);

    // The old link is gone outright (not merely expired).
    expect(await service.checkSetPasswordToken(db, first.setPasswordToken as string)).toEqual({
      status: "invalid",
      emailHint: null,
    });
    expect(
      await service.checkSetPasswordToken(db, reissued.setPasswordToken as string),
    ).toMatchObject({
      status: "valid",
    });

    const password = "correct-horse-battery";
    const redeemed = await service.redeemSetPasswordToken(
      db,
      { token: reissued.setPasswordToken as string, password },
      { ip: "203.0.113.5" },
    );
    expect(redeemed.userId).toBe(first.userId);

    expect(
      await service.checkSetPasswordToken(db, reissued.setPasswordToken as string),
    ).toMatchObject({
      status: "used",
    });

    await expect(
      service.redeemSetPasswordToken(
        db,
        { token: reissued.setPasswordToken as string, password: "another-correct-password" },
        { ip: "203.0.113.5" },
      ),
    ).rejects.toMatchObject({ status: 409, type: "urn:restow:problem:account-link-used" });

    const pending = await service.listPendingAccounts(db, tenantA);
    expect(pending.some((row) => row.userId === first.userId)).toBe(false);

    const actions = await auditActionsFor(first.userId);
    expect(actions.map((row) => row.action)).toEqual([
      "account.provisioned",
      "account.password_link_issued",
      "account.password_link_issued",
      "account.password_set",
    ]);
    await expectNeverLeaked(first.userId, reissued.setPasswordToken as string);
    await expectNeverLeaked(first.userId, password);
  });

  it("an expired link is refused with an honest error, not a silent password change", async () => {
    const who = actor();
    const provisioned = await service.provisionAccount(
      db,
      tenantA,
      { email: "expires.soon@contoso.example", role: "tenant_user" },
      who,
      "en",
    );
    const past = new Date();
    const future = new Date(Date.now() + 73 * 60 * 60 * 1000); // past the 72h window

    expect(
      await service.checkSetPasswordToken(db, provisioned.setPasswordToken as string, past),
    ).toMatchObject({ status: "valid" });
    expect(
      await service.checkSetPasswordToken(db, provisioned.setPasswordToken as string, future),
    ).toMatchObject({ status: "expired" });

    await expect(
      service.redeemSetPasswordToken(
        db,
        { token: provisioned.setPasswordToken as string, password: "correct-horse-battery" },
        { ip: "203.0.113.5" },
        future,
      ),
    ).rejects.toMatchObject({ status: 409, type: "urn:restow:problem:account-link-expired" });
  });

  it("refuses to redeem a link for someone removed from the tenant since it was issued", async () => {
    const who = actor();
    const email = "removed.before.redeem@contoso.example";
    const provisioned = await service.provisionAccount(
      db,
      tenantA,
      { email, role: "tenant_user" },
      who,
      "en",
    );

    // Simulates the tenants feature removing the member while the link is
    // still outstanding (tenants/service.ts's own removeMember, out of this
    // item's owned paths): the membership row is gone, the link is not.
    await owner
      .delete(member)
      .where(and(eq(member.organizationId, orgAId), eq(member.userId, provisioned.userId)));

    await expect(
      service.redeemSetPasswordToken(
        db,
        { token: provisioned.setPasswordToken as string, password: "correct-horse-battery-2" },
        { ip: "203.0.113.6" },
      ),
    ).rejects.toMatchObject({ status: 404, type: "urn:restow:problem:account-link-invalid" });

    // Refused, not silently changed: no credential was written.
    const [credentialRow] = await owner
      .select({ id: account.id })
      .from(account)
      .where(and(eq(account.userId, provisioned.userId), eq(account.providerId, "credential")));
    expect(credentialRow).toBeUndefined();
  });

  it("reuses an existing, still-pending account by email instead of creating a duplicate", async () => {
    const who = actor();
    const email = "shared.person@contoso.example";
    const first = await service.provisionAccount(
      db,
      tenantA,
      { email, role: "tenant_user" },
      who,
      "en",
    );
    expect(first.created).toBe(true);

    const second = await service.provisionAccount(
      db,
      tenantA,
      { email, role: "tenant_user" },
      who,
      "en",
    );
    expect(second.created).toBe(false);
    expect(second.userId).toBe(first.userId);
    expect(second.linkIssued).toBe(true);

    const memberships = await owner
      .select()
      .from(member)
      .where(and(eq(member.organizationId, orgAId), eq(member.userId, first.userId)));
    expect(memberships).toHaveLength(1); // no duplicate membership row
  });

  it("an unknown token is invalid without leaking whether it ever existed", async () => {
    expect(await service.checkSetPasswordToken(db, "not-a-real-token")).toEqual({
      status: "invalid",
      emailHint: null,
    });
    await expect(
      service.redeemSetPasswordToken(
        db,
        { token: "not-a-real-token", password: "correct-horse-battery" },
        { ip: "203.0.113.5" },
      ),
    ).rejects.toMatchObject({ status: 404, type: "urn:restow:problem:account-link-invalid" });
  });

  it("a tenant admin cannot resolve another tenant's id (hidden as not found)", async () => {
    const state = {
      auth: { session: { activeOrganizationId: null } },
      user: { id: randomUUID(), email: "admin@contoso.example" },
      isProviderAdmin: false,
      memberships: [{ organizationId: orgAId, role: "admin" }],
    } as unknown as Parameters<SessionModule["resolveTenantAccess"]>[0];

    await expect(session.resolveTenantAccess(state, tenantB.id, "tenant_admin")).rejects.toThrow(
      ProblemError,
    );
    await expect(
      session.resolveTenantAccess(state, tenantB.id, "tenant_admin"),
    ).rejects.toMatchObject({ status: 404 });

    const own = await session.resolveTenantAccess(state, tenantA.id, "tenant_admin");
    expect(own.tenant.id).toBe(tenantA.id);
    expect(own.role).toBe("tenant_admin");
  });

  // --- Never a way to take an existing account over ----------------------------------

  it("only adds the membership when the account already has a passkey", async () => {
    const userId = randomUUID();
    const email = "has.passkey@contoso.example";
    await owner
      .insert(user)
      .values({ id: userId, name: "Has Passkey", email, emailVerified: true });
    await owner.insert(passkey).values({
      id: randomUUID(),
      userId,
      publicKey: "fake-public-key",
      credentialID: randomBytes(16).toString("base64url"),
      counter: 0,
      deviceType: "singleDevice",
      backedUp: false,
      createdAt: new Date(),
    });

    const result = await service.provisionAccount(
      db,
      tenantA,
      { email, role: "tenant_admin" },
      actor(),
      "en",
    );

    expect(result).toMatchObject({
      userId,
      created: false,
      linkIssued: false,
      setPasswordToken: null,
      linkExpiresAt: null,
    });
    const [membership] = await owner
      .select()
      .from(member)
      .where(and(eq(member.organizationId, orgAId), eq(member.userId, userId)));
    expect(membership?.role).toBe("admin");
    const actions = await auditActionsFor(userId);
    expect(actions.map((row) => row.action)).toEqual(["account.provisioned"]);
  });

  it("only adds the membership when the account already signs in with Microsoft", async () => {
    const userId = randomUUID();
    const email = "has.microsoft@contoso.example";
    await owner
      .insert(user)
      .values({ id: userId, name: "Has Microsoft", email, emailVerified: true });
    await owner.insert(account).values({
      id: randomUUID(),
      accountId: randomUUID(),
      providerId: "microsoft",
      userId,
      createdAt: new Date(),
      updatedAt: new Date(),
    });

    const result = await service.provisionAccount(
      db,
      tenantA,
      { email, role: "tenant_user" },
      actor(),
      "en",
    );

    expect(result).toMatchObject({
      userId,
      created: false,
      linkIssued: false,
      setPasswordToken: null,
    });
  });

  it("only adds the membership when the account already has a working password", async () => {
    const who = actor();
    const email = "has.password.already@contoso.example";
    const first = await service.provisionAccount(
      db,
      tenantA,
      { email, role: "tenant_user" },
      who,
      "en",
    );
    await service.redeemSetPasswordToken(
      db,
      { token: first.setPasswordToken as string, password: "this-was-set-once-already" },
      { ip: "203.0.113.71" },
    );

    const second = await service.provisionAccount(
      db,
      tenantA,
      { email, role: "tenant_admin" },
      who,
      "en",
    );
    expect(second).toMatchObject({ linkIssued: false, setPasswordToken: null, created: false });

    const memberships = await owner
      .select()
      .from(member)
      .where(and(eq(member.organizationId, orgAId), eq(member.userId, first.userId)));
    expect(memberships).toHaveLength(1); // still no duplicate membership row
  });

  it("refuses to provision a provider administrator into a tenant", async () => {
    const providerAdminId = randomUUID();
    const email = "provider.admin@contoso.example";
    await owner.insert(user).values({
      id: providerAdminId,
      name: "Provider Admin",
      email,
      emailVerified: true,
      role: "admin",
    });

    await expect(
      service.provisionAccount(db, tenantA, { email, role: "tenant_user" }, actor(), "en"),
    ).rejects.toMatchObject({
      status: 403,
      type: "urn:restow:problem:account-provider-admin-target",
    });

    const [membership] = await owner
      .select()
      .from(member)
      .where(and(eq(member.organizationId, orgAId), eq(member.userId, providerAdminId)));
    expect(membership).toBeUndefined();
  });

  it("refuses to reissue a link for a provider administrator", async () => {
    const providerAdminId = randomUUID();
    const email = "provider.admin.member@contoso.example";
    await owner.insert(user).values({
      id: providerAdminId,
      name: "Legacy Provider Admin",
      email,
      emailVerified: true,
      role: "admin",
    });
    // Simulates data from before this refusal existed: somehow already a member.
    await owner.insert(member).values({
      id: randomUUID(),
      organizationId: orgAId,
      userId: providerAdminId,
      role: "member",
      createdAt: new Date(),
    });

    await expect(
      service.reissueAccountLink(db, tenantA, providerAdminId, actor(), "en"),
    ).rejects.toMatchObject({
      status: 403,
      type: "urn:restow:problem:account-provider-admin-target",
    });
  });

  it("refuses a tenant admin pulling in an account that already belongs to a different tenant", async () => {
    const email = "cross.tenant@contoso.example";
    const inB = await service.provisionAccount(
      db,
      tenantB,
      { email, role: "tenant_user" },
      actor(),
      "en",
    );

    await expect(
      service.provisionAccount(db, tenantA, { email, role: "tenant_user" }, actor(), "en"),
    ).rejects.toMatchObject({ status: 403, type: "urn:restow:problem:account-cross-tenant" });

    const membershipA = await owner
      .select()
      .from(member)
      .where(and(eq(member.organizationId, orgAId), eq(member.userId, inB.userId)));
    expect(membershipA).toHaveLength(0);
  });

  it("lets a provider admin add the same account to a second tenant", async () => {
    const email = "cross.tenant.provider@contoso.example";
    const inB = await service.provisionAccount(
      db,
      tenantB,
      { email, role: "tenant_user" },
      actor(),
      "en",
    );

    const result = await service.provisionAccount(
      db,
      tenantA,
      { email, role: "tenant_admin" },
      actor("provider@restow.example", true),
      "en",
    );
    expect(result.userId).toBe(inB.userId);

    const [membershipA] = await owner
      .select()
      .from(member)
      .where(and(eq(member.organizationId, orgAId), eq(member.userId, inB.userId)));
    expect(membershipA?.role).toBe("admin");
  });

  it("refuses a tenant admin reissuing a link for a pending account that also belongs to another tenant", async () => {
    // A provider admin is allowed to add the same still-pending person to two
    // tenants (the test above); a tenant admin of just one of them must never
    // be able to pull the other tenant's raw set-password token out through
    // reissue just because the person is also pending here.
    const email = "cross.tenant.reissue@contoso.example";
    const inB = await service.provisionAccount(
      db,
      tenantB,
      { email, role: "tenant_admin" },
      actor("provider@restow.example", true),
      "en",
    );
    await service.provisionAccount(
      db,
      tenantA,
      { email, role: "tenant_user" },
      actor("provider@restow.example", true),
      "en",
    );

    await expect(
      service.reissueAccountLink(db, tenantA, inB.userId, actor(), "en"),
    ).rejects.toMatchObject({ status: 403, type: "urn:restow:problem:account-cross-tenant" });

    // A provider admin may still reissue it, on either tenant.
    const reissued = await service.reissueAccountLink(
      db,
      tenantA,
      inB.userId,
      actor("provider@restow.example", true),
      "en",
    );
    expect(reissued.userId).toBe(inB.userId);
  });

  it("reports the account's actual stored role, not the requested one, when re-provisioning an existing member", async () => {
    // Re-inviting an already-provisioned member must never claim a role
    // change that did not happen: provisioning only ever sets the role on a
    // brand new membership, never on one that already exists.
    const who = actor();
    const email = "role.mismatch@contoso.example";
    const first = await service.provisionAccount(
      db,
      tenantA,
      { email, role: "tenant_user" },
      who,
      "en",
    );
    expect(first.role).toBe("tenant_user");

    const second = await service.provisionAccount(
      db,
      tenantA,
      { email, role: "tenant_admin" },
      who,
      "en",
    );
    expect(second.role).toBe("tenant_user");

    const [membership] = await owner
      .select()
      .from(member)
      .where(and(eq(member.organizationId, orgAId), eq(member.userId, first.userId)));
    expect(membership?.role).toBe("member"); // unchanged: still tenant_user

    const actions = await auditActionsFor(first.userId);
    const provisionedEntries = actions.filter((row) => row.action === "account.provisioned");
    for (const entry of provisionedEntries) {
      expect((entry.details as { role?: string } | null)?.role).toBe("tenant_user");
    }
  });

  it("refuses to reissue a link for someone who already has a working sign-in", async () => {
    const who = actor();
    const provisioned = await service.provisionAccount(
      db,
      tenantA,
      { email: "already.signed.in@contoso.example", role: "tenant_user" },
      who,
      "en",
    );
    await service.redeemSetPasswordToken(
      db,
      { token: provisioned.setPasswordToken as string, password: "already-set-my-own-pw1" },
      { ip: "203.0.113.80" },
    );

    await expect(
      service.reissueAccountLink(db, tenantA, provisioned.userId, who, "en"),
    ).rejects.toMatchObject({ status: 409, type: "urn:restow:problem:account-not-pending" });
  });

  it("refuses to overwrite an existing credential password, and leaves the link valid", async () => {
    const who = actor();
    const provisioned = await service.provisionAccount(
      db,
      tenantA,
      { email: "already.has.a.hash@contoso.example", role: "tenant_user" },
      who,
      "en",
    );
    const token = provisioned.setPasswordToken as string;

    // Simulates a credential that appeared through some other path while the
    // link was still outstanding; provisionAccount no longer issues a link in
    // that situation, so this defends the redeem step itself in depth.
    const context = await authModule.auth.$context;
    await owner.insert(account).values({
      id: randomUUID(),
      accountId: provisioned.userId,
      providerId: "credential",
      userId: provisioned.userId,
      password: await context.password.hash("original-untouched-password"),
      createdAt: new Date(),
      updatedAt: new Date(),
    });

    await expect(
      service.redeemSetPasswordToken(
        db,
        { token, password: "attacker-supplied-password" },
        { ip: "203.0.113.81" },
      ),
    ).rejects.toMatchObject({ status: 409, type: "urn:restow:problem:account-link-used" });

    const [credentialRow] = await owner
      .select({ password: account.password })
      .from(account)
      .where(and(eq(account.userId, provisioned.userId), eq(account.providerId, "credential")));
    expect(
      await context.password.verify({
        hash: credentialRow?.password as string,
        password: "original-untouched-password",
      }),
    ).toBe(true);

    // The failed write rolled back as a whole: the link stays redeemable.
    expect(await service.checkSetPasswordToken(db, token)).toMatchObject({ status: "valid" });
  });

  it("consumes a link atomically: concurrent redeems leave exactly one password set", async () => {
    const provisioned = await service.provisionAccount(
      db,
      tenantA,
      { email: "race.me@contoso.example", role: "tenant_user" },
      actor(),
      "en",
    );
    const token = provisioned.setPasswordToken as string;
    const candidates = ["first-password-12345", "second-password-12345", "third-password-12345"];

    const attempts = await Promise.allSettled(
      candidates.map((password, index) =>
        service.redeemSetPasswordToken(db, { token, password }, { ip: `203.0.113.${90 + index}` }),
      ),
    );

    expect(attempts.filter((a) => a.status === "fulfilled")).toHaveLength(1);
    const rejected = attempts.filter((a): a is PromiseRejectedResult => a.status === "rejected");
    expect(rejected).toHaveLength(2);
    for (const failure of rejected) {
      expect(failure.reason).toMatchObject({
        status: 409,
        type: "urn:restow:problem:account-link-used",
      });
    }

    const [credentialRow] = await owner
      .select({ password: account.password })
      .from(account)
      .where(and(eq(account.userId, provisioned.userId), eq(account.providerId, "credential")));
    const context = await authModule.auth.$context;
    const winners = await Promise.all(
      candidates.map((password) =>
        context.password.verify({ hash: credentialRow?.password as string, password }),
      ),
    );
    expect(winners.filter(Boolean)).toHaveLength(1);
  });

  // --- The public redeem endpoint is rate-limited per IP ------------------------------

  it("rate-limits the public redeem endpoint per client IP", async () => {
    const ip = "203.0.113.220";
    const attempt = () =>
      publicApp.fetch(
        new Request(`${PUBLIC_URL}/set-password`, {
          method: "POST",
          headers: {
            "content-type": "application/json",
            origin: PUBLIC_URL,
            "x-forwarded-for": ip,
          },
          body: JSON.stringify({ token: "not-a-real-token", password: "totally-invalid-token-pw" }),
        }),
      );
    const statuses: number[] = [];
    for (let index = 0; index < 11; index += 1) {
      statuses.push((await attempt()).status);
    }
    expect(statuses.slice(0, 10).every((status) => status === 404)).toBe(true);
    expect(statuses[10]).toBe(429);
  });

  it("refuses a redeem from another site or with a body that is not JSON, before anything else", async () => {
    const ip = "203.0.113.221";
    const redeem = (headers: Record<string, string>) =>
      publicApp.fetch(
        new Request(`${PUBLIC_URL}/set-password`, {
          method: "POST",
          headers: { "x-forwarded-for": ip, ...headers },
          body: JSON.stringify({ token: "not-a-real-token", password: "totally-invalid-token-pw" }),
        }),
      );
    // An older browser without Fetch Metadata still names the page it was sent from.
    const foreign = await redeem({
      "content-type": "application/json",
      origin: "https://evil.example",
    });
    expect(foreign.status).toBe(403);
    expect(((await foreign.json()) as { type: string }).type).toBe(
      "urn:restow:problem:cross-site-request",
    );
    // A no-cors form post from a page on another site carries text/plain.
    const textPlain = await redeem({ "content-type": "text/plain" });
    expect(textPlain.status).toBe(415);
    // Neither reached the token lookup or used up the address's redeem budget.
    const real = await redeem({ "content-type": "application/json", origin: PUBLIC_URL });
    expect(real.status).toBe(404);
  });

  // --- The full invited-admin flow, over HTTP, exactly as the browser sees it --------

  describe("an invited tenant admin without Entra SSO", () => {
    function authPost(
      path: string,
      body: Record<string, unknown> | undefined,
      cookie: string | undefined,
      clientIp: string,
    ): Promise<Response> {
      return authModule.auth.handler(
        new Request(`${PUBLIC_URL}/api/auth${path}`, {
          method: "POST",
          headers: {
            "content-type": "application/json",
            origin: PUBLIC_URL,
            "x-forwarded-for": clientIp,
            ...(cookie ? { cookie } : {}),
          },
          body: body !== undefined ? JSON.stringify(body) : undefined,
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

    /** Sign in with the password, then enrol the mandatory authenticator app; returns the fully-assured session cookie. */
    async function signInAndEnrolTotp(
      userId: string,
      email: string,
      password: string,
      clientIp: string,
    ): Promise<string> {
      const signIn = await authPost("/sign-in/email", { email, password }, undefined, clientIp);
      expect(signIn.status).toBe(200);
      const passwordOnlyCookie = sessionCookieOf(signIn);

      // A password alone only ever unlocks TOTP enrolment (docs/STACK.md "Auth").
      await expect(
        session.authenticate(new Headers({ cookie: passwordOnlyCookie })),
      ).rejects.toMatchObject({ status: 403, type: session.TOTP_ENROLLMENT_REQUIRED_PROBLEM });

      const enable = await authPost(
        "/two-factor/enable",
        { password },
        passwordOnlyCookie,
        clientIp,
      );
      expect(enable.status).toBe(200);

      // The enable response's `totpURI` carries the secret base32-encoded for
      // authenticator apps (RFC 4226/6238); better-auth's own `generateTOTP`
      // takes the raw secret instead, so it is read back the same way
      // `verify-totp` itself does: decrypted straight from the stored row.
      const context = await authModule.auth.$context;
      const [stored] = await owner
        .select({ secret: twoFactor.secret })
        .from(twoFactor)
        .where(eq(twoFactor.userId, userId));
      if (!stored) {
        throw new Error("two-factor/enable created no row to enrol from");
      }
      const rawSecret = await symmetricDecrypt({ key: context.secretConfig, data: stored.secret });
      const { code } = await authModule.auth.api.generateTOTP({ body: { secret: rawSecret } });

      const verify = await authPost(
        "/two-factor/verify-totp",
        { code },
        passwordOnlyCookie,
        clientIp,
      );
      expect(verify.status).toBe(200);
      return sessionCookieOf(verify);
    }

    it("opens the link, sets a password, enrols TOTP and reaches the tenant (never another one)", async () => {
      const email = "flow.admin@contoso.example";
      const password = "correct-horse-battery-flow-1";
      const provisioned = await service.provisionAccount(
        db,
        tenantA,
        { email, role: "tenant_admin" },
        actor(),
        "en",
      );
      await service.redeemSetPasswordToken(
        db,
        { token: provisioned.setPasswordToken as string, password },
        { ip: "203.0.113.100" },
      );

      const enrolledCookie = await signInAndEnrolTotp(
        provisioned.userId,
        email,
        password,
        "198.51.100.70",
      );

      const own = await tenantApp.fetch(
        new Request(`${PUBLIC_URL}/tenants/${tenantA.id}/accounts`, {
          headers: { cookie: enrolledCookie, origin: PUBLIC_URL },
        }),
      );
      expect(own.status).toBe(200);
      const ownBody = (await own.json()) as { items: unknown[] };
      expect(Array.isArray(ownBody.items)).toBe(true);

      // Tenant B stays out of reach for this tenant_admin.
      const foreign = await tenantApp.fetch(
        new Request(`${PUBLIC_URL}/tenants/${tenantB.id}/accounts`, {
          headers: { cookie: enrolledCookie, origin: PUBLIC_URL },
        }),
      );
      expect(foreign.status).toBe(404);

      // Provisioning into tenant B is refused the same way, not just reading it.
      const foreignProvision = await tenantApp.fetch(
        new Request(`${PUBLIC_URL}/tenants/${tenantB.id}/accounts`, {
          method: "POST",
          headers: {
            cookie: enrolledCookie,
            origin: PUBLIC_URL,
            "content-type": "application/json",
          },
          body: JSON.stringify({ email: "someone.else@fabrikam.example", role: "tenant_user" }),
        }),
      );
      expect(foreignProvision.status).toBe(404);
    });
  });
});
