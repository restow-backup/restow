import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  type PublicStatus,
  type StateView,
  publicStatusSchema,
  stateViewSchema,
  updaterErrorSchema,
} from "./protocol.js";
import { buildServer } from "./server.js";
import {
  type Harness,
  apiAt,
  createHarness,
  digestOf,
  scheduleRequest,
  settle,
} from "./testing.js";

const SECRET = "d".repeat(64);
let h: Harness;
let app: ReturnType<typeof buildServer>;

beforeEach(async () => {
  h = await createHarness();
  h.redactor.add(SECRET);
  app = buildServer({
    engine: h.engine,
    preflight: h.preflight,
    secret: SECRET,
    clock: h.clock,
    updaterVersion: "0.1.0",
    logger: h.logger,
    redactor: h.redactor,
  });
});

afterEach(async () => {
  await h.cleanup();
});

const auth = { Authorization: `Bearer ${SECRET}` };

async function call(
  method: string,
  path: string,
  options: { headers?: Record<string, string>; body?: unknown; raw?: string } = {},
) {
  const response = await app.request(path, {
    method,
    headers: {
      ...(options.body !== undefined || options.raw !== undefined
        ? { "Content-Type": "application/json" }
        : {}),
      ...(options.headers ?? {}),
    },
    body: options.raw ?? (options.body === undefined ? undefined : JSON.stringify(options.body)),
  });
  const text = await response.text();
  return { response, text, json: text ? (JSON.parse(text) as Record<string, unknown>) : null };
}

describe("authentication", () => {
  it.each([
    ["GET", "/v1/state"],
    ["POST", "/v1/schedule"],
    ["POST", "/v1/cancel"],
    ["POST", "/v1/acknowledge"],
  ])("%s %s needs the bearer secret", async (method, path) => {
    const attempts: Record<string, string>[] = [
      {},
      { Authorization: "Bearer wrong" },
      { Authorization: SECRET },
      { Authorization: `Basic ${SECRET}` },
      { Authorization: `Bearer ${SECRET}x` },
    ];
    for (const headers of attempts) {
      const { response, json } = await call(method, path, {
        headers,
        body: method === "POST" ? {} : undefined,
      });
      expect(response.status).toBe(401);
      expect(response.headers.get("www-authenticate")).toBe("Bearer");
      expect(updaterErrorSchema.parse(json).code).toBe("unauthorized");
    }
    expect(h.engine.view().phase).toBe("idle");
  });

  it("healthz and the public status need no secret", async () => {
    const health = await call("GET", "/healthz");
    expect(health.response.status).toBe(200);
    expect(health.json).toEqual({ status: "ok" });
    const status = await call("GET", "/public/status");
    expect(status.response.status).toBe(200);
  });

  it("sets Cache-Control: no-store on every response", async () => {
    for (const [method, path, headers] of [
      ["GET", "/healthz", {}],
      ["GET", "/public/status", {}],
      ["GET", "/v1/state", auth],
      ["GET", "/v1/state", {}],
      ["GET", "/nothing-here", {}],
      ["POST", "/v1/cancel", auth],
    ] as const) {
      const { response } = await call(method, path, { headers });
      expect(response.headers.get("cache-control")).toBe("no-store");
    }
  });

  it("answers 404 with the error shape for unknown routes and methods", async () => {
    for (const [method, path] of [
      ["GET", "/"],
      ["GET", "/v1/unknown"],
      ["DELETE", "/v1/state"],
    ] as const) {
      const { response, json } = await call(method, path, { headers: auth });
      expect(response.status).toBe(404);
      expect(updaterErrorSchema.parse(json).code).toBe("not_found");
    }
  });
});

