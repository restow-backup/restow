import { type Context, Hono } from "hono";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { errorHandler } from "../../problem.js";

/**
 * POST /api/v1/pve/guests/:id/repository/reset (routes.ts): the guest's name typed as
 * confirmation and a recent sign-in, before the service begins a new backup chain. Sign-in and
 * the service are replaced at their module boundary; the service is tested against Postgres
 * and restic in repository.restic.pg.test.ts.
 */

const ids = vi.hoisted(() => ({
  tenant: "5a0c7c1e-8d2b-4c3a-9f1e-2b3c4d5e6f70",
  guest: "11111111-1111-4111-8111-111111111111",
}));
const repository = vi.hoisted(() => ({ resetGuestRepository: vi.fn() }));

vi.mock("../../db.js", () => ({ db: {}, providerDb: {} }));
vi.mock("../../middleware/session.js", () => {
  const user = { id: "user-1", email: "admin@contoso.example" };
  return {
    TENANT_HEADER: "x-restow-tenant",
    requireTenant: () => async (c: Context, next: () => Promise<void>) => {
      const age = Number(c.req.header("x-test-session-age") ?? "5");
      c.set("tenantId", ids.tenant);
      c.set("user", user);
      c.set("auth", {
        session: { createdAt: new Date(Date.now() - age * 1000), authMethod: "passkey" },
      });
      await next();
    },
    authenticate: async () => ({}),
    assertProviderRoute: () => undefined,
    resolveTenantAccess: async () => ({ tenant: { id: ids.tenant }, role: "tenant_admin" }),
  };
});
vi.mock("./repository.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./repository.js")>()),
  ...repository,
}));

const { pveRoutes } = await import("./routes.js");

const app = new Hono();
app.onError(errorHandler);
app.route("/pve", pveRoutes);

const headers = { "content-type": "application/json", "x-restow-tenant": ids.tenant };

beforeEach(() => {
  vi.clearAllMocks();
});

describe("resetting a container's repository", () => {
  it("needs a recent sign-in, then passes the typed name and the actor on", async () => {
    repository.resetGuestRepository.mockResolvedValue({ unavailablePoints: 3 });
    const old = await app.request(`/pve/guests/${ids.guest}/repository/reset`, {
      method: "POST",
      headers: { ...headers, "x-test-session-age": "3600" },
      body: JSON.stringify({ confirmName: "paperless" }),
    });
    expect(old.status).toBe(403);
    expect(((await old.json()) as { type: string }).type).toBe(
      "urn:restow:problem:recent-sign-in-required",
    );
    expect(repository.resetGuestRepository).not.toHaveBeenCalled();

    const fresh = await app.request(`/pve/guests/${ids.guest}/repository/reset`, {
      method: "POST",
      headers,
      body: JSON.stringify({ confirmName: "paperless" }),
    });
    expect(fresh.status).toBe(200);
    expect(await fresh.json()).toEqual({ unavailablePoints: 3 });
    const call = repository.resetGuestRepository.mock.calls[0];
    expect(call?.[1]).toBe(ids.tenant);
    expect(call?.[2]).toBe(ids.guest);
    expect(call?.[3]).toBe("paperless");
    expect(call?.[4]).toMatchObject({ label: "admin@contoso.example", userId: "user-1" });
  });

  it("refuses a body without the typed name", async () => {
    const response = await app.request(`/pve/guests/${ids.guest}/repository/reset`, {
      method: "POST",
      headers,
      body: JSON.stringify({}),
    });
    expect(response.status).toBe(422);
    expect(repository.resetGuestRepository).not.toHaveBeenCalled();
  });
});
