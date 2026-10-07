import { beforeEach, describe, expect, it, vi } from "vitest";
import { memoryLogger } from "../updater/logger.js";
import { systemClock } from "../updater/ops.js";
import { Redactor } from "../updater/redact.js";
import { MountEngineError } from "./engine.js";
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
