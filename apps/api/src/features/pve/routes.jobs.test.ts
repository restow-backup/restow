import { type Context, Hono } from "hono";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { errorHandler } from "../../problem.js";

/**
 * POST /api/v1/pve/jobs and PATCH /api/v1/pve/jobs/:id (routes.ts): `bandwidthKbps` and
 * `verifyReadEvery` were taken and stored but never applied (no upload limit reached the node,
 * the full read stayed every 30th backup). They are refused by name now, never dropped in
 * silence. The service is replaced at its module boundary; pve.pg.test.ts shows that a job
 * stored with them is listed without them and saved again without a refusal.
 */

const ids = vi.hoisted(() => ({
  tenant: "5a0c7c1e-8d2b-4c3a-9f1e-2b3c4d5e6f70",
  job: "22222222-2222-4222-8222-222222222222",
}));
const service = vi.hoisted(() => ({ saveJob: vi.fn() }));

vi.mock("../../db.js", () => ({ db: {}, providerDb: {} }));
vi.mock("../../middleware/session.js", () => {
  const user = { id: "user-1", email: "admin@contoso.example" };
  return {
    TENANT_HEADER: "x-restow-tenant",
    requireTenant: () => async (c: Context, next: () => Promise<void>) => {
      c.set("tenantId", ids.tenant);
      c.set("user", user);
      c.set("auth", { session: { createdAt: new Date(), authMethod: "passkey" } });
      await next();
    },
    authenticate: async () => ({}),
    assertProviderRoute: () => undefined,
    resolveTenantAccess: async () => ({ tenant: { id: ids.tenant }, role: "tenant_admin" }),
  };
});
vi.mock("./service.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./service.js")>()),
  ...service,
}));

const { pveRoutes } = await import("./routes.js");

const app = new Hono();
app.onError(errorHandler);
app.route("/pve", pveRoutes);

const headers = { "content-type": "application/json", "x-restow-tenant": ids.tenant };
const job = (settings: Record<string, unknown>) => ({
  name: "Nightly",
  scopeAll: false,
  schedule: null,
  enabled: true,
  settings,
});

beforeEach(() => {
  vi.clearAllMocks();
  service.saveJob.mockResolvedValue({ id: ids.job });
});

describe("Proxmox VE job settings that are not applied", () => {
  it.each([
    ["POST", "/pve/jobs"],
    ["PATCH", `/pve/jobs/${ids.job}`],
  ])("%s refuses bandwidthKbps and verifyReadEvery by name", async (method, path) => {
    for (const [settings, named] of [
      [{ bandwidthKbps: 20000 }, ["bandwidthKbps"]],
      [{ bandwidthKbps: null }, ["bandwidthKbps"]],
      [{ mode: "snapshot", verifyReadEvery: 7 }, ["verifyReadEvery"]],
      [{ bandwidthKbps: 0, verifyReadEvery: 1 }, ["bandwidthKbps", "verifyReadEvery"]],
    ] as const) {
      const response = await app.request(path, {
        method,
        headers,
        body: JSON.stringify(job(settings)),
      });
      expect(response.status).toBe(422);
      const problem = (await response.json()) as { detail: string; settings: string[] };
      expect(problem.settings).toEqual(named);
      expect(problem.detail).toContain("not supported for Proxmox VE jobs yet");
      for (const key of named) expect(problem.detail).toContain(key);
    }
    expect(service.saveJob).not.toHaveBeenCalled();
  });

  it("saves a job with the settings it applies", async () => {
    const response = await app.request(`/pve/jobs/${ids.job}`, {
      method: "PATCH",
      headers,
      body: JSON.stringify(job({ mode: "stop" })),
    });
    expect(response.status).toBe(200);
    expect(service.saveJob.mock.calls[0]?.[3]).toMatchObject({ settings: { mode: "stop" } });
  });
});
