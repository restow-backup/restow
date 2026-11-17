import type { AuditLogEntry, Database } from "@restow/db";
import { Hono, type MiddlewareHandler } from "hono";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { AuditEvent } from "../../../../apps/api/src/lib/audit.js";
import type { SessionEnv } from "../../../../apps/api/src/middleware/session.js";
import { errorHandler } from "../../../../apps/api/src/problem.js";

/**
 * The session routes of Installation › Billing (0.6.0): the list with the open month, one month,
 * its CSV (audited as an export) and a correction with the signed-in person as its author. Who
 * may call them is the provider team rules' business (../provider-rules.ts, proved in
 * ../provider-access.test.ts); here a stand-in admits a provider admin.
 */

const mocks = vi.hoisted(() => ({
  listClosedPeriods: vi.fn(),
  loadClosedPeriod: vi.fn(),
  createCorrection: vi.fn(),
}));

vi.mock("./service.js", async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  ...mocks,
}));
vi.mock("../../../../apps/api/src/lib/installation-time-zone.js", () => ({
  loadInstallationTimeZone: async () => ({ timeZone: "Europe/Berlin", source: "settings" }),
}));
vi.mock("../../../../apps/api/src/db.js", () => ({ db: {}, providerDb: {}, authDb: {} }));

const { buildBillingRoutes } = await import("./routes.js");

const TENANT = "0f6e4b4e-2f2a-4d9a-9c2b-1a2b3c4d5e6f";
const PERIOD_ID = "cccccccc-3333-4333-8333-333333333333";
const periodRow = {
  id: PERIOD_ID,
  period: "2026-10",
  timeZone: "Europe/Berlin",
  startsAt: new Date("2026-09-30T22:00:00.000Z"),
  endsAt: new Date("2026-10-31T23:00:00.000Z"),
  closedAt: new Date("2026-10-31T23:00:30.000Z"),
  currency: "EUR",
  storageUnit: "TB",
  storageBilling: "exact",
  prices: {},
  perTenantOverrides: false,
  days: 31,
  sampledDays: 31,
  total: 20,
  createdAt: new Date("2026-10-31T23:00:30.000Z"),
};
const loaded = {
  period: periodRow,
  tenants: [
    {
      id: "dddddddd-4444-4444-8444-444444444444",
      periodId: PERIOD_ID,
      tenantId: TENANT,
      name: "Contoso",
      customerNumber: "K-1001",
      kind: "customer",
      status: "active",
      complete: true,
      sampledDays: 31,
      lines: [
        {
          type: "mailboxes",
          quantity: 10,
          unit: "mailbox",
          unitPrice: 2,
          priceSource: "installation",
          amount: 20,
          peakDate: "2026-10-14",
        },
      ],
      total: 20,
      createdAt: periodRow.createdAt,
    },
  ],
  corrections: [],
};

const asAdmin: MiddlewareHandler<SessionEnv> = async (c, next) => {
  c.set("user", { id: "user-1", email: "owner@provider.example" } as never);
  await next();
};

function setup() {
  const audits: AuditEvent[] = [];
  const routes = buildBillingRoutes({
    providerDb: {} as Database,
    requireProvider: asAdmin,
    audit: async (_db: unknown, event: AuditEvent) => {
      audits.push(event);
      return {} as AuditLogEntry;
    },
    now: () => new Date("2026-11-17T10:00:00.000Z"),
  });
  const app = new Hono();
  app.onError(errorHandler);
  app.route("/api/v1/billing", routes);
  return {
    audits,
    request: (path: string, init?: RequestInit) => app.request(`/api/v1/billing${path}`, init),
  };
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe("Installation › Billing routes", () => {
  it("lists the closed months with the open one and when it closes", async () => {
    mocks.listClosedPeriods.mockResolvedValue([
      { period: periodRow, tenants: 1, customerCorrections: 0, corrections: 0 },
    ]);
    const { request } = setup();
    const res = await request("/periods");
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({
      items: [{ period: "2026-10", tenants: 1, total: 20 }],
      open: { period: "2026-11", closesAt: "2026-11-30T23:00:00.000Z" },
    });
  });

  it("exports a month as CSV and records the export", async () => {
    mocks.loadClosedPeriod.mockResolvedValue(loaded);
    const { request, audits } = setup();
    const res = await request("/periods/2026-10/csv");
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("text/csv");
    expect(res.headers.get("content-disposition")).toContain("billing-2026-10.csv");
    const text = await res.text();
    expect(text).toContain("line,mailboxes,10,mailbox,2,installation,20,2026-10-14,EUR");
    expect(audits).toEqual([
      expect.objectContaining({
        tenantId: null,
        action: "billing.period.exported",
        target: "2026-10",
        actor: "owner@provider.example",
      }),
    ]);
  });

  it("answers 404 for the open month and adds a correction with the person as its author", async () => {
    const { request } = setup();
    const open = await request("/periods/2026-11");
    expect(open.status).toBe(404);
    expect(((await open.json()) as { type: string }).type).toBe(
      "urn:restow:problem:billing-period-open",
    );
    mocks.createCorrection.mockResolvedValue({
      id: "eeeeeeee-5555-4555-8555-555555555555",
      periodId: PERIOD_ID,
      tenantId: TENANT,
      lineType: null,
      amount: 5,
      reason: "Setup fee",
      actor: "owner@provider.example",
      apiKeyId: null,
      createdAt: new Date("2026-11-17T10:00:00.000Z"),
    });
    const res = await request("/periods/2026-10/corrections", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ tenantId: TENANT, amount: 5, reason: "Setup fee" }),
    });
    expect(res.status).toBe(201);
    expect(mocks.createCorrection).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        period: "2026-10",
        amount: 5,
        actor: expect.objectContaining({ label: "owner@provider.example", userId: "user-1" }),
      }),
    );
  });
});
