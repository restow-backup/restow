import { describe, expect, it, vi } from "vitest";
import type { StateView } from "../../updater/protocol.js";
import {
  UpdaterRejectedError,
  UpdaterUnavailableError,
  bearerOf,
  createUpdaterClient,
  secretMatches,
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
      checkedAt: "2026-10-01T09:00:00.000Z",
    },
    selfUpdate: null,
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

  it("is switched off by an empty URL and in the demo", async () => {
    expect(updaterClientFromEnv({ RESTOW_UPDATER_URL: "" }).enabled).toBe(false);
    expect(updaterClientFromEnv({}, true).enabled).toBe(false);
    expect(updaterClientFromEnv({}).enabled).toBe(true);
    await expect(
      updaterClientFromEnv({ RESTOW_UPDATER_URL: "" }).schedule({} as never),
    ).rejects.toBeInstanceOf(UpdaterUnavailableError);
  });
});
