import { Hono } from "hono";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { errorHandler, notFoundHandler } from "../../problem.js";

/**
 * Route tests of /mounts: the real router and session middleware, with better-auth's
 * session lookup, the database handles and the service replaced at their module
 * boundary. Who may reach which endpoint (provider admins read, only the provider
 * owner changes or tests), the recent sign-in for adding and removing, and what is
 * refused before the service runs.
 */

const mocks = vi.hoisted(() => ({
  getSession: vi.fn(),
  memberships: [] as unknown[],
  providerRows: [] as unknown[],
}));

vi.mock("../../auth.js", () => ({ auth: { api: { getSession: mocks.getSession } } }));
vi.mock("../../db.js", () => {
  const chain = (rows: () => unknown): unknown =>
    new Proxy(() => undefined, {
      get: (_target, property) =>
        property === "then"
          ? (resolve: (value: unknown) => void) => resolve(rows())
          : () => chain(rows),
    });
  return {
    db: { select: () => chain(() => mocks.memberships) },
    providerDb: { select: () => chain(() => mocks.providerRows) },
  };
});

const { buildMountsRoutes } = await import("./routes.js");

const service = {
  view: vi.fn(),
  paths: vi.fn(),
  add: vi.fn(),
  remove: vi.fn(),
  cancelPending: vi.fn(),
  test: vi.fn(),
};

function app() {
  const root = new Hono();
  root.onError(errorHandler);
  root.notFound(notFoundHandler);
  root.route("/api/v1/mounts", buildMountsRoutes(service as never));
  return root;
}

function signedIn(
  role: "admin" | "user",
  options: { signedInSecondsAgo?: number; authMethod?: string } = {},
) {
  mocks.getSession.mockResolvedValue({
    session: {
      authMethod: options.authMethod ?? "passkey",
      impersonatedBy: null,
      activeOrganizationId: "org-1",
      createdAt: new Date(Date.now() - (options.signedInSecondsAgo ?? 60) * 1000),
    },
    user: {
      id: `${role}-id`,
      email: `${role}@provider.test`,
      role,
      banned: false,
      twoFactorEnabled: false,
    },
  });
}

async function call(method: string, path: string, init: { body?: unknown; key?: string } = {}) {
  const headers = new Headers({ "content-type": "application/json" });
  if (init.key) {
    headers.set("authorization", `Bearer ${init.key}`);
  }
  const response = await app().request(path, {
    method,
    headers,
    body: init.body === undefined ? undefined : JSON.stringify(init.body),
  });
  const text = await response.text();
  return { status: response.status, body: text.length > 0 ? JSON.parse(text) : null };
}

const SHARE = { protocol: "nfs", name: "nas", server: "10.0.0.5", export: "/srv/backup" };

const ROUTES: [string, string, unknown?][] = [
  ["GET", "/api/v1/mounts"],
  ["GET", "/api/v1/mounts/paths"],
  ["POST", "/api/v1/mounts", { mount: SHARE }],
  ["DELETE", "/api/v1/mounts/nas"],
  ["DELETE", "/api/v1/mounts/nas?pending=1"],
  ["POST", "/api/v1/mounts/test", { name: "nas" }],
];

const READ = new Set(["GET /api/v1/mounts", "GET /api/v1/mounts/paths"]);
const SUCCESS: Record<string, number> = {
  "POST /api/v1/mounts": 202,
  "DELETE /api/v1/mounts/nas": 202,
};

beforeEach(() => {
  vi.clearAllMocks();
  mocks.memberships = [];
  mocks.providerRows = [];
  for (const fn of Object.values(service)) {
    fn.mockResolvedValue({ ok: true });
  }
});

