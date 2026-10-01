import { afterEach, describe, expect, it, vi } from "vitest";
import { ApiClient, parseSetCookiePairs } from "./http-client.js";

interface FakeFetchInit {
  headers?: Record<string, string>;
  method?: string;
  body?: unknown;
}

function stubFetch(response: { status?: number; body?: unknown; setCookie?: string[] } = {}) {
  const fetchMock = vi.fn(async (_url: string, _init?: FakeFetchInit) => {
    return {
      status: response.status ?? 200,
      headers: { getSetCookie: () => response.setCookie ?? [] },
      text: async () => (response.body === undefined ? "" : JSON.stringify(response.body)),
    } as unknown as Response;
  });
  vi.stubGlobal("fetch", fetchMock);
  return fetchMock;
}

describe("ApiClient origin header", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("sends the configured origin on every request", async () => {
    const fetchMock = stubFetch();
    const client = new ApiClient("http://api:3000", undefined, "http://demo.example.org");
    await client.post("/api/auth/sign-in/email", { email: "a@b.c", password: "x" });
    const headers = fetchMock.mock.calls[0]?.[1]?.headers as Record<string, string>;
    expect(headers.origin).toBe("http://demo.example.org");
  });

  it("sends no origin header when none is configured", async () => {
    const fetchMock = stubFetch();
    const client = new ApiClient("http://api:3000", undefined);
    await client.get("/api/v1/setup/state");
    const headers = fetchMock.mock.calls[0]?.[1]?.headers as Record<string, string>;
    expect(headers.origin).toBeUndefined();
  });
});

describe("ApiClient raw bodies", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("sends an upload segment as given, with its own headers, the tenant and the seed token", async () => {
    const fetchMock = stubFetch({ body: { index: 0 } });
    const client = new ApiClient("http://api:3000", "seed-token", "http://demo.localhost");
    const bytes = Buffer.from("From a@example.org\r\n\r\nbody");
    await client.request("PUT", "/api/v1/imports/uploads/u/segments/0", {
      rawBody: bytes,
      headers: { "content-type": "application/octet-stream", "x-segment-sha256": "ab" },
      tenantId: "tenant-1",
      seed: true,
    });
    const init = fetchMock.mock.calls[0]?.[1] as FakeFetchInit;
    expect(init.method).toBe("PUT");
    expect(init.body).toBe(bytes);
    expect(init.headers).toMatchObject({
      "content-type": "application/octet-stream",
      "x-segment-sha256": "ab",
      "x-restow-tenant": "tenant-1",
      "x-restow-demo-seed-token": "seed-token",
      origin: "http://demo.localhost",
    });
  });
});

describe("parseSetCookiePairs", () => {
  it("reads the name=value pair, ignoring attributes", () => {
    expect(parseSetCookiePairs(["session_token=abc123; Path=/; HttpOnly; SameSite=Lax"])).toEqual([
      ["session_token", "abc123"],
    ]);
  });

  it("reads several Set-Cookie lines", () => {
    expect(parseSetCookiePairs(["a=1; Path=/", "b=2; Path=/; Secure"])).toEqual([
      ["a", "1"],
      ["b", "2"],
    ]);
  });

  it("ignores malformed entries", () => {
    expect(parseSetCookiePairs(["not-a-cookie", ""])).toEqual([]);
  });

  it("returns nothing for an empty list", () => {
    expect(parseSetCookiePairs([])).toEqual([]);
  });
});
