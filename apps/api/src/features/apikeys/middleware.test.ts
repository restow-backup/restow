import { Hono } from "hono";
import { describe, expect, it } from "vitest";
import {
  LAST_USED_RESOLUTION_MS,
  keyUnusableReason,
  rateLimitHeaders,
  requireApiKey,
  shouldTouchLastUsed,
  tenantForApiKey,
} from "../../middleware/apiKey.js";
import { ProblemError, errorHandler } from "../../problem.js";

/**
 * The API-key middleware paths that do not need a database: header parsing,
 * the problem responses for missing or malformed keys, and the pure decisions
 * the middleware is built from. The database-backed paths (lookup, revoke,
 * expiry, rate limit, scopes) run in integrations.pg.test.ts.
 */

const TENANT = "11111111-1111-4111-8111-111111111111";
const OTHER = "22222222-2222-4222-8222-222222222222";

function problemOf(fn: () => unknown): ProblemError {
  try {
    fn();
  } catch (error) {
    if (error instanceof ProblemError) {
      return error;
    }
    throw error;
  }
  throw new Error("expected a problem");
}

function appWithKeyGate() {
  const app = new Hono();
  app.onError(errorHandler);
  app.get("/probe", requireApiKey("status:read"), (c) => c.json({ ok: true }));
  return app;
}

describe("requireApiKey without a usable token", () => {
  it("answers 401 problem+json when the header is missing", async () => {
    const response = await appWithKeyGate().request("/probe");
    expect(response.status).toBe(401);
    expect(response.headers.get("content-type")).toContain("application/problem+json");
    const body = (await response.json()) as { title: string; detail: string };
    expect(body.title).toBe("Missing API key");
    expect(body.detail).toContain("Bearer rsk_");
  });

  it("answers 401 for other bearer tokens and malformed keys without a lookup", async () => {
    for (const token of ["eyJhbGciOiJIUzI1NiJ9", "rsk_contoso_short", "rsk_Contoso_x"]) {
      const response = await appWithKeyGate().request("/probe", {
        headers: { authorization: `Bearer ${token}` },
      });
      expect(response.status).toBe(401);
      const body = (await response.json()) as { title: string; type: string };
      expect(body.title).toBe("Invalid API key");
      expect(body.type).toBe("urn:restow:problem:invalid-api-key");
    }
  });
});

describe("keyUnusableReason", () => {
  const now = new Date("2026-09-23T12:00:00Z");
  it("reports revoked before expired", () => {
    expect(
      keyUnusableReason(
        { revokedAt: new Date("2026-09-01"), expiresAt: new Date("2026-09-02") },
        now,
      ),
    ).toBe("revoked");
  });

  it("treats the expiry instant as expired", () => {
    expect(keyUnusableReason({ revokedAt: null, expiresAt: now }, now)).toBe("expired");
    expect(
      keyUnusableReason({ revokedAt: null, expiresAt: new Date(now.getTime() + 1) }, now),
    ).toBeNull();
    expect(keyUnusableReason({ revokedAt: null, expiresAt: null }, now)).toBeNull();
  });
});

describe("shouldTouchLastUsed", () => {
  const now = new Date("2026-09-23T12:00:00Z");
  it("writes once per minute at most", () => {
    expect(shouldTouchLastUsed(null, now)).toBe(true);
    expect(shouldTouchLastUsed(new Date(now.getTime() - 5_000), now)).toBe(false);
    expect(shouldTouchLastUsed(new Date(now.getTime() - LAST_USED_RESOLUTION_MS), now)).toBe(true);
  });
});

describe("rateLimitHeaders", () => {
  it("reports limit, remaining and reset in seconds", () => {
    expect(
      rateLimitHeaders({
        allowed: true,
        limit: 600,
        remaining: 12,
        resetMs: 1500,
        retryAfterMs: 0,
      }),
    ).toEqual({ "RateLimit-Limit": "600", "RateLimit-Remaining": "12", "RateLimit-Reset": "2" });
  });

  it("adds Retry-After when refused", () => {
    expect(
      rateLimitHeaders({
        allowed: false,
        limit: 600,
        remaining: 0,
        resetMs: 90_000,
        retryAfterMs: 1_001,
      })["Retry-After"],
    ).toBe("2");
  });
});

describe("tenantForApiKey", () => {
  it("binds a tenant key to its own tenant", () => {
    expect(tenantForApiKey({ tenantId: TENANT }, undefined)).toBe(TENANT);
    expect(tenantForApiKey({ tenantId: TENANT }, ` ${TENANT} `)).toBe(TENANT);
    expect(problemOf(() => tenantForApiKey({ tenantId: TENANT }, OTHER)).status).toBe(403);
  });

  it("lets a provider key name the tenant", () => {
    expect(tenantForApiKey({ tenantId: null }, OTHER)).toBe(OTHER);
    expect(problemOf(() => tenantForApiKey({ tenantId: null }, undefined)).status).toBe(400);
    expect(problemOf(() => tenantForApiKey({ tenantId: null }, "contoso")).title).toBe(
      "Invalid tenant id",
    );
  });
});