describe("who may use the Mounts section", () => {
  for (const [method, path, body] of ROUTES) {
    const key = `${method} ${path}`;
    const ok = SUCCESS[key] ?? 200;

    it(`${key}: 401 without a session`, async () => {
      mocks.getSession.mockResolvedValue(null);
      expect((await call(method, path, { body })).status).toBe(401);
    });

    it(`${key}: 403 for tenant users and API keys`, async () => {
      signedIn("user");
      mocks.memberships = [{ organizationId: "org-1", role: "owner" }];
      expect((await call(method, path, { body })).status).toBe(403);
      signedIn("admin");
      const response = await call(method, path, { body, key: "rsk_provider_0123456789abcdef" });
      expect(response.status).toBe(403);
      expect(response.body.type).toBe("urn:restow:problem:session-required");
      for (const fn of Object.values(service)) {
        expect(fn).not.toHaveBeenCalled();
      }
    });

    it(`${key}: served to the provider owner`, async () => {
      signedIn("admin");
      expect((await call(method, path, { body })).status).toBe(ok);
    });

    it(`${key}: the other team roles only read`, async () => {
      signedIn("admin");
      for (const role of ["read_only", "technician", "administrator"]) {
        mocks.providerRows = [{ role, allTenants: true }];
        const response = await call(method, path, { body });
        if (READ.has(key)) {
          expect(response.status, role).toBe(200);
        } else {
          expect(response.status, role).toBe(403);
          expect(response.body.type).toBe("urn:restow:problem:provider-role-required");
          expect(response.body.requiredProviderRole).toBe("owner");
        }
      }
    });
  }

  it("refuses a provider limited to some tenants: the shares are the installation's", async () => {
    signedIn("admin");
    mocks.providerRows = [{ role: "owner", allTenants: false }];
    expect((await call("GET", "/api/v1/mounts")).status).toBe(403);
  });
});

describe("what needs a recent sign-in", () => {
  it("adding and removing are refused 11 minutes after the sign-in", async () => {
    signedIn("admin", { signedInSecondsAgo: 11 * 60 });
    for (const [method, path, body] of [
      ["POST", "/api/v1/mounts", { mount: SHARE }],
      ["DELETE", "/api/v1/mounts/nas", undefined],
    ] as const) {
      const response = await call(method, path, { body });
      expect(response.status, path).toBe(403);
      expect(response.body.type).toBe("urn:restow:problem:recent-sign-in-required");
    }
    expect(service.add).not.toHaveBeenCalled();
    expect(service.remove).not.toHaveBeenCalled();
  });

  it("withdrawing a waiting add needs no fresh sign-in", async () => {
    signedIn("admin", { signedInSecondsAgo: 8 * 60 * 60 });
    expect((await call("DELETE", "/api/v1/mounts/nas?pending=1")).status).toBe(200);
    expect(service.cancelPending).toHaveBeenCalledWith("nas", {
      id: "admin-id",
      email: "admin@provider.test",
      ip: null,
    });
    expect(service.remove).not.toHaveBeenCalled();
  });

  it("a test and the list need no fresh sign-in", async () => {
    signedIn("admin", { signedInSecondsAgo: 8 * 60 * 60 });
    expect((await call("POST", "/api/v1/mounts/test", { body: { name: "nas" } })).status).toBe(200);
    expect((await call("GET", "/api/v1/mounts")).status).toBe(200);
  });
});

describe("what the routes accept", () => {
  beforeEach(() => signedIn("admin"));

  it("passes a valid share with the acting owner to the service", async () => {
    await call("POST", "/api/v1/mounts", { body: { mount: { ...SHARE, nfsVersion: "3" } } });
    expect(service.add).toHaveBeenCalledWith(
      { mount: { ...SHARE, nfsVersion: "3", readOnly: false } },
      { id: "admin-id", email: "admin@provider.test", ip: null },
    );
  });

  it("passes whenIdle on", async () => {
    await call("POST", "/api/v1/mounts", { body: { mount: SHARE, whenIdle: true } });
    expect(service.add).toHaveBeenCalledWith(
      { mount: { ...SHARE, nfsVersion: "4.1", readOnly: false }, whenIdle: true },
      expect.anything(),
    );
    expect(
      (await call("POST", "/api/v1/mounts", { body: { mount: SHARE, whenIdle: "yes" } })).status,
    ).toBe(422);
  });

  it("refuses invalid shares before the service runs", async () => {
    for (const mount of [
      { ...SHARE, name: "Bad Name" },
      { ...SHARE, server: "nas,nolock" },
      { ...SHARE, export: "relative" },
      { ...SHARE, export: "/a/../b" },
      { ...SHARE, nfsVersion: "2" },
      { ...SHARE, protocol: "smb" },
      { ...SHARE, options: "nolock" },
    ]) {
      expect((await call("POST", "/api/v1/mounts", { body: { mount } })).status).toBe(422);
    }
    expect((await call("DELETE", "/api/v1/mounts/Bad_Name")).status).toBe(422);
    expect((await call("POST", "/api/v1/mounts/test", { body: {} })).status).toBe(422);
    expect(service.add).not.toHaveBeenCalled();
    expect(service.remove).not.toHaveBeenCalled();
    expect(service.test).not.toHaveBeenCalled();
  });

  it("asks for a fresh state with ?refresh=1", async () => {
    await call("GET", "/api/v1/mounts?refresh=1");
    expect(service.view).toHaveBeenCalledWith({ refresh: true });
  });
});
