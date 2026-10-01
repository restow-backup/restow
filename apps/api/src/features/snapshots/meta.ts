/**
 * Mounted under /api/v1 by the integration layer (see app.ts).
 *
 * Access outside the viewer's scope (a tenant_user reaching a snapshot,
 * object or mail entry that is not their own mailbox) is refused as 404, on
 * every route below, not 403: like the rest of this feature (tree, versions,
 * search, restore), a non-owner must not be able to tell "not yours" apart
 * from "does not exist" (service.ts loadSnapshotForViewer /
 * loadObjectForViewer). No audit row is written for a refused read.
 *
 * Routes (all tenant-scoped, see routes.ts):
 *   GET /snapshots/objects?include=                protected objects; `all` also lists ones with
 *                                                   no restore point yet (0 snapshots), for the
 *                                                   explorer's left pane
 *   GET /snapshots?objectId=                        snapshots (points in time) of an object
 *   GET /snapshots/:id/tree?path=&foldersOnly=&sort= children of a folder in a snapshot; `sort` is
 *                                                   `date` (default, mail newest first) or `name`
 *   GET /snapshots/objects/:id/versions?path=       the same item across snapshots (version history)
 *   GET /snapshots/search?q=                        name / path / subject / sender / recipient search
 *   GET /snapshots/:snapshotId/entries/:entryId/preview
 *                                                    a mail entry's sanitised body and attachment
 *                                                   list, or why it cannot be shown: `reason` is
 *                                                   `too-large` (above PREVIEW_SIZE_CAP_BYTES),
 *                                                   `rights-protected` (IRM/Purview),
 *                                                   `smime-encrypted`, or `unsupported-format`
 *                                                   (Graph's JSON/attachments export for a message
 *                                                   too large to fetch as MIME; service.ts
 *                                                   isOversizedFormat)
 *   GET /snapshots/:snapshotId/entries/:entryId/attachments/:attachmentId
 *                                                    streams one attachment of a previewed message;
 *                                                   accepts the tenant as the `tenant` query
 *                                                   parameter too (routes.ts
 *                                                   tenantUserForAttachmentDownload), since a plain
 *                                                   browser navigation cannot send the
 *                                                   X-Restow-Tenant header
 */
export const mountPath = "/snapshots";
