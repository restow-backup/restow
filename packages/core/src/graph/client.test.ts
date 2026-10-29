import { describe, expect, it } from "vitest";
import { JobAbortedError } from "../engine/chunkstore.js";
import { isTransientTransferError } from "../storage/transfer.js";
import {
  chunkIntoBatches,
  computeBackoffMs,
  FetchGraphClient,
  GraphResponseTimeoutError,
  MAX_BATCH_SIZE,
  MAX_RETRY_AFTER_MS,
  parseRetryAfter,
} from "./client.js";
import { GraphError } from "./errors.js";
import { batchEnvelope, createFakeGraph, graphError, must } from "./testing/fake-graph.js";

describe("batching", () => {
  it("splits into batches of at most 20", () => {
    const items = Array.from({ length: 45 }, (_, i) => i);
    expect(chunkIntoBatches(items, MAX_BATCH_SIZE).map((b) => b.length)).toEqual([20, 20, 5]);
  });

  it("clamps the batch size to the Graph limit and to at least one", () => {
    expect(chunkIntoBatches([1, 2, 3], 100)).toEqual([[1, 2, 3]]);
    expect(chunkIntoBatches([1, 2, 3], 0)).toEqual([[1], [2], [3]]);
  });

  it("retries only the throttled sub-responses and keeps the caller's order", async () => {
    let round = 0;
    const graph = createFakeGraph([
      {
        method: "POST",
        url: "/v1.0/$batch",
        respond: (call) => {
          round += 1;
          return batchEnvelope(call, (sub) =>
            sub.url === "/users/b" && round === 1
              ? {
                  status: 429,
                  headers: { "Retry-After": "1" },
                  body: graphError("TooManyRequests"),
                }
              : { status: 200, body: { id: sub.id, url: sub.url } },
          );
        },
      },
    ]);
    const throttles: number[] = [];
    const client = graph.client({ onThrottle: (info) => throttles.push(info.retryAfterMs ?? -1) });
    const responses = await client.batch([
      { id: "a", method: "GET", url: "/users/a" },
      { id: "b", method: "GET", url: "/users/b" },
      { id: "c", method: "GET", url: "/users/c" },
    ]);

    expect(responses.map((r) => [r.id, r.status])).toEqual([
      ["a", 200],
      ["b", 200],
      ["c", 200],
    ]);
    expect(round).toBe(2);
    const secondRound = graph.callsTo("POST", "$batch")[1]?.json as { requests: { url: string }[] };
    expect(secondRound.requests.map((r) => r.url)).toEqual(["/users/b"]);
    expect(throttles).toEqual([1000]);
  });

  it("sends unique ids even when the caller's ids repeat, and hands back the caller's", async () => {
    const graph = createFakeGraph([
      {
        method: "POST",
        url: "/v1.0/$batch",
        respond: (call) => batchEnvelope(call, (sub) => ({ status: 200, body: { url: sub.url } })),
      },
    ]);
    const responses = await graph.client().batch([
      { id: "AAMkFolder", method: "GET", url: "/a" },
      { id: "AAMkFolder", method: "GET", url: "/b" },
    ]);
    expect(responses.map((r) => [r.id, (r.body as { url: string }).url])).toEqual([
      ["AAMkFolder", "/a"],
      ["AAMkFolder", "/b"],
    ]);
    const sent = graph.callsTo("POST", "$batch")[0]?.json as { requests: { id: string }[] };
    expect(new Set(sent.requests.map((r) => r.id)).size).toBe(2);
  });

  it("sends an identical read once and gives the answer to every caller", async () => {
    const graph = createFakeGraph([
      {
        method: "POST",
        url: "/v1.0/$batch",
        respond: (call) => batchEnvelope(call, (sub) => ({ status: 200, body: { url: sub.url } })),
      },
    ]);
    // A delta page that lists the same message twice: same caller id, same request.
    const responses = await graph.client().batch([
      { id: "AAMkMsg", method: "GET", url: "/users/u/messages/AAMkMsg/$value" },
      { id: "other", method: "GET", url: "/users/u/messages/other/$value" },
      { id: "AAMkMsg", method: "GET", url: "/users/u/messages/AAMkMsg/$value" },
    ]);
    expect(responses.map((r) => [r.id, r.status, (r.body as { url: string }).url])).toEqual([
      ["AAMkMsg", 200, "/users/u/messages/AAMkMsg/$value"],
      ["other", 200, "/users/u/messages/other/$value"],
      ["AAMkMsg", 200, "/users/u/messages/AAMkMsg/$value"],
    ]);
    const sent = graph.callsTo("POST", "$batch")[0]?.json as { requests: { id: string }[] };
    expect(sent.requests.map((r) => r.id)).toEqual(["0", "1"]);
  });

  it("collapses reads whose headers differ only in name case, not in value", async () => {
    const graph = createFakeGraph([
      {
        method: "POST",
        url: "/v1.0/$batch",
        respond: (call) => batchEnvelope(call, () => ({ status: 200, body: {} })),
      },
    ]);
    await graph.client().batch([
      { id: "a", method: "GET", url: "/x", headers: { Prefer: "IdType=ImmutableId" } },
      { id: "b", method: "get", url: "/x", headers: { prefer: "IdType=ImmutableId" } },
      { id: "c", method: "GET", url: "/x", headers: { Prefer: "outlook.body-content-type=text" } },
    ]);
    const sent = graph.callsTo("POST", "$batch")[0]?.json as { requests: unknown[] };
    expect(sent.requests).toHaveLength(2);
  });

  it("never collapses writes", async () => {
    const graph = createFakeGraph([
      {
        method: "POST",
        url: "/v1.0/$batch",
        respond: (call) => batchEnvelope(call, () => ({ status: 201, body: {} })),
      },
    ]);
    const responses = await graph.client().batch([
      { id: "s", method: "POST", url: "/subscriptions", body: { resource: "r" } },
      { id: "s", method: "POST", url: "/subscriptions", body: { resource: "r" } },
    ]);
    expect(responses).toHaveLength(2);
    const sent = graph.callsTo("POST", "$batch")[0]?.json as { requests: { id: string }[] };
    expect(sent.requests.map((r) => r.id)).toEqual(["0", "1"]);
  });

  it("retries a collapsed read once and answers all its callers with the retry", async () => {
    let round = 0;
    const graph = createFakeGraph([
      {
        method: "POST",
        url: "/v1.0/$batch",
        respond: (call) => {
          round += 1;
          return batchEnvelope(call, (sub) =>
            sub.url === "/users/b" && round === 1
              ? {
                  status: 429,
                  headers: { "Retry-After": "0" },
                  body: graphError("TooManyRequests"),
                }
              : { status: 200, body: { round } },
          );
        },
      },
    ]);
    const responses = await graph.client().batch([
      { id: "b", method: "GET", url: "/users/b" },
      { id: "a", method: "GET", url: "/users/a" },
      { id: "b", method: "GET", url: "/users/b" },
    ]);
    expect(responses.map((r) => [r.id, r.status, (r.body as { round: number }).round])).toEqual([
      ["b", 200, 2],
      ["a", 200, 1],
      ["b", 200, 2],
    ]);
    const second = graph.callsTo("POST", "$batch")[1]?.json as { requests: { id: string }[] };
    expect(second.requests.map((r) => r.id)).toEqual(["0"]);
  });

  it("adds Content-Type to batch sub-requests that carry a body", async () => {
    const graph = createFakeGraph([
      {
        method: "POST",
        url: "/v1.0/$batch",
        respond: (call) => batchEnvelope(call, () => ({ status: 201, body: {} })),
      },
    ]);
    await graph.client().batch([{ id: "1", method: "POST", url: "/x", body: { a: 1 } }]);
    const payload = graph.calls[0]?.json as { requests: { headers?: Record<string, string> }[] };
    expect(payload.requests[0]?.headers).toEqual({ "Content-Type": "application/json" });
  });
});

