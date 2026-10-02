import type { AuditLogEntry, Database, User } from "@restow/db";
import { Hono } from "hono";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import {
  registerApiExtension,
  resetExtensionsForTesting,
} from "../../../../apps/api/src/extensions.js";
import type { AuditEvent } from "../../../../apps/api/src/lib/audit.js";
import { errorHandler, notFoundHandler } from "../../../../apps/api/src/problem.js";
import { buildV1 } from "../../../../apps/api/src/routes/v1.js";
import { decodeCursor } from "../../../../apps/api/src/routes/v1/cursor.js";
import { featuresOn } from "../../../../apps/api/src/routes/v1/testing/features.js";
import {
  OTHER_TENANT_ID,
  TENANT_ID,
  bearer,
  fakeRequireKey,
} from "../../../../apps/api/src/routes/v1/testing/keys.js";
import { scriptedDb } from "../../../../apps/api/src/routes/v1/testing/scripted-db.js";
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
