/**
 * Wiring request for app.ts: mount both routers under `/api/v1` —
 * `app.route("/api/v1", accountsRoutes)` and
 * `app.route("/api/v1" + publicMountPath, accountsPublicRoutes)` (i.e.
 * `/api/v1/accounts`) — the same way every other feature's routers are
 * mounted (see the existing `app.route(`${API_V1}${xMountPath}`, xRoutes)`
 * calls).
 *
 * Provisioning deliberately nests under the tenants feature's own URL space
 * (`/tenants/:tenantId/accounts`: an admin manages accounts next to a
 * tenant's members). `app.test.ts` requires every feature's `mountPath` to be
 * unique, so this one is the empty string — mounted at exactly `/api/v1`,
 * the same base the integration API router already shares with several
 * features — and `routes.ts` spells the "/tenants/..." prefix out in its own
 * route patterns instead of relying on a shared mount path with the tenants
 * feature.
 */
export const mountPath = "";

/** Public, unauthenticated endpoints: checking and redeeming a set-password link. */
export const publicMountPath = "/accounts";
