import { afterEach, describe, expect, it } from "vitest";
import { registerApiExtension, resetExtensionsForTesting } from "../extensions.js";
import { ProblemError } from "../problem.js";
import {
  FEATURE_UNAVAILABLE_PROBLEM,
  GATED_FEATURES,
  type GatedFeature,
  enabledFeatures,
  featureEnabled,
  requireFeature,
} from "./features.js";
import type { DbExecutor } from "./tenant-context.js";

const db = {} as DbExecutor;

afterEach(() => {
  resetExtensionsForTesting();
});

function gate(on: readonly GatedFeature[], problem?: ProblemError) {
  registerApiExtension({
    name: `gate-${on.join("+") || "none"}`,
    featureGate: {
      isEnabled: async (_db, feature) => on.includes(feature),
      ...(problem ? { unavailable: async () => problem } : {}),
    },
  });
}

describe("without any extension", () => {
  it("keeps every gated function off", async () => {
    for (const feature of GATED_FEATURES) {
      expect(await featureEnabled(db, feature)).toBe(false);
    }
    expect(await enabledFeatures(db)).toEqual([]);
  });

  it("answers the core's 403 feature-unavailable", async () => {
    await expect(requireFeature(db, "tenants.additional")).rejects.toMatchObject({
      status: 403,
      type: FEATURE_UNAVAILABLE_PROBLEM,
      extensions: { feature: "tenants.additional" },
    });
  });
});

describe("with a registered gate", () => {
  it("opens exactly what the gate enables", async () => {
    gate(["stats.allTenants", "reports.timed"]);
    expect(await featureEnabled(db, "stats.allTenants")).toBe(true);
    expect(await featureEnabled(db, "apiKeys.provider")).toBe(false);
    expect(await enabledFeatures(db)).toEqual(["stats.allTenants", "reports.timed"]);
    await expect(requireFeature(db, "reports.timed")).resolves.toBeUndefined();
  });

  it("answers the gate's own problem for a function it keeps off", async () => {
    const own = new ProblemError(403, "Edition required", {
      type: "urn:example:problem:needs-more",
    });
    gate([], own);
    await expect(requireFeature(db, "apiKeys.provider")).rejects.toBe(own);
  });

  it("opens a function any of several gates enables", async () => {
    gate(["tenants.additional"]);
    gate(["dashboard.allTenants"]);
    expect(await enabledFeatures(db)).toEqual(["tenants.additional", "dashboard.allTenants"]);
  });
});
