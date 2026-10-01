/**
 * Mounted under /api/v1 by the integration layer (see app.ts).
 *
 * Routes (tenant-scoped; a tenant_admin session or an API key with the scope
 * in brackets, see access.ts):
 *   GET  /jobs                        [jobs:read]     jobs, newest first (type|queue, status, since, cursor)
 *   GET  /jobs/events                 [jobs:read]     SSE: live job updates of the tenant (?queue=)
 *   GET  /jobs/objects                [items:read]    protected objects with last job, snapshot, verify
 *   GET  /jobs/objects/:id/snapshots  [items:read]    snapshot history of one protected object
 *   POST /jobs/backup                 [restore:write] "Backup now" for one object or all
 *   GET  /jobs/:id                    [jobs:read]     one job with item failures, snapshot, result
 *   GET  /jobs/:id/events             [jobs:read]     SSE: live updates of one job until it ends
 *   POST /jobs/:id/cancel             [restore:write] cancel a queued or running job
 *   POST /jobs/:id/retry              [restore:write] re-enqueue a failed or cancelled backup/verify
 */
export const mountPath = "/jobs";
