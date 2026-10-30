/**
 * Mounted under /api/v1 by the integration layer (see app.ts).
 *
 * Routes (provider admins, see routes.ts):
 *   GET /capacity              utilisation, growth and the estimate per tenant, with the
 *                              installation's figures on top
 *   GET /capacity/:tenantId    one tenant's repositories: chunk store targets, machines, file
 *                              shares and containers with used bytes, budget, level and growth
 */
export const mountPath = "/capacity";
