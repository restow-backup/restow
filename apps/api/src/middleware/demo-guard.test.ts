import { Hono, type MiddlewareHandler } from "hono";
import { afterEach, describe, expect, it, vi } from "vitest";
import { DEMO_ALLOWED_ROUTES, DEMO_DENIED_ROUTES } from "../lib/demo.js";

const ENDPOINT_ID = "6f1c2a52-6c0b-4d3a-9d0e-3a1b2c4d5e6f";
/** A concrete URL path for a route template of the allowlist (`:id` becomes a UUID). */
const concrete = (path: string) => path.replace(/:id/g, ENDPOINT_ID);

/**
 * `config` (./config.ts) is a module-level singleton read from `process.env`
 * at import time, so demo mode is exercised by stubbing the environment,
 * resetting the module registry and importing the guard fresh — the same
 * approach app-wide tests use for other environment-derived configuration
 * (see auth.test.ts).
 */
async function loadGuard(env: Record<string, string>): Promise<typeof import("./demo-guard.js")> {
  vi.resetModules();
  for (const [key, value] of Object.entries(env)) {
    vi.stubEnv(key, value);
  }
  return import("./demo-guard.js");
}

function testApp(guard: MiddlewareHandler): Hono {
  const app = new Hono();
  app.use("*", guard);
  app.get("/api/v1/sources", (c) => c.json({ ok: true }));
  app.post("/api/v1/sources", (c) => c.json({ ok: true }));
  app.post("/api/v1/setup", (c) => c.json({ ok: true }));
  app.patch("/api/v1/settings", (c) => c.json({ ok: true }));
  app.post("/api/v1/jobs/backup", (c) => c.json({ ok: true }));
  app.post("/api/v1/restore", (c) => c.json({ ok: true }));
  app.post("/api/v1/verify", (c) => c.json({ ok: true }));
  app.post("/api/v1/tenants", (c) => c.json({ ok: true }));
  app.post("/api/v1/endpoints/:id/downloads", (c) => c.json({ ok: true }));
  app.get("/api/v1/endpoints/:id/downloads/:downloadId", (c) => c.json({ ok: true }));
  app.post("/api/v1/endpoints/:id/tasks", (c) => c.json({ ok: true }));
  app.post("/api/v1/endpoints/:id/restore-test", (c) => c.json({ ok: true }));
  app.post("/api/v1/endpoints/:id/repository-password", (c) => c.json({ ok: true }));
  app.post("/api/v1/endpoints/tokens", (c) => c.json({ ok: true }));
  app.post("/agent/v1/enroll", (c) => c.json({ ok: true }));
  app.post("/agent/v1/heartbeat", (c) => c.json({ ok: true }));
  app.post("/agent/v1/runs", (c) => c.json({ ok: true }));
  app.post("/agent/v1/runs/:runId/finish", (c) => c.json({ ok: true }));
  app.all("/agent/restic/:endpointId/*", (c) => c.json({ ok: true }));
  app.post("/api/auth/sign-in/email", (c) => c.json({ ok: true }));
  app.post("/api/auth/sign-out", (c) => c.json({ ok: true }));
  app.post("/api/auth/organization/set-active", (c) => c.json({ ok: true }));
  app.post("/api/auth/change-password", (c) => c.json({ ok: true }));
  app.get("/api/auth/list-sessions", (c) => c.json({ ok: true }));
  app.post("/api/auth/revoke-session", (c) => c.json({ ok: true }));
  app.onError((err, c) => {
    const problem = err as Partial<{ status: number; type: string; title: string }>;
    if (typeof problem.status === "number") {
      return c.json({ type: problem.type, title: problem.title }, problem.status as never);
    }
    throw err;
  });
  return app;
}

afterEach(() => {
  vi.unstubAllEnvs();
  vi.resetModules();
});

describe("demoGuard, off (the default)", () => {
  it("changes nothing: every method and path passes through", async () => {
    const { demoGuard } = await loadGuard({});
    const app = testApp(demoGuard);
    for (const [method, path] of [
      ["GET", "/api/v1/sources"],
      ["POST", "/api/v1/sources"],
      ["PATCH", "/api/v1/settings"],
      ["POST", "/api/v1/tenants"],
      ["POST", "/api/auth/change-password"],
    ] as const) {
      const res = await app.request(path, { method });
      expect(res.status, `${method} ${path}`).toBe(200);
    }
  });
});

