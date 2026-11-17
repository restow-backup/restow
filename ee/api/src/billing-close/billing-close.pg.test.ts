/**
 * Postgres-backed proof of the monthly billing close (docs/ARCHITECTURE.md, "Monatsabschluss der
 * Abrechnung"): the daily sample per tenant (once a day, a tenant created later joins, one being
 * deleted does not, an unreadable one stays due, two processes write one row), the close at the
 * month's peak with the prices of the close (exactly once with concurrent closers, again after a
 * close cut off mid-way, missed months caught up in order, not before 00:00 on the 1st in the
 * installation's zone, no late sample into a closed month), the database's own guard against any
 * change of a closed month, the corrections with their audit entry, and the edition gate.
 *
 * The tenants' figures come from a stand-in for `readTenantFigures` (the counting itself is the
 * estimate's, proved in apps/api); everything else runs on the real roles: the installation pool
 * for the billing tables, the owner only to arrange rows and to read the audit log.
 *
 * Runs when RESTOW_TEST_DATABASE_URL points at a Postgres server (the database
 * `restow_ee_billing_close_test` is recreated there and dropped after). Without it the suite is
 * skipped.
 */
import { randomBytes, randomUUID } from "node:crypto";
import {
  auditLog,
  billingCorrections,
  billingPeriods,
  billingPeriodTenants,
  billingSamples,
  createDb,
  type Database,
  providers,
  providerWebhooks,
  settings,
  tenants,
  webhookDeliveries,
} from "@restow/db";
import { and, eq, sql } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  registerApiExtension,
  resetExtensionsForTesting,
} from "../../../../apps/api/src/extensions.js";
import type { TenantFigures } from "../../../../apps/api/src/features/settings/pricing-estimate.js";
import {
  dropDatabase,
  recreateDatabase,
  testDatabaseAdminUrl,
} from "../../../../apps/api/src/features/snapshots/testing/explorer-fixture.js";
import {
  provisionTestRoles,
  type TestDatabaseRoles,
} from "../../../../apps/api/src/testing/database-roles.js";
import { licenseFeatureGate } from "../license/gate.js";
import { installTestLicense, removeTestLicense } from "../license/testing.js";
import type { BillingCloseDeps } from "./service.js";

const DATABASE = "restow_ee_billing_close_test";
const ZONE = "Europe/Berlin";
const UNITS = { servers: 0, clients: 0, vms: 0, containers: 0, fileShares: 0 };

type Service = typeof import("./service.js");

/** The database's own message of a refused statement (Drizzle wraps it as the cause). */
async function refusal(statement: PromiseLike<unknown>): Promise<string> {
  try {
    await statement;
  } catch (error) {
    const cause = (error as { cause?: { message?: string } }).cause;
    return cause?.message ?? (error as Error).message;
  }
  throw new Error("the statement was not refused");
}

/** Noon in Berlin on `day` (`YYYY-MM-DD`), summer or winter. */
function noon(day: string): Date {
  return new Date(`${day}T10:00:00.000Z`);
}

