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
import { featuresOn } from "../../../../apps/api/src/routes/v1/testing/features.js";
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

function setup(results: unknown[][]) {
  const script = scriptedDb(results);
  const audits: AuditEvent[] = [];
  const api = buildV1({
    // One scripted database for both pools: the script answers in call order.
    db: script.db,
    providerDb: script.db,
    requireKey: fakeRequireKey,
    requireFeature: featuresOn,
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
