import { beforeEach, describe, expect, it, vi } from "vitest";
import { memoryLogger } from "../updater/logger.js";
import { systemClock } from "../updater/ops.js";
import { Redactor } from "../updater/redact.js";
import { MountEngineError } from "./engine.js";
import { RunnerError } from "./runner-engine.js";
import { buildMounterServer } from "./server.js";

const SECRET = "a".repeat(64);
const ACTOR = { userId: "u1", label: "owner@example.com", ip: null };

const engine = {
  isBusy: false,
  mounts: vi.fn(),
  current: vi.fn(),
  history: vi.fn(),
  capabilities: vi.fn(),
  add: vi.fn(),
  remove: vi.fn(),
  test: vi.fn(),
};

const runner = {
  capabilities: vi.fn(),
  exec: vi.fn(),
  start: vi.fn(),
  list: vi.fn(),
  get: vi.fn(),
  stop: vi.fn(),
  removeCache: vi.fn(),
};
let withRunner = true;

function app() {
  const redactor = new Redactor();
  redactor.add(SECRET);
  return buildMounterServer({
    engine: engine as never,
    secret: SECRET,
    clock: systemClock,
    version: "0.3.0",
    logger: memoryLogger(redactor),
    redactor,
    ...(withRunner ? { runner: runner as never } : {}),
  });
}

