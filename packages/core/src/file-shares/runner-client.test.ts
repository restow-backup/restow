import { describe, expect, it, vi } from "vitest";
import { RunnerRefusedError, RunnerUnavailableError, createRunnerClient } from "./runner-client.js";
import { runnerExitCause, shareCauseOf } from "./runner.js";
import type { RunnerRunRequest, ShareSpec } from "./runner.js";

const RUN_ID = "0f1e2d3c-4b5a-4968-8776-655443322110";
const SHARE_ID = "5b0c6f0e-9f5c-4c8a-9d55-1a2b3c4d5e6f";
const PASSWORD = "very,secret pass";

const smb: ShareSpec = {
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

function respond(status: number, body: unknown) {
  return new Response(body === undefined ? null : JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

function client(fetchImpl: typeof fetch, secret: string | null = "s3cret-shared") {
  const forget = vi.fn();
  return {
    forget,
    client: createRunnerClient({
      url: "http://mounter:8091/",
      secret: async () => secret,
      forgetSecret: forget,
      fetch: fetchImpl,
    }),
  };
}

describe("runner client", () => {
  it("starts a run with the bearer secret and the typed body", async () => {
    const fetchImpl = vi.fn(async () =>
      respond(202, { runId: RUN_ID, startedAt: "2026-10-10T22:00:00Z" }),
    );
    const { client: c } = client(fetchImpl as unknown as typeof fetch);
    const request: RunnerRunRequest = {
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
    expect(await c.start(request)).toEqual({ runId: RUN_ID, startedAt: "2026-10-10T22:00:00Z" });
    const [url, init] = fetchImpl.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe("http://mounter:8091/v1/runner/runs");
    expect((init.headers as Record<string, string>).authorization).toBe("Bearer s3cret-shared");
    expect(JSON.parse(init.body as string)).toEqual(request);
    expect(init.redirect).toBe("error");
  });

  it("turns refusals into RunnerRefusedError with the runner's code, never with the password", async () => {
    const { client: c } = client((async () =>
      respond(422, {
        code: "mount.auth_failed",
        message: "mount: permission denied",
      })) as typeof fetch);
    const error = await c.exec({ op: "probe", share: smb }).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(RunnerRefusedError);
    expect((error as RunnerRefusedError).code).toBe("mount.auth_failed");
    expect(String(error)).not.toContain(PASSWORD);
  });

  it("reports an absent, secretless or unreachable mounter as unavailable", async () => {
    const disabled = createRunnerClient({ url: null, secret: async () => "x" });
    expect(disabled.enabled).toBe(false);
    await expect(disabled.list()).rejects.toMatchObject({ reason: "disabled" });
    const { client: noSecret } = client((async () => respond(200, [])) as typeof fetch, null);
    await expect(noSecret.list()).rejects.toMatchObject({ reason: "no_secret" });
    const { client: down } = client((async () => {
      throw new TypeError("fetch failed");
    }) as typeof fetch);
    await expect(down.list()).rejects.toBeInstanceOf(RunnerUnavailableError);
    expect(await down.capabilities()).toBeNull();
    const { client: unauthorized, forget } = client((async () => respond(401, {})) as typeof fetch);
    await expect(unauthorized.list()).rejects.toMatchObject({ reason: "no_secret" });
    expect(forget).toHaveBeenCalled();
  });

  it("reads runs, the runner state, stops and removes caches", async () => {
    const answers: Record<string, Response> = {
      [`GET /v1/runner/runs/${RUN_ID}`]: respond(200, {
        runId: RUN_ID,
        state: "exited",
        exitCode: 0,
      }),
      "GET /v1/state": respond(200, { runner: { ready: true, blockers: [], limit: 2 } }),
      [`DELETE /v1/runner/runs/${RUN_ID}`]: respond(202, {}),
      [`DELETE /v1/runner/caches/${SHARE_ID}`]: new Response(null, { status: 204 }),
    };
    const { client: c } = client(
      (async (url: string, init: RequestInit) =>
        answers[`${init.method} ${new URL(url).pathname}`] ??
        respond(404, { code: "not_found" })) as unknown as typeof fetch,
    );
    expect(await c.get(RUN_ID)).toMatchObject({ state: "exited" });
    expect(await c.get("1f1e2d3c-4b5a-4968-8776-655443322111")).toBeNull();
    expect(await c.capabilities()).toMatchObject({ ready: true, limit: 2 });
    await c.stop(RUN_ID);
    await c.removeCache(SHARE_ID);
    await expect(c.get("../x")).rejects.toBeInstanceOf(TypeError);
  });
});

describe("causes", () => {
  it("maps runner and restow-share codes to share causes", () => {
    expect(shareCauseOf("mount.auth_failed", "mount: key has expired")).toEqual({
      cause: "share.auth_failed",
      params: { reason: "expired" },
    });
    expect(shareCauseOf("mount.version").cause).toBe("share.version_mismatch");
    expect(shareCauseOf("runner.network").cause).toBe("share.mounter_unavailable");
    expect(shareCauseOf("empty_source").cause).toBe("share.empty_source");
    expect(shareCauseOf("whatever").cause).toBe("share.runner_failed");
  });

  it("explains a runner that ended without a finish", () => {
    expect(runnerExitCause({ exitCode: 137, stopReason: null })).toBe("share.out_of_memory");
    expect(runnerExitCause({ exitCode: 137, stopReason: "deadline" })).toBe("share.timeout");
    expect(runnerExitCause({ exitCode: 143, stopReason: "stopped" })).toBeNull();
    expect(runnerExitCause({ exitCode: 1, stopReason: null })).toBe("share.runner_failed");
  });
});
