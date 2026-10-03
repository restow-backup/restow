import { afterEach, describe, expect, it, vi } from "vitest";
import { AgentApi, basicAuthorization } from "./agent-api.js";
import { ApiRequestError } from "./http-client.js";

interface Init {
  method?: string;
  headers?: Record<string, string>;
  body?: string;
}

function stubFetch(answers: Array<{ status: number; body?: unknown }>) {
  const calls: Array<{ url: string; init: Init }> = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string, init: Init) => {
      calls.push({ url, init });
      const answer = answers.shift() ?? { status: 200 };
      return {
        status: answer.status,
        text: async () => (answer.body === undefined ? "" : JSON.stringify(answer.body)),
      } as unknown as Response;
    }),
  );
  return calls;
}

afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

describe("basicAuthorization", () => {
  it("is HTTP Basic with the endpoint id and its secret", () => {
    expect(basicAuthorization({ endpointId: "id", secret: "rsea_x" })).toBe(
      `Basic ${Buffer.from("id:rsea_x").toString("base64")}`,
    );
  });
});

describe("AgentApi", () => {
  it("enrolls without a login and logs in afterwards, always with the seed token", async () => {
    const calls = stubFetch([
      {
        status: 201,
        body: { endpointId: "e1", agentSecret: "s", repository: { url: "rest:x", password: "p" } },
      },
      { status: 200, body: { tasks: [] } },
    ]);
    const api = new AgentApi("http://api:3000", "seed-token");
    const enrolled = await api.enroll({
      token: "rset_x",
      hostname: "laptop-jdoe",
      os: "darwin",
      arch: "arm64",
      agentVersion: "0.1.0",
      osVersion: "macOS 15.6",
    });
    expect(enrolled.endpointId).toBe("e1");
    expect(calls[0]?.url).toBe("http://api:3000/agent/v1/enroll");
    expect(calls[0]?.init.headers?.authorization).toBeUndefined();
    expect(calls[0]?.init.headers?.["x-restow-demo-seed-token"]).toBe("seed-token");
    expect(JSON.parse(calls[0]?.init.body as string)).toMatchObject({
      os: "darwin",
      arch: "arm64",
    });

    api.setCredentials({ endpointId: "e1", secret: "s" });
    await api.heartbeat({
      agentVersion: "0.1.0",
      osVersion: "macOS 15.6",
      state: "idle",
      nextRunAt: null,
      configVersion: 1,
    });
    expect(calls[1]?.url).toBe("http://api:3000/agent/v1/heartbeat");
    expect(calls[1]?.init.headers?.authorization).toBe(
      basicAuthorization({ endpointId: "e1", secret: "s" }),
    );
    expect(calls[1]?.init.headers?.["x-restow-demo-seed-token"]).toBe("seed-token");
  });

  it("turns a refusal into an error that names the call and the status", async () => {
    stubFetch([{ status: 401, body: { type: "urn:restow:problem:agent-unauthorized" } }]);
    const api = new AgentApi("http://api:3000", "t", { endpointId: "e", secret: "wrong" });
    await expect(api.config()).rejects.toMatchObject({
      name: "ApiRequestError",
      status: 401,
      path: "/agent/v1/config",
    });
    await expect(
      (async () => {
        stubFetch([{ status: 403 }]);
        await api.config();
      })(),
    ).rejects.toBeInstanceOf(ApiRequestError);
  });

  it("starts and finishes a run, returning the run id as text", async () => {
    const calls = stubFetch([
      { status: 201, body: { runId: "run-1" } },
      { status: 200, body: {} },
    ]);
    const api = new AgentApi("http://api:3000", "t", { endpointId: "e", secret: "s" });
    expect(await api.startRun({ kind: "backup", startedAt: "2026-09-01T00:00:00Z" })).toBe("run-1");
    await api.finishRun("run-1", {
      status: "succeeded",
      finishedAt: "2026-09-01T00:01:00Z",
      errors: [],
      logTail: "",
    });
    expect(calls.map((c) => `${c.init.method} ${c.url}`)).toEqual([
      "POST http://api:3000/agent/v1/runs",
      "POST http://api:3000/agent/v1/runs/run-1/finish",
    ]);
  });

  it("waits and tries again while the server is busy", async () => {
    vi.useFakeTimers();
    const calls = stubFetch([
      { status: 503 },
      { status: 429 },
      { status: 200, body: { tasks: [] } },
    ]);
    const api = new AgentApi("http://api:3000", "t", { endpointId: "e", secret: "s" });
    const pending = api.heartbeat({
      agentVersion: "0.1.0",
      osVersion: "x",
      state: "idle",
      nextRunAt: null,
      configVersion: 1,
    });
    await vi.advanceTimersByTimeAsync(10_000);
    expect(await pending).toEqual({ tasks: [] });
    expect(calls).toHaveLength(3);
  });

  it("reports progress of a run", async () => {
    const calls = stubFetch([{ status: 204 }]);
    const api = new AgentApi("http://api:3000", "t", { endpointId: "e", secret: "s" });
    await api.progress("run-1", { filesDone: 3, bytesDone: 4096, currentPath: "/srv/share/a" });
    expect(calls[0]?.url).toBe("http://api:3000/agent/v1/runs/run-1/progress");
    expect(calls[0]?.init.method).toBe("POST");
    expect(JSON.parse(calls[0]?.init.body as string)).toEqual({
      filesDone: 3,
      bytesDone: 4096,
      currentPath: "/srv/share/a",
    });
  });

  it("gives up at once when told not to retry", async () => {
    const calls = stubFetch([{ status: 503 }, { status: 200, body: {} }]);
    const api = new AgentApi(
      "http://api:3000",
      "t",
      { endpointId: "e", secret: "s" },
      { retries: 0, timeoutMs: 1000 },
    );
    await expect(api.config()).rejects.toMatchObject({ status: 503 });
    expect(calls).toHaveLength(1);
    expect((calls[0]?.init as { signal?: AbortSignal }).signal).toBeInstanceOf(AbortSignal);
  });
});
