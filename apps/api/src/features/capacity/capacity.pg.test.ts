/**
 * Postgres-backed test of the capacity page (0.5.0): GET /api/v1/capacity and
 * GET /api/v1/capacity/:tenantId, in two parts that share one database.
 *
 * The figures are read through `loadCapacity` and `loadTenantCapacity` on the provisioned
 * application and installation roles (Row Level Security binds the first), with a fixed clock and
 * a fake filesystem, so that the arithmetic is exact:
 *
 *   - used bytes are the chunk store plus the restic repositories (the dashboard's physical bytes);
 *   - growth per day over 7, 30 and 90 days comes from the daily size samples once they span a
 *     week, until then from the pack dates; a horizon the history does not reach is null;
 *   - the day a repository runs full is given only for a local repository whose free space is
 *     known and that the tenant has to itself, and is withheld while the history of the pack dates
 *     does not count the machines written there; S3 and the shared default have none;
 *   - the machine and file share quotas give their levels; the chunk store has none;
 *   - the all-tenants list needs the gate `dashboard.allTenants`, without it the oldest tenant
 *     alone is listed; a member limited to some tenants gets those and cannot open another's
 *     repositories; tenants being deleted are left out;
 *   - a tenant whose figures cannot be read is counted as missing while the others still add up;
 *   - the figures of a tenant are kept for a short while.
 *
 * The route itself runs through the real application with real sessions: provider admins only,
 * the scope of a limited member, and the same answers as the service.
 *
 * Runs when RESTOW_TEST_DATABASE_URL points at a Postgres server; without it the suite is skipped.
 */
import { randomBytes, randomUUID } from "node:crypto";
import { GIB } from "@restow/core";
import {
  account,
  createDb,
  type Database,
  endpoints,
  fileShares,
  member,
  packs,
  providerMembers,
  providerMemberTenants,
  pveClusters,
  pveGuests,
  settings,
  storageSamples,
  storageTargets,
  tenants,
  twoFactor,
  user,
} from "@restow/db";
import { symmetricDecrypt } from "better-auth/crypto";
import { eq } from "drizzle-orm";
import type { Hono } from "hono";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { registerApiExtension, resetExtensionsForTesting } from "../../extensions.js";
import type { ProviderAccess } from "../../lib/provider-access.js";
import { provisionTestRoles, type TestDatabaseRoles } from "../../testing/database-roles.js";
import {
  dropDatabase,
  recreateDatabase,
  testDatabaseAdminUrl,
} from "../snapshots/testing/explorer-fixture.js";
import { TenantFiguresCache } from "../tenant-jobs/figures-cache.js";
import type { CapacityDto, CapacityTenantDetailDto, CapacityTenantDto } from "./dto.js";
import type { CapacityDeps, TenantFigures } from "./service.js";

const DATABASE = "restow_api_capacity_test";
const PUBLIC_URL = "http://localhost:3000";
const OWNER_EMAIL = "owner@example.com";
const PASSWORD = "correct-horse-battery-1";
const SETUP_TOKEN = "7QKMZ-RT4VX-9HBNP-2WCAE";
const DAY = 24 * 60 * 60 * 1000;

/** The service's clock: noon (UTC) on a fixed day. */
const NOW = new Date("2026-10-30T12:00:00.000Z");
const dayKey = (date: Date) => date.toISOString().slice(0, 10);
const daysAgo = (days: number) => new Date(NOW.getTime() - days * DAY);

/** The free space the fake filesystem reports per repository path. */
const SPACE: Record<string, { freeBytes: number; totalBytes: number }> = {
  "/mnt/alpha": { freeBytes: 1e12, totalBytes: 2e12 },
  "/mnt/eta": { freeBytes: 1000, totalBytes: 5e12 },
  "/mnt/zeta": { freeBytes: 1e12, totalBytes: 2e12 },
  "/data/chunks": { freeBytes: 9e12, totalBytes: 9e12 },
};

function one<T>(rows: readonly T[]): T {
  const [first] = rows;
  if (first === undefined) {
    throw new Error("insert returned no row");
  }
  return first;
}

