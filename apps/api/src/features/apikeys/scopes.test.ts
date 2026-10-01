import { describe, expect, it } from "vitest";
import { API_SCOPES, hasScope, isApiScope, normalizeScopes } from "./scopes.js";

describe("API scopes", () => {
  it("are exactly the documented set", () => {
    expect([...API_SCOPES].sort()).toEqual(
      [
        "archive:read",
        "items:read",
        "jobs:read",
        "restore:write",
        "status:read",
        "users:read",
        "users:write",
        "verify:write",
        "webhooks:manage",
      ].sort(),
    );
  });

  it("recognise known scopes only", () => {
    expect(isApiScope("jobs:read")).toBe(true);
    expect(isApiScope("jobs:write")).toBe(false);
    expect(isApiScope("*")).toBe(false);
  });

  it("normalise stored lists: unknown dropped, duplicates removed, canonical order", () => {
    expect(normalizeScopes(["webhooks:manage", "status:read", "admin", "status:read"])).toEqual([
      "status:read",
      "webhooks:manage",
    ]);
    expect(normalizeScopes([])).toEqual([]);
  });

  it("grant exactly what is listed, with no implied scopes", () => {
    const scopes = normalizeScopes(["users:write"]);
    expect(hasScope(scopes, "users:write")).toBe(true);
    expect(hasScope(scopes, "users:read")).toBe(false);
    expect(hasScope([], "status:read")).toBe(false);
  });
});
