import { describe, expect, it } from "vitest";
import {
  FetchGraphClient,
  MAX_BATCH_SIZE,
  chunkIntoBatches,
  computeBackoffMs,
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
            sub.id === "b" && round === 1
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
    const secondRound = graph.callsTo("POST", "$batch")[1]?.json as { requests: { id: string }[] };
    expect(secondRound.requests.map((r) => r.id)).toEqual(["b"]);
    expect(throttles).toEqual([1000]);
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
  it("parses Retry-After seconds, and rejects absent/garbage values", () => {
    expect(parseRetryAfter("2")).toBe(2000);
    expect(parseRetryAfter(null)).toBeNull();
    expect(parseRetryAfter("nonsense")).toBeNull();
  });

  it("honours Retry-After, backs off exponentially, and jitters within one base interval", () => {
    const opts = { baseMs: 500, maxMs: 60_000, random: () => 0 };
    expect(computeBackoffMs(0, 2000, opts)).toBe(2000);
    expect(computeBackoffMs(3, null, opts)).toBe(500 * 8);

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
