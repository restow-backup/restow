/**
 * Mounted under /api/v1 by the integration layer (see app.ts).
 *
 * Routes (tenant-scoped, every member of the tenant, see routes.ts):
 *   GET /dashboard                  the start page in one response: the tenant widgets
 *                                   that apply to the viewer
 *   GET /dashboard?provider=true    additionally the provider view (provider admins
 *                                   while dashboard.allTenants is on; 403 otherwise)
 */
export const mountPath = "/dashboard";
