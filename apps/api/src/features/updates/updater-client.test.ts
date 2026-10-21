import { describe, expect, it, vi } from "vitest";
import type { StateView } from "../../updater/protocol.js";
import {
  ACTION_TIMEOUT_MS,
  bearerOf,
  createUpdaterClient,
  disabledUpdaterClient,
  SCHEDULE_TIMEOUT_MS,
  secretMatches,
  UpdaterRejectedError,
  UpdaterUnavailableError,
  updaterClientFromEnv,
} from "./updater-client.js";

function state(overrides: Partial<StateView> = {}): StateView {
  return {
    updaterVersion: "0.1.0",
    phase: "idle",
    run: null,
    history: [],
    events: [],
    capabilities: {
      ready: true,
      blockers: [],
      runner: "helper",
      composeFile: "/srv/restow/docker-compose.yml",
      imageRepository: "ghcr.io/restow-backup/restow",
      webImageRepository: "ghcr.io/restow-backup/restow-web",
      dumps: [],
      sourceAllowlist: [],
      signatureChecks: true,
      projectDir: "/srv/restow",
      mounterService: true,
      updateSpace: null,
      checkedAt: "2026-10-01T09:00:00.000Z",
    },
    selfUpdate: null,
    mounterEnable: null,
    restartableServices: [],
    restart: null,
    projectDir: null,
    database: null,
    serverTime: "2026-10-01T09:00:00.000Z",
    ...overrides,
  };
}

