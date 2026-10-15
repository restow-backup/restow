import { Hono } from "hono";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { errorHandler, notFoundHandler } from "../../problem.js";

/**
 * Route tests of Installation > Database (database.ts): the real routers and session
 * middleware, with the session lookup, the database handles and the services replaced.
 * Every provider admin reads; the owner checks, moves, removes and handles the dumps;
 * moving, removing and every dump action need a recent sign-in.
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
    authDb: { select: () => chain(() => mocks.memberships) },
    providerDb: { select: () => chain(() => mocks.providerRows) },
  };
});

const { buildUpdatesRoutes } = await import("./routes.js");

const service = { view: vi.fn() };
const database = {
  view: vi.fn(),
  check: vi.fn(),
  move: vi.fn(),
  removeOldCopy: vi.fn(),
  issueDumpTicket: vi.fn(),
  downloadDump: vi.fn(),
  deleteDump: vi.fn(),
};

const DUMP = "restow-20260930-100000-0.3.6-to-0.4.0.dump";

function app() {
  const root = new Hono();
  root.onError(errorHandler);
  root.notFound(notFoundHandler);
  root.route("/api/v1/updates", buildUpdatesRoutes(service as never, undefined, database as never));
  return root;
}

function signedIn(signedInSecondsAgo = 60) {
  mocks.getSession.mockResolvedValue({
    session: {
      authMethod: "passkey",
      impersonatedBy: null,
      activeOrganizationId: "org-1",
      createdAt: new Date(Date.now() - signedInSecondsAgo * 1000),
    },
    user: {
      id: "admin-id",
      email: "admin@provider.test",
      role: "admin",
      banned: false,
      twoFactorEnabled: false,
    },
  });
}

async function call(method: string, path: string, body?: unknown) {
  return app().request(path, {
    method,
    headers: { "content-type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
}

const ROUTES: [string, string, unknown?][] = [
  ["GET", "/api/v1/updates/database"],
  ["POST", "/api/v1/updates/database/check", { targetDir: "/mnt/volume-1/restow-db" }],
  ["POST", "/api/v1/updates/database/move", { targetDir: "/mnt/volume-1/restow-db" }],
  ["DELETE", "/api/v1/updates/database/old-copies/c-1"],
  ["POST", `/api/v1/updates/dumps/${DUMP}/download`, {}],
  ["GET", `/api/v1/updates/dumps/${DUMP}?ticket=abc`],
  ["DELETE", `/api/v1/updates/dumps/${DUMP}`],
];

const STEP_UP = new Set([
  "POST /api/v1/updates/database/move",
  "DELETE /api/v1/updates/database/old-copies/c-1",
  `POST /api/v1/updates/dumps/${DUMP}/download`,
  `DELETE /api/v1/updates/dumps/${DUMP}`,
]);

beforeEach(() => {
  vi.clearAllMocks();
  mocks.memberships = [];
  mocks.providerRows = [];
  for (const fn of [...Object.values(database), service.view]) {
    fn.mockResolvedValue({ ok: true });
  }
  database.downloadDump.mockResolvedValue(
    new Response("PGDMP", {
      headers: {
        "content-type": "application/octet-stream",
        "content-disposition": `attachment; filename="${DUMP}"`,
      },
    }),
  );
});

describe("who may use Installation > Database", () => {
  for (const [method, path, body] of ROUTES) {
    const key = `${method} ${path}`;

    it(`${key}: 401 without a session, 403 for a tenant user`, async () => {
      mocks.getSession.mockResolvedValue(null);
      expect((await call(method, path, body)).status).toBe(401);
      mocks.getSession.mockResolvedValue({
        session: {
          authMethod: "passkey",
          impersonatedBy: null,
          activeOrganizationId: "org-1",
          createdAt: new Date(),
        },
        user: { id: "u", email: "u@t.test", role: "user", banned: false, twoFactorEnabled: false },
      });
      mocks.memberships = [{ organizationId: "org-1", role: "owner" }];
      expect((await call(method, path, body)).status).toBe(403);
      for (const fn of Object.values(database)) {
        expect(fn).not.toHaveBeenCalled();
      }
    });

    it(`${key}: reading for every team role, the rest for the owner`, async () => {
      signedIn();
      for (const role of ["read_only", "technician", "administrator"]) {
        mocks.providerRows = [{ role, allTenants: true }];
        const response = await call(method, path, body);
        expect(response.status, `${role} ${key}`).toBe(
          method === "GET" && path.endsWith("/database") ? 200 : 403,
        );
      }
      mocks.providerRows = [{ role: "owner", allTenants: true }];
      expect((await call(method, path, body)).status).toBe(200);
    });

    it(`${key}: ${STEP_UP.has(key) ? "needs" : "does not need"} a recent sign-in`, async () => {
      signedIn(11 * 60);
      const response = await call(method, path, body);
      if (STEP_UP.has(key)) {
        expect(response.status).toBe(403);
        const problem = (await response.json()) as { type: string };
        expect(problem.type).toBe("urn:restow:problem:recent-sign-in-required");
        for (const fn of Object.values(database)) {
          expect(fn).not.toHaveBeenCalled();
        }
      } else {
        expect(response.status).toBe(200);
      }
    });
  }

  it("is the installation's: a provider limited to some tenants is refused", async () => {
    signedIn();
    mocks.providerRows = [{ role: "owner", allTenants: false }];
    expect((await call("GET", "/api/v1/updates/database")).status).toBe(403);
  });
});

describe("what the routes accept", () => {
  beforeEach(() => signedIn());

  it("passes the directory and the acting owner on", async () => {
    await call("POST", "/api/v1/updates/database/move", { targetDir: " /mnt/volume-1/restow-db " });
    expect(database.move).toHaveBeenCalledWith(
      "/mnt/volume-1/restow-db",
      expect.objectContaining({ id: "admin-id", email: "admin@provider.test" }),
    );
  });

  it("refuses a request without a directory or with more", async () => {
    for (const body of [
      {},
      { targetDir: "" },
      { targetDir: 5 },
      { targetDir: "/mnt/x", force: true },
    ]) {
      expect(
        (await call("POST", "/api/v1/updates/database/move", body)).status,
        JSON.stringify(body),
      ).toBe(422);
    }
    expect(database.move).not.toHaveBeenCalled();
  });

  it("streams the dump the service hands over", async () => {
    const response = await call("GET", `/api/v1/updates/dumps/${DUMP}?ticket=abc`);
    expect(response.headers.get("content-disposition")).toBe(`attachment; filename="${DUMP}"`);
    expect(await response.text()).toBe("PGDMP");
    expect(database.downloadDump).toHaveBeenCalledWith(
      DUMP,
      "abc",
      expect.objectContaining({ id: "admin-id" }),
    );
  });
});
