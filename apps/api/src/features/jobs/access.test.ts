import { describe, expect, it } from "vitest";
import { ProblemError } from "../../problem.js";
import { tenantForApiKey } from "../apikeys/key-tenant.js";
import { isApiKeyAuthorization } from "../apikeys/tokens.js";

/**
 * The jobs gate (./access.ts) is the shared session-or-key gate; these are the
 * key rules it applies before a job is read or changed. The provider-key and
 * tenant-state rules run in ../apikeys/key-tenant.test.ts.
 */

const TENANT = "0f6e4b4e-2f2a-4d9a-9c2b-1a2b3c4d5e6f";
const OTHER = "9b2f2c6e-3d1a-4a1b-8e3f-0c1d2e3f4a5b";

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

describe("jobs access: API key detection", () => {
  it("recognises Restow API keys and leaves sessions and other tokens alone", () => {
    expect(isApiKeyAuthorization("Bearer rsk_tenant_abc")).toBe(true);
    expect(isApiKeyAuthorization("  Bearer rsk_provider_abc ")).toBe(true);
    expect(isApiKeyAuthorization(undefined)).toBe(false);
    expect(isApiKeyAuthorization("")).toBe(false);
    expect(isApiKeyAuthorization("Bearer eyJhbGciOi")).toBe(false);
    expect(isApiKeyAuthorization("Basic b3NrXw==")).toBe(false);
  });
});

describe("jobs access: the tenant a key acts on", () => {
  it("lets a tenant key act on its own tenant, named or not", () => {
    expect(tenantForApiKey({ tenantId: TENANT }, undefined)).toBe(TENANT);
    expect(tenantForApiKey({ tenantId: TENANT }, TENANT)).toBe(TENANT);
  });

  it("refuses a tenant key naming another tenant", () => {
    expect(problemOf(() => tenantForApiKey({ tenantId: TENANT }, OTHER)).status).toBe(403);
  });

  it("makes a provider key name a valid tenant", () => {
    expect(tenantForApiKey({ tenantId: null }, ` ${OTHER} `)).toBe(OTHER);
    expect(problemOf(() => tenantForApiKey({ tenantId: null }, undefined)).status).toBe(400);
    expect(problemOf(() => tenantForApiKey({ tenantId: null }, "tenant-1")).title).toBe(
      "Invalid tenant id",
    );
  });
});