describe.skipIf(!testDatabaseAdminUrl)("the monthly billing close against Postgres", () => {
  let owner: Database;
  let db: Database;
  let providerDb: Database;
  let roles: TestDatabaseRoles | undefined;
  let service: Service;
  let providerId: string;
  /** What the stand-in reads per tenant; an Error is thrown as a failed read. */
  const figures = new Map<string, TenantFigures | Error>();
  let deps: BillingCloseDeps;

  async function addTenant(
    name: string,
    over: Partial<typeof tenants.$inferInsert> = {},
  ): Promise<string> {
    const [row] = await owner
      .insert(tenants)
      .values({
        providerId,
        name,
        slug: `${name.toLowerCase()}-${randomUUID().slice(0, 8)}`,
        ...over,
      })
      .returning({ id: tenants.id });
    if (!row) throw new Error("tenant insert returned no row");
    return row.id;
  }

  async function sample(tenantId: string, day: string, mailboxes: number, storedBytes = 0) {
    await owner
      .insert(billingSamples)
      .values({ tenantId, day, quantities: { mailboxes, storedBytes, ...UNITS } });
  }

  async function setPrices(pricing: Record<string, unknown>) {
    await owner.update(settings).set({ pricing });
  }

  async function closedAudits(period: string) {
    return owner
      .select()
      .from(auditLog)
      .where(and(eq(auditLog.action, "billing.period.closed"), eq(auditLog.target, period)));
  }

  beforeAll(async () => {
    const url = await recreateDatabase(testDatabaseAdminUrl as string, DATABASE);
    roles = await provisionTestRoles(url);
    process.env.DATABASE_URL = roles.appUrl;
    process.env.DATABASE_PROVIDER_URL = roles.providerUrl;
    process.env.RESTOW_MASTER_KEY = randomBytes(32).toString("base64");
    owner = createDb(url);
    await installTestLicense(owner, "service_provider");
    registerApiExtension({ name: "ee-license-gate", featureGate: licenseFeatureGate });
    db = createDb(roles.appUrl);
    providerDb = createDb(roles.providerUrl);
    const [provider] = await owner.insert(providers).values({ name: "Provider" }).returning();
    providerId = provider?.id as string;
    await owner.insert(settings).values({
      timeZone: ZONE,
      pricing: { currency: "EUR", mailboxPrice: 2, storagePrice: 10, storageUnit: "TB" },
    });
    service = await import("./service.js");
    deps = {
      db,
      providerDb,
      readFigures: async (_db, tenantId) => {
        const read = figures.get(tenantId);
        if (read instanceof Error) throw read;
        return read ?? { mailboxes: 1, storedBytes: 0, units: { ...UNITS } };
      },
    };
  }, 60_000);

  afterAll(async () => {
    resetExtensionsForTesting();
    const shared = await import("../../../../apps/api/src/db.js");
    await Promise.all([
      shared.db.$client.end(),
      shared.providerDb.$client.end(),
      shared.authDb.$client.end(),
    ]);
    await owner?.$client.end();
    await db?.$client.end();
    await providerDb?.$client.end();
    await dropDatabase(testDatabaseAdminUrl as string, DATABASE);
    await roles?.drop(testDatabaseAdminUrl as string);
  });

  it("samples each tenant once a day, joins a tenant created later and skips one being deleted", async () => {
    const active = await addTenant("Active");
    const suspended = await addTenant("Suspended", { status: "suspended" });
    const deleting = await addTenant("Deleting", { status: "deleting" });
    figures.set(active, { mailboxes: 7, storedBytes: 5, units: { ...UNITS, servers: 2 } });

    const first = await service.sampleDueTenants(deps, noon("2026-01-05"), ZONE);
    expect(first).toMatchObject({ day: "2026-01-05", sampled: 2, failed: 0 });
    // The same day again: nothing is due.
    expect((await service.sampleDueTenants(deps, noon("2026-01-05"), ZONE)).sampled).toBe(0);

    const later = await addTenant("Later");
    figures.set(later, new Error("figures not readable"));
    const failed = await service.sampleDueTenants(deps, noon("2026-01-05"), ZONE);
    expect(failed).toMatchObject({ sampled: 0, failed: 1 });
    figures.delete(later);
    expect((await service.sampleDueTenants(deps, noon("2026-01-05"), ZONE)).sampled).toBe(1);

    const rows = await owner
      .select()
      .from(billingSamples)
      .where(eq(billingSamples.day, "2026-01-05"));
    expect(rows.map((row) => row.tenantId).sort()).toEqual([active, suspended, later].sort());
    expect(rows.find((row) => row.tenantId === deleting)).toBeUndefined();
    expect(rows.find((row) => row.tenantId === active)?.quantities).toEqual({
      mailboxes: 7,
      storedBytes: 5,
      ...UNITS,
      servers: 2,
    });

    // Two processes sampling the same day at once write one row per tenant.
    await Promise.all([
      service.sampleDueTenants(deps, noon("2026-01-06"), ZONE),
      service.sampleDueTenants(deps, noon("2026-01-06"), ZONE),
    ]);
    const [counted] = await owner
      .select({
        rows: sql<number>`count(*)::int`,
        tenants: sql<number>`count(distinct tenant_id)::int`,
      })
      .from(billingSamples)
      .where(eq(billingSamples.day, "2026-01-06"));
    expect(counted?.rows).toBe(counted?.tenants);
    expect(counted?.rows).toBe(3);

    // 23:30 UTC on 31 January is 1 February in Berlin: that is the day sampled.
    const nextDay = await service.sampleDueTenants(
      deps,
      new Date("2026-01-31T23:30:00.000Z"),
      ZONE,
    );
    expect(nextDay.day).toBe("2026-02-01");
  });

  it("closes a month at its peak, and the database refuses any change of the closed month [BILLING-001]", async () => {
    const peak = await addTenant("Peak", { customerNumber: "K-7001" });
    const midMonth = await addTenant("MidMonth");
    const leaving = await addTenant("Leaving", { customerNumber: "K-7003" });
    const own = await addTenant("Own", { kind: "internal" });
    // Missed days: the server was off from the 3rd to the 9th.
    await sample(peak, "2026-03-01", 10, 0.5e12);
    await sample(peak, "2026-03-02", 14, 0.4e12);
    await sample(peak, "2026-03-10", 14, 1.5e12);
    await sample(peak, "2026-03-11", 9, 0.2e12);
    await sample(midMonth, "2026-03-20", 3);
    await sample(leaving, "2026-03-01", 6);
    await sample(leaving, "2026-03-02", 8);
    await owner.update(tenants).set({ status: "deleting" }).where(eq(tenants.id, leaving));
    await sample(own, "2026-03-05", 50);
    // These samples were written as before migration 0107, without the prices of their day:
    // for them the close falls back to the prices in force when it runs.
    await setPrices({ currency: "EUR", mailboxPrice: 3, storagePrice: 10, storageUnit: "TB" });

    // Not before 00:00 on 1 April in Berlin (22:00 UTC on 31 March, summer time).
    expect(
      await service.closePeriod(deps, "2026-03", new Date("2026-03-31T21:59:00.000Z"), ZONE),
    ).toEqual({ status: "open", period: "2026-03" });
    const outcome = await service.closePeriod(
      deps,
      "2026-03",
      new Date("2026-03-31T22:00:30.000Z"),
      ZONE,
    );
    expect(outcome).toMatchObject({ status: "closed", period: "2026-03", tenants: 4 });

    const loaded = await service.loadClosedPeriod(providerDb, "2026-03");
    expect(loaded?.period).toMatchObject({
      timeZone: ZONE,
      days: 31,
      sampledDays: 6,
      currency: "EUR",
      storageUnit: "TB",
      startsAt: new Date("2026-02-28T23:00:00.000Z"),
      endsAt: new Date("2026-03-31T22:00:00.000Z"),
    });
    const byName = new Map(loaded?.tenants.map((row) => [row.name, row]));
    expect(byName.get("Peak")).toMatchObject({
      customerNumber: "K-7001",
      sampledDays: 4,
      status: "active",
      total: 14 * 3 + 1.5 * 10,
    });
    expect(byName.get("Peak")?.lines).toEqual([
      expect.objectContaining({
        type: "mailboxes",
        quantity: 14,
        unitPrice: 3,
        peakDate: "2026-03-02",
      }),
      expect.objectContaining({
        type: "storage",
        quantity: 1.5,
        unit: "TB",
        peakDate: "2026-03-10",
      }),
    ]);
    expect(byName.get("MidMonth")).toMatchObject({
      sampledDays: 1,
      total: 9,
      customerNumber: null,
    });
    expect(byName.get("Leaving")).toMatchObject({ status: "deleting", total: 24 });
    // The own organisation is listed but not billed in the month's total.
    expect(byName.get("Own")).toMatchObject({ kind: "internal", total: 150 });
    expect(loaded?.period.total).toBe(57 + 9 + 24);
    expect(await closedAudits("2026-03")).toHaveLength(1);

    // A later price change and a late sample of a closed day change nothing.
    await setPrices({ currency: "EUR", mailboxPrice: 99, storagePrice: 10, storageUnit: "TB" });
    const late = await service.sampleDueTenants(deps, noon("2026-03-31"), ZONE);
    expect(late.sampled).toBe(0);
    expect(
      await service.closePeriod(deps, "2026-03", new Date("2026-04-02T10:00:00.000Z"), ZONE),
    ).toEqual({ status: "already_closed", period: "2026-03" });
    const again = await service.loadClosedPeriod(providerDb, "2026-03");
    expect(again?.tenants.find((row) => row.tenantId === peak)?.total).toBe(57);
    expect(
      await owner.select().from(billingSamples).where(eq(billingSamples.day, "2026-03-31")),
    ).toEqual([]);

    // The database refuses every change of a closed month: the trigger for the owner, the
    // missing grant for the installation role.
    const periodId = loaded?.period.id as string;
    expect(
      await refusal(
        owner.update(billingPeriods).set({ total: 1 }).where(eq(billingPeriods.id, periodId)),
      ),
    ).toMatch(/append-only/);
    expect(
      await refusal(
        owner.delete(billingPeriodTenants).where(eq(billingPeriodTenants.periodId, periodId)),
      ),
    ).toMatch(/append-only/);
    expect(
      await refusal(
        providerDb.update(billingPeriods).set({ total: 1 }).where(eq(billingPeriods.id, periodId)),
      ),
    ).toMatch(/permission denied/);
    expect(
      await refusal(
        providerDb
          .update(billingPeriodTenants)
          .set({ total: 0 })
          .where(eq(billingPeriodTenants.periodId, periodId)),
      ),
    ).toMatch(/permission denied/);
    expect(
      await refusal(providerDb.delete(billingPeriods).where(eq(billingPeriods.id, periodId))),
    ).toMatch(/permission denied/);
    // The provider's figures are not the tenants' to read: the application role has no grant.
    expect(await refusal(db.select().from(billingPeriodTenants))).toMatch(/permission denied/);
    expect(await refusal(db.select().from(billingSamples))).toMatch(/permission denied/);
    const [stored] = await owner
      .select()
      .from(billingPeriods)
      .where(eq(billingPeriods.id, periodId));
    expect(stored?.total).toBe(90);
    await setPrices({ currency: "EUR", mailboxPrice: 2, storagePrice: 10, storageUnit: "TB" });
  });

  it("adds corrections next to a closed month, audited in the tenant's chain, and refuses changing them [BILLING-001]", async () => {
    const loaded = await service.loadClosedPeriod(providerDb, "2026-03");
    const peak = loaded?.tenants.find((row) => row.name === "Peak")?.tenantId as string;
    const actor = { label: "api-key:test", keyId: "test", ip: "192.0.2.7" };
    const row = await service.createCorrection(
      { providerDb },
      {
        period: "2026-03",
        tenantId: peak,
        lineType: "mailboxes",
        amount: -6,
        reason: "Two test mailboxes",
        actor,
      },
    );
    expect(row).toMatchObject({
      tenantId: peak,
      amount: -6,
      lineType: "mailboxes",
      actor: "api-key:test",
    });
    const [entry] = await owner
      .select()
      .from(auditLog)
      .where(and(eq(auditLog.action, "billing.correction.created"), eq(auditLog.target, row.id)));
    expect(entry).toMatchObject({ tenantId: peak, actor: "api-key:test", ip: "192.0.2.7" });
    expect(entry?.details).toMatchObject({
      period: "2026-03",
      amount: -6,
      reason: "Two test mailboxes",
    });

    // The close is unchanged; the list adds the correction up.
    const after = await service.loadClosedPeriod(providerDb, "2026-03");
    expect(after?.tenants.find((tenant) => tenant.tenantId === peak)?.total).toBe(57);
    expect(after?.corrections).toHaveLength(1);
    const listed = (await service.listClosedPeriods(providerDb)).find(
      (entry) => entry.period.period === "2026-03",
    );
    expect(listed).toMatchObject({ corrections: 1, customerCorrections: -6, tenants: 4 });

    // Only a closed month, only a tenant of it.
    await expect(
      service.createCorrection(
        { providerDb },
        {
          period: "2026-04",
          tenantId: peak,
          lineType: null,
          amount: 1,
          reason: "open month",
          actor,
        },
      ),
    ).rejects.toMatchObject({ status: 404 });
    const stranger = await addTenant("Stranger");
    await expect(
      service.createCorrection(
        { providerDb },
        {
          period: "2026-03",
          tenantId: stranger,
          lineType: null,
          amount: 1,
          reason: "not billed",
          actor,
        },
      ),
    ).rejects.toMatchObject({ status: 404 });
    expect(
      await refusal(
        providerDb
          .update(billingCorrections)
          .set({ amount: 5 })
          .where(eq(billingCorrections.id, row.id)),
      ),
    ).toMatch(/permission denied/);
    expect(
      await refusal(owner.delete(billingCorrections).where(eq(billingCorrections.id, row.id))),
    ).toMatch(/append-only/);
  });

  it("closes a month exactly once with concurrent closers, and again after a close cut off", async () => {
    const tenant = await addTenant("Concurrent");
    await sample(tenant, "2026-04-10", 5);
    const after = new Date("2026-05-01T08:00:00.000Z");
    // A close cut off mid-way (here: the audit entry fails) leaves nothing behind.
    const crashing: BillingCloseDeps = {
      ...deps,
      audit: async () => {
        throw new Error("process killed");
      },
    };
    await expect(service.closePeriod(crashing, "2026-04", after, ZONE)).rejects.toThrow(
      /process killed/,
    );
    expect(await service.loadClosedPeriod(providerDb, "2026-04")).toBeNull();
    // Four closers at once, as after a restart of several API processes.
    const outcomes = await Promise.all(
      [1, 2, 3, 4].map(() => service.closePeriod(deps, "2026-04", after, ZONE)),
    );
    expect(outcomes.filter((outcome) => outcome.status === "closed")).toHaveLength(1);
    expect(outcomes.filter((outcome) => outcome.status === "already_closed")).toHaveLength(3);
    const [counted] = await owner
      .select({ count: sql<number>`count(*)::int` })
      .from(billingPeriods)
      .where(eq(billingPeriods.period, "2026-04"));
    expect(counted?.count).toBe(1);
    expect(await closedAudits("2026-04")).toHaveLength(1);
  });

  it("catches up every month missed while the server was off, oldest first, on its next pass", async () => {
    const tenant = await addTenant("CatchUp");
    await sample(tenant, "2026-05-31", 4);
    await sample(tenant, "2026-06-15", 6);
    await sample(tenant, "2026-07-01", 8);
    // Back on 3 July: May and June are due (January and February have samples from the first
    // test and are due as well), July is open.
    const due = await service.duePeriods(providerDb, new Date("2026-07-03T08:00:00.000Z"), ZONE);
    expect(due).toEqual(["2026-01", "2026-02", "2026-05", "2026-06"]);
    const outcomes = await service.closeDuePeriods(
      deps,
      new Date("2026-07-03T08:00:00.000Z"),
      ZONE,
    );
    expect(outcomes.map((outcome) => [outcome.period, outcome.status])).toEqual([
      ["2026-01", "closed"],
      ["2026-02", "closed"],
      ["2026-05", "closed"],
      ["2026-06", "closed"],
    ]);
    expect(
      await service.duePeriods(providerDb, new Date("2026-07-03T08:00:00.000Z"), ZONE),
    ).toEqual([]);
    const june = await service.loadClosedPeriod(providerDb, "2026-06");
    expect(june?.tenants.find((row) => row.tenantId === tenant)?.lines[0]).toMatchObject({
      quantity: 6,
      peakDate: "2026-06-15",
    });
  });

  it("runs only while the edition opens the provider API, and prunes old samples of closed months", async () => {
    await removeTestLicense(owner);
    expect(await service.runBillingPass(deps, new Date("2026-08-01T08:00:00.000Z"))).toEqual({
      enabled: false,
    });
    await installTestLicense(owner, "service_provider");
    const pass = await service.runBillingPass(deps, new Date("2026-08-01T08:00:00.000Z"));
    expect(pass).toMatchObject({ enabled: true, timeZone: ZONE });
    expect(pass.closed?.map((outcome) => [outcome.period, outcome.status])).toEqual([
      ["2026-07", "closed"],
    ]);
    expect(pass.samples?.day).toBe("2026-08-01");
    expect(pass.samples?.sampled).toBeGreaterThan(0);

    // 400 days after January, its samples go; the open month's stay.
    const removed = await service.pruneBillingSamples(
      providerDb,
      new Date("2027-02-20T08:00:00.000Z"),
      ZONE,
    );
    expect(removed).toBeGreaterThan(0);
    const left = await owner
      .select({ day: billingSamples.day })
      .from(billingSamples)
      .where(sql`${billingSamples.day} < '2026-01-20'`);
    expect(left).toEqual([]);
    expect(
      (await owner.select().from(billingSamples).where(eq(billingSamples.day, "2026-08-01")))
        .length,
    ).toBeGreaterThan(0);
  });

  it("bills the prices of the month's end, also when the close runs days late after a price change", async () => {
    const monthEnd = await addTenant("MonthEnd", { customerNumber: "K-9001" });
    const own = await addTenant("OwnPrice", { pricing: { mailboxPrice: 1.5 } });
    figures.set(monthEnd, { mailboxes: 5, storedBytes: 0, units: { ...UNITS } });
    figures.set(own, { mailboxes: 4, storedBytes: 0, units: { ...UNITS } });
    await setPrices({ currency: "EUR", mailboxPrice: 2 });
    await service.sampleDueTenants(deps, noon("2026-09-10"), ZONE);
    // A price change mid-month: the month's end counts.
    await setPrices({ currency: "EUR", mailboxPrice: 3 });
    await service.sampleDueTenants(deps, noon("2026-09-30"), ZONE);
    const [recorded] = await owner
      .select({ prices: billingSamples.prices })
      .from(billingSamples)
      .where(and(eq(billingSamples.tenantId, own), eq(billingSamples.day, "2026-09-30")));
    expect(recorded?.prices?.lines.mailboxes).toEqual({ unitPrice: 1.5, source: "tenant" });
    expect(recorded?.prices?.installation.mailboxPrice).toBe(3);
    // The server was off on the 1st; the provider raised the price meanwhile.
    await setPrices({ currency: "CHF", mailboxPrice: 7 });

    const hooks = await import("../provider-webhooks/service.js");
    const hook = await hooks.createProviderWebhook(
      { providerDb },
      { name: "PSA", url: "https://psa.example/hooks/restow", active: true },
      { label: "owner@provider.example", userId: null, ip: "192.0.2.1" },
    );
    expect(hook.secret).toMatch(/^whsec_/);
    expect(hook.events).toEqual(["billing.period_closed"]);

    const late = new Date("2026-10-03T08:00:00.000Z");
    expect(await service.closePeriod(deps, "2026-09", late, ZONE)).toMatchObject({
      status: "closed",
    });
    const closed = await service.loadClosedPeriod(providerDb, "2026-09");
    expect(closed?.period).toMatchObject({ currency: "EUR", closedAt: late });
    expect(closed?.period.prices).toMatchObject({ mailboxPrice: 3 });
    const byId = new Map(closed?.tenants.map((row) => [row.tenantId, row]));
    expect(byId.get(monthEnd)?.lines[0]).toMatchObject({
      type: "mailboxes",
      quantity: 5,
      unitPrice: 3,
      priceSource: "installation",
      amount: 15,
    });
    expect(byId.get(own)?.lines[0]).toMatchObject({ unitPrice: 1.5, priceSource: "tenant" });

    // The provider's webhook got `billing.period_closed` in the close's transaction.
    const [delivery] = await owner
      .select()
      .from(webhookDeliveries)
      .where(eq(webhookDeliveries.providerWebhookId, hook.id));
    expect(delivery).toMatchObject({
      tenantId: null,
      webhookId: null,
      event: "billing.period_closed",
      status: "pending",
    });
    expect(delivery?.payload).toMatchObject({
      event: "billing.period_closed",
      scope: "provider",
      data: {
        period: "2026-09",
        closedAt: late.toISOString(),
        currency: "EUR",
        tenants: closed?.tenants.length,
        total: closed?.period.total,
        url: "/api/v1/provider/billing/periods/2026-09",
      },
    });
    // No tenant figures in the payload: those are read, audited, at `url`.
    expect(JSON.stringify(delivery?.payload)).not.toContain("K-9001");
    await setPrices({ currency: "EUR", mailboxPrice: 2, storagePrice: 10, storageUnit: "TB" });
  });

  it("manages the provider's webhooks with an audit entry for each change and a readable secret", async () => {
    const hooks = await import("../provider-webhooks/service.js");
    const { readSecret } = await import("../../../../apps/api/src/lib/secrets.js");
    const actor = { label: "api-key:psa", userId: null, ip: "192.0.2.9", keyId: "psa" };
    const created = await hooks.createProviderWebhook(
      { providerDb },
      { name: "Billing", url: "https://billing.example/in?token=abc", events: [], active: true },
      actor,
    );
    const [row] = await owner
      .select()
      .from(providerWebhooks)
      .where(eq(providerWebhooks.id, created.id));
    expect(await readSecret(providerDb, { id: row?.secretRef as string, tenantId: null })).toBe(
      created.secret,
    );
    await hooks.updateProviderWebhook(
      { providerDb },
      created.id,
      { events: ["billing.period_closed"], name: "Billing tool" },
      actor,
    );
    const test = await hooks.sendProviderWebhookTest({ providerDb }, created.id, actor);
    expect(test).toMatchObject({ event: "webhook.test", status: "pending" });
    const rotated = await hooks.rotateProviderWebhookSecret({ providerDb }, created.id, actor);
    expect(rotated.secret).not.toBe(created.secret);
    expect((await hooks.listProviderWebhookDeliveries(providerDb, created.id)).items).toHaveLength(
      1,
    );
    await hooks.updateProviderWebhook({ providerDb }, created.id, { active: false }, actor);
    await expect(
      hooks.sendProviderWebhookTest({ providerDb }, created.id, actor),
    ).rejects.toMatchObject({ status: 409 });
    await hooks.deleteProviderWebhook({ providerDb }, created.id, actor);
    await expect(hooks.getProviderWebhook(providerDb, created.id)).rejects.toMatchObject({
      status: 404,
    });

    const entries = await owner
      .select()
      .from(auditLog)
      .where(and(eq(auditLog.target, created.id), sql`${auditLog.tenantId} IS NULL`))
      .orderBy(auditLog.createdAt);
    expect(entries.map((entry) => entry.action)).toEqual([
      "provider_webhook.created",
      "provider_webhook.updated",
      "provider_webhook.tested",
      "provider_webhook.secret_rotated",
      "provider_webhook.updated",
      "provider_webhook.deleted",
    ]);
    expect(entries[0]?.details).toMatchObject({ keyId: "psa", origin: "https://billing.example" });
    // The URL is audited by origin only: a receiver's token in the query never lands in the log.
    expect(JSON.stringify(entries.map((entry) => entry.details))).not.toContain("token=abc");
  });
});