function reply(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

function client(
  fetcher: typeof fetch,
  extra: { clock?: () => number; secret?: string | Error } = {},
) {
  const secret = extra.secret ?? "the-shared-secret\n";
  return createUpdaterClient({
    url: "http://updater:8090/",
    secretFile: "/updater-shared/secret",
    fetch: fetcher,
    readFile: async () => {
      if (secret instanceof Error) {
        throw secret;
      }
      return secret;
    },
    now: extra.clock,
  });
}

describe("bearer tokens", () => {
  it("are read from the Authorization header, exactly", () => {
    expect(bearerOf("Bearer abc")).toBe("abc");
    expect(bearerOf("bearer abc")).toBe("abc");
    expect(bearerOf("Basic abc")).toBeNull();
    expect(bearerOf("Bearer")).toBeNull();
    expect(bearerOf("Bearer a b")).toBeNull();
    expect(bearerOf(null)).toBeNull();
    expect(bearerOf(undefined)).toBeNull();
  });

  it("are compared in constant time and only when equal", () => {
    expect(secretMatches("abc", "abc")).toBe(true);
    expect(secretMatches("abc", "abd")).toBe(false);
    expect(secretMatches("abc", "abcd")).toBe(false);
    expect(secretMatches("", "abc")).toBe(false);
  });
});

describe("the updater client", () => {
  it("authenticates with the shared secret and reads the state", async () => {
    const fetcher = vi.fn(async () => reply(state()));
    const result = await client(fetcher as unknown as typeof fetch).state();
    expect(result?.updaterVersion).toBe("0.1.0");
    const [url, init] = fetcher.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe("http://updater:8090/v1/state");
    expect((init.headers as Record<string, string>).authorization).toBe("Bearer the-shared-secret");
    expect(init.redirect).toBe("error");
  });

  it("answers null when nothing is listening, without throwing", async () => {
    const refused = vi.fn(async () => Promise.reject(new TypeError("fetch failed")));
    expect(await client(refused as unknown as typeof fetch).state()).toBeNull();
  });

  it("answers null while the shared secret does not exist yet (the updater never ran)", async () => {
    const fetcher = vi.fn();
    const result = await client(fetcher as unknown as typeof fetch, {
      secret: Object.assign(new Error("ENOENT"), { code: "ENOENT" }),
    }).state();
    expect(result).toBeNull();
    expect(fetcher).not.toHaveBeenCalled();
  });

  it("reuses a state answer briefly, and a missing updater a little longer", async () => {
    let now = 0;
    const fetcher = vi.fn(async () => reply(state()));
    const subject = client(fetcher as unknown as typeof fetch, { clock: () => now });
    await subject.state();
    now = 1000;
    await subject.state();
    expect(fetcher).toHaveBeenCalledTimes(1);
    now = 2500;
    await subject.state();
    expect(fetcher).toHaveBeenCalledTimes(2);
    await subject.state({ fresh: true });
    expect(fetcher).toHaveBeenCalledTimes(3);
  });

  it("asks for a fresh preflight on request", async () => {
    const fetcher = vi.fn(async () => reply(state()));
    await client(fetcher as unknown as typeof fetch).state({ refresh: true });
    expect((fetcher.mock.calls[0] as unknown as [string])[0]).toBe(
      "http://updater:8090/v1/state?refresh=1",
    );
  });

  it("refuses an updater that speaks another protocol instead of guessing", async () => {
    const fetcher = vi.fn(async () => reply({ phase: "somewhere-else" }));
    await expect(client(fetcher as unknown as typeof fetch).state()).rejects.toMatchObject({
      reason: "incompatible",
    });
  });

  it("forgets the secret when the updater no longer accepts it", async () => {
    const fetcher = vi.fn(async () => reply({ code: "unauthorized" }, 401));
    expect(await client(fetcher as unknown as typeof fetch).state()).toBeNull();
  });

  it("passes the updater's refusals on with their code", async () => {
    const fetcher = vi.fn(async () => reply({ code: "busy", message: "x" }, 409));
    const subject = client(fetcher as unknown as typeof fetch);
    await expect(subject.cancel()).rejects.toMatchObject({ status: 409, code: "busy" });
    await expect(subject.cancel()).rejects.toBeInstanceOf(UpdaterRejectedError);
  });

  it("posts the schedule as JSON", async () => {
    const fetcher = vi.fn(async () => reply(state({ phase: "scheduled" }), 202));
    const request = {
      release: { version: "0.2.0", tag: "v0.2.0", url: null, prerelease: false, digests: {} },
      mode: "image" as const,
      switchTo: null,
      source: null,
      leadSeconds: 300,
      requestedBy: { userId: "u1", label: "admin@example.com", ip: null },
    };
    const result = await client(fetcher as unknown as typeof fetch).schedule(request);
    expect(result.phase).toBe("scheduled");
    const [url, init] = fetcher.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe("http://updater:8090/v1/schedule");
    expect(init.method).toBe("POST");
    expect(JSON.parse(init.body as string)).toEqual(request);
  });

  it("waits a minute for the schedule and longer than for a state read for the other actions", async () => {
    // The updater checks deeply before it accepts an update (5-12 s on a real installation):
    // the 5 s of a state read made the api report "no updater" for an accepted update.
    const timeouts: number[] = [];
    const spy = vi.spyOn(AbortSignal, "timeout").mockImplementation((ms: number) => {
      timeouts.push(ms);
      return new AbortController().signal;
    });
    try {
      const fetcher = vi.fn(async () => reply(state(), 202));
      const subject = client(fetcher as unknown as typeof fetch);
      await subject.schedule({
        release: { version: "0.2.0", tag: "v0.2.0", url: null, prerelease: false, digests: {} },
        mode: "image",
        switchTo: null,
        source: null,
        leadSeconds: 0,
        requestedBy: { userId: "u1", label: "admin@example.com", ip: null },
      });
      await subject.cancel();
      await subject.acknowledge();
      await subject.restart("worker");
      await subject.deleteDump("restow-0.2.0.dump");
      await subject.state({ fresh: true });
      await subject.state({ fresh: true, patient: true });
      expect(timeouts).toEqual([
        SCHEDULE_TIMEOUT_MS,
        ACTION_TIMEOUT_MS,
        ACTION_TIMEOUT_MS,
        ACTION_TIMEOUT_MS,
        ACTION_TIMEOUT_MS,
        5000,
        ACTION_TIMEOUT_MS,
      ]);
      expect(SCHEDULE_TIMEOUT_MS).toBeGreaterThanOrEqual(60_000);
    } finally {
      spy.mockRestore();
    }
  });

  it("reports a schedule that did not answer in time as a timeout", async () => {
    const fetcher = vi.fn(async () => {
      throw new DOMException("The operation timed out.", "TimeoutError");
    });
    await expect(
      client(fetcher as unknown as typeof fetch).schedule({
        release: { version: "0.2.0", tag: "v0.2.0", url: null, prerelease: false, digests: {} },
        mode: "image",
        switchTo: null,
        source: null,
        leadSeconds: 0,
        requestedBy: { userId: "u1", label: "admin@example.com", ip: null },
      }),
    ).rejects.toMatchObject({ reason: "timeout" });
  });

  it("asks the updater to start the mounter and reads the outcome", async () => {
    const outcome = {
      last: {
        status: "started" as const,
        reason: null,
        image: null,
        requestedAt: "2026-10-01T09:00:00.000Z",
        finishedAt: "2026-10-01T09:00:05.000Z",
        detail: "",
      },
    };
    const fetcher = vi.fn(async () => reply(state({ mounterEnable: outcome })));
    const result = await client(fetcher as unknown as typeof fetch).enableMounter();
    expect(result.mounterEnable).toEqual(outcome);
    const [url, init] = fetcher.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe("http://updater:8090/v1/mounter/enable");
    expect(init.method).toBe("POST");
    expect((init.headers as Record<string, string>).authorization).toBe("Bearer the-shared-secret");
    await expect(
      updaterClientFromEnv({ RESTOW_UPDATER_URL: "" }).enableMounter(),
    ).rejects.toBeInstanceOf(UpdaterUnavailableError);
  });

  it("posts a restart with the service name only", async () => {
    const fetcher = vi.fn(async () =>
      reply(
        state({
          restartableServices: ["api", "worker", "scheduler"],
          restart: {
            service: "worker",
            status: "running",
            startedAt: "2026-10-01T09:00:00.000Z",
            finishedAt: null,
          },
        }),
        202,
      ),
    );
    const result = await client(fetcher as unknown as typeof fetch).restart("worker");
    expect(result.restart?.status).toBe("running");
    const [url, init] = fetcher.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe("http://updater:8090/v1/restart");
    expect(init.method).toBe("POST");
    expect(JSON.parse(init.body as string)).toEqual({ service: "worker" });
    await expect(
      updaterClientFromEnv({ RESTOW_UPDATER_URL: "" }).restart("api"),
    ).rejects.toBeInstanceOf(UpdaterUnavailableError);
  });

  it("reads the state of an updater that predates restarts", async () => {
    const { restartableServices, restart, projectDir, ...old } = state();
    const fetcher = vi.fn(async () => reply(old));
    const result = await client(fetcher as unknown as typeof fetch).state();
    expect(result).toMatchObject({ restartableServices: [], restart: null, projectDir: null });
  });

  it("is switched off by an empty URL and in the demo", async () => {
    expect(updaterClientFromEnv({ RESTOW_UPDATER_URL: "" }).enabled).toBe(false);
    expect(updaterClientFromEnv({}, true).enabled).toBe(false);
    expect(updaterClientFromEnv({}).enabled).toBe(true);
    await expect(
      updaterClientFromEnv({ RESTOW_UPDATER_URL: "" }).schedule({} as never),
    ).rejects.toBeInstanceOf(UpdaterUnavailableError);
  });
});

describe("the database routes of the updater client", () => {
  const requestedBy = { userId: "u1", label: "owner@example.com", ip: null };

  it("checks and moves with the directory and the requester", async () => {
    const check = {
      ok: true,
      problems: [],
      targetDir: "/mnt/x",
      filesystem: "xfs",
      freeBytes: 1,
      totalBytes: 2,
      dataBytes: 1,
      requiredBytes: 1,
      checkedAt: "2026-10-01T09:00:00.000Z",
    };
    const fetcher = vi.fn(async (url: string) =>
      url.endsWith("/check") ? reply(check) : reply(state(), 202),
    );
    const subject = client(fetcher as unknown as typeof fetch);
    expect(await subject.checkDatabaseLocation({ targetDir: "/mnt/x", requestedBy })).toEqual(
      check,
    );
    await subject.moveDatabase({ targetDir: "/mnt/x", requestedBy });
    const calls = fetcher.mock.calls as unknown as [string, RequestInit][];
    expect(calls.map(([url, init]) => `${init.method} ${url}`)).toEqual([
      "POST http://updater:8090/v1/database/check",
      "POST http://updater:8090/v1/database/move",
    ]);
    expect(JSON.parse(calls[1]?.[1].body as string)).toEqual({ targetDir: "/mnt/x", requestedBy });
  });

  it("passes a refusal on with its problems", async () => {
    const fetcher = vi.fn(async () =>
      reply(
        { code: "blocked", message: "no", problems: [{ code: "same_filesystem", detail: null }] },
        409,
      ),
    );
    const error = await client(fetcher as unknown as typeof fetch)
      .moveDatabase({ targetDir: "/mnt/x", requestedBy })
      .catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(UpdaterRejectedError);
    expect((error as UpdaterRejectedError).code).toBe("blocked");
  });

  it("hands a dump's response through without reading it", async () => {
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new TextEncoder().encode("PGDMP"));
        controller.close();
      },
    });
    const upstream = new Response(body, { status: 200 });
    const fetcher = vi.fn(async () => upstream);
    const response = await client(fetcher as unknown as typeof fetch).downloadDump(
      "restow-20260930-100000-0.3.6-to-0.4.0.dump",
    );
    expect(response).toBe(upstream);
    expect(response?.bodyUsed).toBe(false);
    const [url] = fetcher.mock.calls[0] as unknown as [string];
    expect(url).toBe("http://updater:8090/v1/dumps/restow-20260930-100000-0.3.6-to-0.4.0.dump");
  });

  it("answers null for a missing dump and refuses with the updater's code otherwise", async () => {
    const missing = vi.fn(async () => reply({ code: "not_found", message: "no" }, 404));
    expect(await client(missing as unknown as typeof fetch).downloadDump("x.dump")).toBeNull();
    const busy = vi.fn(async () => reply({ code: "busy", message: "no" }, 409));
    await expect(
      client(busy as unknown as typeof fetch).deleteDump("x.dump"),
    ).rejects.toMatchObject({
      code: "busy",
    });
  });

  it("is switched off with the client", async () => {
    await expect(disabledUpdaterClient.downloadDump("x")).rejects.toBeInstanceOf(
      UpdaterUnavailableError,
    );
    await expect(
      disabledUpdaterClient.moveDatabase({ targetDir: "/mnt/x", requestedBy }),
    ).rejects.toBeInstanceOf(UpdaterUnavailableError);
  });
});
