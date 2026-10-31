/**
 * Postgres-backed test through the real application (apps/api/src/app.ts), with real sessions:
 * the provider's price for a tenant is written to the tenant's audit chain when it is set, and a
 * tenant's administrator reads that chain. They must never get the figures from it: not from the
 * list, not from one entry, not from the JSON or CSV export. The provider owner reads them there.
 *
 * Runs when RESTOW_TEST_DATABASE_URL points at a Postgres server (the database
 * `restow_ee_audit_prices_test` is recreated there and dropped after). Without it the suite is
 * skipped.
 */
import { randomBytes, randomUUID } from "node:crypto";
import { account, createDb, type Database, member, tenants, twoFactor, user } from "@restow/db";
import { symmetricDecrypt } from "better-auth/crypto";
import { eq } from "drizzle-orm";
import type { Hono } from "hono";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  registerApiExtension,
  resetExtensionsForTesting,
} from "../../../../apps/api/src/extensions.js";
import {
  dropDatabase,
  recreateDatabase,
  testDatabaseAdminUrl,
} from "../../../../apps/api/src/features/snapshots/testing/explorer-fixture.js";
import {
  provisionTestRoles,
  type TestDatabaseRoles,
} from "../../../../apps/api/src/testing/database-roles.js";

const DATABASE = "restow_ee_audit_prices_test";
const PUBLIC_URL = "http://localhost:3000";
const OWNER_EMAIL = "owner@example.com";
const ADMIN_EMAIL = "tenant-admin@example.com";
const PASSWORD = "correct-horse-battery-1";
const SETUP_TOKEN = "7QKMZ-RT4VX-9HBNP-2WCAE";
const FIGURES = /7\.77|3\.33|mailboxPrice|storagePrice/;