describe("GET /v1/state", () => {
  it("returns the state view with capabilities", async () => {
    const { response, json } = await call("GET", "/v1/state", { headers: auth });
    expect(response.status).toBe(200);
    const view = stateViewSchema.parse(json);
    expect(view).toMatchObject({
      updaterVersion: "0.1.0",
      phase: "idle",
      run: null,
      history: [],
      events: [],
      capabilities: { ready: true, blockers: [], runner: "cli", composeFile: "docker-compose.yml" },
    });
    expect(view.capabilities.imageRepository).toBe("ghcr.io/restow-backup/restow");
  });

  it("caches the capabilities for 30 seconds and refresh=1 recomputes them", async () => {
    await call("GET", "/v1/state", { headers: auth });
    const pings = () => h.ops.callsTo("ping").length;
    const first = pings();
    await call("GET", "/v1/state", { headers: auth });
    expect(pings()).toBe(first);
    h.clock.advance(29_000);
    await call("GET", "/v1/state", { headers: auth });
    expect(pings()).toBe(first);
    h.ops.pingError = new Error("gone");
    const stale = await call("GET", "/v1/state", { headers: auth });
    expect((stale.json as unknown as StateView).capabilities.ready).toBe(true);
    const fresh = await call("GET", "/v1/state?refresh=1", { headers: auth });
    expect((fresh.json as unknown as StateView).capabilities.ready).toBe(false);
    expect((fresh.json as unknown as StateView).capabilities.blockers[0]?.code).toBe(
      "docker_unreachable",
    );
    h.clock.advance(31_000);
    h.ops.pingError = null;
    const later = await call("GET", "/v1/state", { headers: auth });
    expect((later.json as unknown as StateView).capabilities.ready).toBe(true);
  });

  it("lists the dumps in the capabilities", async () => {
    await h.engine.schedule(scheduleRequest("0.2.0"));
    await settle(h.engine);
    const { json } = await call("GET", "/v1/state?refresh=1", { headers: auth });
    const view = stateViewSchema.parse(json);
    expect(view.capabilities.dumps).toHaveLength(1);
    expect(view.capabilities.dumps[0]?.bytes).toBeGreaterThan(0);
  });
});

describe("GET /public/status", () => {
  it("is idle before anything is announced", async () => {
    const { json } = await call("GET", "/public/status");
    expect(publicStatusSchema.parse(json)).toMatchObject({
      phase: "idle",
      runId: null,
      outcome: null,
      steps: [],
      progress: 0,
    });
  });

  it("shows only what a visitor may see", async () => {
    apiAt(h, "ghcr.io/restow-backup/restow:0.2.0", { kind: "ready", reportsVersion: "0.2.0" });
    await h.engine.schedule(scheduleRequest("0.2.0", { leadSeconds: 300 }));
    const raw = (await call("GET", "/public/status")).json as Record<string, unknown>;
    const scheduled = publicStatusSchema.parse(raw);
    expect(scheduled).toMatchObject({
      phase: "scheduled",
      failureCode: null,
      message: { code: "run.scheduled", params: { startsAt: expect.any(String) } },
    });
    // Which version runs and which one comes is for signed-in users only.
    expect(raw).not.toHaveProperty("targetVersion");
    expect(raw).not.toHaveProperty("fromVersion");
    expect(scheduled.message?.params).not.toHaveProperty("version");
    expect(scheduled.steps.map((step) => step.status)).toEqual(Array(7).fill("pending"));

    h.clock.advance(300_000);
    await settle(h.engine);
    const { text } = await call("GET", "/public/status");
    const done = publicStatusSchema.parse(JSON.parse(text)) as PublicStatus;
    expect(done).toMatchObject({ phase: "succeeded", outcome: "succeeded", progress: 100 });
    // Nothing that identifies the operator or the installation.
    for (const forbidden of [
      "admin@example.com",
      "203.0.113.7",
      "user-1",
      "ghcr.io",
      "restow:",
      "/state",
      ".dump",
      "log",
      "0.1.0",
      "0.2.0",
    ]) {
      expect(text).not.toContain(forbidden);
    }
    expect(Object.keys(done).sort()).toEqual(Object.keys(publicStatusSchema.shape).sort());
  });

  it("carries the failure code of a failed run", async () => {
    h.ops.registry.set("ghcr.io/restow-backup/restow:0.2.0", "denied");
    await h.engine.schedule(scheduleRequest("0.2.0"));
    await settle(h.engine);
    const status = publicStatusSchema.parse((await call("GET", "/public/status")).json);
    expect(status).toMatchObject({
      phase: "failed",
      outcome: "unchanged",
      failureCode: "fetch.pull_failed",
    });
  });
});

