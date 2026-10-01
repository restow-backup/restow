/**
 * Mounted under /api/v1 through the core's session route extension point
 * (apps/api/src/extensions.ts), behind the `audit.log` capability.
 *
 * Routes (session required; provider admins see every chain, tenant admins
 * their own tenant's, see routes.ts):
 *   GET /audit          entries, newest first (tenant, action, actor, target,
 *                       from, to, limit, cursor)
 *   GET /audit/actions  recorded actions with counts, for the action filter
 *   GET /audit/verify   walk the chain(s) end to end: links, hashes and daily
 *                       anchors; reports the first break per chain
 *   GET /audit/:id      one entry
 */
export const mountPath = "/audit";
