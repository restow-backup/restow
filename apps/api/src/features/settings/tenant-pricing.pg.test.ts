/**
 * Postgres-backed test of a tenant's own prices and the price estimate (0.4.8) through the real
 * application (apps/api/src/app.ts), with real sessions on the application and installation roles
 * Row Level Security binds:
 *
 *   - the estimate multiplies the mailboxes (counting rule) and the stored bytes (chunk store plus
 *     repositories, in GB or TB) with the prices, per tenant and summed over the customers; the
 *     operator's own organisation is listed but does not add up;
 *   - a tenant's own price replaces the installation's, 0 included, and null removes it again;
 *   - only the owner changes it, every provider admin reads it, a tenant's own admin neither;
 *   - the change is audited in the tenant's chain with before and after;
 *   - with the gate `tenants.additional` closed a change is refused and what is stored is ignored
 *     everywhere, until the gate opens again;
 *   - a member limited to one tenant gets that tenant's estimate and nothing of the others;
 *   - a tenant being deleted is left out, and a tenant whose figures cannot be read is counted as
 *     missing while the others still add up.
 *
 * Runs when RESTOW_TEST_DATABASE_URL points at a Postgres server; without it the suite is skipped.
 */
import { randomBytes, randomUUID } from "node:crypto";
import {
  account,
  auditLog,
  createDb,
  type Database,
  endpoints,
  member,
  packs,
  protectedObjects,
  providerMembers,
  providerMemberTenants,
  sources,
  tenants,
  twoFactor,
  user,
} from "@restow/db";
import { symmetricDecrypt } from "better-auth/crypto";
import { and, eq } from "drizzle-orm";
import type { Hono } from "hono";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { registerApiExtension, resetExtensionsForTesting } from "../../extensions.js";
import { provisionTestRoles, type TestDatabaseRoles } from "../../testing/database-roles.js";
import {
  dropDatabase,
  recreateDatabase,
  testDatabaseAdminUrl,
} from "../snapshots/testing/explorer-fixture.js";
import type { PricingEstimateDto } from "./pricing-estimate.js";
import type { TenantPricingDto } from "./tenant-pricing.js";

const DATABASE = "restow_api_tenant_pricing_test";
const PUBLIC_URL = "http://localhost:3000";
const OWNER_EMAIL = "owner@example.com";
const PASSWORD = "correct-horse-battery-1";
const SETUP_TOKEN = "7QKMZ-RT4VX-9HBNP-2WCAE";

function one<T>(rows: readonly T[]): T {
  const [first] = rows;
  if (first === undefined) {
    throw new Error("insert returned no row");
  }
  return first;
}

