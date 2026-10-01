import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * /readyz is public (the edge exposes it). It is ready only when the database
 * answers and the worker and the scheduler have reported in (their
 * `service_heartbeats` rows, at most two minutes old); /healthz stays a plain
 * liveness answer. The opt-in updater, which holds the shared secret, also
 * learns the running version: it waits for the new one to answer.
 */

const SECRET = "fedcba9876543210fedcba9876543210fedcba9876543210fedcba9876543210";

vi.hoisted(() => {
  const { mkdtempSync, writeFileSync } = require("node:fs") as typeof import("node:fs");
  const { tmpdir } = require("node:os") as typeof import("node:os");
  const { join } = require("node:path") as typeof import("node:path");
  const dir = mkdtempSync(join(tmpdir(), "restow-readyz-"));
  writeFileSync(
    join(dir, "secret"),
    "fedcba9876543210fedcba9876543210fedcba9876543210fedcba9876543210\n",
  );
  process.env.RESTOW_UPDATER_SECRET_FILE = join(dir, "secret");
  process.env.RESTOW_VERSION = "v0.2.0";
});
const state = vi.hoisted(() => ({
  database: true,
  services: { worker: "ok", scheduler: "ok" } as Record<"worker" | "scheduler", "ok" | "missing">,
  serviceReads: 0,
}));
vi.mock("./db.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./db.js")>()),
  isDatabaseReachable: async () => state.database,
  readWorkerAndScheduler: async () => {
    state.serviceReads += 1;
    return state.services;
  },
}));

const { buildApp } = await import("./app.js");

async function readyz(headers: Record<string, string> = {}) {
  const response = await buildApp().request("/readyz", { headers });
  return { status: response.status, body: await response.json() };
}

beforeEach(() => {
  state.database = true;
  state.services = { worker: "ok", scheduler: "ok" };
  state.serviceReads = 0;
});

describe("GET /readyz", () => {
  it("reports readiness without a version to everybody else", async () => {
    const others: Record<string, string>[] = [
      {},
      { authorization: "Bearer wrong" },
      { authorization: `Basic ${SECRET}` },
    ];
    for (const headers of others) {
      const { status, body } = await readyz(headers);
      expect(status).toBe(200);
      expect(body).toEqual({
        status: "ready",
        checks: { database: true, worker: "ok", scheduler: "ok" },
      });
    }
  });

  it("adds the running version for the updater", async () => {
    const { status, body } = await readyz({ authorization: `Bearer ${SECRET}` });
    expect(status).toBe(200);
    expect(body).toMatchObject({ status: "ready", version: "0.2.0" });
  });

  it("is not ready without a worker: a backup product that cannot run jobs is not ready", async () => {
    state.services = { worker: "missing", scheduler: "ok" };
    const { status, body } = await readyz();
    expect(status).toBe(503);
    expect(body).toEqual({
      status: "not_ready",
      checks: { database: true, worker: "missing", scheduler: "ok" },
    });
  });

  it("is not ready without a scheduler", async () => {
    state.services = { worker: "ok", scheduler: "missing" };
    const { status, body } = await readyz();
    expect(status).toBe(503);
    expect(body).toEqual({
      status: "not_ready",
      checks: { database: true, worker: "ok", scheduler: "missing" },
    });
  });

  it("is not ready without the database, and then reports both roles as missing without asking", async () => {
    state.database = false;
    const { status, body } = await readyz();
    expect(status).toBe(503);
    expect(body).toEqual({
      status: "not_ready",
      checks: { database: false, worker: "missing", scheduler: "missing" },
    });
    expect(state.serviceReads).toBe(0);
  });

  it("still tells the updater the running version while not ready", async () => {
    state.services = { worker: "missing", scheduler: "missing" };
    const { status, body } = await readyz({ authorization: `Bearer ${SECRET}` });
    expect(status).toBe(503);
    expect(body).toMatchObject({ status: "not_ready", version: "0.2.0" });
  });
});

describe("GET /healthz", () => {
  it("is liveness only: it answers ok whatever the database, worker and scheduler do", async () => {
    state.database = false;
    state.services = { worker: "missing", scheduler: "missing" };
    const response = await buildApp().request("/healthz");
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ status: "ok" });
    expect(state.serviceReads).toBe(0);
  });
});
