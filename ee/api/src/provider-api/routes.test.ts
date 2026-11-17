import type { AuditLogEntry, Database, User } from "@restow/db";
import { Hono } from "hono";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import {
  registerApiExtension,
  resetExtensionsForTesting,
} from "../../../../apps/api/src/extensions.js";
import type { AuditEvent } from "../../../../apps/api/src/lib/audit.js";
import { errorHandler, notFoundHandler } from "../../../../apps/api/src/problem.js";
import { decodeCursor } from "../../../../apps/api/src/routes/v1/cursor.js";
import { featuresOff, featuresOn } from "../../../../apps/api/src/routes/v1/testing/features.js";
import {
  bearer,
  fakeRequireKey,
  OTHER_TENANT_ID,
  TENANT_ID,
} from "../../../../apps/api/src/routes/v1/testing/keys.js";
import { scriptedDb } from "../../../../apps/api/src/routes/v1/testing/scripted-db.js";
import { buildV1 } from "../../../../apps/api/src/routes/v1.js";
import { providerUserCursorSchema, registerProviderRoutes } from "./routes.js";

/**
 * Route tests of the provider operations (Service Provider edition) on the
 * integration API, registered through the extension point exactly as
 * ee/api/src/index.ts does. Same harness as apps/api/src/routes/v1/routes.test.ts: the real router, a scripted database, the
 * fake key gate, and the feature services replaced at their module boundary.
 * The counting rule is taken from the @restow/core source, so the test does
 * not depend on the package's build output.
 */

const mocks = vi.hoisted(() => ({
  loadPricingEstimate: vi.fn(),
  listClosedPeriods: vi.fn(),
  loadClosedPeriod: vi.fn(),
  createCorrection: vi.fn(),
  setUserProtection: vi.fn(),
  createRestore: vi.fn(),
  startBackup: vi.fn(),
  findJob: vi.fn(),
}));

vi.mock("@restow/core", async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  ...(await vi.importActual<Record<string, unknown>>(
    "../../../../packages/core/src/usage/mailboxes.js",
  )),
}));
vi.mock(
  "../../../../apps/api/src/features/settings/pricing-estimate.js",
  async (importOriginal) => ({
    ...(await importOriginal<Record<string, unknown>>()),
    loadPricingEstimate: mocks.loadPricingEstimate,
  }),
);
vi.mock("../billing-close/service.js", async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  listClosedPeriods: mocks.listClosedPeriods,
  loadClosedPeriod: mocks.loadClosedPeriod,
  createCorrection: mocks.createCorrection,
}));
vi.mock("../../../../apps/api/src/lib/installation-time-zone.js", () => ({
  loadInstallationTimeZone: async () => ({ timeZone: "Europe/Berlin", source: "settings" }),
}));
vi.mock("../../../../apps/api/src/features/directory/service.js", async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  setUserProtection: mocks.setUserProtection,
}));
vi.mock("../../../../apps/api/src/features/restore/service.js", async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  createRestore: mocks.createRestore,
}));
vi.mock("../../../../apps/api/src/features/jobs/service.js", async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  startBackup: mocks.startBackup,
  findJob: mocks.findJob,
}));

const NOW = new Date("2026-09-23T10:00:00.000Z");
const CLIENT_IP = "203.0.113.7";
const USER_A = "aaaaaaaa-1111-4111-8111-111111111111";
const USER_B = "bbbbbbbb-2222-4222-8222-222222222222";

const tenantRow = {
  id: TENANT_ID,
  name: "Contoso",
  slug: "contoso",
  status: "active",
  kind: "customer",
  mailboxCap: null,
  createdAt: new Date("2026-01-01T00:00:00.000Z"),
};

function directoryUser(id: string, email: string, createdAt: string, tenantId = TENANT_ID): User {
  return {
    id,
    tenantId,
    entraObjectId: `oid-${email}`,
    email,
    upn: email,
    displayName: email.split("@")[0] ?? null,
    mailAddresses: [email],
    createdAt: new Date(createdAt),
    updatedAt: new Date(createdAt),
  };
}

