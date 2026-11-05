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
  removeEndpoint: vi.fn(),
  holdSettings: vi.fn(),
  recovery: vi.fn(),
  rebind: vi.fn(),
}));

vi.mock("../../db.js", () => ({ db: {}, providerDb: {}, authDb: {} }));
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

vi.mock("./removal.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./removal.js")>()),
  removeEndpoint: mocks.removeEndpoint,
}));
vi.mock("../suspicion/service.js", () => ({ retentionHoldSettings: mocks.holdSettings }));
vi.mock("./instance-url.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./instance-url.js")>()),
  instanceUrl: async () => ({ url: "https://restow.firma.de", configured: true }),
}));
// Bare metal recovery (docs/BAREMETAL.md 9, 11): every service call answers the same stand-in.
vi.mock("./recovery-codes.js", () => ({
  issueRecoveryCode: mocks.recovery,
  revokeRecoveryCode: mocks.recovery,
  extendRecoveryCode: mocks.recovery,
  listRecoveries: mocks.recovery,
  getRecovery: mocks.recovery,
  approveRecovery: mocks.recovery,
  cancelRecovery: mocks.recovery,
  setRecoverySshKeys: mocks.recovery,
}));
vi.mock("./rebind.js", () => ({ createRebindToken: mocks.rebind }));

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
  mocks.removeEndpoint.mockResolvedValue({ id: ids.endpoint, state: "scheduled" });
  mocks.holdSettings.mockResolvedValue({ enabled: false });
  mocks.recovery.mockResolvedValue({ id: "r-1", status: "issued" });
  mocks.rebind.mockResolvedValue({ id: "t-1", token: "rset_x" });
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

describe("removing a machine (#65)", () => {
  const body = { mode: "delete", confirmHostname: "srv-01" };

  it("is refused eleven minutes after the sign-in and never reaches the service", async () => {
    signedIn(11 * 60);
    const response = await call("POST", "/remove", body);
    expect(response.status).toBe(403);
    expect(((await response.json()) as { type?: string }).type).toBe(RECENT_SIGN_IN);
    expect(mocks.removeEndpoint).not.toHaveBeenCalled();
  });

  it("is accepted right after a sign-in, with the installation's suspicion hold setting", async () => {
    signedIn(30);
    const response = await call("POST", "/remove", body);
    expect(response.status).toBe(202);
    expect(mocks.removeEndpoint).toHaveBeenCalledTimes(1);
    expect(mocks.removeEndpoint.mock.calls[0]?.[3]).toEqual(body);
    expect(mocks.removeEndpoint.mock.calls[0]?.[5]).toEqual({ suspicionHoldsApply: false });
  });

  it("needs the typed hostname and a known mode", async () => {
    signedIn(30);
    expect((await call("POST", "/remove", { mode: "delete" })).status).toBe(422);
    expect((await call("POST", "/remove", { ...body, mode: "archive" })).status).toBe(422);
    expect(mocks.removeEndpoint).not.toHaveBeenCalled();
  });
});

describe("bare metal recovery and rebind (docs/BAREMETAL.md 9, 11)", () => {
  const recovery = "22222222-2222-4222-8222-222222222222";
  const key = `ssh-ed25519 ${Buffer.concat([
    Buffer.from([0, 0, 0, 11]),
    Buffer.from("ssh-ed25519"),
    Buffer.from([0, 0, 0, 32]),
    Buffer.alloc(32, 7),
  ]).toString("base64")} admin@laptop`;
  const stepUp: [string, string, unknown, () => ReturnType<typeof vi.fn>][] = [
    ["POST", "/recovery-codes", {}, () => mocks.recovery],
    ["POST", `/recovery-codes/${recovery}/extend`, { validityHours: 8 }, () => mocks.recovery],
    ["POST", `/recoveries/${recovery}/approve`, {}, () => mocks.recovery],
    ["PUT", `/recoveries/${recovery}/ssh-keys`, { keys: [key] }, () => mocks.recovery],
    ["POST", "/rebind-token", { purpose: "reinstall" }, () => mocks.rebind],
  ];

  it.each(stepUp)("%s %s needs a recent sign-in", async (method, path, body, service) => {
    signedIn(11 * 60);
    const refused = await call(method, path, body);
    expect(refused.status).toBe(403);
    expect(((await refused.json()) as { type?: string }).type).toBe(RECENT_SIGN_IN);
    expect(service()).not.toHaveBeenCalled();
    signedIn(30);
    const served = await call(method, path, body);
    expect(served.status).toBeLessThan(300);
    expect(service()).toHaveBeenCalledTimes(1);
  });

  it("hands out the code and the token without a cache copy", async () => {
    signedIn(30);
    expect((await call("POST", "/recovery-codes", {})).headers.get("cache-control")).toBe(
      "no-store",
    );
    expect(
      (await call("POST", "/rebind-token", { purpose: "baremetal" })).headers.get("cache-control"),
    ).toBe("no-store");
  });

  it("leaves revoking, cancelling and reading to any admin session", async () => {
    signedIn(8 * 60 * 60);
    expect((await call("POST", `/recovery-codes/${recovery}/revoke`, {})).status).toBe(200);
    expect((await call("POST", `/recoveries/${recovery}/cancel`, {})).status).toBe(200);
    expect((await call("GET", "/recoveries")).status).toBe(200);
    expect((await call("GET", `/recoveries/${recovery}`)).status).toBe(200);
  });

  it("refuses unknown fields, out of range validity and keys that are not keys", async () => {
    signedIn(30);
    expect((await call("POST", "/recovery-codes", { validityHours: 49 })).status).toBe(422);
    expect((await call("POST", "/recovery-codes", { code: "RC-1" })).status).toBe(422);
    expect((await call("POST", "/rebind-token", { purpose: "mac_setup" })).status).toBe(422);
    expect(
      (await call("POST", "/rebind-token", { purpose: "reinstall", validityHours: 25 })).status,
    ).toBe(422);
    expect(
      (await call("PUT", `/recoveries/${recovery}/ssh-keys`, { keys: ["ssh-ed25519 AAAA"] }))
        .status,
    ).toBe(422);
    expect(mocks.recovery).not.toHaveBeenCalled();
    expect(mocks.rebind).not.toHaveBeenCalled();
  });
});
