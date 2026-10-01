import { describe, expect, it } from "vitest";

import { LIMITS, endpointDownloadUrl, endpointKeys } from "./api.js";

describe("endpointDownloadUrl", () => {
  it("names the prepared download and carries the tenant, because a navigation has no header", () => {
    const url = new URL(endpointDownloadUrl("e 1", "dl/1", "tenant-1"), "http://localhost");
    expect(url.pathname).toBe("/api/v1/endpoints/e%201/downloads/dl%2F1");
    expect(url.searchParams.get("tenant")).toBe("tenant-1");
    // The paths and the snapshot were sent when the download was prepared, not in the address.
    expect(url.searchParams.has("path")).toBe(false);
    expect(url.searchParams.has("snapshotId")).toBe(false);
  });

  it("leaves the tenant out when none is active", () => {
    expect(endpointDownloadUrl("e", "d", null)).not.toContain("tenant=");
  });
});

describe("limits and keys", () => {
  it("mirrors the API's limits", () => {
    expect(LIMITS.downloadPaths).toBe(10_000);
    expect(LIMITS.restorePaths).toBe(200);
    expect(LIMITS.backupPaths).toBe(200);
    expect(LIMITS.browsePage).toBeLessThanOrEqual(5000);
  });

  it("scopes every query key to the tenant", () => {
    for (const key of [
      endpointKeys.all("t"),
      endpointKeys.list("t", "server"),
      endpointKeys.detail("t", "e"),
      endpointKeys.snapshots("t", "e"),
      endpointKeys.browse("t", "e", "s", "/"),
      endpointKeys.tokens("t", "valid"),
      endpointKeys.tokens("t", "all"),
      endpointKeys.tokensAll("t"),
    ]) {
      expect(key.slice(0, 3)).toEqual(["tenant", "t", "endpoints"]);
    }
    expect(endpointKeys.list("t", undefined)).toContain("all");
  });

  it("keeps the two token listings apart but under one prefix to invalidate", () => {
    const prefix = endpointKeys.tokensAll("t");
    for (const state of ["valid", "all"] as const) {
      const key = endpointKeys.tokens("t", state);
      expect(key.slice(0, prefix.length)).toEqual([...prefix]);
    }
    expect(endpointKeys.tokens("t", "valid")).not.toEqual(endpointKeys.tokens("t", "all"));
  });
});