function setup(results: unknown[][], requireFeature = featuresOn) {
  const script = scriptedDb(results);
  const audits: AuditEvent[] = [];
  const api = buildV1({
    // One scripted database for both pools: the script answers in call order.
    db: script.db,
    providerDb: script.db,
    requireKey: fakeRequireKey,
    requireFeature,
    audit: async (_db: unknown, event: AuditEvent) => {
      audits.push(event);
      return {} as AuditLogEntry;
    },
    version: {
      current: () => ({
        running: "1.4.0",
        commit: null,
        releasedAt: null,
        latest: null,
        updateAvailable: null,
        releaseUrl: null,
        updateCheck: "disabled",
        checkedAt: null,
        channel: "stable",
        latestTag: null,
        publishedAt: null,
        checkError: null,
        maintenance: null,
      }),
    },
    now: () => NOW,
  });
  const app = new Hono();
  app.onError(errorHandler);
  app.notFound(notFoundHandler);
  app.route("/api/v1", api.app);
  const request = (path: string, init: RequestInit & { key?: string } = {}) => {
    const { key = "rsk_tenant_full", headers, ...rest } = init;
    return app.request(`/api/v1${path}`, {
      ...rest,
      headers: {
        ...bearer(key),
        "x-forwarded-for": CLIENT_IP,
        ...(rest.body ? { "content-type": "application/json" } : {}),
        ...(headers as Record<string, string> | undefined),
      },
    });
  };
  return { script, audits, request, db: script.db as Database };
}

beforeAll(() => {
  registerApiExtension({ name: "provider-api-test", integrationRoutes: [registerProviderRoutes] });
});

afterAll(() => {
  resetExtensionsForTesting();
});

beforeEach(() => {
  vi.clearAllMocks();
});

describe("GET /provider/users", () => {
  it("pages across tenants and records the read in each tenant's audit log", async () => {
    const { request, audits, script } = setup([
      [
        { ...tenantRow, id: TENANT_ID },
        { ...tenantRow, id: OTHER_TENANT_ID, name: "Fabrikam", slug: "fabrikam" },
      ],
      [directoryUser(USER_A, "ada@contoso.example", "2026-03-01T00:00:00.000Z")],
      [],
      [directoryUser(USER_B, "eve@fabrikam.example", "2026-03-05T00:00:00.000Z", OTHER_TENANT_ID)],
      [],
    ]);
    const res = await request("/provider/users?limit=1", { key: "rsk_provider_full" });
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      items: { id: string; tenant: { slug: string; kind: string } }[];
      next: string;
    };
    expect(body.items.map((item) => [item.id, item.tenant.slug, item.tenant.kind])).toEqual([
      [USER_A, "contoso", "customer"],
    ]);
    expect(decodeCursor(providerUserCursorSchema, body.next)).toEqual({
      tenantId: TENANT_ID,
      at: "2026-03-01T00:00:00.000Z",
      id: USER_A,
    });
    expect(script.pending()).toBe(0);
    expect(audits.map((event) => [event.tenantId, event.action, event.details?.count])).toEqual([
      [TENANT_ID, "api.provider.users.read", 1],
    ]);
  });

  it("is closed to tenant keys", async () => {
    const { request } = setup([]);
    const res = await request("/provider/users");
    expect(res.status).toBe(403);
  });
});

