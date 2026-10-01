/**
 * Mounted under /api/v1 by the integration layer (see app.ts).
 *
 * Routes (session; tenant scope: tenant_admin and above via X-Restow-Tenant;
 * provider scope: provider admins while `stats.allTenants` is on):
 *   GET /stats              KPIs, series and tables (?from&to&granularity&scope)
 *   GET /stats/export.csv   one dataset as CSV (?dataset=...), audited
 *   GET /stats/report.pdf   the statistics report as PDF (?lang=de|en), audited
 */
export const mountPath = "/stats";
