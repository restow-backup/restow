import { Hono } from "hono";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { errorHandler, notFoundHandler } from "../../problem.js";

/**
 * Route tests of /updates and /maintenance: the real routers and session
 * middleware, with better-auth's session lookup, the database handles and the
 * service replaced at their module boundary. Who may reach which endpoint
 * (tenant users see the maintenance state, only provider admins the tab, only
 * the provider owner changes anything), what is refused before the service
 * runs, and that nothing in a response carries the access token.
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

const { buildMaintenanceRoutes, buildUpdatesRoutes } = await import("./routes.js");

const service = {
  view: vi.fn(),
  saveSettings: vi.fn(),
  checkNow: vi.fn(),
  schedule: vi.fn(),
  cancel: vi.fn(),
  dismiss: vi.fn(),
  maintenance: vi.fn(),
  switchToFullBuild: vi.fn(),
  storeLicenseKey: vi.fn(),
  removeLicenseKey: vi.fn(),
};

function app() {
  const root = new Hono();
  root.onError(errorHandler);
  root.notFound(notFoundHandler);
  root.route("/api/v1/updates", buildUpdatesRoutes(service as never));
  root.route("/api/v1/maintenance", buildMaintenanceRoutes(service as never));
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
  return { status: response.status, body: text.length > 0 ? JSON.parse(text) : null, text };
}

const TAB: [string, string, unknown?][] = [
  ["GET", "/api/v1/updates"],
  ["PATCH", "/api/v1/updates/settings", { enabled: true }],
  ["POST", "/api/v1/updates/check", {}],
  ["POST", "/api/v1/updates/maintenance", { version: "0.2.0", leadSeconds: 300 }],
  ["DELETE", "/api/v1/updates/maintenance"],
  ["POST", "/api/v1/updates/maintenance/dismiss", {}],
  ["POST", "/api/v1/updates/edition/switch", { leadSeconds: 300 }],
  ["PUT", "/api/v1/updates/edition/license-key", { key: "restow-license-v1.a.b" }],
  ["DELETE", "/api/v1/updates/edition/license-key"],
];

/** Everything that changes something is the owner's; the other team roles only read. */
const OWNER_ONLY = new Set([
  "PATCH /api/v1/updates/settings",
  "POST /api/v1/updates/check",
  "POST /api/v1/updates/maintenance",
  "DELETE /api/v1/updates/maintenance",
  "POST /api/v1/updates/maintenance/dismiss",
  "POST /api/v1/updates/edition/switch",
  "PUT /api/v1/updates/edition/license-key",
  "DELETE /api/v1/updates/edition/license-key",
]);

beforeEach(() => {
  vi.clearAllMocks();
  mocks.memberships = [];
  mocks.providerRows = [];
  for (const fn of Object.values(service)) {
    fn.mockResolvedValue({ ok: true });
  }
});

describe("who may use the Updates tab", () => {
  for (const [method, path, body] of TAB) {
    it(`${method} ${path}: 401 without a session`, async () => {
      mocks.getSession.mockResolvedValue(null);
      expect((await call(method, path, { body })).status).toBe(401);
    });

    it(`${method} ${path}: 403 for a tenant admin or tenant user`, async () => {
      signedIn("user");
      mocks.memberships = [{ organizationId: "org-1", role: "owner" }];
      expect((await call(method, path, { body })).status).toBe(403);
      mocks.memberships = [{ organizationId: "org-1", role: "member" }];
      expect((await call(method, path, { body })).status).toBe(403);
      for (const fn of Object.values(service)) {
        expect(fn).not.toHaveBeenCalled();
      }
    });

    it(`${method} ${path}: 403 for an API key, even a provider key`, async () => {
      signedIn("admin");
      const response = await call(method, path, { body, key: "rsk_provider_0123456789abcdef" });
      expect(response.status).toBe(403);
      expect(response.body.type).toBe("urn:restow:problem:session-required");
    });

    it(`${method} ${path}: served to the provider owner`, async () => {
      signedIn("admin");
      expect((await call(method, path, { body })).status).toBe(200);
    });

    it(`${method} ${path}: for the other provider team roles, by what it does`, async () => {
      signedIn("admin");
      const key = `${method} ${path}`;
      const allowed: Record<string, string[]> = {
        read_only: ["GET /api/v1/updates"],
        technician: ["GET /api/v1/updates"],
        administrator: ["GET /api/v1/updates"],
      };
      for (const [role, keys] of Object.entries(allowed)) {
        mocks.providerRows = [{ role, allTenants: true }];
        const response = await call(method, path, { body });
        const expected = keys.includes(key) ? 200 : 403;
        expect(response.status, `${role} ${key}`).toBe(expected);
        if (expected === 403) {
          expect(response.body.type).toBe("urn:restow:problem:provider-role-required");
          expect(response.body.requiredProviderRole).toBe(
            OWNER_ONLY.has(key) ? "owner" : "administrator",
          );
        }
      }
    });
  }

  it("refuses a provider limited to some tenants: the tab is the installation's", async () => {
    signedIn("admin");
    mocks.providerRows = [{ role: "administrator", allTenants: false }];
    const response = await call("GET", "/api/v1/updates");
    expect(response.status).toBe(403);
    expect(response.body.reason).toBe("scope");
  });
});

