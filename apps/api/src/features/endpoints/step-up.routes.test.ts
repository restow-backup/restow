import { type Context, Hono } from "hono";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { errorHandler } from "../../problem.js";

/**
 * The step-up of the endpoint routes (routes.ts, lib/recent-sign-in.ts):
 * setting or changing a hook and showing the repository password need a
 * sign-in from the last ten minutes; everything else an admin does to an
 * endpoint does not. Sign-in and the service are replaced at their module
 * boundary; the session the route sees is the one better-auth would hand it.
 */

const ids = vi.hoisted(() => ({
  tenant: "5a0c7c1e-8d2b-4c3a-9f1e-2b3c4d5e6f70",
  endpoint: "11111111-1111-4111-8111-111111111111",
}));
const mocks = vi.hoisted(() => ({
  session: {} as { authMethod?: string; createdAt?: Date },
  updateEndpoint: vi.fn(),
  revealRepositoryPassword: vi.fn(),
}));

vi.mock("../../db.js", () => ({ db: {}, providerDb: {} }));
vi.mock("../../middleware/session.js", () => {
  const user = { id: "user-1", email: "admin@contoso.example" };
  return {
    TENANT_HEADER: "x-restow-tenant",
    requireTenant: () => async (c: Context, next: () => Promise<void>) => {
      c.set("tenantId", ids.tenant);
      c.set("user", user);
      c.set("auth", { session: mocks.session, user });
      c.set("isProviderAdmin", false);
      c.set("providerAccess", null);
      await next();
    },
    authenticate: async () => {
      throw new Error("not used here");
    },
    assertProviderRoute: () => undefined,
    resolveTenantAccess: async () => {
      throw new Error("not used here");
    },
  };
});
vi.mock("./service.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./service.js")>()),
  updateEndpoint: mocks.updateEndpoint,
  revealRepositoryPassword: mocks.revealRepositoryPassword,
}));

const { endpointsRoutes } = await import("./routes.js");
const { hookChangeNeedsRecentSignIn } = await import("./service.js");

const app = new Hono();
app.onError(errorHandler);
app.route("/endpoints", endpointsRoutes);

const headers = { "content-type": "application/json", "x-restow-tenant": ids.tenant };
const call = (method: string, path: string, body?: unknown) =>
  app.request(`/endpoints/${ids.endpoint}${path}`, {
    method,
    headers,
    body: body === undefined ? undefined : JSON.stringify(body),
  });

function signedIn(secondsAgo: number, authMethod = "passkey") {
  mocks.session = { authMethod, createdAt: new Date(Date.now() - secondsAgo * 1000) };
}

const RECENT_SIGN_IN = "urn:restow:problem:recent-sign-in-required";

beforeEach(() => {
  vi.clearAllMocks();
  // The service asks for the confirmation exactly when the hooks it would store leave one to run.
  mocks.updateEndpoint.mockImplementation(
    async (
      _db: unknown,
      _tenantId: string,
      _id: string,
      input: { config?: { hooks?: { pre?: string; post?: string } } },
      _actor: unknown,
      options: { confirmHookChange?: () => void } = {},
    ) => {
      const hooks = input.config?.hooks;
      if (hooks && hookChangeNeedsRecentSignIn(hooks)) {
        options.confirmHookChange?.();
      }
      return { configVersion: 2, changed: hooks ? ["config.hooks"] : ["config.paths"] };
    },
  );
  mocks.revealRepositoryPassword.mockResolvedValue({
    password: "restic-password",
    storagePrefix: `endpoints/${ids.endpoint}/`,
  });
});

describe("changing hooks", () => {
  const hook = { config: { hooks: { pre: "pg_dumpall > /srv/all.sql" } } };

  it("is refused eleven minutes after the sign-in, with the type the web app reacts to", async () => {
    signedIn(11 * 60);
    const response = await call("PATCH", "", hook);
    expect(response.status).toBe(403);
    expect(await response.json()).toMatchObject({ type: RECENT_SIGN_IN, maxAgeSeconds: 600 });
  });

  it("is served nine minutes after a sign-in with a passkey, the password and code, or Microsoft", async () => {
    for (const method of ["passkey", "password_totp", "oidc"]) {
      signedIn(9 * 60, method);
      expect((await call("PATCH", "", hook)).status, method).toBe(200);
    }
  });

  it("does not count an impersonation or a password alone as a sign-in", async () => {
    for (const method of ["impersonation", "password"]) {
      signedIn(10, method);
      expect((await call("PATCH", "", hook)).status, method).toBe(403);
    }
  });

  it("leaves other settings and the removal of every hook to any session", async () => {
    signedIn(8 * 60 * 60);
    expect((await call("PATCH", "", { config: { paths: ["/srv"] } })).status).toBe(200);
    expect((await call("PATCH", "", { config: { hooks: { pre: "", post: "" } } })).status).toBe(
      200,
    );
    expect((await call("PATCH", "", { displayName: "db-1" })).status).toBe(200);
  });
});

describe("showing the repository password", () => {
  it("is refused eleven minutes after the sign-in and never reaches the service", async () => {
    signedIn(11 * 60);
    const response = await call("POST", "/repository-password", {});
    expect(response.status).toBe(403);
    const body = (await response.json()) as { type?: string };
    expect(body.type).toBe(RECENT_SIGN_IN);
    expect(JSON.stringify(body)).not.toContain("restic-password");
    expect(mocks.revealRepositoryPassword).not.toHaveBeenCalled();
  });

  it("is served right after a sign-in, and nothing may keep a copy", async () => {
    signedIn(30);
    const response = await call("POST", "/repository-password", {});
    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(await response.json()).toMatchObject({ password: "restic-password" });
    expect(mocks.revealRepositoryPassword).toHaveBeenCalledTimes(1);
  });
});
