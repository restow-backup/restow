import { afterEach, describe, expect, it, vi } from "vitest";

import {
  ApiError,
  NetworkError,
  TENANT_HEADER,
  apiFetch,
  errorMessageKey,
  isFeatureUnavailable,
  normalizeStatus,
  unwrapList,
} from "./api";
import { setActiveTenantId } from "./tenant";

function jsonResponse(body: unknown, init: ResponseInit = {}): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { "content-type": "application/json" },
    ...init,
  });
}

describe("apiFetch", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    setActiveTenantId(null);
  });

  it("sends the active tenant header and cookies, and decodes JSON", async () => {
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse({ ok: true }));
    vi.stubGlobal("fetch", fetchMock);
    setActiveTenantId("tenant-1");

    const result = await apiFetch<{ ok: boolean }>("/status");

    expect(result).toEqual({ ok: true });
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe("/api/v1/status");
    expect(init.credentials).toBe("include");
    expect((init.headers as Headers).get(TENANT_HEADER)).toBe("tenant-1");
    expect((init.headers as Headers).get("content-type")).toBeNull();
  });

  it("lets a call opt out of the tenant header and encodes JSON bodies", async () => {
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse({ ok: true }, { status: 201 }));
    vi.stubGlobal("fetch", fetchMock);
    setActiveTenantId("tenant-1");

    await apiFetch("/setup", { method: "POST", body: { a: 1 }, tenantId: null });

    const [, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect((init.headers as Headers).get(TENANT_HEADER)).toBeNull();
    expect((init.headers as Headers).get("content-type")).toBe("application/json");
    expect(init.body).toBe('{"a":1}');
  });

  it("tells the server the UI language, unless the call names one", async () => {
    const fetchMock = vi.fn().mockImplementation(async () => jsonResponse({ ok: true }));
    vi.stubGlobal("fetch", fetchMock);
    vi.stubGlobal("document", { documentElement: { lang: "de" } });

    await apiFetch("/settings/mail/test", { method: "POST", body: {} });
    await apiFetch("/status", { headers: { "accept-language": "en" } });

    const [, first] = fetchMock.mock.calls[0] as [string, RequestInit];
    const [, second] = fetchMock.mock.calls[1] as [string, RequestInit];
    expect((first.headers as Headers).get("accept-language")).toBe("de");
    expect((second.headers as Headers).get("accept-language")).toBe("en");
  });

  it("turns problem+json responses into ApiError with the detail", async () => {
    vi.stubGlobal(
      "fetch",
      vi
        .fn()
        .mockResolvedValue(
          new Response(
            JSON.stringify({ type: "about:blank", title: "Conflict", status: 409, detail: "Done" }),
            { status: 409, headers: { "content-type": "application/problem+json" } },
          ),
        ),
    );

    await expect(apiFetch("/setup", { method: "POST", body: {} })).rejects.toMatchObject({
      name: "ApiError",
      status: 409,
      message: "Done",
      problem: { title: "Conflict", status: 409 },
    });
  });

  it("survives non-JSON error bodies", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(new Response("nope", { status: 502, headers: {} })),
    );

    await expect(apiFetch("/status")).rejects.toMatchObject({ status: 502, problem: null });
  });

  it("wraps transport failures in NetworkError", async () => {
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new TypeError("Failed to fetch")));

    await expect(apiFetch("/status")).rejects.toBeInstanceOf(NetworkError);
  });

  it("returns undefined for 204", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response(null, { status: 204 })));

    await expect(apiFetch("/tenants/x", { method: "DELETE" })).resolves.toBeUndefined();
  });
});

