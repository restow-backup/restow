import {
  endpoints,
  importUploads,
  mailExports,
  mailImports,
  protectedObjects,
  restoreJobs,
  snapshots,
  sources,
  tenants,
} from "@restow/db";
import { eq, inArray } from "drizzle-orm";

import type { DbExecutor } from "../../../../apps/api/src/lib/tenant-context.js";

/**
 * Human names for audit targets: an entry stores the target's id (a UUID the
 * chain hashes and must never change), the list shows what that id is today.
 * Resolved per page in a handful of batched lookups; a target that was
 * deleted since, or whose type has no name, keeps showing its id.
 */

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Target types whose name can be looked up; everything else shows the raw target. */
export const LABELLED_TARGET_TYPES = [
  "tenant",
  "source",
  "protected_object",
  // Protection changes and password entries name the kind of the protected object as the
  // target type (the id is still the protected object's).
  "mailbox",
  "onedrive",
  "imap",
  "snapshot",
  "restore_job",
  "export_job",
  "mail_import",
  "import_upload",
  "endpoint",
] as const;
type LabelledType = (typeof LABELLED_TARGET_TYPES)[number];

/** The target types whose id is the id of a protected object. */
const PROTECTED_OBJECT_TYPES = ["protected_object", "mailbox", "onedrive", "imap"] as const;

export interface TargetRef {
  target: string | null;
  targetType: string | null;
  /** What the entry recorded when it was written; names a target that is gone. */
  details?: Record<string, unknown> | null;
}

/**
 * The detail that names the target, for a target the database no longer knows
 * (a cancelled upload that expired, a deleted import): the file name an upload
 * recorded, the mailbox name an import recorded. Written into the entry when it
 * happened, so it is the name at that time, not today's.
 */
const DETAIL_NAME: Readonly<Record<string, string>> = {
  import_upload: "fileName",
  mail_import: "name",
};

/** The UUID targets of `entries`, grouped by the type that names them. */
export function targetsByType(entries: readonly TargetRef[]): Map<LabelledType, string[]> {
  const grouped = new Map<LabelledType, Set<string>>();
  for (const entry of entries) {
    const type = entry.targetType as LabelledType | null;
    if (
      !type ||
      !(LABELLED_TARGET_TYPES as readonly string[]).includes(type) ||
      !entry.target ||
      !UUID.test(entry.target)
    ) {
      continue;
    }
    const ids = grouped.get(type) ?? new Set<string>();
    ids.add(entry.target.toLowerCase());
    grouped.set(type, ids);
  }
  return new Map([...grouped].map(([type, ids]) => [type, [...ids]]));
}

/** Key of a resolved label: the type and the lower-cased id. */
export function labelKey(type: string, id: string): string {
  return `${type}:${id.toLowerCase()}`;
}

/** An object's name as the rest of the UI shows it: display name, else its external id. */
function objectName(displayName: string | null, externalId: string): string {
  const name = displayName?.trim();
  return name && name.length > 0 ? name : externalId;
}

/**
 * Look up the names of the targets on one page. Runs where the page itself
 * was read (the same tenant pin or installation-wide reader), so it never
 * sees a name the reader could not see anyway.
 */
