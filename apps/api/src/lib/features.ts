import { featureGates } from "../extensions.js";
import { ProblemError } from "../problem.js";
import type { DbExecutor } from "./tenant-context.js";

/**
 * Core functions that exist only when an extension enables them. The core
 * implements each of them (routes, data, UI) but offers it only while a
 * registered feature gate (extensions.ts `FeatureGate`) says so; without one
 * every entry is off, so the core alone offers exactly its own features. The
 * core never learns why a gate opens (in the full build, ee/ decides by the
 * installed license):
 *
 *   tenants.additional    creating a tenant while the installation already has
 *                         one (the first tenant is always the core's)
 *   apiKeys.provider      provider API keys and the cross-tenant operations of
 *                         the integration API
 *   stats.allTenants      the statistics summed over every tenant
 *   dashboard.allTenants  the provider view of the dashboard
 *   reports.timed         time-triggered summary reports (alerts on events are
 *                         always on)
 */
export const GATED_FEATURES = [
  "tenants.additional",
  "apiKeys.provider",
  "stats.allTenants",
  "dashboard.allTenants",
  "reports.timed",
] as const;

export type GatedFeature = (typeof GATED_FEATURES)[number];

/** Problem type of a gated function no extension enables. */
export const FEATURE_UNAVAILABLE_PROBLEM = "urn:restow:problem:feature-unavailable";

/** The core's own answer for a gated function that is off. */
export function featureUnavailable(feature: GatedFeature): ProblemError {
  return new ProblemError(403, "Not available", {
    type: FEATURE_UNAVAILABLE_PROBLEM,
    detail: "This installation does not offer this function.",
    extensions: { feature },
  });
}

/** Whether `feature` is on right now (off without any registered gate). */
export async function featureEnabled(db: DbExecutor, feature: GatedFeature): Promise<boolean> {
  for (const gate of featureGates()) {
    if (await gate.isEnabled(db, feature)) {
      return true;
    }
  }
  return false;
}

/**
 * Throw the problem for `feature` unless it is on: the first registered
 * gate's own problem when it names one, else the core's 403.
 */
export async function requireFeature(db: DbExecutor, feature: GatedFeature): Promise<void> {
  if (await featureEnabled(db, feature)) {
    return;
  }
  for (const gate of featureGates()) {
    if (gate.unavailable) {
      throw await gate.unavailable(db, feature);
    }
  }
  throw featureUnavailable(feature);
}

/** Every gated function that is on right now, in the order of {@link GATED_FEATURES}. */
export async function enabledFeatures(db: DbExecutor): Promise<GatedFeature[]> {
  const enabled: GatedFeature[] = [];
  for (const feature of GATED_FEATURES) {
    if (await featureEnabled(db, feature)) {
      enabled.push(feature);
    }
  }
  return enabled;
}
