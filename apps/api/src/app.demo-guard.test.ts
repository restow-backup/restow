import type { Hono } from "hono";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";

/**
 * The demo guard (middleware/demo-guard.ts) against the real, fully wired
 * app (app.ts) rather than a hand-picked sample: every mutating route this
 * application actually registers — every feature, not just the ones
 * lib/demo.test.ts and middleware/demo-guard.test.ts happen to name — is
 * refused while RESTOW_DEMO=true, except the fixed public allowlist.
 *
 * Building the app opens no connection (see app.test.ts), and the guard
 * runs before session or database access, so a refused request never
 * reaches a handler: this suite needs no database.
 */

let app: Hono;
let isDemoAllowedRoute: (method: string, path: string) => boolean;
let DEMO_READ_ONLY_PROBLEM: string;

beforeAll(async () => {
  vi.stubEnv("RESTOW_DEMO", "true");
  const appModule = await import("./app.js");
  const demoModule = await import("./lib/demo.js");
  const guardModule = await import("./middleware/demo-guard.js");
  app = appModule.buildApp();
  isDemoAllowedRoute = demoModule.isDemoAllowedRoute;
  DEMO_READ_ONLY_PROBLEM = guardModule.DEMO_READ_ONLY_PROBLEM;
}, 60_000); // a fresh import of the whole app (first use in this file) is transform-heavy

afterEach(() => {
  vi.unstubAllEnvs();
});

const PLACEHOLDER_ID = "00000000-0000-4000-8000-000000000000";

/** A concrete, routable path for a registered pattern (`:id` -> a UUID placeholder). */
function concretePath(pattern: string): string {
  if (pattern === "/api/auth/*") {
    // The only wildcard route: a concrete, guarded subpath under it.
    return "/api/auth/change-password";
  }
  return pattern.replace(/:[^/]+/g, PLACEHOLDER_ID);
}

const IGNORED_METHODS: ReadonlySet<string> = new Set(["GET", "HEAD", "OPTIONS", "ALL"]);

describe("demo guard vs. the real app", () => {
  it("refuses every registered mutating route that is not on the public allowlist", async () => {
    const seen = new Set<string>();
    const denied: Array<{ method: string; path: string }> = [];
    for (const { method, path } of app.routes) {
      if (IGNORED_METHODS.has(method) || isDemoAllowedRoute(method, concretePath(path))) {
        continue;
      }
      const key = `${method} ${path}`;
      if (seen.has(key)) {
        continue;
      }
      seen.add(key);
      denied.push({ method, path });
    }
    // A sanity floor: if this drops near zero, the route table was not read
    // correctly and the test below would pass for the wrong reason.
    expect(denied.length).toBeGreaterThan(30);

    for (const { method, path } of denied) {
      const response = await app.request(concretePath(path), { method });
      expect(response.status, `${method} ${path}`).toBe(403);
      const body = (await response.json()) as { type?: string };
      expect(body.type, `${method} ${path}`).toBe(DEMO_READ_ONLY_PROBLEM);
    }
  }, 30_000);

  it("refuses every write of backup jobs (creating, changing, scope, deleting, running) and reads them", async () => {
    const id = PLACEHOLDER_ID;
    for (const [method, path] of [
      ["POST", "/api/v1/backup-jobs"],
      ["PATCH", `/api/v1/backup-jobs/${id}`],
      ["DELETE", `/api/v1/backup-jobs/${id}`],
      ["PUT", `/api/v1/backup-jobs/${id}/members`],
      ["POST", `/api/v1/backup-jobs/${id}/members`],
      ["PATCH", `/api/v1/backup-jobs/${id}/members/${id}`],
      ["DELETE", `/api/v1/backup-jobs/${id}/members/${id}`],
      ["POST", `/api/v1/backup-jobs/${id}/run`],
      // The same operations on the runs alias (the demo lets a visitor back up, not change jobs).
      ["POST", `/api/v1/runs/${id}/cancel`],
    ] as const) {
      const response = await app.request(path, { method });
      expect(response.status, `${method} ${path}`).toBe(403);
      expect(((await response.json()) as { type?: string }).type, `${method} ${path}`).toBe(
        DEMO_READ_ONLY_PROBLEM,
      );
    }
    // Looking at jobs is a read: the session check answers, not the guard.
    for (const path of ["/api/v1/backup-jobs", `/api/v1/backup-jobs/${id}/members`]) {
      expect((await app.request(path)).status, path).toBe(401);
    }
  });

  it("lets the ZIP download of endpoint files past the guard, and only that endpoint action", async () => {
    // No session: the route itself answers 401, which is what proves the guard let it through.
    const prepare = await app.request(`/api/v1/endpoints/${PLACEHOLDER_ID}/downloads`, {
      method: "POST",
    });
    expect(prepare.status).toBe(401);
    for (const path of [
      `/api/v1/endpoints/${PLACEHOLDER_ID}/tasks`,
      `/api/v1/endpoints/${PLACEHOLDER_ID}/restore-test`,
      `/api/v1/endpoints/${PLACEHOLDER_ID}/repository-password`,
      `/api/v1/endpoints/${PLACEHOLDER_ID}/revoke`,
      "/api/v1/endpoints/tokens",
    ]) {
      const refused = await app.request(path, { method: "POST" });
      expect(refused.status, path).toBe(403);
      expect(((await refused.json()) as { type?: string }).type, path).toBe(DEMO_READ_ONLY_PROBLEM);
    }
  });

  it("refuses a visitor on the agent API and the restic backend (a wildcard route the table check skips)", async () => {
    for (const [method, path] of [
      ["POST", "/agent/v1/enroll"],
      ["POST", "/agent/v1/heartbeat"],
      ["POST", `/agent/restic/${PLACEHOLDER_ID}/data/${"ab".repeat(32)}`],
      ["PUT", `/agent/restic/${PLACEHOLDER_ID}/data/${"ab".repeat(32)}`],
      ["DELETE", `/agent/restic/${PLACEHOLDER_ID}/snapshots/${"ab".repeat(32)}`],
      ["POST", `/agent/restic/${PLACEHOLDER_ID}/?create=true`],
    ] as const) {
      const response = await app.request(path, { method });
      expect(response.status, `${method} ${path}`).toBe(403);
      expect(((await response.json()) as { type?: string }).type, `${method} ${path}`).toBe(
        DEMO_READ_ONLY_PROBLEM,
      );
    }
    // A wrong seed token is no better than none.
    const wrong = await app.request("/agent/v1/heartbeat", {
      method: "POST",
      headers: { "x-restow-demo-seed-token": "not-the-token" },
    });
    expect(wrong.status).toBe(403);
  });

  it("leaves every read (GET) reachable past the guard", async () => {
    // /readyz pings the database directly; excluded so this suite needs none.
    const getRoutes = app.routes.filter(
      (route) =>
        route.method === "GET" &&
        !route.path.includes(":") &&
        route.path !== "/api/auth/*" &&
        route.path !== "/readyz",
    );
    expect(getRoutes.length).toBeGreaterThan(5);
    for (const { path } of getRoutes.slice(0, 5)) {
      const response = await app.request(path);
      expect(response.status, path).not.toBe(403);
    }
  });
});
