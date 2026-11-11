/**
 * Mounted under /api/v1 (see app.ts).
 *
 * Routes (tenant-scoped, a tenant_admin session or a provider admin; see routes.ts):
 *   GET  /run-size/holds                  the open holds of the tenant and the recent decided ones
 *   POST /run-size/holds/:id/continue     let the next run continue once ({ note }); audited
 *   POST /run-size/holds/:id/raise        raise the object's limit ({ limitGib }); audited
 *   GET  /run-size/settings               the defaults, the tenant's and the objects' overrides
 *   PUT  /run-size/settings               set or clear one ({ kind?, objectId?, override?, space? });
 *                                         audited
 *   GET  /run-size/targets                the space rule of each of the tenant's storage targets
 *   PUT  /run-size/targets/:id            set or clear a target's space rule ({ space }); audited
 *
 * The installation's space rule is under /updates/space-rule (features/updates/routes.ts).
 */
export const mountPath = "/run-size";
