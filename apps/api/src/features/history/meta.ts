/**
 * Mounted under /api/v1 (see app.ts).
 *
 * Routes (tenant-scoped, a tenant_admin session or a provider admin; see routes.ts):
 *   GET /history        every run of the tenant, mail and agent, newest first
 *   GET /history/:id    one run with its objects, timeline and restore check
 *   GET /live           SSE: runs, backup jobs and machines as they change
 */
export const mountPath = "/history";
export const liveMountPath = "/live";