describe("demoGuard, on", () => {
  it("always allows reads", async () => {
    const { demoGuard } = await loadGuard({ RESTOW_DEMO: "true" });
    const app = testApp(demoGuard);
    const res = await app.request("/api/v1/sources", { method: "GET" });
    expect(res.status).toBe(200);
  });

  it("allows every route of the fixed public allowlist", async () => {
    const { demoGuard } = await loadGuard({ RESTOW_DEMO: "true" });
    const app = testApp(demoGuard);
    for (const route of DEMO_ALLOWED_ROUTES) {
      const res = await app.request(concrete(route.path), { method: route.method });
      expect(res.status, `${route.method} ${route.path}`).toBe(200);
    }
  });

  it("refuses a write outside the allowlist with the demo-read-only problem", async () => {
    const { demoGuard, DEMO_READ_ONLY_PROBLEM } = await loadGuard({ RESTOW_DEMO: "true" });
    const app = testApp(demoGuard);
    for (const [method, path] of [
      ["POST", "/api/v1/setup"],
      ["POST", "/api/v1/sources"],
      ["PATCH", "/api/v1/settings"],
      ["POST", "/api/v1/tenants"],
      ["POST", "/api/auth/change-password"],
    ] as const) {
      const res = await app.request(path, { method });
      expect(res.status, `${method} ${path}`).toBe(403);
      expect(await res.json()).toMatchObject({ type: DEMO_READ_ONLY_PROBLEM });
    }
  });

  it("refuses the session-listing/revocation endpoints even as a GET or with the seed token", async () => {
    const { demoGuard } = await loadGuard({
      RESTOW_DEMO: "true",
      RESTOW_DEMO_SEED_TOKEN: "seed-secret",
    });
    const app = testApp(demoGuard);
    for (const path of DEMO_DENIED_ROUTES) {
      const getRes = await app.request(path, { method: "GET" });
      expect(getRes.status, `GET ${path}`).toBe(403);
      const postRes = await app.request(path, {
        method: "POST",
        headers: { "x-restow-demo-seed-token": "seed-secret" },
      });
      expect(postRes.status, `POST ${path} with seed token`).toBe(403);
    }
  });

  it("lets the seed process bootstrap through the guard with its own token", async () => {
    const { demoGuard } = await loadGuard({
      RESTOW_DEMO: "true",
      RESTOW_DEMO_SEED_TOKEN: "seed-secret",
    });
    const app = testApp(demoGuard);

    const withoutToken = await app.request("/api/v1/tenants", { method: "POST" });
    expect(withoutToken.status).toBe(403);

    const wrongToken = await app.request("/api/v1/tenants", {
      method: "POST",
      headers: { "x-restow-demo-seed-token": "not-it" },
    });
    expect(wrongToken.status).toBe(403);

    const withToken = await app.request("/api/v1/tenants", {
      method: "POST",
      headers: { "x-restow-demo-seed-token": "seed-secret" },
    });
    expect(withToken.status).toBe(200);
  });

  it("never accepts the seed token from an unconfigured installation", async () => {
    const { demoGuard } = await loadGuard({ RESTOW_DEMO: "true" });
    const app = testApp(demoGuard);
    const res = await app.request("/api/v1/tenants", {
      method: "POST",
      headers: { "x-restow-demo-seed-token": "anything" },
    });
    expect(res.status).toBe(403);
  });

  it("rate-limits a job-triggering route per visitor IP (finding 3)", async () => {
    const { demoGuard, DEMO_RATE_LIMITED_PROBLEM } = await loadGuard({ RESTOW_DEMO: "true" });
    const app = testApp(demoGuard);
    const from = (ip: string) => ({ method: "POST", headers: { "x-forwarded-for": ip } });

    for (let i = 0; i < 10; i++) {
      const res = await app.request("/api/v1/jobs/backup", from("203.0.113.9"));
      expect(res.status, `attempt ${i + 1}`).toBe(200);
    }
    const limited = await app.request("/api/v1/jobs/backup", from("203.0.113.9"));
    expect(limited.status).toBe(429);
    expect(await limited.json()).toMatchObject({ type: DEMO_RATE_LIMITED_PROBLEM });

    // A different visitor (different IP) has their own, untouched budget.
    const other = await app.request("/api/v1/jobs/backup", from("203.0.113.10"));
    expect(other.status).toBe(200);
  });

  it("rate-limits sign-in per visitor IP with its own, larger budget (finding M1)", async () => {
    const { demoGuard, DEMO_RATE_LIMITED_PROBLEM } = await loadGuard({ RESTOW_DEMO: "true" });
    const app = testApp(demoGuard);
    const from = (ip: string) => ({ method: "POST", headers: { "x-forwarded-for": ip } });

    for (let i = 0; i < 30; i++) {
      const res = await app.request("/api/auth/sign-in/email", from("203.0.113.20"));
      expect(res.status, `attempt ${i + 1}`).toBe(200);
    }
    const limited = await app.request("/api/auth/sign-in/email", from("203.0.113.20"));
    expect(limited.status).toBe(429);
    expect(await limited.json()).toMatchObject({ type: DEMO_RATE_LIMITED_PROBLEM });

    // A different, non-job route (sign-out) still has its own untouched budget.
    const signOut = await app.request("/api/auth/sign-out", from("203.0.113.20"));
    expect(signOut.status).toBe(200);
  });

  it("lets a visitor prepare an endpoint ZIP download but nothing else on the endpoints", async () => {
    const { demoGuard, DEMO_READ_ONLY_PROBLEM } = await loadGuard({ RESTOW_DEMO: "true" });
    const app = testApp(demoGuard);

    const prepare = await app.request(`/api/v1/endpoints/${ENDPOINT_ID}/downloads`, {
      method: "POST",
    });
    expect(prepare.status).toBe(200);
    // Starting the prepared download is a read.
    const start = await app.request(`/api/v1/endpoints/${ENDPOINT_ID}/downloads/${ENDPOINT_ID}`, {
      method: "GET",
    });
    expect(start.status).toBe(200);

    for (const path of [
      `/api/v1/endpoints/${ENDPOINT_ID}/tasks`,
      `/api/v1/endpoints/${ENDPOINT_ID}/restore-test`,
      `/api/v1/endpoints/${ENDPOINT_ID}/repository-password`,
      "/api/v1/endpoints/tokens",
    ]) {
      const res = await app.request(path, { method: "POST" });
      expect(res.status, path).toBe(403);
      expect(await res.json(), path).toMatchObject({ type: DEMO_READ_ONLY_PROBLEM });
    }
  });

  it("gives the download route one budget per visitor, whatever endpoint id is asked for", async () => {
    const { demoGuard, DEMO_RATE_LIMITED_PROBLEM } = await loadGuard({ RESTOW_DEMO: "true" });
    const app = testApp(demoGuard);
    const from = { method: "POST", headers: { "x-forwarded-for": "203.0.113.77" } };
    const route = DEMO_ALLOWED_ROUTES.find((r) => r.path.endsWith("/downloads"));
    expect(route).toBeDefined();
    for (let i = 0; i < (route?.rateLimit.max ?? 0); i++) {
      // A different, valid id each time: still the same budget.
      const id = `00000000-0000-4000-8000-${String(i).padStart(12, "0")}`;
      const res = await app.request(`/api/v1/endpoints/${id}/downloads`, from);
      expect(res.status, `attempt ${i + 1}`).toBe(200);
    }
    const limited = await app.request(`/api/v1/endpoints/${ENDPOINT_ID}/downloads`, from);
    expect(limited.status).toBe(429);
    expect(await limited.json()).toMatchObject({ type: DEMO_RATE_LIMITED_PROBLEM });
  });

  it("refuses a visitor on the agent API and the restic backend, and only the exact seed token opens them", async () => {
    const { demoGuard, DEMO_READ_ONLY_PROBLEM } = await loadGuard({
      RESTOW_DEMO: "true",
      RESTOW_DEMO_SEED_TOKEN: "seed-secret",
    });
    const app = testApp(demoGuard);
    const writes: Array<[string, string]> = [
      ["POST", "/agent/v1/enroll"],
      ["POST", "/agent/v1/heartbeat"],
      ["POST", "/agent/v1/runs"],
      ["POST", `/agent/v1/runs/${ENDPOINT_ID}/finish`],
      ["POST", `/agent/restic/${ENDPOINT_ID}/data/ab12`],
      ["PUT", `/agent/restic/${ENDPOINT_ID}/data/ab12`],
      ["DELETE", `/agent/restic/${ENDPOINT_ID}/snapshots/ab12`],
      ["POST", `/agent/restic/${ENDPOINT_ID}/?create=true`],
    ];
    for (const [method, path] of writes) {
      const none = await app.request(path, { method });
      expect(none.status, `${method} ${path} without a token`).toBe(403);
      expect(await none.json()).toMatchObject({ type: DEMO_READ_ONLY_PROBLEM });
      // (A header value loses surrounding whitespace on the wire, so a padded token is not a case here.)
      for (const wrong of ["", "seed-secre", "seed-secrets", "SEED-SECRET", "x-seed-secret"]) {
        const res = await app.request(path, {
          method,
          headers: { "x-restow-demo-seed-token": wrong },
        });
        expect(res.status, `${method} ${path} with "${wrong}"`).toBe(403);
      }
      const exact = await app.request(path, {
        method,
        headers: { "x-restow-demo-seed-token": "seed-secret" },
      });
      expect(exact.status, `${method} ${path} with the token`).toBe(200);
    }
    // Reads reach the route (which authenticates the agent itself).
    const read = await app.request(`/agent/restic/${ENDPOINT_ID}/config`, { method: "GET" });
    expect(read.status).toBe(200);
  });

  it("rate-limits every route on the public allowlist, each with its own budget", async () => {
    const { demoGuard, DEMO_RATE_LIMITED_PROBLEM } = await loadGuard({ RESTOW_DEMO: "true" });
    const app = testApp(demoGuard);
    const { DEMO_ALLOWED_ROUTES } = await import("../lib/demo.js");

    for (const route of DEMO_ALLOWED_ROUTES) {
      const ip = `203.0.113.${DEMO_ALLOWED_ROUTES.indexOf(route) + 30}`;
      const from = { method: route.method, headers: { "x-forwarded-for": ip } };
      for (let i = 0; i < route.rateLimit.max; i++) {
        const res = await app.request(concrete(route.path), from);
        expect(res.status, `${route.method} ${route.path} attempt ${i + 1}`).toBe(200);
      }
      const limited = await app.request(concrete(route.path), from);
      expect(limited.status, `${route.method} ${route.path} over budget`).toBe(429);
      expect(await limited.json()).toMatchObject({ type: DEMO_RATE_LIMITED_PROBLEM });
    }
  });
});
