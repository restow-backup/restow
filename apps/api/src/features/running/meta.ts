/**
 * Mounted under /api/v1 by the integration layer (see app.ts).
 *
 * Routes (provider admins; see routes.ts):
 *   GET /tenant-running   what runs right now in every tenant the member may enter
 *
 * The tenant's own "Running now" widget is part of GET /dashboard (features/dashboard) and
 * moves with the live channel (features/history/live.ts).
 */
export const mountPath = "/tenant-running";