describe("throttling", () => {
  /** The waits of a client whose first GET is answered 429 with Retry-After: 300. */
  async function retryAfterWaits(options: { signal?: AbortSignal; maxRetryAfterMs?: number }) {
    const waits: number[] = [];
    let calls = 0;
    const fetchImpl = (async () =>
      ++calls === 1
        ? new Response("{}", { status: 429, headers: { "retry-after": "300" } })
        : new Response("{}", {
            status: 200,
            headers: { "content-type": "application/json" },
          })) as unknown as typeof fetch;
    const client = new FetchGraphClient({
      accessTokenProvider: async () => "token",
      fetchImpl,
      random: () => 0,
      sleep: async (ms) => {
        waits.push(ms);
      },
      ...options,
    });
    expect((await client.request({ method: "GET", url: "/me" })).status).toBe(200);
    return waits;
  }

  it("honours a minutes-long Retry-After only for a client with a signal", async () => {
    // An API request has no signal that would end the wait: kept to maxBackoffMs.
    expect(await retryAfterWaits({})).toEqual([60_000]);
    expect(await retryAfterWaits({ signal: new AbortController().signal })).toEqual([300_000]);
    expect(await retryAfterWaits({ maxRetryAfterMs: 300_000 })).toEqual([300_000]);
  });

  it("parses Retry-After seconds, and rejects absent/garbage values", () => {
    expect(parseRetryAfter("2")).toBe(2000);
    expect(parseRetryAfter(null)).toBeNull();
    expect(parseRetryAfter("nonsense")).toBeNull();
  });

  it("honours Retry-After, backs off exponentially, and jitters within one base interval", () => {
    const opts = { baseMs: 500, maxMs: 60_000, random: () => 0 };
    expect(computeBackoffMs(0, 2000, opts)).toBe(2000);
    expect(computeBackoffMs(3, null, opts)).toBe(500 * 8);

    // A server's Retry-After beyond maxMs is honoured (Exchange asks for minutes), up to a bound.
    expect(computeBackoffMs(0, 120_000, opts)).toBe(120_000);
    expect(computeBackoffMs(0, 3_600_000, opts)).toBe(MAX_RETRY_AFTER_MS);
    expect(computeBackoffMs(10, null, opts)).toBe(60_000);

    expect(computeBackoffMs(0, 120_000, { ...opts, maxRetryAfterMs: 60_000 })).toBe(60_000);

    const jittered = computeBackoffMs(0, 1000, { baseMs: 500, maxMs: 60_000, random: () => 0.999 });
    expect(jittered).toBeGreaterThanOrEqual(1000);
    expect(jittered).toBeLessThan(1000 + 500);
  });

  it("retries a 429 then succeeds, without touching the network", async () => {
    let calls = 0;
    const fakeFetch = (async () => {
      calls += 1;
      if (calls === 1) {
        return new Response("", { status: 429, headers: { "retry-after": "0" } });
      }
      return new Response(JSON.stringify({ ok: true }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }) as unknown as typeof fetch;

    const client = new FetchGraphClient({
      accessTokenProvider: async () => "token",
      fetchImpl: fakeFetch,
      sleep: async () => {},
      random: () => 0,
    });

    const res = await client.request<{ ok: boolean }>({ method: "GET", url: "/me" });
    expect(calls).toBe(2);
    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
  });

  it("retries 504 and gives up after maxRetries, returning the last status", async () => {
    const graph = createFakeGraph([{ url: "/v1.0/me", respond: { status: 504, text: "gateway" } }]);
    const client = graph.client({ maxRetries: 2 });
    const res = await client.request({ method: "GET", url: "/me" });
    expect(res.status).toBe(504);
    expect(graph.calls).toHaveLength(3);
  });
});

describe("connection errors before Graph answered", () => {
  /** A fetch that fails like undici on a reset socket `failures` times, then answers 200. */
  function resetting(failures: number) {
    const methods: string[] = [];
    const fetchImpl = (async (_url: string, init?: RequestInit) => {
      methods.push(init?.method ?? "GET");
      if (methods.length <= failures) {
        throw new TypeError("fetch failed", {
          cause: Object.assign(new Error("other side closed"), { code: "UND_ERR_SOCKET" }),
        });
      }
      return new Response(JSON.stringify({ responses: [{ id: "0", status: 200, body: {} }] }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }) as unknown as typeof fetch;
    const throttles: number[] = [];
    const client = new FetchGraphClient({
      accessTokenProvider: async () => "token",
      fetchImpl,
      sleep: async () => {},
      random: () => 0,
      maxRetries: 3,
      onThrottle: (info) => throttles.push(info.status),
    });
    return { client, methods, throttles };
  }

  it("sends a GET again after a reset, with backoff not reported as throttling", async () => {
    const { client, methods, throttles } = resetting(2);
    expect((await client.request({ method: "GET", url: "/drives/d/root/delta" })).status).toBe(200);
    expect(methods).toEqual(["GET", "GET", "GET"]);
    expect(throttles).toEqual([]);
  });

  it("gives up after maxRetries and throws the network error", async () => {
    const { client, methods } = resetting(10);
    await expect(client.request({ method: "GET", url: "/sites/s" })).rejects.toThrow(
      "fetch failed",
    );
    expect(methods).toHaveLength(4);
  });

  it("never sends a request that changes something twice", async () => {
    const { client, methods } = resetting(1);
    await expect(
      client.request({ method: "POST", url: "/users/u/messages", body: {} }),
    ).rejects.toThrow("fetch failed");
    expect(methods).toEqual(["POST"]);
  });

  it("sends a $batch of reads again, but not a $batch that writes", async () => {
    const reads = resetting(1);
    const answered = await reads.client.batch([{ id: "x", method: "GET", url: "/users/a" }]);
    expect(answered.map((r) => r.status)).toEqual([200]);
    expect(reads.methods).toEqual(["POST", "POST"]);

    const writes = resetting(1);
    await expect(
      writes.client.batch([{ id: "x", method: "PATCH", url: "/users/a", body: {} }]),
    ).rejects.toThrow("fetch failed");
    expect(writes.methods).toEqual(["POST"]);
  });

  it("does not send again once the job was cancelled", async () => {
    const controller = new AbortController();
    let calls = 0;
    const fetchImpl = (async () => {
      calls++;
      controller.abort();
      throw new TypeError("fetch failed", { cause: { code: "ECONNRESET" } });
    }) as unknown as typeof fetch;
    const client = new FetchGraphClient({
      accessTokenProvider: async () => "token",
      fetchImpl,
      sleep: async () => {},
      signal: controller.signal,
    });
    await expect(client.request({ method: "GET", url: "/me" })).rejects.toBeInstanceOf(
      JobAbortedError,
    );
    expect(calls).toBe(1);
  });

  it("classifies a reset as transient, a cancellation never", () => {
    expect(
      isTransientTransferError(new TypeError("fetch failed", { cause: { code: "ECONNRESET" } })),
    ).toBe(true);
    expect(isTransientTransferError(new JobAbortedError())).toBe(false);
  });
});

describe("requests", () => {
  it("sends raw bodies verbatim and omits the bearer token when auth is false", async () => {
    const graph = createFakeGraph([
      {
        method: "PUT",
        url: /upload\.aspx/,
        respond: { status: 202, json: { nextExpectedRanges: ["5-"] } },
      },
      { method: "POST", url: /messages$/, respond: { status: 201, json: { id: "new" } } },
    ]);
    const client = graph.client();

    await client.request({
      method: "PUT",
      url: "https://contoso-my.sharepoint.example/upload.aspx?s=1",
      auth: false,
      rawBody: new Uint8Array([1, 2, 3, 4, 5]),
      headers: { "Content-Type": "application/octet-stream" },
    });
    const upload = must(graph.calls[0]);
    expect(upload.headers.authorization).toBeUndefined();
    expect(upload.headers["content-type"]).toBe("application/octet-stream");
    expect(Buffer.from(upload.body as Uint8Array)).toEqual(Buffer.from([1, 2, 3, 4, 5]));

    await client.request({
      method: "POST",
      url: "/users/u/mailFolders/f/messages",
      headers: { "Content-Type": "text/plain" },
      rawBody: "QUJD",
    });
    const mime = must(graph.calls[1]);
    expect(mime.headers.authorization).toBe("Bearer test-token");
    expect(mime.body).toBe("QUJD");
  });

  it("never attaches the bearer token to a URL whose origin is not Graph, even when the caller left auth at its default", async () => {
    // The realistic source of such a URL: a stored delta/next link
    // (graph/delta.ts) read back from a manifest, which this client must
    // never trust with the app-only token just because the caller forgot
    // `auth: false` — see client.ts's `isGraphOrigin`.
    const graph = createFakeGraph([
      { url: () => true, respond: { status: 200, json: { value: [] } } },
    ]);
    const client = graph.client();

    await client.request({ method: "GET", url: "https://attacker.example.test/steal" });
    expect(must(graph.calls[0]).headers.authorization).toBeUndefined();

    await client.request({ method: "GET", url: "/users/u/messages" });
    expect(must(graph.calls[1]).headers.authorization).toBe("Bearer test-token");
  });

  it("streams 2xx bodies and parses non-2xx bodies as errors", async () => {
    const graph = createFakeGraph([
      {
        url: "/v1.0/users/u/messages/ok/$value",
        respond: { status: 200, text: "From: a@b\r\n\r\nhi" },
      },
      {
        url: "/v1.0/users/u/messages/missing/$value",
        respond: { status: 404, json: graphError("ErrorItemNotFound") },
      },
    ]);
    const client = graph.client();

    const ok = await client.stream({ method: "GET", url: "/users/u/messages/ok/$value" });
    const chunks: Buffer[] = [];
    for await (const chunk of must(ok.body)) {
      chunks.push(chunk as Buffer);
    }
    expect(Buffer.concat(chunks).toString()).toBe("From: a@b\r\n\r\nhi");

    const missing = await client.stream({ method: "GET", url: "/users/u/messages/missing/$value" });
    expect(missing.body).toBeNull();
    expect(missing.status).toBe(404);
    expect((missing.error as { error: { code: string } }).error.code).toBe("ErrorItemNotFound");
  });

  it("delta throws a GraphError with status, code and headers on a non-2xx page", async () => {
    const graph = createFakeGraph([
      {
        url: /messages\/delta/,
        respond: {
          status: 410,
          headers: { Location: "https://x/new" },
          json: graphError("SyncStateNotFound"),
        },
      },
    ]);
    const pages = graph.client().delta("/users/u/mailFolders/f/messages/delta");
    const error = await pages.next().catch((e: unknown) => e);
    expect(error).toBeInstanceOf(GraphError);
    expect((error as GraphError).status).toBe(410);
    expect((error as GraphError).code).toBe("SyncStateNotFound");
    expect((error as GraphError).headers.location).toBe("https://x/new");
    expect((error as GraphError).message).not.toContain("token");
  });
});

describe("a refused token (401, 403)", () => {
  const denied = {
    status: 403,
    json: { error: { code: "Authorization_RequestDenied", message: "Insufficient privileges" } },
  };

  it("asks once for a new token and sends the request again, which then carries a granted permission", async () => {
    const graph = createFakeGraph([
      { url: /messages$/, respond: [denied, { status: 200, json: { value: [] } }] },
    ]);
    let token = 0;
    let refreshes = 0;
    const client = graph.client({
      accessTokenProvider: async () => `token-${token}`,
      refreshAccessToken: () => {
        refreshes++;
        token++;
        return true;
      },
    });
    await client.request({ method: "GET", url: "/users/u/messages" });
    expect(refreshes).toBe(1);
    expect(graph.calls.map((call) => call.headers.authorization)).toEqual([
      "Bearer token-0",
      "Bearer token-1",
    ]);
  });

  it("returns the refusal when the provider keeps its token, and asks only once per request", async () => {
    const graph = createFakeGraph([{ url: /messages$/, respond: denied }]);
    let refreshes = 0;
    const kept = graph.client({
      refreshAccessToken: () => {
        refreshes++;
        return false;
      },
    });
    expect((await kept.request({ method: "GET", url: "/users/u/messages" })).status).toBe(403);
    expect(graph.calls).toHaveLength(1);

    const fresh = graph.client({
      refreshAccessToken: () => {
        refreshes++;
        return true;
      },
    });
    expect((await fresh.request({ method: "GET", url: "/users/u/messages" })).status).toBe(403);
    // Refused again with the new token: no third attempt.
    expect(graph.calls).toHaveLength(3);
    expect(refreshes).toBe(2);
  });
});

describe("a refused token inside a $batch", () => {
  it("sends the refused sub-requests once more with a new token", async () => {
    let round = 0;
    const graph = createFakeGraph([
      {
        method: "POST",
        url: "/v1.0/$batch",
        respond: (call) => {
          round += 1;
          return batchEnvelope(call, (sub) =>
            sub.url === "/users/b/messages" && round === 1
              ? { status: 403, body: graphError("ErrorAccessDenied") }
              : { status: 200, body: { url: sub.url } },
          );
        },
      },
    ]);
    let token = 0;
    const refused: (string | undefined)[] = [];
    const client = graph.client({
      accessTokenProvider: async () => `token-${token}`,
      refreshAccessToken: (refusedToken) => {
        refused.push(refusedToken);
        token++;
        return true;
      },
    });
    const responses = await client.batch([
      { id: "a", method: "GET", url: "/users/a/messages" },
      { id: "b", method: "GET", url: "/users/b/messages" },
    ]);
    expect(responses.map((r) => [r.id, r.status])).toEqual([
      ["a", 200],
      ["b", 200],
    ]);
    expect(refused).toEqual(["token-0"]);
    const second = graph.callsTo("POST", "$batch")[1];
    expect(second?.headers.authorization).toBe("Bearer token-1");
    const resent = must(second?.json as { requests: { url: string }[] } | undefined);
    expect(resent.requests.map((r) => r.url)).toEqual(["/users/b/messages"]);
  });

  it("re-sends a refused read that several callers share as one sub-request", async () => {
    let round = 0;
    const graph = createFakeGraph([
      {
        method: "POST",
        url: "/v1.0/$batch",
        respond: (call) => {
          round += 1;
          return batchEnvelope(call, () =>
            round === 1
              ? { status: 403, body: graphError("ErrorAccessDenied") }
              : { status: 200, body: {} },
          );
        },
      },
    ]);
    const client = graph.client({ refreshAccessToken: () => true });
    const responses = await client.batch([
      { id: "m", method: "GET", url: "/users/b/messages/m" },
      { id: "m", method: "GET", url: "/users/b/messages/m" },
    ]);
    expect(responses.map((r) => [r.id, r.status])).toEqual([
      ["m", 200],
      ["m", 200],
    ]);
    for (const call of graph.callsTo("POST", "$batch")) {
      expect((call.json as { requests: { id: string }[] }).requests.map((r) => r.id)).toEqual([
        "0",
      ]);
    }
  });

  it("returns the refusal when the provider keeps its token, and asks only once", async () => {
    const graph = createFakeGraph([
      {
        method: "POST",
        url: "/v1.0/$batch",
        respond: (call) =>
          batchEnvelope(call, () => ({ status: 403, body: graphError("ErrorAccessDenied") })),
      },
    ]);
    let refreshes = 0;
    const fresh = graph.client({
      refreshAccessToken: () => {
        refreshes++;
        return true;
      },
    });
    const responses = await fresh.batch([{ id: "a", method: "GET", url: "/users/a" }]);
    expect(responses.map((r) => r.status)).toEqual([403]);
    // Refused again with the new token: no third round.
    expect(graph.callsTo("POST", "$batch")).toHaveLength(2);
    expect(refreshes).toBe(1);
  });
});

describe("hanging requests and aborted jobs (#47)", () => {
  /** A fetch that never answers until its signal aborts it, then succeeds on the next call. */
  function hangingOnce() {
    let calls = 0;
    const fetchImpl = ((_url: string, init: RequestInit) => {
      calls += 1;
      if (calls === 1) {
        return new Promise((_, reject) => {
          init.signal?.addEventListener("abort", () => reject(new Error("aborted")), {
            once: true,
          });
        });
      }
      return Promise.resolve(
        new Response(JSON.stringify({ ok: true }), {
          status: 200,
          headers: { "content-type": "application/json" },
        }),
      );
    }) as unknown as typeof fetch;
    return { fetchImpl, calls: () => calls };
  }

  it("retries a request Graph does not answer in time, like a 504", async () => {
    const hanging = hangingOnce();
    const client = new FetchGraphClient({
      accessTokenProvider: async () => "token",
      fetchImpl: hanging.fetchImpl,
      sleep: async () => {},
      random: () => 0,
      responseTimeoutMs: 20,
    });
    const res = await client.request<{ ok: boolean }>({ method: "GET", url: "/me" });
    expect(res.status).toBe(200);
    expect(hanging.calls()).toBe(2);
  });

  it("gives up with a timeout error that is classified like undici's, without the query string", async () => {
    const fetchImpl = ((_url: string, init: RequestInit) =>
      new Promise((_, reject) => {
        init.signal?.addEventListener("abort", () => reject(new Error("aborted")), { once: true });
      })) as unknown as typeof fetch;
    const client = new FetchGraphClient({
      accessTokenProvider: async () => "token",
      fetchImpl,
      sleep: async () => {},
      maxRetries: 1,
      responseTimeoutMs: 10,
    });
    const error = await client
      .request({ method: "GET", url: "/me/drive/items/1/content?token=secret" })
      .catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(GraphResponseTimeoutError);
    expect((error as { code: string }).code).toBe("UND_ERR_HEADERS_TIMEOUT");
    expect((error as Error).message).not.toContain("secret");
  });

  it("stops a hanging request and a throttling wait when the job is aborted", async () => {
    const job = new AbortController();
    const hanging = hangingOnce();
    const client = new FetchGraphClient({
      accessTokenProvider: async () => "token",
      fetchImpl: hanging.fetchImpl,
      signal: job.signal,
      responseTimeoutMs: 60_000,
    });
    const pending = client.request({ method: "GET", url: "/me" });
    job.abort("expired");
    await expect(pending).rejects.toBeInstanceOf(JobAbortedError);

    const throttled = new AbortController();
    const waiting = new FetchGraphClient({
      accessTokenProvider: async () => "token",
      fetchImpl: (async () =>
        new Response("", {
          status: 429,
          headers: { "retry-after": "3600" },
        })) as unknown as typeof fetch,
      signal: throttled.signal,
    });
    const slow = waiting.request({ method: "GET", url: "/me" });
    setTimeout(() => throttled.abort("shutdown"), 10);
    await expect(slow).rejects.toBeInstanceOf(JobAbortedError);
  });
});