describe.skipIf(!testDatabaseAdminUrl)("the capacity page", () => {
  let owner: Database;
  let appDb: Database;
  let installationDb: Database;
  let roles: TestDatabaseRoles | undefined;
  let app: Hono;
  let authModule: typeof import("../../auth.js");
  // Imported once the environment is set: the module reaches the API's shared pools.
  let service: typeof import("./service.js");
  let ownerCookie: string;
  let ipCounter = 0;
  /** What the test gate answers for `dashboard.allTenants`; every other gated function is open. */
  let allTenantsOpen = true;

  let internalTenant: string;
  let alpha: string;
  let beta: string;
  let gamma: string;
  let delta: string;
  let eta: string;
  let zeta: string;
  let leaving: string;
  const machine: Record<string, string> = {};

  const everyone: ProviderAccess | null = null;
  const limitedTo = (...tenantIds: string[]): ProviderAccess => ({
    role: "administrator",
    allTenants: false,
    tenantIds: new Set(tenantIds),
  });

  const deps = (extra: Partial<CapacityDeps> = {}): CapacityDeps => ({
    db: appDb,
    providerDb: installationDb,
    env: { STORAGE_TARGET: "local", STORAGE_LOCAL_PATH: "/data/chunks" },
    filesystemSpace: async (path) => SPACE[path] ?? null,
    quotaLimits: { endpointBytes: 100 * GIB, tenantBytes: 200e9 },
    now: () => NOW,
    ...extra,
  });

  const capacity = (access: ProviderAccess | null = everyone, extra: Partial<CapacityDeps> = {}) =>
    service.loadCapacity(deps(extra), access);

  const entry = (body: CapacityDto, tenantId: string): CapacityTenantDto => {
    const found = body.tenants.find((tenant) => tenant.tenantId === tenantId);
    if (!found) {
      throw new Error("the answer lists no such tenant");
    }
    return found;
  };

  function call(method: string, path: string, cookie?: string): Promise<Response> {
    return Promise.resolve(
      app.fetch(
        new Request(`${PUBLIC_URL}${path}`, {
          method,
          headers: { origin: PUBLIC_URL, ...(cookie ? { cookie } : {}) },
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
    const response = await app.fetch(
      new Request(`${PUBLIC_URL}/api/v1/tenants`, {
        method: "POST",
        headers: { origin: PUBLIC_URL, "content-type": "application/json", cookie: ownerCookie },
        body: JSON.stringify({ name, slug: name.toLowerCase() }),
      }),
    );
    expect(response.status).toBe(201);
    return ((await response.json()) as { id: string }).id;
  }

  /** One sample row per day for `count` days ending today, `at(i)` bytes `i` days ago. */
  async function sample(
    tenantId: string,
    kind: "chunk_store" | "endpoint",
    sourceId: string | null,
    count: number,
    at: (daysBack: number) => number,
  ) {
    await owner.insert(storageSamples).values(
      Array.from({ length: count }, (_, daysBack) => ({
        tenantId,
        sourceKind: kind,
        sourceId,
        day: dayKey(daysAgo(daysBack)),
        bytes: at(daysBack),
      })),
    );
  }

  const target = (tenantId: string, kind: "local" | "s3", config: Record<string, unknown>) =>
    owner.insert(storageTargets).values({
      tenantId,
      kind,
      role: "primary",
      config: config as never,
      status: "ok",
      bytesUsed: 123,
    });

  const pack = (tenantId: string, path: string, size: number, createdAt: Date) =>
    owner.insert(packs).values({ tenantId, path, sha256: "a".repeat(64), size, createdAt });

  const machineRow = (tenantId: string, hostname: string, extra: Record<string, unknown> = {}) =>
    owner
      .insert(endpoints)
      .values({
        tenantId,
        hostname,
        os: "linux",
        arch: "amd64",
        profile: "server",
        secretHash: randomUUID(),
        config: {} as never,
        ...extra,
      })
      .returning({ id: endpoints.id })
      .then((rows) => one(rows).id);

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
      featureGate: {
        isEnabled: async (_db, feature) =>
          feature === "dashboard.allTenants" ? allTenantsOpen : true,
      },
    });
    owner = createDb(url);
    appDb = createDb(roles.appUrl);
    installationDb = createDb(roles.providerUrl);
    service = await import("./service.js");
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
    delta = await createTenant("Delta");
    eta = await createTenant("Eta");
    zeta = await createTenant("Zeta");
    leaving = await createTenant("Leaving");
    await owner.update(tenants).set({ status: "deleting" }).where(eq(tenants.id, leaving));
    const [own] = await owner
      .select({ id: tenants.id })
      .from(tenants)
      .where(eq(tenants.kind, "internal"));
    internalTenant = (own as { id: string }).id;

    // Alpha: a local repository of its own; 60 GB of packs and a machine with 40 GB; 30 days of
    // samples, the total 2 GB more every day (100 GB today).
    await target(alpha, "local", { basePath: "/mnt/alpha" });
    await pack(alpha, "p/1", 60e9, daysAgo(200));
    machine.web01 = await machineRow(alpha, "web01", {
      repositoryBytes: 40e9,
      settings: { quotaGib: 45 },
    });
    machine.web02 = await machineRow(alpha, "web02");
    await sample(alpha, "chunk_store", null, 30, (back) => 60e9 - 1e9 * back);
    await sample(alpha, "endpoint", machine.web01, 30, (back) => 40e9 - 1e9 * back);

    // Beta: an S3 bucket; packs written 120, 40 and 3 days ago (10 GB each); a file share at
    // 9.5 of its 10 GiB.
    await target(beta, "s3", { bucket: "beta-bucket", region: "eu-central-1" });
    await pack(beta, "p/1", 10e9, daysAgo(120));
    await pack(beta, "p/2", 10e9, daysAgo(40));
    await pack(beta, "p/3", 10e9, daysAgo(3));
    await owner.insert(fileShares).values({
      tenantId: beta,
      name: "Office",
      protocol: "smb",
      server: "nas.example",
      repositoryBytes: 9.5 * GIB,
      quotaGib: 10,
    });

    // Gamma and Delta keep their data on the installation default together.
    await pack(gamma, "p/1", 5e9, daysAgo(10));
    // Eta: a local repository of its own with 1000 bytes left; packs 60 and 10 days old.
    await target(eta, "local", { basePath: "/mnt/eta" });
    await pack(eta, "p/1", 20e9, daysAgo(60));
    await pack(eta, "p/2", 10e9, daysAgo(10));
    // Zeta: the same, but a machine writes to it as well, and there are no samples.
    await target(zeta, "local", { basePath: "/mnt/zeta" });
    await pack(zeta, "p/1", 10e9, daysAgo(30));
    await pack(zeta, "p/2", 5e9, daysAgo(5));
    machine.zeta = await machineRow(zeta, "db01", { repositoryBytes: 2e9 });
    const cluster = one(
      await owner
        .insert(pveClusters)
        .values({ tenantId: zeta, name: "lab", fingerprint: "fp-capacity", storageId: "restow" })
        .returning({ id: pveClusters.id }),
    );
    await owner.insert(pveGuests).values({
      tenantId: zeta,
      clusterId: cluster.id,
      vmid: 101,
      kind: "vm",
      name: "web",
      repositoryBytes: 1e9,
    });
  }, 120_000);

  afterAll(async () => {
    resetExtensionsForTesting();
    const shared = await import("../../db.js");
    await Promise.all([
      shared.db.$client.end(),
      shared.providerDb.$client.end(),
      shared.authDb.$client.end(),
    ]);
    await Promise.all([owner?.$client.end(), appDb?.$client.end(), installationDb?.$client.end()]);
    Reflect.deleteProperty(process.env, "RESTOW_SETUP_TOKEN");
    await dropDatabase(testDatabaseAdminUrl as string, DATABASE);
    await roles?.drop(testDatabaseAdminUrl as string);
  }, 30_000);

  it("lists the tenants that are not being deleted, with what each stores", async () => {
    const body = await capacity();
    expect(body).toMatchObject({ scope: "all", missing: 0, generatedAt: NOW.toISOString() });
    expect(body.tenants.map((tenant) => tenant.tenantId).sort()).toEqual(
      [internalTenant, alpha, beta, gamma, delta, eta, zeta].sort(),
    );
    expect(body.tenants.map((tenant) => tenant.name)).toEqual(
      [...body.tenants.map((tenant) => tenant.name)].sort((a, b) => a.localeCompare(b)),
    );
    expect(entry(body, internalTenant)).toMatchObject({ kind: "internal", usedBytes: 0 });
    // The chunk store and the restic repositories, as the dashboard's physical bytes.
    expect(entry(body, alpha)).toMatchObject({
      usedBytes: 100e9,
      chunkStoreBytes: 60e9,
      repositoryBytes: 40e9,
      repositories: { machines: 2, fileShares: 0, guests: 0 },
    });
    expect(entry(body, beta)).toMatchObject({
      usedBytes: 30e9 + 9.5 * GIB,
      chunkStoreBytes: 30e9,
      repositories: { machines: 0, fileShares: 1, guests: 0 },
    });
    expect(entry(body, zeta)).toMatchObject({
      usedBytes: 15e9 + 2e9 + 1e9,
      repositoryBytes: 3e9,
      repositories: { machines: 1, fileShares: 0, guests: 1 },
    });
  });

  it("reads the growth of a tenant with a week of samples from the samples", async () => {
    const alphaFigures = entry(await capacity(), alpha);
    expect(alphaFigures).toMatchObject({
      basis: "samples",
      historyDays: 30,
      // 2 GB a day; the samples reach back 29 days, so neither 30 nor 90 days.
      growth: { days7: 2e9, days30: null, days90: null },
      forecast: { slopeBytesPerDay: 2e9, band: null },
    });
  });

  it("falls back to the pack dates until a week of samples exists", async () => {
    const betaFigures = entry(await capacity(), beta);
    expect(betaFigures.basis).toBe("packs");
    // 30 GB now; 20 GB at the end of the day 7 and 30 days ago; 10 GB 90 days ago.
    expect(betaFigures.growth).toEqual({
      days7: Math.round(10e9 / 7),
      days30: Math.round(10e9 / 30),
      days90: Math.round(20e9 / 90),
    });
    // Gamma's only pack is 10 days old: a week of it is flat, a month is not there yet.
    expect(entry(await capacity(), gamma).growth).toEqual({
      days7: 0,
      days30: null,
      days90: null,
    });
    expect(entry(await capacity(), delta)).toMatchObject({
      basis: "none",
      historyDays: 0,
      growth: { days7: null, days30: null, days90: null },
      forecast: null,
      full: null,
    });
  });

  it("dates when a local repository runs full, and only there", async () => {
    const body = await capacity();
    const alphaFigures = entry(body, alpha);
    // 1 TB free at 2 GB a day: 500 days.
    expect(alphaFigures.limit).toEqual({
      kind: "filesystem",
      freeBytes: 1e12,
      totalBytes: 2e12,
      dateWithheld: null,
    });
    expect(alphaFigures.full).toMatchObject({
      estimate: dayKey(new Date(NOW.getTime() + 500 * DAY)),
      estimateInDays: 500,
      nearestInDays: 500,
    });
    // Eta has 1000 bytes left on a repository it has to itself: full the next day.
    const etaFigures = entry(body, eta);
    expect(etaFigures.basis).toBe("packs");
    expect(etaFigures.limit.kind).toBe("filesystem");
    expect(etaFigures.full).toMatchObject({ estimateInDays: 1, nearestInDays: 1 });
    // S3 has no limit to read, and the default is shared by Gamma and Delta.
    expect(entry(body, beta)).toMatchObject({ limit: { kind: "s3", freeBytes: null }, full: null });
    expect(entry(body, gamma)).toMatchObject({
      limit: { kind: "shared_default", freeBytes: null },
      full: null,
    });
    expect(entry(body, delta).limit.kind).toBe("shared_default");
  });

  it("withholds the day while machines write to the repository that the pack dates do not count", async () => {
    const zetaFigures = entry(await capacity(), zeta);
    expect(zetaFigures.basis).toBe("packs");
    expect(zetaFigures.limit).toMatchObject({ kind: "filesystem", dateWithheld: "other_data" });
    expect(zetaFigures.full).toBeNull();
    // The estimate itself is still given.
    expect(zetaFigures.forecast?.slopeBytesPerDay).toBeGreaterThan(0);
  });

  it("gives the default to a tenant that has it to itself", async () => {
    // Delta alone on the default once Gamma and the own organisation have a repository each.
    await target(gamma, "local", { basePath: "/mnt/gamma" });
    await target(internalTenant, "local", { basePath: "/mnt/own" });
    try {
      const body = await capacity();
      expect(entry(body, delta).limit).toMatchObject({
        kind: "filesystem",
        freeBytes: 9e12,
        totalBytes: 9e12,
      });
      // Gamma's own path has no filesystem the fake knows: the space cannot be read.
      expect(entry(body, gamma).limit.kind).toBe("unknown");
    } finally {
      await owner.delete(storageTargets).where(eq(storageTargets.tenantId, gamma));
      await owner.delete(storageTargets).where(eq(storageTargets.tenantId, internalTenant));
    }
  });

  it("judges the machine and file share quotas, and the chunk store has none", async () => {
    const body = await capacity();
    // web01 is at 40 of its own 45 GiB (83 percent), the tenant at 40 of 200 GB.
    expect(entry(body, alpha)).toMatchObject({
      quotaLevel: "ok",
      quotas: [
        { scope: "endpoints", usedBytes: 40e9, budgetBytes: 200e9, level: "ok", percent: 20 },
      ],
    });
    // The share is at 9.5 of its 10 GiB: near.
    expect(entry(body, beta)).toMatchObject({
      quotaLevel: "near",
      quotas: [{ scope: "file_shares", usedBytes: 9.5 * GIB, level: "near", percent: null }],
    });
    expect(entry(body, delta).quotas).toEqual([]);
    expect(entry(body, delta).quotaLevel).toBe("ok");
  });

  it("adds the installation's figures on top", async () => {
    await owner.update(settings).set({
      diskAlerts: {
        system: {
          freeBytes: 80e9,
          totalBytes: 200e9,
          samples: [
            { at: "2026-10-28T12:00:00.000Z", freeBytes: 120e9 },
            { at: "2026-10-29T12:00:00.000Z", freeBytes: 100e9 },
            { at: "2026-10-30T12:00:00.000Z", freeBytes: 80e9 },
          ],
        } as never,
      },
    });
    const body = await capacity();
    const stored = body.tenants.reduce((sum, tenant) => sum + (tenant.usedBytes ?? 0), 0);
    expect(body.kpis).toMatchObject({
      totalBytes: stored,
      tenantsNearQuota: 1,
      tenantsNearFull: 1,
    });
    // The 30-day figure where there is one, else the 7-day one: Alpha 2 GB, Beta, Gamma, Eta, Zeta.
    const rates = body.tenants
      .map((tenant) => tenant.growth.days30 ?? tenant.growth.days7)
      .filter((rate): rate is number => rate !== null);
    expect(body.kpis.growthBytesPerDay).toBe(rates.reduce((sum, rate) => sum + rate, 0));
    expect(body.kpis.growthTenants).toBe(rates.length);
    // The system disk loses 20 GB a day: 80 GB are gone in 4 days, before Eta's tomorrow? No: Eta's
    // 1 day is the nearer.
    expect(body.kpis.systemDisk).toMatchObject({
      freeBytes: 80e9,
      totalBytes: 200e9,
      trend: { bytesPerDay: -20e9 },
    });
    expect(body.kpis.earliestFull).toMatchObject({ tenantId: eta, name: "Eta", inDays: 1 });
  });

  it("names the system disk when it runs full before any repository", async () => {
    await owner.update(settings).set({
      diskAlerts: {
        system: {
          freeBytes: 1000,
          totalBytes: 200e9,
          samples: [
            { at: "2026-10-29T12:00:00.000Z", freeBytes: 1000 + 0.5e9 },
            { at: "2026-10-30T12:00:00.000Z", freeBytes: 1000 },
          ],
        } as never,
      },
    });
    // Free space gone within the day at 0.5 GB a day: the disk is the earliest, not a tenant.
    const body = await capacity();
    expect(body.kpis.earliestFull).toMatchObject({ tenantId: null, name: null });
    expect(body.kpis.earliestFull?.inDays).toBeLessThanOrEqual(1);
    await owner.update(settings).set({ diskAlerts: {} });
    expect((await capacity()).kpis.systemDisk).toBeNull();
  });

  it("lists a member limited to some tenants those, and opens no other tenant's repositories", async () => {
    const body = await capacity(limitedTo(alpha, beta));
    expect(body.tenants.map((tenant) => tenant.tenantId).sort()).toEqual([alpha, beta].sort());
    expect(body.kpis.totalBytes).toBe(100e9 + 30e9 + 9.5 * GIB);
    await expect(
      service.loadTenantCapacity(deps(), limitedTo(alpha, beta), gamma),
    ).rejects.toMatchObject({
      status: 404,
    });
    expect((await service.loadTenantCapacity(deps(), limitedTo(alpha, beta), alpha)).tenantId).toBe(
      alpha,
    );
  });

  it("lists the oldest tenant alone while the all-tenants view is closed", async () => {
    allTenantsOpen = false;
    try {
      const body = await capacity();
      expect(body.scope).toBe("tenant");
      expect(body.tenants.map((tenant) => tenant.tenantId)).toEqual([internalTenant]);
      expect(body.kpis.totalBytes).toBe(0);
      // A limited member gets the oldest of the tenants they may enter.
      const limited = await capacity(limitedTo(beta, alpha));
      expect(limited.tenants.map((tenant) => tenant.tenantId)).toEqual([alpha]);
      // The repositories of another tenant are not open either.
      await expect(service.loadTenantCapacity(deps(), everyone, alpha)).rejects.toMatchObject({
        status: 404,
      });
      expect((await service.loadTenantCapacity(deps(), everyone, internalTenant)).tenantId).toBe(
        internalTenant,
      );
    } finally {
      allTenantsOpen = true;
    }
  });

  it("counts a tenant whose figures cannot be read as missing while the others still add up", async () => {
    const quiet = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      const flaky = Object.create(appDb) as Database;
      Object.assign(flaky, {
        transaction: (fn: (tx: never) => Promise<unknown>, config?: never) =>
          appDb.transaction(async (tx) => {
            const wrapped = Object.create(tx);
            wrapped.execute = (query: { queryChunks?: unknown[] }) => {
              const pinsBeta = query.queryChunks?.some((chunk) => chunk === beta);
              if (pinsBeta) {
                throw new Error("the database went away");
              }
              return tx.execute(query as never);
            };
            return fn(wrapped as never);
          }, config),
      });
      const body = await capacity(everyone, { db: flaky });
      expect(body.missing).toBe(1);
      expect(entry(body, beta)).toMatchObject({ state: "error", usedBytes: null, basis: "none" });
      expect(entry(body, alpha)).toMatchObject({ state: "ok", usedBytes: 100e9 });
      expect(body.kpis.totalBytes).toBeGreaterThan(100e9);
      // The failure is logged with the tenant, not with the failed query.
      const logged = quiet.mock.calls.map((call) => String(call[0]));
      expect(
        logged.some((line) => line.includes("capacity figures read failed") && line.includes(beta)),
      ).toBe(true);
    } finally {
      quiet.mockRestore();
    }
  });

  it("keeps a tenant's figures for a short while", async () => {
    let clock = 1_000_000;
    const cache = new TenantFiguresCache<TenantFigures>(30_000, () => clock);
    const before = entry(await capacity(everyone, { cache }), delta);
    expect(before.usedBytes).toBe(0);
    await pack(delta, "p/late", 777, daysAgo(0));
    try {
      clock += 10_000;
      expect(entry(await capacity(everyone, { cache }), delta).usedBytes).toBe(0);
      clock += 30_000;
      expect(entry(await capacity(everyone, { cache }), delta).usedBytes).toBe(777);
    } finally {
      await owner.delete(packs).where(eq(packs.tenantId, delta));
    }
  });

  describe("a tenant's repositories", () => {
    const detail = (tenantId: string, access: ProviderAccess | null = everyone) =>
      service.loadTenantCapacity(deps(), access, tenantId);

    it("lists the targets, machines, file shares and containers with used bytes, budget and level", async () => {
      const body = await detail(alpha);
      expect(body.defaultRepository).toBe(false);
      expect(body.targets).toEqual([
        {
          id: expect.any(String),
          name: null,
          role: "primary",
          kind: "local",
          status: "ok",
          usedBytes: 123,
        },
      ]);
      expect(body.machines.map((row) => [row.name, row.usedBytes, row.level])).toEqual([
        ["web01", 40e9, "ok"],
        // Never measured: no figure yet.
        ["web02", null, "ok"],
      ]);
      // Its own budget of 45 GiB, else the default of the installation.
      expect(body.machines[0]?.budgetBytes).toBe(45 * GIB);
      expect(body.machines[1]?.budgetBytes).toBe(100 * GIB);
      expect(body.omitted).toEqual({ machines: 0, fileShares: 0, guests: 0 });

      const shares = await detail(beta);
      expect(shares.fileShares).toMatchObject([
        { name: "Office", usedBytes: 9.5 * GIB, budgetBytes: 10 * GIB, level: "near" },
      ]);
      const guests = await detail(zeta);
      expect(guests.guests).toMatchObject([
        { name: "web", usedBytes: 1e9, budgetBytes: null, level: "ok" },
      ]);
    });

    it("gives a machine its growth once its samples reach back, and nothing before", async () => {
      const web01 = (await detail(alpha)).machines.find((row) => row.name === "web01");
      // 1 GB a day over the week; the samples are 30 days old at most.
      expect(web01?.growth).toEqual({ days7: 1e9, days30: null, days90: null });
      const web02 = (await detail(alpha)).machines.find((row) => row.name === "web02");
      expect(web02?.growth).toEqual({ days7: null, days30: null, days90: null });
    });

    it("says a tenant on the installation default has no target of its own", async () => {
      expect(await detail(delta)).toMatchObject({ defaultRepository: true, targets: [] });
    });

    it("lists the largest repositories and counts the rest", async () => {
      await owner.insert(endpoints).values(
        Array.from({ length: 205 }, (_, index) => ({
          tenantId: delta,
          hostname: `many-${String(index).padStart(3, "0")}`,
          os: "linux" as const,
          arch: "amd64" as const,
          profile: "server" as const,
          secretHash: randomUUID(),
          config: {} as never,
          repositoryBytes: 1000 + index,
        })),
      );
      try {
        const body = await detail(delta);
        expect(body.machines).toHaveLength(200);
        expect(body.omitted.machines).toBe(5);
        // Largest first.
        expect(body.machines[0]?.usedBytes).toBe(1204);
      } finally {
        await owner.delete(endpoints).where(eq(endpoints.tenantId, delta));
      }
    });

    it("answers 404 for an unknown tenant and for one being deleted", async () => {
      await expect(detail(randomUUID())).rejects.toMatchObject({ status: 404 });
      await expect(detail(leaving)).rejects.toMatchObject({ status: 404 });
    });
  });

  describe("through the application", () => {
    it("refuses everyone who is not a provider admin", async () => {
      expect((await call("GET", "/api/v1/capacity")).status).toBe(401);
      expect((await call("GET", `/api/v1/capacity/${alpha}`)).status).toBe(401);
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
      expect((await call("GET", "/api/v1/capacity", cookie)).status).toBe(403);
      expect((await call("GET", `/api/v1/capacity/${alpha}`, cookie)).status).toBe(403);
    });

    it("answers a provider admin with the tenants and their repositories", async () => {
      const list = await call("GET", "/api/v1/capacity", ownerCookie);
      expect(list.status).toBe(200);
      const body = (await list.json()) as CapacityDto;
      expect(body.scope).toBe("all");
      expect(entry(body, alpha)).toMatchObject({ usedBytes: 100e9, basis: "samples" });
      expect(body.tenants.some((tenant) => tenant.tenantId === leaving)).toBe(false);

      const one = await call("GET", `/api/v1/capacity/${alpha}`, ownerCookie);
      expect(one.status).toBe(200);
      expect(((await one.json()) as CapacityTenantDetailDto).machines).toHaveLength(2);
      expect((await call("GET", "/api/v1/capacity/not-a-uuid", ownerCookie)).status).toBe(422);
      expect((await call("GET", `/api/v1/capacity/${randomUUID()}`, ownerCookie)).status).toBe(404);
    });

    it("shows a member limited to one tenant that tenant only, and closes the others", async () => {
      const userId = await createAccount("tech-beta@example.com", "admin");
      await owner.insert(providerMembers).values({ userId, role: "read_only", allTenants: false });
      await owner.insert(providerMemberTenants).values({ userId, tenantId: beta });
      const cookie = await signIn("tech-beta@example.com");

      const body = (await (await call("GET", "/api/v1/capacity", cookie)).json()) as CapacityDto;
      expect(body.tenants.map((tenant) => tenant.tenantId)).toEqual([beta]);
      expect(body.kpis.totalBytes).toBe(30e9 + 9.5 * GIB);
      expect((await call("GET", `/api/v1/capacity/${beta}`, cookie)).status).toBe(200);
      expect((await call("GET", `/api/v1/capacity/${alpha}`, cookie)).status).toBe(403);
    });

    it("lists the one tenant of the installation while the all-tenants view is closed", async () => {
      allTenantsOpen = false;
      try {
        const body = (await (
          await call("GET", "/api/v1/capacity", ownerCookie)
        ).json()) as CapacityDto;
        expect(body.scope).toBe("tenant");
        expect(body.tenants).toHaveLength(1);
      } finally {
        allTenantsOpen = true;
      }
    });
  });
});