describe("what needs a recent sign-in", () => {
  const STEP_UP: [string, string, unknown][] = [
    ["PATCH", "/api/v1/updates/settings", { sourceUrl: "https://git.example.com/a/b" }],
    ["PATCH", "/api/v1/updates/settings", { sourceUrl: null }],
    ["PATCH", "/api/v1/updates/settings", { token: "t" }],
    ["PATCH", "/api/v1/updates/settings", { token: null }],
    ["PATCH", "/api/v1/updates/settings", { enabled: true, sourceUrl: "https://x.example/a/b" }],
    ["POST", "/api/v1/updates/maintenance", { version: "0.2.0", leadSeconds: 0 }],
    ["POST", "/api/v1/updates/maintenance", { version: "0.2.0", leadSeconds: 3600 }],
    ["POST", "/api/v1/updates/edition/switch", { leadSeconds: 0 }],
  ];

  for (const [method, path, body] of STEP_UP) {
    it(`${method} ${path} ${JSON.stringify(body)}: refused 11 minutes after the sign-in`, async () => {
      signedIn("admin", { signedInSecondsAgo: 11 * 60 });
      const response = await call(method, path, { body });
      expect(response.status).toBe(403);
      expect(response.body.type).toBe("urn:restow:problem:recent-sign-in-required");
      expect(response.body.maxAgeSeconds).toBe(600);
      expect(service.saveSettings).not.toHaveBeenCalled();
      expect(service.schedule).not.toHaveBeenCalled();
      expect(service.switchToFullBuild).not.toHaveBeenCalled();
    });

    it(`${method} ${path} ${JSON.stringify(body)}: served 9 minutes after the sign-in`, async () => {
      signedIn("admin", { signedInSecondsAgo: 9 * 60 });
      expect((await call(method, path, { body })).status).toBe(200);
    });
  }

  it("counts a fresh sign-in with the password and the authenticator code as well", async () => {
    signedIn("admin", { authMethod: "password_totp" });
    expect(
      (
        await call("POST", "/api/v1/updates/maintenance", {
          body: { version: "0.2.0", leadSeconds: 0 },
        })
      ).status,
    ).toBe(200);
  });

  it("leaves the switch, the channel, the check, cancelling and dismissing to any owner session", async () => {
    signedIn("admin", { signedInSecondsAgo: 8 * 60 * 60 });
    for (const [method, path, body] of [
      ["PATCH", "/api/v1/updates/settings", { enabled: false, channel: "beta" }],
      ["POST", "/api/v1/updates/check", {}],
      ["DELETE", "/api/v1/updates/maintenance", undefined],
      ["POST", "/api/v1/updates/maintenance/dismiss", {}],
      ["GET", "/api/v1/updates", undefined],
    ] as const) {
      expect((await call(method, path, { body })).status, `${method} ${path}`).toBe(200);
    }
  });

  it("still checks the owner role first", async () => {
    signedIn("admin", { signedInSecondsAgo: 11 * 60 });
    mocks.providerRows = [{ role: "administrator", allTenants: true }];
    const response = await call("POST", "/api/v1/updates/maintenance", {
      body: { version: "0.2.0", leadSeconds: 0 },
    });
    expect(response.status).toBe(403);
    expect(response.body.type).toBe("urn:restow:problem:provider-role-required");
  });
});

