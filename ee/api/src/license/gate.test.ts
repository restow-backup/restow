import type { Database } from "@restow/db";
import { Hono } from "hono";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ProblemError } from "../../../../apps/api/src/problem.js";
import {
  FEATURE_CAPABILITIES,
  capabilityGuard,
  currentEdition,
  editionRequired,
  hasCapability,
  licenseFeatureGate,
  requireCapability,
} from "./gate.js";

type Edition = "community" | "business" | "service_provider";

/** Fake database returning the given active license row (none = the environment applies). */
function fakeDb(edition?: Edition) {
  const db = {
    select: () => ({
      from: () => ({
        where: () => ({
          orderBy: () => ({
            limit: async () => (edition ? [{ edition }] : []),
          }),
        }),
      }),
    }),
  };
  return db as unknown as Database;
}

afterEach(() => {
  vi.unstubAllEnvs();
});

describe("currentEdition", () => {
  it("is Community without a key", async () => {
    expect(await currentEdition(fakeDb())).toBe("community");
  });

  it("prefers an installed, active license", async () => {
    expect(await currentEdition(fakeDb("business"))).toBe("business");
  });

  it("ignores RESTOW_EDITION outside demo mode", async () => {
    vi.stubEnv("RESTOW_EDITION", "service_provider");
    vi.stubEnv("RESTOW_DEMO", "");
    expect(await currentEdition(fakeDb())).toBe("community");
  });

  it("honours RESTOW_EDITION in demo mode", async () => {
    vi.stubEnv("RESTOW_EDITION", "service_provider");
    vi.stubEnv("RESTOW_DEMO", "true");
    expect(await currentEdition(fakeDb())).toBe("service_provider");
  });
});

describe("hasCapability", () => {
  it("community has no Business or Service Provider capability", async () => {
    expect(await hasCapability(fakeDb(), "provider.crossTenantApi")).toBe(false);
    expect(await hasCapability(fakeDb(), "archive.legalHold")).toBe(false);
  });

  it("a Business license unlocks Business capabilities but not Service Provider ones", async () => {
    expect(await hasCapability(fakeDb("business"), "archive.legalHold")).toBe(true);
    expect(await hasCapability(fakeDb("business"), "provider.crossTenantApi")).toBe(false);
  });

  it("a Service Provider license unlocks every capability", async () => {
    expect(await hasCapability(fakeDb("service_provider"), "archive.legalHold")).toBe(true);
    expect(await hasCapability(fakeDb("service_provider"), "provider.crossTenantApi")).toBe(true);
  });
});

describe("requireCapability", () => {
  it("throws a 404, not a 403, for an edition that lacks the capability", async () => {
    await expect(requireCapability(fakeDb(), "provider.crossTenantApi")).rejects.toMatchObject({
      status: 404,
    });
    await expect(requireCapability(fakeDb(), "audit.log")).rejects.toBeInstanceOf(ProblemError);
  });

  it("resolves once the edition has the capability", async () => {
    await expect(
      requireCapability(fakeDb("service_provider"), "provider.crossTenantApi"),
    ).resolves.toBeUndefined();
  });
});

describe("capabilityGuard", () => {
  function app(edition?: Edition) {
    const routes = new Hono();
    routes.use("*", capabilityGuard(fakeDb(edition), "archive.legalHold"));
    routes.get("/holds", (c) => c.json({ ok: true }));
    return routes;
  }

  it("answers 404 like an unknown path without the capability", async () => {
    const response = await app().request("/holds");
    expect(response.status).toBe(404);
  });

  it("lets the request through with the capability", async () => {
    const response = await app("business").request("/holds");
    expect(response.status).toBe(200);
  });
});

describe("editionRequired", () => {
  it("builds a 403 problem naming both editions", () => {
    const problem = editionRequired("service_provider", "community");
    expect(problem).toBeInstanceOf(ProblemError);
    expect(problem.status).toBe(403);
    expect(problem.type).toBe("urn:restow:problem:edition-required");
    expect(problem.extensions).toEqual({
      requiredEdition: "service_provider",
      edition: "community",
    });
  });
});

describe("licenseFeatureGate", () => {
  it("opens the Service Provider functions only for Service Provider", async () => {
    for (const feature of [
      "tenants.additional",
      "apiKeys.provider",
      "stats.allTenants",
      "dashboard.allTenants",
      "providerTeam.tenantScope",
    ] as const) {
      expect(await licenseFeatureGate.isEnabled(fakeDb("business"), feature)).toBe(false);
      expect(await licenseFeatureGate.isEnabled(fakeDb("service_provider"), feature)).toBe(true);
    }
  });

  it("opens time-triggered reports from Business on", async () => {
    expect(await licenseFeatureGate.isEnabled(fakeDb(), "reports.timed")).toBe(false);
    expect(await licenseFeatureGate.isEnabled(fakeDb("business"), "reports.timed")).toBe(true);
  });

  it("names the edition a function needs while it is off", async () => {
    const problem = await licenseFeatureGate.unavailable?.(
      fakeDb("business"),
      "tenants.additional",
    );
    expect(problem).toMatchObject({
      status: 403,
      type: "urn:restow:problem:edition-required",
      extensions: {
        requiredEdition: "service_provider",
        edition: "business",
        capability: FEATURE_CAPABILITIES["tenants.additional"],
      },
    });
  });
});