describe("GET /provider/billing", () => {
  const priced = (tenantId: string, name: string, total: number) => ({
    tenantId,
    name,
    kind: "customer",
    mailboxes: 10,
    storedBytes: 0,
    billedBytes: 0,
    servers: null,
    clients: null,
    vms: null,
    containers: null,
    fileShares: null,
    mailboxPrice: total / 10,
    storagePrice: null,
    serverPrice: null,
    clientPrice: null,
    vmPrice: null,
    containerPrice: null,
    fileSharePrice: null,
    overridden: {
      mailbox: false,
      storage: false,
      server: false,
      client: false,
      vm: false,
      container: false,
      fileShare: false,
    },
    amount: {
      mailboxes: total,
      storage: null,
      servers: null,
      clients: null,
      vms: null,
      containers: null,
      fileShares: null,
      total,
    },
  });
  const estimate = (tenants: unknown[]) => ({
    currency: "CHF",
    storageUnit: "TB",
    storageBilling: "exact",
    global: {},
    perTenantOverrides: false,
    hasPrices: true,
    tenants,
    total: 30,
    missing: 0,
  });
  const facts = [
    { id: TENANT_ID, customerNumber: "K-1001", status: "active" },
    { id: OTHER_TENANT_ID, customerNumber: "K-2002", status: "suspended" },
  ];

  it("answers every tenant's lines with its customer number and records the read in each tenant", async () => {
    mocks.loadPricingEstimate.mockResolvedValue(
      estimate([priced(TENANT_ID, "Contoso", 10), priced(OTHER_TENANT_ID, "Fabrikam", 20)]),
    );
    const { request, audits } = setup([facts]);
    const res = await request("/provider/billing", { key: "rsk_provider_full" });
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      currency: string;
      total: number;
      tenants: {
        customerNumber: string;
        status: string;
        lines: { type: string; amount: number }[];
      }[];
    };
    expect(body.currency).toBe("CHF");
    expect(body.tenants.map((t) => [t.customerNumber, t.status, t.lines])).toEqual([
      ["K-1001", "active", [expect.objectContaining({ type: "mailboxes", amount: 10 })]],
      ["K-2002", "suspended", [expect.objectContaining({ type: "mailboxes", amount: 20 })]],
    ]);
    // Every tenant, never a member's narrower view: the key is the provider's.
    expect(mocks.loadPricingEstimate).toHaveBeenCalledWith(expect.anything(), null, {});
    expect(audits.map((event) => [event.tenantId, event.action])).toEqual([
      [TENANT_ID, "api.provider.billing.read"],
      [OTHER_TENANT_ID, "api.provider.billing.read"],
    ]);
  });

  it("narrows to the tenant a customer number names, and 404 for an unknown one", async () => {
    mocks.loadPricingEstimate.mockResolvedValue(
      estimate([priced(OTHER_TENANT_ID, "Fabrikam", 20)]),
    );
    const { request } = setup([facts]);
    const res = await request("/provider/billing?customerNumber=k-2002", {
      key: "rsk_provider_full",
    });
    expect(res.status).toBe(200);
    expect(mocks.loadPricingEstimate).toHaveBeenCalledWith(expect.anything(), null, {
      tenantId: OTHER_TENANT_ID,
    });
    const unknown = setup([facts]);
    const none = await unknown.request("/provider/billing?customerNumber=K-404", {
      key: "rsk_provider_full",
    });
    expect(none.status).toBe(404);
  });

  it("is closed to tenant keys and to provider keys without billing:read", async () => {
    const { request } = setup([]);
    expect((await request("/provider/billing")).status).toBe(403);
    expect((await request("/provider/billing", { key: "rsk_provider_status" })).status).toBe(403);
    expect(mocks.loadPricingEstimate).not.toHaveBeenCalled();
  });
});

