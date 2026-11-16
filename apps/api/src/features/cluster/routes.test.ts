import { Hono } from "hono";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { errorHandler, notFoundHandler } from "../../problem.js";

/**
 * Route tests of /cluster (routes.ts): the real router and session middleware, with better-auth's
 * session lookup, the database handles and the service replaced at their module boundary. Only the
 * provider team's owner reads or changes anything; a token and a removal need a recent sign-in;
 * tenant users and API keys get nothing; the token form is validated before the service runs.
 */

const mocks = vi.hoisted(() => ({
  getSession: vi.fn(),
  memberships: [] as unknown[],
  providerRows: [] as unknown[],
  service: {
    clusterView: vi.fn(),
    createJoinToken: vi.fn(),
    revokeJoinToken: vi.fn(),
    removeNode: vi.fn(),
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

const { buildClusterRoutes } = await import("./routes.js");

function app() {
  const root = new Hono();
  root.onError(errorHandler);
  root.notFound(notFoundHandler);
  root.route("/api/v1/cluster", buildClusterRoutes({} as never));
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

async function call(
  method: string,
  path: string,
  body?: unknown,
  headers: Record<string, string> = {},
) {
  const response = await app().request(path, {
    method,
    headers: { "content-type": "application/json", ...headers },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await response.text();
  return { status: response.status, body: text.length > 0 ? JSON.parse(text) : null };
}

const NODE = "0b8c8e5e-6d6a-4f7e-9d3c-1f2e3d4c5b6a";
const ROUTES: [string, string, unknown?, number?][] = [
  ["GET", "/api/v1/cluster", undefined, 200],
  ["POST", "/api/v1/cluster/join-tokens", { nodeName: "worker-1" }, 201],
  ["DELETE", `/api/v1/cluster/join-tokens/${NODE}`, undefined, 204],
  ["DELETE", `/api/v1/cluster/nodes/${NODE}`, undefined, 204],
];

beforeEach(() => {
  vi.clearAllMocks();
  mocks.memberships = [];
  mocks.providerRows = [];
  mocks.service.clusterView.mockResolvedValue({ nodes: [] });
  mocks.service.createJoinToken.mockResolvedValue({ id: "t1", token: "rsj_x", prefix: "rsj_x" });
  mocks.service.revokeJoinToken.mockResolvedValue(undefined);
  mocks.service.removeNode.mockResolvedValue(undefined);
});

describe("who may use Installation > Cluster", () => {
  for (const [method, path, body, ok] of ROUTES) {
    it(`${method} ${path}: the owner only`, async () => {
      mocks.getSession.mockResolvedValue(null);
      expect((await call(method, path, body)).status).toBe(401);
      signedIn("user");
      mocks.memberships = [{ organizationId: "org-1", role: "owner" }];
      expect((await call(method, path, body)).status).toBe(403);
      signedIn("admin");
      expect((await call(method, path, body)).status).toBe(ok);
      for (const role of ["read_only", "technician", "administrator"]) {
        mocks.providerRows = [{ role, allTenants: true }];
        expect((await call(method, path, body)).status, role).toBe(403);
      }
    });
  }

  it("refuses API keys", async () => {
    signedIn("admin");
    const response = await call("GET", "/api/v1/cluster", undefined, {
      authorization: "Bearer rsk_provider_0123456789abcdefghijABCDEFGHIJ0123456789",
    });
    expect(response.status).toBe(403);
  });
});

describe("join tokens and removals", () => {
  it("need a recent sign-in", async () => {
    signedIn("admin", 3600);
    for (const [method, path, body] of ROUTES.slice(1)) {
      const response = await call(method, path, body);
      expect(response.status, `${method} ${path}`).toBe(403);
      expect(response.body.type).toBe("urn:restow:problem:recent-sign-in-required");
    }
    expect(mocks.service.createJoinToken).not.toHaveBeenCalled();
    expect(mocks.service.removeNode).not.toHaveBeenCalled();
  });

  it("validates the token form before the service runs", async () => {
    signedIn("admin");
    for (const body of [
      { nodeName: "Worker 1" },
      { nodeName: "worker-1", ttlMinutes: 5 },
      { nodeName: "worker-1", ttlMinutes: 3000 },
      { nodeName: "worker-1", expectedAddress: "not-an-ip" },
      { nodeName: "worker-1", extra: true },
    ]) {
      expect((await call("POST", "/api/v1/cluster/join-tokens", body)).status).toBe(422);
    }
    expect(mocks.service.createJoinToken).not.toHaveBeenCalled();
  });

  it("passes the defaults and the owner to the service, and answers without caching", async () => {
    signedIn("admin");
    const response = await app().request("/api/v1/cluster/join-tokens", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ nodeName: "worker-1", expectedAddress: "198.51.100.20" }),
    });
    expect(response.status).toBe(201);
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(mocks.service.createJoinToken).toHaveBeenCalledWith(
      {},
      expect.objectContaining({
        nodeName: "worker-1",
        expectedAddress: "198.51.100.20",
        ttlMinutes: 60,
        standbyScheduler: false,
        actor: expect.objectContaining({ email: "admin@provider.test", userId: "admin-id" }),
      }),
    );
  });
});

describe("the node's .env", () => {
  it("quotes what Compose would read otherwise and keeps install.sh's own lines apart", async () => {
    const { envLine, formatJoinEnv } = await import("./service.js");
    expect(envLine("S3_SECRET_ACCESS_KEY", "abc/def+ghi=")).toBe(
      "S3_SECRET_ACCESS_KEY=abc/def+ghi=",
    );
    expect(envLine("RESTOW_PRODUCT_NAME", "Acme Backup")).toBe("RESTOW_PRODUCT_NAME='Acme Backup'");
    expect(envLine("X", `it's $HOME`)).toBe('X="it\'s $$HOME"');
    expect(() => envLine("X", "a\nb")).toThrow();
    const text = formatJoinEnv({
      node: { id: "n1", name: "worker-1" },
      version: "0.5.0",
      standbyScheduler: true,
      env: {
        RESTOW_NODE_ID: "n1",
        DATABASE_URL: "postgres://a:b@10.0.0.5:5432/restow?sslmode=verify-full",
      },
      caCertificate: "-----BEGIN CERTIFICATE-----\n",
      directories: ["/srv/a", "/mnt/restow/b"],
    });
    expect(text).toContain("RESTOW_JOIN_STANDBY_SCHEDULER=1\n");
    expect(text).toContain("RESTOW_JOIN_DIRECTORIES=/srv/a:/mnt/restow/b\n");
    expect(text).toContain(
      `RESTOW_JOIN_CA_B64=${Buffer.from("-----BEGIN CERTIFICATE-----\n").toString("base64")}\n`,
    );
    expect(text).toContain(
      "DATABASE_URL=postgres://a:b@10.0.0.5:5432/restow?sslmode=verify-full\n",
    );
  });
});
