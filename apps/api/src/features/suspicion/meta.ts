/**
 * Mounted under /api/v1 (see app.ts).
 *
 * Routes (tenant-scoped, a tenant_admin session or a provider admin; see routes.ts):
 *   GET    /suspicions?kind=&objectId=        the judgements of one object's restore points
 *   GET    /suspicions/open                   the objects whose newest restore point is suspicious
 *   POST   /suspicions/:id/false-alarm        mark a finding as a false alarm ({ note })
 *   DELETE /suspicions/:id/false-alarm        take the false alarm back
 *
 * The installation's thresholds are under /settings/ransomware (features/settings/routes.ts).
 */
export const mountPath = "/suspicions";
