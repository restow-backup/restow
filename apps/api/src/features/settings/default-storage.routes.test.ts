import { Hono } from "hono";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { errorHandler, notFoundHandler } from "../../problem.js";

/**
 * Route tests of /settings/default-storage: the real router and session
 * middleware, with better-auth's session lookup, the database handles and the
 * feature service replaced at their module boundary. Who may reach the two
 * endpoints, and what each hands to the service.
 */

const mocks = vi.hoisted(() => ({
  getSession: vi.fn(),
  getDefaultStorage: vi.fn(),
  testDefaultStorage: vi.fn(),
  memberships: [] as unknown[],
}));

vi.mock("../../auth.js", () => ({ auth: { api: { getSession: mocks.getSession } } }));
vi.mock("../../db.js", () => {
  // Membership lookups of non-provider users: `select().from().where()` resolves to the rows.
  const chain = (): unknown =>
    new Proxy(() => undefined, {
      get: (_target, property) =>
        property === "then"
          ? (resolve: (value: unknown) => void) => resolve(mocks.memberships)
          : () => chain(),
    });
  const db = { select: chain };
  return { db, providerDb: db };
});
vi.mock("./default-storage.js", () => ({
  getDefaultStorage: mocks.getDefaultStorage,
  testDefaultStorage: mocks.testDefaultStorage,
}));

const { settingsRoutes } = await import("./routes.js");

function app() {
  const root = new Hono();
  root.onError(errorHandler);
  root.notFound(notFoundHandler);
  root.route("/api/v1/settings", settingsRoutes);
  return root;
}

function signedIn(role: "admin" | "user") {
  mocks.getSession.mockResolvedValue({
    session: { authMethod: "passkey", impersonatedBy: null, activeOrganizationId: "org-1" },
    user: {
      id: `${role}-id`,
      email: `${role}@provider.test`,
      role,
      banned: false,
      twoFactorEnabled: false,
    },
  });
}

async function call(method: string, path: string, key?: string) {
  const headers = new Headers({ "content-type": "application/json" });
  if (key) {
    headers.set("authorization", `Bearer ${key}`);
  }
  const response = await app().request(`/api/v1/settings${path}`, { method, headers });
  const text = await response.text();
  return { status: response.status, body: text.length > 0 ? JSON.parse(text) : null };
}

const ENDPOINTS: [string, string][] = [
  ["GET", "/default-storage"],
  ["POST", "/default-storage/test"],
];

beforeEach(() => {
  vi.clearAllMocks();
  mocks.memberships = [];
  mocks.getDefaultStorage.mockResolvedValue({ configured: true, kind: "local" });
  mocks.testDefaultStorage.mockResolvedValue({ probe: { ok: true }, objectLock: null });
});

describe("who may use /settings/default-storage", () => {
  for (const [method, path] of ENDPOINTS) {
    it(`${method} ${path}: 401 without a session`, async () => {
      mocks.getSession.mockResolvedValue(null);
      expect((await call(method, path)).status).toBe(401);
    });

    it(`${method} ${path}: 403 for a tenant admin or tenant user`, async () => {
      signedIn("user");
      mocks.memberships = [{ organizationId: "org-1", role: "owner" }];
      expect((await call(method, path)).status).toBe(403);
      mocks.memberships = [{ organizationId: "org-1", role: "member" }];
      expect((await call(method, path)).status).toBe(403);
      expect(mocks.getDefaultStorage).not.toHaveBeenCalled();
      expect(mocks.testDefaultStorage).not.toHaveBeenCalled();
    });

    it(`${method} ${path}: 403 for an API key, even a provider key`, async () => {
      signedIn("admin");
      const response = await call(method, path, "rsk_provider_0123456789abcdef");
      expect(response.status).toBe(403);
      expect(response.body.type).toBe("urn:restow:problem:session-required");
    });
  }

  it("serves provider admins", async () => {
    signedIn("admin");
    expect(await call("GET", "/default-storage")).toMatchObject({
      status: 200,
      body: { configured: true, kind: "local" },
    });
    expect(mocks.getDefaultStorage).toHaveBeenCalledOnce();
  });

  it("runs the test as the signed-in provider admin", async () => {
    signedIn("admin");
    expect(await call("POST", "/default-storage/test")).toMatchObject({
      status: 200,
      body: { probe: { ok: true } },
    });
    expect(mocks.testDefaultStorage.mock.calls[0]?.[1]).toMatchObject({
      id: "admin-id",
      email: "admin@provider.test",
    });
  });
});
