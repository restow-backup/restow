/**
 * Mounted under /api/v1 (see app.ts).
 *
 * Routes (tenant-scoped, a tenant_admin session or a provider admin; see routes.ts):
 *   GET    /warnings                            open and acknowledged warnings
 *   GET    /warnings/:kind/:id                  one object or machine: runs, failed items, acknowledgement
 *   POST   /warnings/acknowledge                acknowledge one or many
 *   DELETE /warnings/:kind/:id/acknowledgement  revoke
 */
export const mountPath = "/warnings";