describe.skipIf(!testDatabaseAdminUrl)("a tenant's own prices and the estimate", () => {
  let owner: Database;
  let roles: TestDatabaseRoles | undefined;
  let app: Hono;
  let authModule: typeof import("../../auth.js");
  let ownerCookie: string;
  let alpha: string;
  let beta: string;
  let gamma: string;
  let internalTenant: string;
  let ipCounter = 0;
  /** What the test gate answers for `tenants.additional`. */
  let gateOpen = true;

  function call(
    method: string,
    path: string,
    cookie?: string,
    body?: Record<string, unknown>,
  ): Promise<Response> {
    return Promise.resolve(
      app.fetch(
        new Request(`${PUBLIC_URL}${path}`, {
          method,
          headers: {
            origin: PUBLIC_URL,
            ...(body ? { "content-type": "application/json" } : {}),
            ...(cookie ? { cookie } : {}),
          },
          ...(body ? { body: JSON.stringify(body) } : {}),
        }),
      ),
    );
  }

  const estimate = async (cookie = ownerCookie, query = ""): Promise<PricingEstimateDto> => {
    const response = await call("GET", `/api/v1/settings/pricing/estimate${query}`, cookie);
    expect(response.status).toBe(200);
    return (await response.json()) as PricingEstimateDto;
  };

  const entryOf = (body: PricingEstimateDto, tenantId: string) => {
    const entry = body.tenants.find((tenant) => tenant.tenantId === tenantId);
    if (!entry) {
      throw new Error("the estimate lists no such tenant");
    }
    return entry;
  };

  const setGlobal = (body: Record<string, unknown>) =>
    call("PUT", "/api/v1/settings/pricing", ownerCookie, body);

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

  async function createTenant(name: string): Promise<string> {
    const response = await call("POST", "/api/v1/tenants", ownerCookie, {
      name,
      slug: name.toLowerCase(),
    });
    expect(response.status).toBe(201);
    return ((await response.json()) as { id: string }).id;
  }

  /** `count` active mailboxes, and a site and an excluded mailbox that never count. */
  async function seedMailboxes(tenantId: string, count: number): Promise<void> {
    const source = one(
      await owner
        .insert(sources)
        .values({ tenantId, kind: "m365", name: "M365", status: "active" })
        .returning(),
    ).id;
    const object = (kind: "mailbox" | "site", name: string, status?: "excluded") => ({
      tenantId,
      sourceId: source,
      kind,
      externalId: `${name}@${tenantId}`,
      displayName: name,
      ...(status ? { status } : {}),
    });
    await owner
      .insert(protectedObjects)
      .values([
        ...Array.from({ length: count }, (_, index) => object("mailbox", `user${index}`)),
        object("site", "Team site"),
        object("mailbox", "excluded", "excluded"),
      ]);
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
    // Several tenants and tenant scopes: the gates answer as the test says.
    registerApiExtension({ name: "test-gate", featureGate: { isEnabled: async () => gateOpen } });
    owner = createDb(url);
    ({ app } = await import("../../app.js"));
    authModule = await import("../../auth.js");
    const { DISCLAIMER_VERSION: version } = await import("../../lib/disclaimer.js");

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
    alpha = await createTenant("Alpha");
    beta = await createTenant("Beta");
    gamma = await createTenant("Gamma");
    const [own] = await owner
      .select({ id: tenants.id })
      .from(tenants)
      .where(eq(tenants.kind, "internal"));
    internalTenant = (own as { id: string }).id;

    // Alpha: 2 mailboxes; 3 GB of packs and 1 GB of a machine's repository = 4 GB stored.
    await seedMailboxes(alpha, 2);
    await owner.insert(packs).values({
      tenantId: alpha,
      path: "packs/a",
      sha256: "a".repeat(64),
      size: 3_000_000_000,
    });
    await owner.insert(endpoints).values({
      tenantId: alpha,
      hostname: "web01",
      os: "linux",
      arch: "amd64",
      profile: "server",
      secretHash: randomUUID(),
      config: {} as never,
      repositoryBytes: 1_000_000_000,
    });
    // Beta: 1 mailbox, nothing stored. Gamma: nothing. The own organisation: 1 mailbox.
    await seedMailboxes(beta, 1);
    await seedMailboxes(internalTenant, 1);
  }, 120_000);

  afterAll(async () => {
    resetExtensionsForTesting();
    const shared = await import("../../db.js");
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

  it("answers without amounts while no price is set", async () => {
    const body = await estimate();
    expect(body).toMatchObject({
      currency: "EUR",
      storageUnit: "GB",
      global: { mailboxPrice: null, storagePrice: null },
      perTenantOverrides: true,
      hasPrices: false,
      total: null,
      missing: 0,
    });
    expect(body.tenants.map((entry) => entry.tenantId).sort()).toEqual(
      [alpha, beta, gamma, internalTenant].sort(),
    );
    expect(
      body.tenants.every((entry) => entry.amount.total === null && entry.mailboxes === null),
    ).toBe(true);
    expect(entryOf(body, internalTenant).kind).toBe("internal");
  });

  it("multiplies mailboxes and stored bytes with the installation's prices", async () => {
    expect(
      (await setGlobal({ mailboxPrice: 2, storagePrice: 0.5, storageUnit: "GB" })).status,
    ).toBe(200);
    const body = await estimate();
    expect(body.hasPrices).toBe(true);
    expect(entryOf(body, alpha)).toMatchObject({
      mailboxes: 2,
      storedBytes: 4_000_000_000,
      mailboxPrice: 2,
      storagePrice: 0.5,
      overridden: { mailbox: false, storage: false },
      amount: { mailboxes: 4, storage: 2, total: 6 },
    });
    expect(entryOf(body, beta)).toMatchObject({
      mailboxes: 1,
      storedBytes: 0,
      amount: { mailboxes: 2, storage: 0, total: 2 },
    });
    expect(entryOf(body, gamma).amount).toEqual({ mailboxes: 0, storage: 0, total: 0 });
    // The own organisation is listed with its amount but is no customer: 6 + 2 + 0.
    expect(entryOf(body, internalTenant).amount.total).toBe(2);
    expect(body.total).toBe(8);
    expect(body.missing).toBe(0);
  });

  it("counts the storage in terabytes when the price is per TB", async () => {
    await setGlobal({ storagePrice: 400, storageUnit: "TB" });
    const body = await estimate();
    expect(body.storageUnit).toBe("TB");
    expect(entryOf(body, alpha).amount.storage).toBeCloseTo(1.6, 10);
    expect(entryOf(body, alpha).amount.total).toBeCloseTo(5.6, 10);
    await setGlobal({ storagePrice: 0.5, storageUnit: "GB" });
  });

  it("answers for one tenant, 404 for an unknown one and 422 for a malformed id", async () => {
    const body = await estimate(ownerCookie, `?tenant=${alpha}`);
    expect(body.tenants.map((entry) => entry.tenantId)).toEqual([alpha]);
    expect(body.total).toBe(6);
    // Asked for itself, the own organisation answers for itself.
    expect((await estimate(ownerCookie, `?tenant=${internalTenant}`)).total).toBe(2);
    expect(
      (await call("GET", `/api/v1/settings/pricing/estimate?tenant=${randomUUID()}`, ownerCookie))
        .status,
    ).toBe(404);
    expect(
      (await call("GET", "/api/v1/settings/pricing/estimate?tenant=nope", ownerCookie)).status,
    ).toBe(422);
  });

  it("refuses the estimate and the tenant's prices to anyone who is not a provider admin", async () => {
    expect((await call("GET", "/api/v1/settings/pricing/estimate")).status).toBe(401);
    const adminId = await createAccount("alpha-admin@example.com", "user");
    const [row] = await owner
      .select({ organizationId: tenants.organizationId })
      .from(tenants)
      .where(eq(tenants.id, alpha));
    await owner.insert(member).values({
      id: randomUUID(),
      organizationId: row?.organizationId as string,
      userId: adminId,
      role: "owner",
      createdAt: new Date(),
    });
    const cookie = await signIn("alpha-admin@example.com");
    expect((await call("GET", "/api/v1/settings/pricing/estimate", cookie)).status).toBe(403);
    expect((await call("GET", `/api/v1/tenants/${alpha}/pricing`, cookie)).status).toBe(403);
    expect(
      (await call("PUT", `/api/v1/tenants/${alpha}/pricing`, cookie, { mailboxPrice: 1 })).status,
    ).toBe(403);
    // The tenant's own page data does not carry the price either.
    expect(
      JSON.stringify(await (await call("GET", `/api/v1/tenants/${alpha}`, cookie)).json()),
    ).not.toMatch(/pric/i);
  });

  it("gives a tenant's administrator and end user no price from any other route either", async () => {
    // Prices are set (mailbox 2, storage 0.5 and Alpha's amount of 6 above): none may show up in
    // what a tenant's people read, whatever the route. The provider-only routes are refused.
    const [row] = await owner
      .select({ organizationId: tenants.organizationId })
      .from(tenants)
      .where(eq(tenants.id, alpha));
    const organizationId = row?.organizationId as string;
    const people = [
      ["owner", "alpha-owner@example.com"],
      ["member", "alpha-user@example.com"],
    ] as const;
    for (const [role, email] of people) {
      const userId = await createAccount(email, "user");
      await owner.insert(member).values({
        id: randomUUID(),
        organizationId,
        userId,
        role,
        createdAt: new Date(),
      });
      const cookie = await signIn(email);
      for (const [method, path, body] of [
        ["GET", "/api/v1/settings/pricing"],
        ["PUT", "/api/v1/settings/pricing", { mailboxPrice: 1 }],
        ["GET", "/api/v1/settings/pricing/estimate"],
        ["GET", `/api/v1/settings/pricing/estimate?tenant=${alpha}`],
        ["GET", `/api/v1/tenants/${alpha}/pricing`],
        ["PUT", `/api/v1/tenants/${alpha}/pricing`, { storagePrice: 1 }],
        ["GET", "/api/v1/usage"],
        ["GET", "/api/v1/settings"],
      ] as const) {
        const response = await call(method, path, cookie, body);
        expect(response.status, `${role}: ${method} ${path}`).toBe(403);
        expect(await response.text()).not.toMatch(/mailboxPrice|storagePrice|"amount"/);
      }
      // What a tenant's person may read carries no price field, no amount and no estimate.
      for (const path of ["/api/v1/me", "/api/v1/tenant", "/api/v1/dashboard", "/api/v1/stats"]) {
        const response = await app.fetch(
          new Request(`${PUBLIC_URL}${path}`, {
            headers: { origin: PUBLIC_URL, cookie, "x-restow-tenant": alpha },
          }),
        );
        expect(response.status, `${role}: GET ${path}`).toBeLessThan(500);
        expect(await response.text(), `${role}: GET ${path}`).not.toMatch(
          /mailboxPrice|storagePrice|pricing|"amount"|estimate/i,
        );
      }
    }
  });

  it("lets only the owner set a tenant's own prices, and any provider admin read them", async () => {
    const adminId = await createAccount("administrator@example.com", "admin");
    await owner
      .insert(providerMembers)
      .values({ userId: adminId, role: "administrator", allTenants: true });
    const administrator = await signIn("administrator@example.com");

    const read = await call("GET", `/api/v1/tenants/${alpha}/pricing`, administrator);
    expect(read.status).toBe(200);
    expect((await read.json()) as TenantPricingDto).toEqual({
      tenantId: alpha,
      currency: "EUR",
      storageUnit: "GB",
      overridesEnabled: true,
      global: { mailboxPrice: 2, storagePrice: 0.5 },
      overrides: { mailboxPrice: null, storagePrice: null },
      effective: { mailboxPrice: 2, storagePrice: 0.5 },
    });
    expect(
      (await call("PUT", `/api/v1/tenants/${alpha}/pricing`, administrator, { mailboxPrice: 1 }))
        .status,
    ).toBe(403);
    expect((await call("GET", `/api/v1/tenants/${alpha}/pricing`, ownerCookie)).status).toBe(200);
  });

  it("sets, frees and removes a tenant's own prices, and audits each change", async () => {
    const put = (body: Record<string, unknown>) =>
      call("PUT", `/api/v1/tenants/${alpha}/pricing`, ownerCookie, body);

    const first = await put({ mailboxPrice: 1.5 });
    expect(first.status).toBe(200);
    expect((await first.json()) as TenantPricingDto).toMatchObject({
      overrides: { mailboxPrice: 1.5, storagePrice: null },
      effective: { mailboxPrice: 1.5, storagePrice: 0.5 },
    });
    let body = await estimate();
    expect(entryOf(body, alpha)).toMatchObject({
      mailboxPrice: 1.5,
      overridden: { mailbox: true, storage: false },
      amount: { mailboxes: 3, storage: 2, total: 5 },
    });
    // The other tenants keep the installation's prices.
    expect(entryOf(body, beta).overridden).toEqual({ mailbox: false, storage: false });

    // A free storage (0) is a price of its own, not "none"; what is left out stays.
    await put({ storagePrice: 0 });
    body = await estimate();
    expect(entryOf(body, alpha)).toMatchObject({
      mailboxPrice: 1.5,
      storagePrice: 0,
      overridden: { mailbox: true, storage: true },
      amount: { mailboxes: 3, storage: 0, total: 3 },
    });
    expect(body.total).toBe(3 + 2 + 0);

    // null removes the override: the installation's price applies again.
    await put({ mailboxPrice: null, storagePrice: null });
    body = await estimate();
    expect(entryOf(body, alpha)).toMatchObject({
      mailboxPrice: 2,
      overridden: { mailbox: false, storage: false },
      amount: { total: 6 },
    });
    expect(
      (
        await owner.select({ pricing: tenants.pricing }).from(tenants).where(eq(tenants.id, alpha))
      )[0]?.pricing,
    ).toEqual({});

    // The audit chain of the tenant names before and after of every change.
    const entries = (
      await owner
        .select()
        .from(auditLog)
        .where(and(eq(auditLog.action, "tenant.pricing.updated"), eq(auditLog.tenantId, alpha)))
    ).sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime());
    expect(entries.map((entry) => entry.details)).toEqual([
      { before: {}, after: { mailboxPrice: 1.5 } },
      { before: { mailboxPrice: 1.5 }, after: { mailboxPrice: 1.5, storagePrice: 0 } },
      { before: { mailboxPrice: 1.5, storagePrice: 0 }, after: {} },
    ]);
    expect(entries[0]).toMatchObject({
      actor: OWNER_EMAIL,
      target: alpha,
      targetType: "tenant",
    });
  });

  it("refuses prices that are not prices, an unknown tenant and a tenant being deleted", async () => {
    const put = (id: string, body: Record<string, unknown>) =>
      call("PUT", `/api/v1/tenants/${id}/pricing`, ownerCookie, body);
    expect((await put(alpha, { mailboxPrice: -1 })).status).toBe(422);
    expect((await put(alpha, { storagePrice: 0.12345 })).status).toBe(422);
    expect((await put(alpha, { currency: "CHF" })).status).toBe(422);
    expect((await put(randomUUID(), { mailboxPrice: 1 })).status).toBe(404);
    expect((await call("GET", `/api/v1/tenants/${randomUUID()}/pricing`, ownerCookie)).status).toBe(
      404,
    );
    const doomed = await createTenant("Doomed");
    await owner.update(tenants).set({ status: "deleting" }).where(eq(tenants.id, doomed));
    expect((await put(doomed, { mailboxPrice: 1 })).status).toBe(409);
    // A tenant being deleted is not listed in the estimate either.
    expect((await estimate()).tenants.some((entry) => entry.tenantId === doomed)).toBe(false);
  });

  it("refuses a change and ignores what is stored while the gate is closed", async () => {
    const put = (body: Record<string, unknown>) =>
      call("PUT", `/api/v1/tenants/${alpha}/pricing`, ownerCookie, body);
    expect((await put({ mailboxPrice: 1 })).status).toBe(200);
    expect(entryOf(await estimate(), alpha).amount.total).toBe(1 * 2 + 2);

    gateOpen = false;
    try {
      const refused = await put({ mailboxPrice: 0.5 });
      expect(refused.status).toBe(403);
      expect(((await refused.json()) as { type: string }).type).toBe(
        "urn:restow:problem:feature-unavailable",
      );
      // The gate comes before the body: a malformed one is refused the same way.
      expect((await put({ mailboxPrice: -1 })).status).toBe(403);

      const body = await estimate();
      expect(body.perTenantOverrides).toBe(false);
      expect(entryOf(body, alpha)).toMatchObject({
        mailboxPrice: 2,
        overridden: { mailbox: false, storage: false },
        amount: { total: 6 },
      });
      expect(body.total).toBe(8);
      const read = (await (
        await call("GET", `/api/v1/tenants/${alpha}/pricing`, ownerCookie)
      ).json()) as TenantPricingDto;
      expect(read).toMatchObject({
        overridesEnabled: false,
        overrides: { mailboxPrice: null, storagePrice: null },
        effective: { mailboxPrice: 2 },
      });
    } finally {
      gateOpen = true;
    }
    // Stored, not lost: with the gate open again the override applies again.
    expect(entryOf(await estimate(), alpha).mailboxPrice).toBe(1);
    await put({ mailboxPrice: null });
    // The refused changes left no audit entry.
    expect(
      await owner
        .select()
        .from(auditLog)
        .where(and(eq(auditLog.action, "tenant.pricing.updated"), eq(auditLog.tenantId, alpha))),
    ).toHaveLength(5);
  });

  it("shows a member limited to one tenant that tenant only", async () => {
    const userId = await createAccount("tech-beta@example.com", "admin");
    await owner.insert(providerMembers).values({ userId, role: "read_only", allTenants: false });
    await owner.insert(providerMemberTenants).values({ userId, tenantId: beta });
    const cookie = await signIn("tech-beta@example.com");

    const body = await estimate(cookie);
    expect(body.tenants.map((entry) => entry.tenantId)).toEqual([beta]);
    expect(body.total).toBe(2);
    // Alpha's figures are not theirs to see, by list, by tenant or by its own prices.
    expect(
      (await call("GET", `/api/v1/settings/pricing/estimate?tenant=${alpha}`, cookie)).status,
    ).toBe(404);
    expect((await call("GET", `/api/v1/tenants/${alpha}/pricing`, cookie)).status).toBe(403);
    expect((await call("GET", `/api/v1/tenants/${beta}/pricing`, cookie)).status).toBe(200);
    expect(
      (await call("PUT", `/api/v1/tenants/${beta}/pricing`, cookie, { mailboxPrice: 1 })).status,
    ).toBe(403);
  });

  it("counts a tenant whose figures cannot be read as missing and adds up the others", async () => {
    const shared = await import("../../db.js");
    const { loadPricingEstimate } = await import("./pricing-estimate.js");
    let reads = 0;
    // The first tenant read (Alpha, by name) fails; the others read as usual.
    const flaky = new Proxy(shared.db, {
      get(target, property, receiver) {
        if (property === "transaction") {
          return (...args: Parameters<Database["transaction"]>) => {
            reads += 1;
            return reads === 1 ? Promise.reject(new Error("boom")) : target.transaction(...args);
          };
        }
        return Reflect.get(target, property, receiver);
      },
    });
    const logged = vi.spyOn(console, "error").mockImplementation(() => undefined);
    try {
      const body = await loadPricingEstimate({ db: flaky, providerDb: shared.providerDb }, null);
      expect(entryOf(body, alpha)).toMatchObject({
        mailboxes: null,
        storedBytes: null,
        amount: { mailboxes: null, storage: null, total: null },
      });
      expect(body.missing).toBe(1);
      // Beta 2 + Gamma 0; Alpha has no total, the own organisation does not count.
      expect(body.total).toBe(2);
      expect(logged).toHaveBeenCalledTimes(1);
      expect(String(logged.mock.calls[0]?.[0])).not.toContain('boom"x');
    } finally {
      logged.mockRestore();
    }
  });

  it("reads on the application role, which Row Level Security binds", async () => {
    const shared = await import("../../db.js");
    // Unpinned, the pool the figures are read on sees no tenant's packs at all.
    expect(await shared.db.select().from(packs)).toHaveLength(0);
    expect((await owner.select().from(packs)).length).toBe(1);
  });
});