describe("what the tab accepts", () => {
  beforeEach(() => signedIn("admin"));

  it("passes a valid settings change to the service with the acting admin", async () => {
    await call("PATCH", "/api/v1/updates/settings", {
      body: {
        enabled: true,
        channel: "beta",
        sourceUrl: "https://git.example.com/a/b",
        token: "t",
      },
    });
    expect(service.saveSettings).toHaveBeenCalledWith(
      { enabled: true, channel: "beta", sourceUrl: "https://git.example.com/a/b", token: "t" },
      expect.objectContaining({ id: "admin-id", email: "admin@provider.test" }),
    );
  });

  it("rejects an empty change, an unknown channel, an unknown field and an oversized token", async () => {
    for (const body of [
      {},
      { channel: "nightly" },
      { enabled: true, surprise: 1 },
      { token: "x".repeat(501) },
      { token: "" },
      { sourceUrl: 5 },
    ]) {
      const response = await call("PATCH", "/api/v1/updates/settings", { body });
      expect(response.status, JSON.stringify(body)).toBe(422);
    }
    expect(service.saveSettings).not.toHaveBeenCalled();
  });

  it("accepts only the offered lead times", async () => {
    for (const leadSeconds of [0, 60, 300, 900, 1800, 3600]) {
      const response = await call("POST", "/api/v1/updates/maintenance", {
        body: { version: "0.2.0", leadSeconds },
      });
      expect(response.status).toBe(200);
    }
    for (const leadSeconds of [-1, 1, 61, 7200, 1.5, "300"]) {
      const response = await call("POST", "/api/v1/updates/maintenance", {
        body: { version: "0.2.0", leadSeconds },
      });
      expect(response.status, String(leadSeconds)).toBe(422);
    }
    expect(service.schedule).toHaveBeenCalledTimes(6);
  });

  it("requires a version", async () => {
    for (const body of [
      { leadSeconds: 0 },
      { version: "", leadSeconds: 0 },
      { version: 2, leadSeconds: 0 },
    ]) {
      expect((await call("POST", "/api/v1/updates/maintenance", { body })).status).toBe(422);
    }
  });

  it("returns the service's answer untouched, and it has no token in it", async () => {
    service.view.mockResolvedValue({ settings: { tokenSet: true }, running: "0.1.0" });
    const response = await call("GET", "/api/v1/updates");
    expect(response.body).toEqual({ settings: { tokenSet: true }, running: "0.1.0" });
  });
});

describe("who may see the maintenance state", () => {
  const cases: [string, () => void][] = [
    [
      "a provider admin",
      () => {
        signedIn("admin");
      },
    ],
    [
      "a tenant admin",
      () => {
        signedIn("user");
        mocks.memberships = [{ organizationId: "org-1", role: "owner" }];
      },
    ],
    [
      "a tenant user",
      () => {
        signedIn("user");
        mocks.memberships = [{ organizationId: "org-1", role: "member" }];
      },
    ],
  ];

  for (const [who, setup] of cases) {
    it(`serves ${who}`, async () => {
      setup();
      service.maintenance.mockResolvedValue({ phase: "scheduled", targetVersion: "0.2.0" });
      const response = await call("GET", "/api/v1/maintenance");
      expect(response.status).toBe(200);
      expect(response.body).toEqual({ phase: "scheduled", targetVersion: "0.2.0" });
    });
  }

  it("serves a provider admin of every team role", async () => {
    signedIn("admin");
    for (const role of ["read_only", "technician", "administrator", "owner"]) {
      mocks.providerRows = [{ role, allTenants: false }];
      expect((await call("GET", "/api/v1/maintenance")).status, role).toBe(200);
    }
  });

  it("needs a session and refuses API keys", async () => {
    mocks.getSession.mockResolvedValue(null);
    expect((await call("GET", "/api/v1/maintenance")).status).toBe(401);
    signedIn("admin");
    const response = await call("GET", "/api/v1/maintenance", {
      key: "rsk_tenant_0123456789abcdef",
    });
    expect(response.status).toBe(403);
  });

  it("offers nothing to write", async () => {
    signedIn("admin");
    expect((await call("POST", "/api/v1/maintenance", { body: {} })).status).toBe(404);
    expect((await call("DELETE", "/api/v1/maintenance")).status).toBe(404);
  });
});

describe("the build switch and the pending license key", () => {
  it("takes only a lead time for the switch, and passes it on", async () => {
    signedIn("admin");
    expect(
      (await call("POST", "/api/v1/updates/edition/switch", { body: { leadSeconds: 7 } })).status,
    ).toBe(422);
    expect(
      (
        await call("POST", "/api/v1/updates/edition/switch", {
          body: { leadSeconds: 300, to: "community" },
        })
      ).status,
    ).toBe(422);
    expect(service.switchToFullBuild).not.toHaveBeenCalled();
    await call("POST", "/api/v1/updates/edition/switch", { body: { leadSeconds: 300 } });
    expect(service.switchToFullBuild).toHaveBeenCalledWith(
      { leadSeconds: 300 },
      expect.objectContaining({ email: "admin@provider.test" }),
    );
  });

  it("stores a key without a fresh sign-in, but never an empty one", async () => {
    signedIn("admin", { signedInSecondsAgo: 11 * 60 });
    expect(
      (await call("PUT", "/api/v1/updates/edition/license-key", { body: { key: "  " } })).status,
    ).toBe(422);
    const response = await call("PUT", "/api/v1/updates/edition/license-key", {
      body: { key: " restow-license-v1.a.b " },
    });
    expect(response.status).toBe(200);
    expect(service.storeLicenseKey).toHaveBeenCalledWith(
      { key: "restow-license-v1.a.b" },
      expect.anything(),
    );
  });
});
