/**
 * Mounted under /api/v1 by the integration layer (see app.ts). Mounted before
 * the generic v1 router, this surface also answers `POST /api/v1/webhooks`
 * for integrations (API key with `webhooks:manage`).
 */
export const mountPath = "/webhooks";