describe("the closed billing months", () => {
  const PERIOD_ID = "cccccccc-3333-4333-8333-333333333333";
  const CORRECTION_ID = "dddddddd-4444-4444-8444-444444444444";
  const periodRow = {
    id: PERIOD_ID,
    period: "2026-08",
    timeZone: "Europe/Berlin",
    startsAt: new Date("2026-07-31T22:00:00.000Z"),
    endsAt: new Date("2026-08-31T22:00:00.000Z"),
    closedAt: new Date("2026-08-31T22:00:40.000Z"),
    currency: "EUR",
    storageUnit: "TB",
    storageBilling: "exact",
    prices: { mailboxPrice: 2 },
    perTenantOverrides: false,
    days: 31,
    sampledDays: 29,
    total: 24,
    createdAt: new Date("2026-08-31T22:00:40.000Z"),
  };
  const tenantRow = (
    tenantId: string,
    name: string,
    customerNumber: string | null,
    total: number,
    kind = "customer",
  ) => ({
    id: `${tenantId.slice(0, 8)}-0000-4000-8000-000000000000`,
    periodId: PERIOD_ID,
    tenantId,
    name,
    customerNumber,
    kind,
    status: "active",
    complete: true,
    sampledDays: 29,
    lines: [
      {
        type: "mailboxes",
        quantity: total / 2,
        unit: "mailbox",
        unitPrice: 2,
        priceSource: "installation",
        amount: total,
        peakDate: "2026-08-14",
      },
    ],
    total,
    createdAt: periodRow.createdAt,
  });
  const loaded = () => ({
    period: periodRow,
    tenants: [
      tenantRow(TENANT_ID, "Contoso", "K-1001", 20),
      tenantRow(OTHER_TENANT_ID, "Fabrikam", null, 4),
    ],
    corrections: [
      {
        id: CORRECTION_ID,
        periodId: PERIOD_ID,
        tenantId: TENANT_ID,
        lineType: "mailboxes",
        amount: -2,
        reason: "Two test mailboxes",
        actor: "api-key:key-provider",
        apiKeyId: "key-provider",
        createdAt: new Date("2026-09-02T08:00:00.000Z"),
      },
    ],
  });

  it("answers a closed month in the shape of GET /provider/billing with peaks and corrections, audited per tenant", async () => {
    mocks.loadClosedPeriod.mockResolvedValue(loaded());
    const { request, audits } = setup([]);
    const res = await request("/provider/billing/periods/2026-08", { key: "rsk_provider_full" });
    expect(res.status).toBe(200);
    const body = (await res.json()) as Record<string, unknown> & {
      tenants: Record<string, unknown>[];
    };
    expect(body).toMatchObject({
      period: "2026-08",
      status: "closed",
      timeZone: "Europe/Berlin",
      startsAt: "2026-07-31T22:00:00.000Z",
      endsAt: "2026-08-31T22:00:00.000Z",
      closedAt: "2026-08-31T22:00:40.000Z",
      generatedAt: "2026-08-31T22:00:40.000Z",
      currency: "EUR",
      storageBilling: "exact",
      days: 31,
      sampledDays: 29,
      total: 24,
      correctedTotal: 22,
      missing: 0,
    });
    expect(body.tenants[0]).toMatchObject({
      tenantId: TENANT_ID,
      customerNumber: "K-1001",
      lines: [expect.objectContaining({ type: "mailboxes", amount: 20, peakDate: "2026-08-14" })],
      total: 20,
      correctedTotal: 18,
      corrections: [expect.objectContaining({ id: CORRECTION_ID, type: "mailboxes", amount: -2 })],
    });
    // A tenant without a customer number is billed all the same.
    expect(body.tenants[1]).toMatchObject({ customerNumber: null, total: 4, correctedTotal: 4 });
    expect(audits.map((event) => [event.tenantId, event.action, event.details?.period])).toEqual([
      [TENANT_ID, "api.provider.billing.period.read", "2026-08"],
      [OTHER_TENANT_ID, "api.provider.billing.period.read", "2026-08"],
    ]);
  });

  it("narrows to a customer number recorded at the close, and 404 for one not in the month", async () => {
    mocks.loadClosedPeriod.mockResolvedValue(loaded());
    const { request, audits } = setup([]);
    const res = await request("/provider/billing/periods/2026-08?customerNumber=k-1001", {
      key: "rsk_provider_full",
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { tenants: { tenantId: string }[]; total: number };
    expect(body.tenants.map((tenant) => tenant.tenantId)).toEqual([TENANT_ID]);
    expect(body.total).toBe(20);
    expect(audits).toHaveLength(1);
    const none = await request("/provider/billing/periods/2026-08?customerNumber=K-404", {
      key: "rsk_provider_full",
    });
    expect(none.status).toBe(404);
  });

  it("does not answer the open month, and 404 for a past month without a close", async () => {
    const { request } = setup([]);
    // NOW is 23 September 2026.
    const open = await request("/provider/billing/periods/2026-09", { key: "rsk_provider_full" });
    expect(open.status).toBe(404);
    const problem = (await open.json()) as { type: string; closesAt: string };
    expect(problem.type).toBe("urn:restow:problem:billing-period-open");
    expect(problem.closesAt).toBe("2026-09-30T22:00:00.000Z");
    expect(mocks.loadClosedPeriod).not.toHaveBeenCalled();
    mocks.loadClosedPeriod.mockResolvedValue(null);
    const missing = await request("/provider/billing/periods/2026-07", {
      key: "rsk_provider_full",
    });
    expect(missing.status).toBe(404);
    const invalid = await request("/provider/billing/periods/2026-13", {
      key: "rsk_provider_full",
    });
    expect([400, 422]).toContain(invalid.status);
  });

  it("lists the closed months with the open one", async () => {
    mocks.listClosedPeriods.mockResolvedValue([
      { period: periodRow, tenants: 2, customerCorrections: -2, corrections: 1 },
    ]);
    const { request, audits } = setup([]);
    const res = await request("/provider/billing/periods", { key: "rsk_provider_full" });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      items: [
        {
          period: "2026-08",
          status: "closed",
          timeZone: "Europe/Berlin",
          startsAt: "2026-07-31T22:00:00.000Z",
          endsAt: "2026-08-31T22:00:00.000Z",
          closedAt: "2026-08-31T22:00:40.000Z",
          currency: "EUR",
          tenants: 2,
          total: 24,
          correctedTotal: 22,
          corrections: 1,
        },
      ],
      open: {
        period: "2026-09",
        startsAt: "2026-08-31T22:00:00.000Z",
        closesAt: "2026-09-30T22:00:00.000Z",
      },
    });
    expect(audits).toEqual([]);
  });

  it("adds a correction with the key as its author", async () => {
    mocks.createCorrection.mockResolvedValue(loaded().corrections[0]);
    const { request } = setup([]);
    const res = await request("/provider/billing/periods/2026-08/corrections", {
      key: "rsk_provider_full",
      method: "POST",
      body: JSON.stringify({
        tenantId: TENANT_ID,
        type: "mailboxes",
        amount: -2,
        reason: "Two test mailboxes",
      }),
    });
    expect(res.status).toBe(201);
    expect(await res.json()).toMatchObject({ id: CORRECTION_ID, amount: -2, type: "mailboxes" });
    expect(mocks.createCorrection).toHaveBeenCalledWith(expect.anything(), {
      period: "2026-08",
      tenantId: TENANT_ID,
      lineType: "mailboxes",
      amount: -2,
      reason: "Two test mailboxes",
      actor: { label: "api-key:key-provider", keyId: "key-provider", ip: CLIENT_IP },
    });
    const zero = await request("/provider/billing/periods/2026-08/corrections", {
      key: "rsk_provider_full",
      method: "POST",
      body: JSON.stringify({ tenantId: TENANT_ID, amount: 0, reason: "nothing" }),
    });
    expect([400, 422]).toContain(zero.status);
  });

  it("is closed to tenant keys and to provider keys without the billing scopes", async () => {
    const { request } = setup([]);
    expect((await request("/provider/billing/periods")).status).toBe(403);
    expect((await request("/provider/billing/periods/2026-08")).status).toBe(403);
    expect(
      (await request("/provider/billing/periods/2026-08", { key: "rsk_provider_status" })).status,
    ).toBe(403);
    const correction = {
      method: "POST",
      body: JSON.stringify({ tenantId: TENANT_ID, amount: 1, reason: "late fee" }),
    };
    expect(
      (await request("/provider/billing/periods/2026-08/corrections", correction)).status,
    ).toBe(403);
    expect(
      (
        await request("/provider/billing/periods/2026-08/corrections", {
          ...correction,
          key: "rsk_provider_status",
        })
      ).status,
    ).toBe(403);
    expect(mocks.loadClosedPeriod).not.toHaveBeenCalled();
    expect(mocks.createCorrection).not.toHaveBeenCalled();
  });

  it("is not there while the edition does not open the provider API", async () => {
    const { request } = setup([], featuresOff);
    for (const path of ["/provider/billing/periods", "/provider/billing/periods/2026-08"]) {
      const res = await request(path, { key: "rsk_provider_full" });
      expect(res.status).toBe(403);
      expect(((await res.json()) as { type: string }).type).toBe(
        "urn:restow:problem:feature-unavailable",
      );
    }
    const res = await request("/provider/billing/periods/2026-08/corrections", {
      key: "rsk_provider_full",
      method: "POST",
      body: JSON.stringify({ tenantId: TENANT_ID, amount: 1, reason: "late fee" }),
    });
    expect(res.status).toBe(403);
    expect(mocks.listClosedPeriods).not.toHaveBeenCalled();
    expect(mocks.loadClosedPeriod).not.toHaveBeenCalled();
    expect(mocks.createCorrection).not.toHaveBeenCalled();
  });
});