export async function resolveTargetLabels(
  executor: DbExecutor,
  entries: readonly TargetRef[],
): Promise<Map<string, string>> {
  const labels = new Map<string, string>();
  const grouped = targetsByType(entries);

  const tenantIds = grouped.get("tenant");
  if (tenantIds) {
    const rows = await executor
      .select({ id: tenants.id, name: tenants.name })
      .from(tenants)
      .where(inArray(tenants.id, tenantIds));
    for (const row of rows) labels.set(labelKey("tenant", row.id), row.name);
  }

  const sourceIds = grouped.get("source");
  if (sourceIds) {
    const rows = await executor
      .select({ id: sources.id, name: sources.name })
      .from(sources)
      .where(inArray(sources.id, sourceIds));
    for (const row of rows) labels.set(labelKey("source", row.id), row.name);
  }

  const objectIds = [...new Set(PROTECTED_OBJECT_TYPES.flatMap((type) => grouped.get(type) ?? []))];
  if (objectIds.length > 0) {
    const rows = await executor
      .select({
        id: protectedObjects.id,
        displayName: protectedObjects.displayName,
        externalId: protectedObjects.externalId,
      })
      .from(protectedObjects)
      .where(inArray(protectedObjects.id, objectIds));
    for (const row of rows) {
      const name = objectName(row.displayName, row.externalId);
      for (const type of PROTECTED_OBJECT_TYPES) {
        labels.set(labelKey(type, row.id), name);
      }
    }
  }

  const snapshotIds = grouped.get("snapshot");
  if (snapshotIds) {
    const rows = await executor
      .select({
        id: snapshots.id,
        displayName: protectedObjects.displayName,
        externalId: protectedObjects.externalId,
      })
      .from(snapshots)
      .innerJoin(protectedObjects, eq(protectedObjects.id, snapshots.protectedObjectId))
      .where(inArray(snapshots.id, snapshotIds));
    for (const row of rows) {
      labels.set(labelKey("snapshot", row.id), objectName(row.displayName, row.externalId));
    }
  }

  const restoreIds = grouped.get("restore_job");
  if (restoreIds) {
    const rows = await executor
      .select({
        id: restoreJobs.id,
        displayName: protectedObjects.displayName,
        externalId: protectedObjects.externalId,
      })
      .from(restoreJobs)
      .innerJoin(snapshots, eq(snapshots.id, restoreJobs.snapshotId))
      .innerJoin(protectedObjects, eq(protectedObjects.id, snapshots.protectedObjectId))
      .where(inArray(restoreJobs.id, restoreIds));
    for (const row of rows) {
      labels.set(labelKey("restore_job", row.id), objectName(row.displayName, row.externalId));
    }
  }

  // Snapshot exports are named after the exported object; archive exports have none and keep the id.
  const exportIds = grouped.get("export_job");
  if (exportIds) {
    const rows = await executor
      .select({
        id: mailExports.id,
        displayName: protectedObjects.displayName,
        externalId: protectedObjects.externalId,
      })
      .from(mailExports)
      .innerJoin(protectedObjects, eq(protectedObjects.id, mailExports.protectedObjectId))
      .where(inArray(mailExports.id, exportIds));
    for (const row of rows) {
      labels.set(labelKey("export_job", row.id), objectName(row.displayName, row.externalId));
    }
  }

  // An import is named after the mailbox it brings in, an upload after its file.
  const importIds = grouped.get("mail_import");
  if (importIds) {
    const rows = await executor
      .select({ id: mailImports.id, name: mailImports.name })
      .from(mailImports)
      .where(inArray(mailImports.id, importIds));
    for (const row of rows) {
      const name = row.name.trim();
      if (name) labels.set(labelKey("mail_import", row.id), name);
    }
  }

  const uploadIds = grouped.get("import_upload");
  if (uploadIds) {
    const rows = await executor
      .select({ id: importUploads.id, fileName: importUploads.fileName })
      .from(importUploads)
      .where(inArray(importUploads.id, uploadIds));
    for (const row of rows) {
      const name = row.fileName.trim();
      if (name) labels.set(labelKey("import_upload", row.id), name);
    }
  }

  const endpointIds = grouped.get("endpoint");
  if (endpointIds) {
    const rows = await executor
      .select({
        id: endpoints.id,
        displayName: endpoints.displayName,
        hostname: endpoints.hostname,
      })
      .from(endpoints)
      .where(inArray(endpoints.id, endpointIds));
    for (const row of rows) {
      labels.set(labelKey("endpoint", row.id), objectName(row.displayName, row.hostname));
    }
  }

  return labels;
}

/**
 * The label of one entry's target: the name resolved from the database, else
 * (for an import or an upload that no longer exists) the name the entry itself
 * recorded; null when neither is known.
 */
export function targetLabelOf(
  entry: TargetRef,
  labels: ReadonlyMap<string, string>,
): string | null {
  if (!entry.target || !entry.targetType) {
    return null;
  }
  const resolved = labels.get(labelKey(entry.targetType, entry.target));
  if (resolved) {
    return resolved;
  }
  const detail = DETAIL_NAME[entry.targetType];
  const recorded = detail ? entry.details?.[detail] : undefined;
  return typeof recorded === "string" && recorded.trim() ? recorded.trim() : null;
}