describe("errorMessageKey", () => {
  it("maps status codes to common error keys", () => {
    expect(errorMessageKey(new NetworkError(null))).toBe("errors.network");
    expect(errorMessageKey(new ApiError(401, null, "x"))).toBe("errors.unauthorized");
    expect(errorMessageKey(new ApiError(403, null, "x"))).toBe("errors.forbidden");
    expect(errorMessageKey(new ApiError(404, null, "x"))).toBe("errors.notFound");
    expect(errorMessageKey(new ApiError(409, null, "x"))).toBe("errors.conflict");
    expect(errorMessageKey(new ApiError(422, null, "x"))).toBe("errors.validation");
    expect(errorMessageKey(new ApiError(500, null, "x"))).toBe("errors.server");
    expect(errorMessageKey(new ApiError(502, null, "x"))).toBe("errors.network");
    expect(errorMessageKey(new ApiError(503, null, "x"))).toBe("errors.network");
    expect(errorMessageKey(new Error("?"))).toBe("errors.generic");
  });

  it("words a gated function refused here the same neutral way, whoever refused it", () => {
    const refused = (type: string, extra: Record<string, unknown> = {}) =>
      new ApiError(403, { type, title: "Forbidden", status: 403, ...extra }, "x");
    const core = refused("urn:restow:problem:feature-unavailable", { feature: "reports.timed" });
    const extension = refused("urn:restow:problem:edition-required", { capability: "x" });
    expect(isFeatureUnavailable(core)).toBe(true);
    expect(isFeatureUnavailable(extension)).toBe(true);
    expect(isFeatureUnavailable(refused("about:blank"))).toBe(false);
    expect(isFeatureUnavailable(new Error("?"))).toBe(false);
    expect(errorMessageKey(core)).toBe("errors.featureUnavailable");
    expect(errorMessageKey(extension)).toBe("errors.featureUnavailable");
  });
});

describe("unwrapList", () => {
  it("accepts arrays and pages", () => {
    expect(unwrapList([1, 2])).toEqual([1, 2]);
    expect(unwrapList({ items: [1], next: null })).toEqual([1]);
    expect(unwrapList({ nope: true })).toEqual([]);
    expect(unwrapList(null)).toEqual([]);
  });
});

describe("normalizeStatus", () => {
  it("fills a fully stubbed payload with honest empties", () => {
    expect(normalizeStatus({})).toEqual({
      lastSuccess: { mail: null, onedrive: null, imap: null, archive: null },
      protectedObjects: 0,
      failedObjects: 0,
      objectsWithItemFailures: 0,
      storage: { logicalBytes: 0, physicalBytes: 0 },
      recoveryReadiness: null,
      lastVerifyAt: null,
      archiveChain: "unknown",
      version: "",
      updateAvailable: false,
    });
  });

  it("keeps valid values and drops invalid ones", () => {
    const status = normalizeStatus({
      lastSuccess: { mail: "2026-09-21T10:00:00Z", onedrive: 5 },
      protectedObjects: 12,
      failedObjects: "2",
      storage: { logicalBytes: 100, physicalBytes: Number.NaN },
      recoveryReadiness: "purple",
      archiveChain: "ok",
      version: "1.2.3",
      updateAvailable: "yes",
    });
    expect(status.lastSuccess.mail).toBe("2026-09-21T10:00:00Z");
    expect(status.lastSuccess.onedrive).toBeNull();
    expect(status.protectedObjects).toBe(12);
    expect(status.failedObjects).toBe(0);
    expect(status.storage).toEqual({ logicalBytes: 100, physicalBytes: 0 });
    expect(status.recoveryReadiness).toBeNull();
    expect(status.archiveChain).toBe("ok");
    expect(status.version).toBe("1.2.3");
    expect(status.updateAvailable).toBe(false);
  });

  it("reads the API's Status document", () => {
    const status = normalizeStatus({
      tenant: { id: "t1", name: "Acme", slug: "acme", status: "active" },
      generatedAt: "2026-09-23T08:00:00Z",
      lastSuccess: { mail: "2026-09-23T02:00:00Z", onedrive: null, imap: null, archive: null },
      objects: {
        total: 14,
        active: 12,
        excluded: 1,
        orphaned: 1,
        failed: 2,
        withItemFailures: 3,
        runningBackups: 0,
      },
      storage: { logicalBytes: 2048, physicalBytes: 1024 },
      recoveryReadiness: "yellow",
      lastVerifyAt: "2026-09-22T03:00:00Z",
      archive: { chain: "verified", lastCaptureAt: null },
      version: { running: "1.4.0", latest: "1.5.0", updateAvailable: true },
    });
    expect(status.protectedObjects).toBe(12);
    expect(status.failedObjects).toBe(2);
    expect(status.objectsWithItemFailures).toBe(3);
    expect(status.storage).toEqual({ logicalBytes: 2048, physicalBytes: 1024 });
    expect(status.recoveryReadiness).toBe("yellow");
    expect(status.archiveChain).toBe("ok");
    expect(status.version).toBe("1.4.0");
    expect(status.updateAvailable).toBe(true);
    expect(normalizeStatus({ archive: { chain: "not_verified" } }).archiveChain).toBe("unknown");
    expect(normalizeStatus({ archive: { chain: "broken" } }).archiveChain).toBe("broken");
  });
});
