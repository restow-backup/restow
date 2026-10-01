import type { Database } from "@restow/db";
import { Hono } from "hono";
import { streamSSE } from "hono/streaming";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { AuditEvent } from "../lib/audit.js";
import { ProblemError, errorHandler } from "../problem.js";
import { scriptedDb } from "../routes/v1/testing/scripted-db.js";

/**
 * The read audit of API keys on the feature routes they share with the web UI
 * (requireTenantOrApiKey), through the real middleware: the database and the
 * audit writer are replaced at their module boundary. A key read of user or
 * backup data must land in the audit log under the integration API's action
 * names; failed reads, changes and session reads are not recorded here.
 */

const state = vi.hoisted(() => ({
  db: null as unknown,
  audit: vi.fn(),
  getSession: vi.fn(),
}));

vi.mock("../auth.js", () => ({ auth: { api: { getSession: state.getSession } } }));
vi.mock("../db.js", () => {
  const pool = new Proxy(
    {},
    { get: (_target, property) => (state.db as Record<PropertyKey, unknown>)[property] },
  );
  return { db: pool, providerDb: pool };
});
vi.mock("../lib/audit.js", async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  audit: state.audit,
}));

const { requireTenantOrApiKey } = await import("./apiKey.js");

const TENANT = "5a0c7c1e-8d2b-4c3a-9f1e-2b3c4d5e6f70";
const OBJECT = "7c9e6679-7425-40de-944b-e07fc1f90ae7";
const JOB = "0b4b8a9e-3c1d-4e2f-8a7b-6c5d4e3f2a1b";
const KEY_ID = "3f2e1d0c-9b8a-4765-8432-10fedcba9876";
const TOKEN = `rsk_contoso_${"k".repeat(40)}`;
const CLIENT_IP = "203.0.113.7";

const keyRow = {
  id: KEY_ID,
  tenantId: TENANT,
  scopes: ["jobs:read", "items:read", "restore:write", "webhooks:manage"],
  expiresAt: null,
  revokedAt: null,
  lastUsedAt: new Date(),
  tenantStatus: "active",
};

const tenantRow = {
  id: TENANT,
  name: "Contoso",
  slug: "contoso",
  status: "active",
  mailboxCap: null,
  createdAt: new Date("2026-01-01T00:00:00.000Z"),
};

function app() {
  // Every request: the key lookup, then the key's tenant.
  state.db = scriptedDb([[keyRow], [tenantRow], [keyRow], [tenantRow]]).db as Database;
  const hono = new Hono();
  hono.onError(errorHandler);
  const readJobs = requireTenantOrApiKey("jobs:read");
  const readItems = requireTenantOrApiKey("items:read");
  const control = requireTenantOrApiKey("restore:write");
  const webhooks = requireTenantOrApiKey("webhooks:manage");
  hono.get("/jobs", readJobs, (c) => c.json({ items: [] }));
  hono.get("/jobs/objects/:id/snapshots", readItems, (c) => c.json({ snapshots: [] }));
  hono.get("/jobs/:id", readJobs, (c) => c.json({ id: c.req.param("id") }));
  hono.get("/jobs/:id/events", readJobs, (c) =>
    streamSSE(c, async (stream) => {
      await stream.writeSSE({ event: "end", data: "{}" });
    }),
  );
  hono.get("/missing/:id", readItems, () => {
    throw new ProblemError(404, "Protected object not found");
  });
  hono.post("/jobs/backup", control, (c) => c.json({ queued: [] }, 202));
  hono.get("/webhooks/:id", webhooks, (c) => c.json({ id: c.req.param("id") }));
  return hono;
}

function read(hono: Hono, path: string, init: RequestInit = {}) {
  return hono.request(path, {
    ...init,
    headers: {
      authorization: `Bearer ${TOKEN}`,
      "x-forwarded-for": CLIENT_IP,
      ...(init.headers as Record<string, string> | undefined),
    },
  });
}

function recorded(): AuditEvent[] {
  return state.audit.mock.calls.map(([, event]) => event as AuditEvent);
}

beforeEach(() => {
  vi.clearAllMocks();
  state.audit.mockResolvedValue({});
});

describe("key reads on the shared feature routes", () => {
  it("records a read of backup data under the integration API's action", async () => {
    const res = await read(app(), `/jobs/objects/${OBJECT}/snapshots?limit=5`);
    expect(res.status).toBe(200);
    expect(recorded()).toEqual([
      {
        tenantId: TENANT,
        actor: `api-key:${KEY_ID}`,
        actorUserId: null,
        action: "api.objects.read",
        target: OBJECT,
        targetType: "protected_object",
        ip: CLIENT_IP,
        details: {
          keyId: KEY_ID,
          route: "GET /jobs/objects/:id/snapshots",
          filters: { limit: "5" },
        },
      },
    ]);
  });

  it("names jobs reads like the integration API: the list, one job, its stream", async () => {
    const hono = app();
    expect((await read(hono, "/jobs?status=failed")).status).toBe(200);
    const stream = await read(hono, `/jobs/${JOB}/events`);
    expect(stream.status).toBe(200);
    await stream.text();
    expect(
      recorded().map(({ action, target, targetType }) => ({ action, target, targetType })),
    ).toEqual([
      { action: "api.jobs.read", target: TENANT, targetType: "tenant" },
      { action: "api.job.events.opened", target: JOB, targetType: "job" },
    ]);

    vi.clearAllMocks();
    state.audit.mockResolvedValue({});
    expect((await read(app(), `/jobs/${JOB}`)).status).toBe(200);
    expect(recorded()[0]).toMatchObject({ action: "api.job.read", target: JOB, targetType: "job" });
  });

  it("records nothing for a read that failed", async () => {
    const res = await read(app(), `/missing/${OBJECT}`);
    expect(res.status).toBe(404);
    expect(state.audit).not.toHaveBeenCalled();
  });

  it("leaves changes to the services that make them", async () => {
    const res = await read(app(), "/jobs/backup", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: "{}",
    });
    expect(res.status).toBe(202);
    expect(state.audit).not.toHaveBeenCalled();
  });

  it("does not record reads of webhook configuration, as on the integration API", async () => {
    const res = await read(app(), `/webhooks/${OBJECT}`);
    expect(res.status).toBe(200);
    expect(state.audit).not.toHaveBeenCalled();
  });

  it("serves nothing when the read cannot be recorded", async () => {
    state.audit.mockRejectedValue(new Error("audit log unavailable"));
    const res = await read(app(), `/jobs/objects/${OBJECT}/snapshots`);
    expect(res.status).toBe(500);
    expect(await res.text()).not.toContain("snapshots");
  });
});

describe("session reads on the shared feature routes", () => {
  it("are not recorded as key reads", async () => {
    state.getSession.mockResolvedValue({
      session: { id: "session-id", userId: "ops-id", authMethod: "passkey" },
      user: { id: "ops-id", email: "ops@provider.example", role: "admin", banned: false },
    });
    // The provider team lookup (no row: an owner), then the tenant.
    state.db = scriptedDb([[], [{ ...tenantRow, organizationId: null }]]).db as Database;
    const hono = new Hono();
    hono.onError(errorHandler);
    hono.get("/jobs", requireTenantOrApiKey("jobs:read"), (c) => c.json({ items: [] }));
    const res = await hono.request("/jobs", { headers: { "x-restow-tenant": TENANT } });
    expect(res.status).toBe(200);
    expect(state.audit).not.toHaveBeenCalled();
  });
});