describe("POST /v1/schedule", () => {
  it("accepts a valid request with 202 and the new state", async () => {
    const { response, json } = await call("POST", "/v1/schedule", {
      headers: auth,
      body: scheduleRequest("0.2.0", { leadSeconds: 300, digests: { app: digestOf("a") } }),
    });
    expect(response.status).toBe(202);
    const view = stateViewSchema.parse(json);
    expect(view.phase).toBe("scheduled");
    expect(view.run).toMatchObject({
      targetVersion: "0.2.0",
      leadSeconds: 300,
      requestedBy: { label: "admin@example.com" },
    });
  });

  it("starts at once with lead time 0", async () => {
    const { response, json } = await call("POST", "/v1/schedule", {
      headers: auth,
      body: scheduleRequest("0.2.0"),
    });
    expect(response.status).toBe(202);
    expect(stateViewSchema.parse(json).phase).toBe("running");
    await settle(h.engine);
  });

  it.each([
    ["not JSON", { raw: "{nope" }],
    ["an empty body", { raw: "" }],
    ["an array", { body: [] }],
    [
      "no release",
      {
        body: {
          mode: "image",
          leadSeconds: 0,
          requestedBy: { userId: null, label: "x", ip: null },
        },
      },
    ],
    ["an unknown lead time", { body: { ...scheduleRequest("0.2.0"), leadSeconds: 7 } }],
    ["an unknown mode", { body: { ...scheduleRequest("0.2.0"), mode: "magic" } }],
    ["a bad digest", { body: scheduleRequest("0.2.0", { digests: { app: "sha256:abc" } }) }],
  ])("rejects %s with 422", async (_name, request) => {
    const { response, json } = await call("POST", "/v1/schedule", { headers: auth, ...request });
    expect(response.status).toBe(422);
    expect(updaterErrorSchema.parse(json).code).toBe("invalid_request");
    expect(h.engine.view().phase).toBe("idle");
  });

  it("rejects an oversized body", async () => {
    const { response } = await call("POST", "/v1/schedule", {
      headers: auth,
      raw: `{"x":"${"a".repeat(70_000)}"}`,
    });
    expect(response.status).toBe(422);
  });

  it("rejects versions that are not newer or not versions with 422", async () => {
    for (const [version, code] of [
      ["0.1.0", "not_newer"],
      ["0.0.1", "not_newer"],
      ["nightly", "invalid_request"],
    ] as const) {
      const { response, json } = await call("POST", "/v1/schedule", {
        headers: auth,
        body: scheduleRequest(version),
      });
      expect(response.status).toBe(422);
      expect(updaterErrorSchema.parse(json).code).toBe(code);
    }
  });

  it("rejects a source archive that is not https or has no source", async () => {
    for (const source of [
      null,
      { archiveUrl: "http://example.com/a.tgz", repository: "a/b", useToken: false },
    ]) {
      const { response, json } = await call("POST", "/v1/schedule", {
        headers: auth,
        body: scheduleRequest("0.2.0", { mode: "source", source }),
      });
      expect(response.status).toBe(422);
      expect(updaterErrorSchema.parse(json).code).toBe("invalid_request");
    }
  });

  it("answers 409 source_not_allowed for a repository the operator did not allow", async () => {
    h.source.notAllowed = true;
    const { response, json } = await call("POST", "/v1/schedule", {
      headers: auth,
      body: scheduleRequest("0.2.0", {
        mode: "source",
        source: {
          archiveUrl: "https://attacker.example/api/v1/repos/x/y/archive/v0.2.0.tar.gz",
          repository: "x/y",
          useToken: false,
        },
      }),
    });
    expect(response.status).toBe(409);
    expect(updaterErrorSchema.parse(json).code).toBe("source_not_allowed");
    expect(h.engine.view().phase).toBe("idle");
  });

  it("answers 409 busy while a run is scheduled", async () => {
    await call("POST", "/v1/schedule", {
      headers: auth,
      body: scheduleRequest("0.2.0", { leadSeconds: 60 }),
    });
    const { response, json } = await call("POST", "/v1/schedule", {
      headers: auth,
      body: scheduleRequest("0.3.0"),
    });
    expect(response.status).toBe(409);
    expect(updaterErrorSchema.parse(json).code).toBe("busy");
  });

  it("answers 409 blocked with the blockers", async () => {
    h.ops.freeBytesValue = 1024;
    h.ops.composeFile = null;
    const { response, json } = await call("POST", "/v1/schedule", {
      headers: auth,
      body: scheduleRequest("0.2.0"),
    });
    expect(response.status).toBe(409);
    const error = updaterErrorSchema.parse(json);
    expect(error.code).toBe("blocked");
    expect(error.blockers?.map((blocker) => blocker.code).sort()).toEqual([
      "compose_missing",
      "disk_space",
    ]);
    expect(h.engine.view().phase).toBe("idle");
  });
});

