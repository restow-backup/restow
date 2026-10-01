/**
 * Mounted under /api/v1 by the integration layer (see app.ts).
 *
 * Routes (tenant-scoped, tenant_admin and above, see routes.ts):
 *   GET  /verify/latest        readiness per object, tenant summary, storage integrity, schedules
 *   GET  /verify/reports       report history (?objectId=&readiness=&limit=&cursor=)
 *   GET  /verify/reports/:id   one report with its item list (audited read)
 *   POST /verify               check now: { protectedObjectId?, kind?, sampleSize? }
 *   POST /verify/scrub         storage check now: { mode: "sample" | "full" }
 */
export const mountPath = "/verify";