describe.skipIf(!testDatabaseAdminUrl)("the audit log and a tenant's own prices", () => {
  let owner: Database;
  let roles: TestDatabaseRoles | undefined;
  let app: Hono;
  let authModule: typeof import("../../../../apps/api/src/auth.js");
  let ownerCookie: string;
  let adminCookie: string;
  let tenantId: string;
  let ipCounter = 0;

  function request(path: string, cookie: string, init: RequestInit = {}, tenant?: string) {
    return Promise.resolve(
      app.fetch(
        new Request(`${PUBLIC_URL}${path}`, {
          ...init,
          headers: {
            origin: PUBLIC_URL,
            cookie,
            ...(tenant ? { "x-restow-tenant": tenant } : {}),
            ...((init.headers as Record<string, string> | undefined) ?? {}),
          },
        }),
      ),
    );
  }

  function authPost(path: string, body: Record<string, unknown>, cookie?: string, ip = "") {
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

  /** Sign in with the password and enrol the mandatory authenticator app. */
  async function signIn(email: string): Promise<string> {
    ipCounter += 1;
    const ip = `198.51.100.${ipCounter}`;
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
    return sessionCookieOf(verify);
  }

  beforeAll(async () => {
    const url = await recreateDatabase(testDatabaseAdminUrl as string, DATABASE);
    roles = await provisionTestRoles(url);
    process.env.DATABASE_URL = roles.appUrl;
    process.env.DATABASE_PROVIDER_URL = roles.providerUrl;
    process.env.RESTOW_MASTER_KEY = randomBytes(32).toString("base64");
    process.env.BETTER_AUTH_SECRET = randomBytes(32).toString("base64");
    process.env.RESTOW_PUBLIC_URL = PUBLIC_URL;
    process.env.RESTOW_SETUP_TOKEN = SETUP_TOKEN;
    // The routes read the configuration the environment above sets: imported only now.
    const { mountPath } = await import("./meta.js");
    const { auditRoutes } = await import("./routes.js");
    // Several tenants and tenant prices are gated; the audit log is mounted without its licence.
    registerApiExtension({ name: "test-gate", featureGate: { isEnabled: async () => true } });
    registerApiExtension({
      name: "test-audit",
      sessionRoutes: [{ path: mountPath, routes: auditRoutes }],
    });
    owner = createDb(url);
    ({ app } = await import("../../../../apps/api/src/app.js"));
    authModule = await import("../../../../apps/api/src/auth.js");
    const { DISCLAIMER_VERSION: version } = await import(
      "../../../../apps/api/src/lib/disclaimer.js"
    );

    const setup = await app.fetch(
      new Request(`${PUBLIC_URL}/api/v1/setup`, {
        method: "POST",
        headers: {
          origin: PUBLIC_URL,
          "content-type": "application/json",
          "x-restow-setup-token": SETUP_TOKEN,
        },
        body: JSON.stringify({
          disclaimer: { version, accepted: true },
          operatingMode: "local",
          providerName: "Operator",
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
        }),
      }),
    );
    expect(setup.status).toBe(201);
    ownerCookie = await signIn(OWNER_EMAIL);

    const created = await request(
      "/api/v1/tenants",
      ownerCookie,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ name: "Alpha", slug: "alpha" }),
      },
      undefined,
    );
    expect(created.status).toBe(201);
    tenantId = ((await created.json()) as { id: string }).id;

    // The tenant's own administrator: the owner of the tenant's organisation.
    const [row] = await owner
      .select({ organizationId: tenants.organizationId })
      .from(tenants)
      .where(eq(tenants.id, tenantId));
    const context = await authModule.auth.$context;
    const userId = randomUUID();
    await owner.insert(user).values({
      id: userId,
      name: ADMIN_EMAIL,
      email: ADMIN_EMAIL,
      emailVerified: false,
      role: "user",
    });
    await owner.insert(account).values({
      id: randomUUID(),
      accountId: userId,
      providerId: "credential",
      userId,
      password: await context.password.hash(PASSWORD),
    });
    await owner.insert(member).values({
      id: randomUUID(),
      organizationId: row?.organizationId as string,
      userId,
      role: "owner",
      createdAt: new Date(),
    });
    adminCookie = await signIn(ADMIN_EMAIL);
  }, 120_000);

  afterAll(async () => {
    resetExtensionsForTesting();
    const shared = await import("../../../../apps/api/src/db.js");
    await Promise.all([
      shared.db.$client.end(),
      shared.providerDb.$client.end(),
      shared.authDb.$client.end(),
    ]);
    await owner?.$client.end();
    Reflect.deleteProperty(process.env, "RESTOW_SETUP_TOKEN");
    await dropDatabase(testDatabaseAdminUrl as string, DATABASE);
    await roles?.drop(testDatabaseAdminUrl as string);
  }, 30_000);

  it("shows the provider the prices of the change and a tenant's administrator none", async () => {
    const put = await request(`/api/v1/tenants/${tenantId}/pricing`, ownerCookie, {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ mailboxPrice: 7.77, storagePrice: 3.33 }),
    });
    expect(put.status).toBe(200);

    // The provider reads the change in the tenant's chain, figures included.
    const own = await request(`/api/v1/audit?tenant=${tenantId}`, ownerCookie);
    expect(own.status).toBe(200);
    const items = ((await own.json()) as { items: { id: string; action: string }[] }).items;
    const change = items.find((item) => item.action === "tenant.pricing.updated");
    expect(change).toBeDefined();
    expect(JSON.stringify(change)).toContain("7.77");
    const entryId = change?.id as string;

    // The tenant's administrator reads the same chain, entry and export without them.
    for (const path of [
      "/api/v1/audit",
      `/api/v1/audit/${entryId}`,
      "/api/v1/audit/export?format=json",
      "/api/v1/audit/export?format=csv",
    ]) {
      const response = await request(path, adminCookie, {}, tenantId);
      expect(response.status, path).toBe(200);
      expect(await response.text(), path).not.toMatch(FIGURES);
    }

    // The entry is still there and its hash still checks; only its details are gone.
    const listed = (await (await request("/api/v1/audit", adminCookie, {}, tenantId)).json()) as {
      items: { action: string; details: unknown; hashValid: boolean }[];
    };
    expect(listed.items.find((item) => item.action === "tenant.pricing.updated")).toMatchObject({
      details: null,
      hashValid: true,
    });
  });
});
