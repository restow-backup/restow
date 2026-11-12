import { Hono } from "hono";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { errorHandler, notFoundHandler } from "../../problem.js";

/**
 * Route tests of /restore-mode (routes.ts): the real router and session middleware, with
 * better-auth's session lookup, the database handles and the service replaced at their module
 * boundary. Every provider admin reads and compares; switching on, importing keys and ending it
 * are the provider owner's and need a recent sign-in; tenant users and API keys get nothing; the
 * end form is validated before the service runs.
 */

const mocks = vi.hoisted(() => ({
  getSession: vi.fn(),
  memberships: [] as unknown[],
  providerRows: [] as unknown[],
  service: {
    restoreModeView: vi.fn(),
    restoreModeBanner: vi.fn(),
    checkRestoreMode: vi.fn(),
    startRestoreMode: vi.fn(),
    importRestoreModeKeys: vi.fn(),
    endRestoreModeConfirmed: vi.fn(),
  },
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
    authDb: { select: () => chain(() => mocks.memberships) },
    providerDb: { select: () => chain(() => mocks.providerRows) },
  };
});
vi.mock("./service.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./service.js")>()),
  ...mocks.service,
}));

const { buildRestoreModeRoutes } = await import("./routes.js");

const guard = { forgetChecks: vi.fn() };

function app() {
  const root = new Hono();
  root.onError(errorHandler);
  root.notFound(notFoundHandler);
  root.route(
    "/api/v1/restore-mode",
    buildRestoreModeRoutes({} as never, () => guard as never),
  );
  return root;
}

function signedIn(role: "admin" | "user", signedInSecondsAgo = 60) {
  mocks.getSession.mockResolvedValue({
    session: {
      authMethod: "passkey",
      impersonatedBy: null,
      activeOrganizationId: "org-1",
      createdAt: new Date(Date.now() - signedInSecondsAgo * 1000),
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

async function call(method: string, path: string, body?: unknown) {
  const response = await app().request(path, {
    method,
    headers: { "content-type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await response.text();
  return { status: response.status, body: text.length > 0 ? JSON.parse(text) : null };
}

const END = {
  checked: "Compared the restore points with the customer's tickets.",
  confirmation: "END",
  storageOnlyData: "keep",
};

const ROUTES: [string, string, unknown?][] = [
  ["GET", "/api/v1/restore-mode"],
  ["GET", "/api/v1/restore-mode/banner"],
  ["POST", "/api/v1/restore-mode/check", {}],
  ["POST", "/api/v1/restore-mode/start", { reason: "rollback" }],
  ["POST", "/api/v1/restore-mode/import-keys", {}],
  ["POST", "/api/v1/restore-mode/end", END],
];
const OWNER_ONLY = new Set([
  "POST /api/v1/restore-mode/start",
  "POST /api/v1/restore-mode/import-keys",
  "POST /api/v1/restore-mode/end",
]);

beforeEach(() => {
  vi.clearAllMocks();
  mocks.memberships = [];
  mocks.providerRows = [];
  for (const fn of Object.values(mocks.service)) {
    fn.mockResolvedValue({ ok: true });
  }
  mocks.service.checkRestoreMode.mockResolvedValue([]);
  mocks.service.endRestoreModeConfirmed.mockResolvedValue({
    ended: true,
    rebase: [],
    acceptedUnreachable: [],
  });
});

describe("who may use restore mode", () => {
  for (const [method, path, body] of ROUTES) {
    it(`${method} ${path}: 401 without a session, 403 for tenant users`, async () => {
      mocks.getSession.mockResolvedValue(null);
      expect((await call(method, path, body)).status).toBe(401);
      signedIn("user");
      mocks.memberships = [{ organizationId: "org-1", role: "owner" }];
      expect((await call(method, path, body)).status).toBe(403);
    });

    it(`${method} ${path}: by provider team role`, async () => {
      signedIn("admin");
      expect((await call(method, path, body)).status).toBe(200);
      const key = `${method} ${path}`;
      for (const role of ["read_only", "technician", "administrator"]) {
        mocks.providerRows = [{ role, allTenants: true }];
        const allowed = !OWNER_ONLY.has(key) && (key.startsWith("GET") || role === "administrator");
        expect((await call(method, path, body)).status, `${role} ${key}`).toBe(allowed ? 200 : 403);
      }
    });
  }
});

describe("ending restore mode", () => {
  it("needs a recent sign-in", async () => {
    signedIn("admin", 3600);
    const response = await call("POST", "/api/v1/restore-mode/end", END);
    expect(response.status).toBe(403);
    expect(response.body.type).toBe("urn:restow:problem:recent-sign-in-required");
    expect(mocks.service.endRestoreModeConfirmed).not.toHaveBeenCalled();
  });

  it("refuses a short description, a missing confirmation and an unknown choice", async () => {
    signedIn("admin");
    for (const body of [
      { ...END, checked: "too short" },
      { ...END, confirmation: "end" },
      { ...END, storageOnlyData: "delete" },
    ]) {
      expect((await call("POST", "/api/v1/restore-mode/end", body)).status).toBe(422);
    }
    expect(mocks.service.endRestoreModeConfirmed).not.toHaveBeenCalled();
  });

  it("passes what was checked and who did it to the service", async () => {
    signedIn("admin");
    expect((await call("POST", "/api/v1/restore-mode/end", END)).status).toBe(200);
    expect(mocks.service.endRestoreModeConfirmed).toHaveBeenCalledWith(
      {},
      guard,
      expect.objectContaining({
        checked: END.checked,
        storageOnlyData: "keep",
        actor: expect.objectContaining({ email: "admin@provider.test", userId: "admin-id" }),
      }),
    );
  });
});
