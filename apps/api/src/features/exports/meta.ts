/**
 * Mounted under /api/v1 by the integration layer (see app.ts).
 *
 * Routes (all tenant-scoped, see routes.ts):
 *   GET  /exports/formats         the export formats and which of them can be requested
 *   POST /exports                 request an export of backed-up, imported or archived mail
 *   GET  /exports                 recent export requests (own ones for end users)
 *   GET  /exports/:id             status, progress, report, download availability
 *   POST /exports/:id/cancel      cancel a queued or running export
 *   GET  /exports/:id/download    stream the finished file (decrypted on the fly)
 */
export const mountPath = "/exports";
