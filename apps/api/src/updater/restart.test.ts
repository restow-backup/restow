import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { OpsError } from "./ops.js";
import { stateViewSchema, updaterErrorSchema } from "./protocol.js";
import { ServiceRestarter } from "./restart.js";
import { buildServer } from "./server.js";
import { type Harness, createHarness, scheduleRequest } from "./testing.js";

/**
 * `POST /v1/restart` (restart.ts): an administrator's click restarts exactly
 * one application service with `docker compose restart <service>`, behind the
 * bearer secret, for the three application roles only, never while an update
 * is announced or running, and never two at a time.
 */

const SECRET = "e".repeat(64);
let h: Harness;
let restarter: ServiceRestarter;
let app: ReturnType<typeof buildServer>;

beforeEach(async () => {
  h = await createHarness();
  h.redactor.add(SECRET);
  restarter = new ServiceRestarter({
    ops: h.ops,
    updateActive: () => {
      const { phase } = h.engine.view();
      return phase === "scheduled" || phase === "running";
    },
    clock: h.clock,
    logger: h.logger,
  });
  app = buildServer({
    engine: h.engine,
    preflight: h.preflight,
    secret: SECRET,
    clock: h.clock,
    updaterVersion: "0.1.0",
    logger: h.logger,
    redactor: h.redactor,
    restarter,
    projectDir: "/opt/restow",
  });
});

afterEach(async () => {
  await restarter.settled();
  await h.cleanup();
});

const auth = { Authorization: `Bearer ${SECRET}` };

async function restart(body: unknown, headers: Record<string, string> = auth) {
  const response = await app.request("/v1/restart", {
    method: "POST",
    headers: { "Content-Type": "application/json", ...headers },
    body: typeof body === "string" ? body : JSON.stringify(body),
  });
  const text = await response.text();
  return { response, json: text ? (JSON.parse(text) as unknown) : null };
}

describe("POST /v1/restart", () => {
  it("restarts exactly the named service and reports it in the state", async () => {
    const { response, json } = await restart({ service: "worker" });
    expect(response.status).toBe(202);
    const view = stateViewSchema.parse(json);
    // The fake finishes at once; the answer may already carry the outcome.
    expect(view.restart?.service).toBe("worker");
    expect(view.restartableServices).toEqual(["api", "worker", "scheduler"]);
    expect(view.projectDir).toBe("/opt/restow");

    await restarter.settled();
    expect(h.ops.callsTo("composeRestart")).toEqual(["composeRestart worker"]);
    const after = await app.request("/v1/state", { headers: auth });
    expect(stateViewSchema.parse(await after.json()).restart).toMatchObject({
      service: "worker",
      status: "succeeded",
    });
  });

  it("refuses every service outside the allowlist before any command runs", async () => {
    for (const service of [
      "postgres",
      "caddy",
      "updater",
      "mounter",
      "worker scheduler",
      "worker;id",
      "--all",
      "",
      "API",
    ]) {
      const { response, json } = await restart({ service });
      expect(response.status, service).toBe(422);
      expect(updaterErrorSchema.parse(json).code).toBe("invalid_request");
    }
    for (const body of [{}, { service: "api", extra: true }, { service: ["api"] }, "not json"]) {
      const { response } = await restart(body);
      expect(response.status).toBe(422);
    }
    expect(h.ops.callsTo("composeRestart")).toEqual([]);
  });

  it("needs the bearer secret", async () => {
    const attempts: Record<string, string>[] = [
      {},
      { Authorization: "Bearer wrong" },
      { Authorization: SECRET },
    ];
    for (const headers of attempts) {
      const { response, json } = await restart({ service: "api" }, headers);
      expect(response.status).toBe(401);
      expect(updaterErrorSchema.parse(json).code).toBe("unauthorized");
    }
    expect(h.ops.callsTo("composeRestart")).toEqual([]);
  });

  it("refuses while an update is announced, and while another restart runs", async () => {
    await h.engine.schedule(scheduleRequest("0.2.0", { leadSeconds: 300 }));
    const during = await restart({ service: "api" });
    expect(during.response.status).toBe(409);
    expect(updaterErrorSchema.parse(during.json).code).toBe("busy");
    await h.engine.cancel();

    let release: () => void = () => undefined;
    const slow = new Promise<void>((resolve) => {
      release = resolve;
    });
    const original = h.ops.composeRestart.bind(h.ops);
    h.ops.composeRestart = async (services) => {
      await slow;
      await original(services);
    };
    expect((await restart({ service: "worker" })).response.status).toBe(202);
    const second = await restart({ service: "scheduler" });
    expect(second.response.status).toBe(409);
    expect(updaterErrorSchema.parse(second.json).code).toBe("busy");
    release();
    await restarter.settled();
    expect((await restart({ service: "scheduler" })).response.status).toBe(202);
  });

  it("reports a failed restart in the state and its log, not in the answer", async () => {
    h.ops.failOn(
      "composeRestart",
      new OpsError("Restarting services failed (exit code 1).", "boom"),
    );
    const { response } = await restart({ service: "api" });
    expect(response.status).toBe(202);
    await restarter.settled();
    expect(restarter.view()).toMatchObject({ service: "api", status: "failed" });
    expect(h.logger.lines.some((line) => line.startsWith("ERROR") && line.includes("api"))).toBe(
      true,
    );
  });

  it("is not there on an updater built without a restarter", async () => {
    const bare = buildServer({
      engine: h.engine,
      preflight: h.preflight,
      secret: SECRET,
      clock: h.clock,
      updaterVersion: "0.1.0",
      logger: h.logger,
      redactor: h.redactor,
    });
    const response = await bare.request("/v1/restart", {
      method: "POST",
      headers: { "Content-Type": "application/json", ...auth },
      body: JSON.stringify({ service: "api" }),
    });
    expect(response.status).toBe(404);
    const state = stateViewSchema.parse(
      await (await bare.request("/v1/state", { headers: auth })).json(),
    );
    expect(state).toMatchObject({ restartableServices: [], restart: null, projectDir: null });
  });
});
