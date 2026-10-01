import { describe, expect, it } from "vitest";
import { REACHABILITY_PATH, classifyFetchError, probePublicUrl } from "./reachability.js";

const fixedNow = () => new Date("2026-09-23T09:00:00.000Z");

/** A fetch fixture: records the request and answers with the given response or error. */
function fixtureFetch(answer: () => Response | Promise<Response>) {
  const calls: { url: string; init: RequestInit | undefined }[] = [];
  const fetchImpl = (async (input: string | URL | Request, init?: RequestInit) => {
    calls.push({ url: String(input), init });
    return answer();
  }) as typeof fetch;
  return { calls, fetchImpl };
}

/** undici's shape: `TypeError("fetch failed")` wrapping the socket error. */
function fetchFailed(code: string): TypeError {
  const cause = Object.assign(new Error(code), { code });
  return new TypeError("fetch failed", { cause });
}

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

describe("probePublicUrl", () => {
  it("confirms a Restow installation behind a trusted certificate", async () => {
    const { calls, fetchImpl } = fixtureFetch(() => json({ configured: true }));
    const probe = await probePublicUrl("https://restow.example.com", { fetchImpl, now: fixedNow });
    expect(probe).toEqual({
      status: "ok",
      url: `https://restow.example.com${REACHABILITY_PATH}`,
      detail: null,
      checkedAt: "2026-09-23T09:00:00.000Z",
    });
    expect(calls[0]?.init?.redirect).toBe("manual");
  });

  it("is skipped without a public URL, for HTTP and for localhost", async () => {
    const { calls, fetchImpl } = fixtureFetch(() => json({ configured: true }));
    for (const origin of [null, "http://restow.example.com", "https://localhost:8443"]) {
      const probe = await probePublicUrl(origin, { fetchImpl, now: fixedNow });
      expect(probe.status, String(origin)).toBe("skipped");
      expect(probe.url).toBeNull();
    }
    expect(calls).toHaveLength(0);
  });

  it("reports a redirect or error status as an unexpected response", async () => {
    const redirect = fixtureFetch(() => new Response(null, { status: 301 }));
    expect(
      await probePublicUrl("https://restow.example.com", { fetchImpl: redirect.fetchImpl }),
    ).toMatchObject({ status: "unexpected_response", detail: "HTTP 301" });
  });

  it("reports a server that is not Restow", async () => {
    const other = fixtureFetch(() => new Response("<html></html>", { status: 200 }));
    expect(
      await probePublicUrl("https://restow.example.com", { fetchImpl: other.fetchImpl }),
    ).toMatchObject({ status: "unexpected_response", detail: "not_restow" });
  });

  it("names an untrusted certificate", async () => {
    const { fetchImpl } = fixtureFetch(() => {
      throw fetchFailed("DEPTH_ZERO_SELF_SIGNED_CERT");
    });
    expect(await probePublicUrl("https://restow.example.com", { fetchImpl })).toMatchObject({
      status: "certificate_invalid",
      detail: "DEPTH_ZERO_SELF_SIGNED_CERT",
    });
  });

  it("names an unreachable host", async () => {
    const { fetchImpl } = fixtureFetch(() => {
      throw fetchFailed("ENOTFOUND");
    });
    expect(await probePublicUrl("https://restow.example.com", { fetchImpl })).toMatchObject({
      status: "unreachable",
      detail: "ENOTFOUND",
    });
  });
});

describe("classifyFetchError", () => {
  it("recognizes certificate problems anywhere in the cause chain", () => {
    for (const code of [
      "CERT_HAS_EXPIRED",
      "SELF_SIGNED_CERT_IN_CHAIN",
      "UNABLE_TO_VERIFY_LEAF_SIGNATURE",
      "ERR_TLS_CERT_ALTNAME_INVALID",
    ]) {
      expect(classifyFetchError(fetchFailed(code)), code).toEqual({
        status: "certificate_invalid",
        detail: code,
      });
    }
  });

  it("recognizes timeouts", () => {
    const aborted = Object.assign(new Error("The operation was aborted due to timeout"), {
      name: "TimeoutError",
    });
    expect(classifyFetchError(aborted)).toEqual({ status: "timeout", detail: null });
    expect(classifyFetchError(fetchFailed("UND_ERR_CONNECT_TIMEOUT"))).toEqual({
      status: "timeout",
      detail: "UND_ERR_CONNECT_TIMEOUT",
    });
  });

  it("falls back to unreachable, with or without a code", () => {
    expect(classifyFetchError(fetchFailed("ECONNREFUSED"))).toEqual({
      status: "unreachable",
      detail: "ECONNREFUSED",
    });
    expect(classifyFetchError(new Error("boom"))).toEqual({ status: "unreachable", detail: null });
    expect(classifyFetchError("weird")).toEqual({ status: "unreachable", detail: null });
  });
});
