import type { KeyTenantDeps } from "../../../features/apikeys/key-tenant.js";
import { featureUnavailable } from "../../../lib/features.js";

/**
 * Stand-ins for the core's feature gate (lib/features.ts `requireFeature`) in
 * tests that build the integration API by hand: every gated function on, or
 * every one off (the core's 403 `feature-unavailable`).
 */
export const featuresOn: KeyTenantDeps["requireFeature"] = async () => {};

export const featuresOff: KeyTenantDeps["requireFeature"] = async (_db, feature) => {
  throw featureUnavailable(feature);
};