async function call(method: string, path: string, body?: unknown, secret: string | null = SECRET) {
  const headers: Record<string, string> = { "content-type": "application/json" };
  if (secret) {
    headers.authorization = `Bearer ${secret}`;
  }
  const response = await app().request(path, {
    method,
    headers,
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await response.text();
  return { status: response.status, body: text ? JSON.parse(text) : null, text };
}

beforeEach(() => {
  vi.clearAllMocks();
  withRunner = true;
  runner.capabilities.mockResolvedValue({
    ready: true,
    blockers: [],
    protocols: ["smb", "nfs"],
    running: 0,
    limit: 8,
    image: "sha256:api",
  });
  engine.mounts.mockResolvedValue([]);
  engine.current.mockReturnValue(null);
  engine.history.mockReturnValue([]);
  engine.capabilities.mockResolvedValue({
    ready: true,
    blockers: [],
    runner: "helper",
    composeFile: "docker-compose.yml",
    overrideFile: "docker-compose.override.yml",
    protocols: ["nfs"],
    checkedAt: new Date().toISOString(),
  });
  engine.add.mockResolvedValue({});
  engine.remove.mockResolvedValue({});
  engine.test.mockResolvedValue({ ok: true, code: null, detail: null, wrote: true, durationMs: 5 });
});

const SHARE = { protocol: "nfs", name: "nas", server: "10.0.0.5", export: "/srv" };

describe("mounter server", () => {
  it("answers the health check without a secret, with whether an operation runs", async () => {
    engine.isBusy = false;
    const idle = await call("GET", "/healthz", undefined, null);
    expect(idle.status).toBe(200);
    expect(idle.body).toEqual({ status: "ok", busy: false });
    engine.isBusy = true;
    expect((await call("GET", "/healthz", undefined, null)).body).toEqual({
      status: "ok",
      busy: true,
    });
    engine.isBusy = false;
  });

  it("refuses /v1 without the shared secret", async () => {
    for (const [method, path] of [
      ["GET", "/v1/state"],
      ["POST", "/v1/mounts"],
      ["DELETE", "/v1/mounts/nas"],
      ["POST", "/v1/test"],
    ] as const) {
      const body = method === "GET" ? undefined : {};
      expect((await call(method, path, body, null)).status, path).toBe(401);
      expect((await call(method, path, body, "b".repeat(64))).status, path).toBe(401);
    }
    expect(engine.add).not.toHaveBeenCalled();
  });

  it("returns the state", async () => {
    const response = await call("GET", "/v1/state?refresh=1");
    expect(response.status).toBe(200);
    expect(response.body.mounterVersion).toBe("0.3.0");
    expect(engine.capabilities).toHaveBeenCalledWith(true);
    expect(response.text).not.toContain(SECRET);
  });

  it("starts an add with a valid share and refuses an invalid one", async () => {
    const ok = await call("POST", "/v1/mounts", { mount: SHARE, requestedBy: ACTOR });
    expect(ok.status).toBe(202);
    expect(engine.add).toHaveBeenCalledWith(
      { ...SHARE, nfsVersion: "4.1", readOnly: false },
      ACTOR,
    );
    const bad = await call("POST", "/v1/mounts", {
      mount: { ...SHARE, server: "x,nolock" },
      requestedBy: ACTOR,
    });
    expect(bad.status).toBe(422);
    expect(bad.body.code).toBe("invalid_request");
    expect(engine.add).toHaveBeenCalledTimes(1);
  });

  it("maps engine refusals to their status", async () => {
    engine.add.mockRejectedValueOnce(new MountEngineError("busy", "Another change runs."));
    expect((await call("POST", "/v1/mounts", { mount: SHARE, requestedBy: ACTOR })).status).toBe(
      409,
    );
    engine.remove.mockRejectedValueOnce(new MountEngineError("not_found", "No share."));
    expect((await call("DELETE", "/v1/mounts/nas", { requestedBy: ACTOR })).status).toBe(404);
  });

  it("checks the name of a share to remove", async () => {
    expect((await call("DELETE", "/v1/mounts/NAS", { requestedBy: ACTOR })).status).toBe(422);
    expect((await call("DELETE", "/v1/mounts/nas", { requestedBy: ACTOR })).status).toBe(202);
    expect(engine.remove).toHaveBeenCalledWith("nas", ACTOR);
  });

  it("tests settings or a share", async () => {
    expect((await call("POST", "/v1/test", { mount: SHARE })).body.ok).toBe(true);
    expect((await call("POST", "/v1/test", { name: "nas" })).status).toBe(200);
    expect((await call("POST", "/v1/test", { name: "nas", mount: SHARE })).status).toBe(422);
  });

  it("hides internal errors", async () => {
    engine.mounts.mockRejectedValueOnce(new Error(`boom ${SECRET}`));
    const response = await call("GET", "/v1/state");
    expect(response.status).toBe(500);
    expect(response.text).not.toContain(SECRET);
  });
});

describe("mounter server: runner routes", () => {
  const RUN_ID = "0f1e2d3c-4b5a-4968-8776-655443322110";
  const SHARE_ID = "5b0c6f0e-9f5c-4c8a-9d55-1a2b3c4d5e6f";
  const PASSWORD = "very,secret pass";
  const smb = {
    protocol: "smb",
    server: "fs1",
    address: "10.0.0.5",
    share: "Data",
    subfolder: "",
    username: "backup",
    password: PASSWORD,
    domain: null,
    smbVersion: "3.1.1",
    seal: false,
  };
  const runRequest = {
    runId: RUN_ID,
    kind: "backup",
    mounts: [{ role: "source", share: smb, readOnly: true }],
    token: "T".repeat(43),
    limits: {
      memoryMiB: 2048,
      goMemLimitMiB: 1638,
      deadline: "2026-10-12T22:00:00Z",
      cacheKey: SHARE_ID,
    },
  };

  it("needs the bearer secret", async () => {
    expect((await call("POST", "/v1/runner/exec", { op: "probe", share: smb }, null)).status).toBe(
      401,
    );
    expect((await call("GET", "/v1/runner/runs", undefined, "wrong")).status).toBe(401);
  });

  it("adds the runner to the state", async () => {
    const state = await call("GET", "/v1/state");
    expect(state.body.runner).toMatchObject({ ready: true, protocols: ["smb", "nfs"], limit: 8 });
    withRunner = false;
    expect((await call("GET", "/v1/state")).body.runner).toBeUndefined();
    expect((await call("GET", "/v1/runner/runs")).status).toBe(404);
  });

  it("runs a test and passes the validated request on", async () => {
    runner.exec.mockResolvedValue({ ok: true, code: null, detail: null, output: { ok: true } });
    const response = await call("POST", "/v1/runner/exec", { op: "probe", share: smb });
    expect(response.status).toBe(200);
    expect(response.body.ok).toBe(true);
    expect(runner.exec.mock.calls[0]?.[0]).toMatchObject({
      op: "probe",
      share: { password: PASSWORD },
    });
  });

  it("refuses an invalid request without echoing the password", async () => {
    const response = await call("POST", "/v1/runner/exec", {
      op: "probe",
      share: { ...smb, password: "secret-value,ro" },
    });
    expect(response.status).toBe(422);
    expect(response.text).not.toContain("secret-value");
    expect(runner.exec).not.toHaveBeenCalled();
  });

  it("starts a run (202), maps refusals and mount failures", async () => {
    runner.start.mockResolvedValueOnce({ runId: RUN_ID, startedAt: "2026-10-10T22:00:00.000Z" });
    const started = await call("POST", "/v1/runner/runs", runRequest);
    expect(started.status).toBe(202);
    expect(started.body).toEqual({ runId: RUN_ID, startedAt: "2026-10-10T22:00:00.000Z" });
    runner.start.mockRejectedValueOnce(new RunnerError("runner.limit", "2 runs are running", 409));
    expect((await call("POST", "/v1/runner/runs", runRequest)).body).toEqual({
      code: "runner.limit",
      message: "2 runs are running",
    });
    runner.start.mockRejectedValueOnce(
      new RunnerError("mount.auth_failed", "mount: permission denied", 422),
    );
    const refused = await call("POST", "/v1/runner/runs", runRequest);
    expect(refused.status).toBe(422);
    expect(refused.body.code).toBe("mount.auth_failed");
  });

  it("lists, shows, stops runs and removes caches", async () => {
    runner.list.mockReturnValue([{ runId: RUN_ID }]);
    expect((await call("GET", "/v1/runner/runs")).body).toEqual([{ runId: RUN_ID }]);
    runner.get.mockReturnValueOnce(null);
    expect((await call("GET", `/v1/runner/runs/${RUN_ID}`)).status).toBe(404);
    expect((await call("GET", "/v1/runner/runs/not-a-uuid")).status).toBe(404);
    runner.get.mockReturnValue({ runId: RUN_ID, state: "exited" });
    expect((await call("GET", `/v1/runner/runs/${RUN_ID}`)).body.state).toBe("exited");
    const stopped = await call("DELETE", `/v1/runner/runs/${RUN_ID}`);
    expect(stopped.status).toBe(202);
    expect(runner.stop).toHaveBeenCalledWith(RUN_ID);
    expect((await call("DELETE", `/v1/runner/caches/${SHARE_ID}`)).status).toBe(204);
    runner.removeCache.mockRejectedValueOnce(
      new RunnerError("busy", "A run of this share is running.", 409),
    );
    expect((await call("DELETE", `/v1/runner/caches/${SHARE_ID}`)).status).toBe(409);
  });
});
