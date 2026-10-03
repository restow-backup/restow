import { Hono, type MiddlewareHandler } from "hono";
import type { FeatureGate } from "../../../../apps/api/src/extensions.js";
import type { GatedFeature } from "../../../../apps/api/src/lib/features.js";
import type { DbExecutor } from "../../../../apps/api/src/lib/tenant-context.js";
import { ProblemError, notFoundHandler } from "../../../../apps/api/src/problem.js";
import {
  type Capability,
  type LicenseEdition,
  hasCapability as editionHasCapability,
  currentEdition as editionInEffect,
  minEditionFor,
} from "../../../licensing/src/index.js";

/**
 * The license gate of the Business and Service Provider API modules
 * (ee/README.md). Every module guards its own routes with it; the core never
 * sees a capability. Three ways in:
 *
 * - {@link capabilityGuard}: the guard of a session route group
 *   (apps/api/src/extensions.ts `SessionRouteContribution.guard`). Without
 *   the capability it answers exactly like a path nobody registered (404),
 *   never with a 403 that would reveal the feature exists.
 * - {@link requireCapability}: the same check inside a handler.
 * - {@link licenseFeatureGate}: the core's feature gate (apps/api/src/lib/features.ts),
 *   which opens the core functions a capability stands for and names the
 *   edition they need when they are off (403 `edition-required`).
 *
 * The license is read per request, so installing or removing a key takes
 * effect immediately.
 */

/** The edition in effect: the installed key, else Community (or the demo's RESTOW_EDITION). */
export async function currentEdition(db: DbExecutor): Promise<LicenseEdition> {
  return editionInEffect(db);
}

export async function hasCapability(db: DbExecutor, capability: Capability): Promise<boolean> {
  return editionHasCapability(await currentEdition(db), capability);
}

/** Throws a 404 (not a 403) when the installation's edition lacks `capability`. */
export async function requireCapability(db: DbExecutor, capability: Capability): Promise<void> {
  if (!(await hasCapability(db, capability))) {
    throw new ProblemError(404, "Not Found", {
      type: "urn:restow:problem:not-found",
      detail: "No such route.",
    });
  }
}

/**
 * Route guard: without `capability`, answer as the app's not-found handler
 * does for an unknown path; otherwise continue.
 */
export function capabilityGuard(db: DbExecutor, capability: Capability): MiddlewareHandler {
  return async (c, next) => {
    if (!(await hasCapability(db, capability))) {
      return notFoundHandler(c);
    }
    await next();
  };
}

/**
 * `routes` behind {@link capabilityGuard}, mounted the way apps/api/src/app.ts
 * mounts a guarded contribution, for a module's tests.
 */
// biome-ignore lint/suspicious/noExplicitAny: each group declares its own session env.
export function gateRoutes(db: DbExecutor, capability: Capability, routes: Hono<any>): Hono {
  const gated = new Hono();
  gated.use("*", capabilityGuard(db, capability));
  gated.route("/", routes);
  return gated;
}

/** 403 problem for an operation the installation's edition does not include. */
export function editionRequired(required: LicenseEdition, current: LicenseEdition): ProblemError {
  return new ProblemError(403, "Edition required", {
    type: "urn:restow:problem:edition-required",
    detail: `This action requires the ${required} edition; the installation runs ${current}.`,
    extensions: { requiredEdition: required, edition: current },
  });
}

/** Which capability opens each gated core function (apps/api/src/lib/features.ts). */
export const FEATURE_CAPABILITIES: Readonly<Record<GatedFeature, Capability>> = {
  "tenants.additional": "provider.tenantManagement",
  "apiKeys.provider": "provider.crossTenantApi",
  "stats.allTenants": "provider.tenantReporting",
  "dashboard.allTenants": "provider.tenantReporting",
  "reports.timed": "reports.scheduled",
  "providerTeam.tenantScope": "provider.teamTenantScope",
};

/** The core's feature gate, decided by the installed license. */
export const licenseFeatureGate: FeatureGate = {
  async isEnabled(db, feature) {
    return hasCapability(db, FEATURE_CAPABILITIES[feature]);
  },
  async unavailable(db, feature) {
    const capability = FEATURE_CAPABILITIES[feature];
    const problem = editionRequired(minEditionFor(capability), await currentEdition(db));
    return new ProblemError(problem.status, problem.title, {
      type: problem.type,
      detail: problem.detail,
      extensions: { ...problem.extensions, capability },
    });
  },
};
