/**
 * Mounted under /api/v1 by the integration layer (see app.ts).
 *
 * Mail file import (docs/IMPORT.md). All routes need the tenant_admin role.
 *
 *   GET    /imports/config                          upload limits and whether the import folder exists
 *   GET    /imports/folder?path=                    browse the server-side import folder (one level)
 *   GET    /imports/uploads                         open uploads of the tenant (resume after a reload)
 *   POST   /imports/uploads                         start a chunked upload
 *   GET    /imports/uploads/:id                     state of an upload (which segments arrived)
 *   PUT    /imports/uploads/:id/segments/:index     one raw segment (application/octet-stream)
 *   POST   /imports/uploads/:id/complete            verify the segments and detect the format
 *   DELETE /imports/uploads/:id                     cancel an upload and delete its segments
 *   POST   /imports                                 request an import (creates or extends an imported mailbox)
 *   GET    /imports                                 recent imports of the tenant
 *   GET    /imports/:id                             status, progress, report, failures
 *   POST   /imports/:id/cancel                      cancel a queued or running import
 */
export const mountPath = "/imports";
