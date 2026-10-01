/**
 * Mounted under /api/v1 by the integration layer (see app.ts).
 *
 * Routes (all tenant-scoped, see routes.ts):
 *   POST /restore                 request a restore (creates restore_jobs + jobs, enqueues)
 *   GET  /restore                 recent restore requests of the tenant (own ones for end users)
 *   GET  /restore/targets?objectId=  accounts a restore of an object may go into (tenant admins)
 *   GET  /restore/:id             status, progress, per-item results, download availability
 *   POST /restore/:id/cancel      cancel a queued or running restore
 *   GET  /restore/:id/download    stream the ZIP of a completed download restore
 */
export const mountPath = "/restore";