describe("POST /v1/cancel", () => {
  it("cancels a scheduled run", async () => {
    await call("POST", "/v1/schedule", {
      headers: auth,
      body: scheduleRequest("0.2.0", { leadSeconds: 60 }),
    });
    const { response, json } = await call("POST", "/v1/cancel", { headers: auth });
    expect(response.status).toBe(200);
    const view = stateViewSchema.parse(json);
    expect(view.phase).toBe("idle");
    expect(view.history[0]).toMatchObject({ cancelled: true, outcome: null });
  });

  it("answers 409 not_scheduled when nothing is scheduled", async () => {
    const { response, json } = await call("POST", "/v1/cancel", { headers: auth });
    expect(response.status).toBe(409);
    expect(updaterErrorSchema.parse(json).code).toBe("not_scheduled");
  });

  it("answers 409 running once the run started", async () => {
    let cancelled: { status: number; code: string } | null = null;
    const original = h.ops.pull.bind(h.ops);
    h.ops.pull = async (image) => {
      const result = await call("POST", "/v1/cancel", { headers: auth });
      cancelled = {
        status: result.response.status,
        code: updaterErrorSchema.parse(result.json).code,
      };
      return original(image);
    };
    await call("POST", "/v1/schedule", { headers: auth, body: scheduleRequest("0.2.0") });
    await settle(h.engine);
    expect(cancelled).toEqual({ status: 409, code: "running" });
  });
});

describe("POST /v1/acknowledge", () => {
  it("clears a finished run and keeps the history", async () => {
    await call("POST", "/v1/schedule", { headers: auth, body: scheduleRequest("0.2.0") });
    await settle(h.engine);
    const { response, json } = await call("POST", "/v1/acknowledge", { headers: auth });
    expect(response.status).toBe(200);
    const view = stateViewSchema.parse(json);
    expect(view.phase).toBe("idle");
    expect(view.run).toBeNull();
    expect(view.history).toHaveLength(1);
  });

  it("is harmless when nothing is finished and refused while a run is scheduled", async () => {
    expect((await call("POST", "/v1/acknowledge", { headers: auth })).response.status).toBe(200);
    await call("POST", "/v1/schedule", {
      headers: auth,
      body: scheduleRequest("0.2.0", { leadSeconds: 60 }),
    });
    const { response, json } = await call("POST", "/v1/acknowledge", { headers: auth });
    expect(response.status).toBe(409);
    expect(updaterErrorSchema.parse(json).code).toBe("not_finished");
  });
});

describe("what responses carry", () => {
  it("never contains the shared secret, whatever happens", async () => {
    const texts: string[] = [];
    const record = async (method: string, path: string, options = {}) => {
      texts.push((await call(method, path, options)).text);
    };
    await record("GET", "/healthz");
    await record("GET", "/public/status");
    await record("GET", "/v1/state", { headers: auth });
    await record("GET", "/v1/state", { headers: { Authorization: `Bearer ${SECRET}x` } });
    await record("POST", "/v1/schedule", { headers: auth, raw: SECRET });
    await record("POST", "/v1/schedule", { headers: auth, body: { release: SECRET } });
    h.ops.failOn("pull", new Error(`registry rejected Authorization: Bearer ${SECRET}`));
    await record("POST", "/v1/schedule", { headers: auth, body: scheduleRequest("0.2.0") });
    await settle(h.engine);
    await record("GET", "/v1/state", { headers: auth });
    await record("GET", "/public/status");
    for (const text of texts) {
      expect(text).not.toContain(SECRET);
    }
  });

  it("answers an unexpected error with a plain 500 and no details", async () => {
    h.engine.view = () => {
      throw new Error(`boom with ${SECRET} and /internal/path`);
    };
    const { response, json, text } = await call("GET", "/v1/state", { headers: auth });
    expect(response.status).toBe(500);
    expect(updaterErrorSchema.parse(json).code).toBe("internal");
    expect(text).not.toContain("boom");
    expect(text).not.toContain(SECRET);
    expect(h.logger.lines.join("\n")).not.toContain(SECRET);
  });
});
