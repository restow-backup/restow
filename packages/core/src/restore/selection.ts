/**
 * From a restore request to the objects to restore.
 *
 * The snapshot named by the request is the point in time: the API resolves
 * "as of <date>" to a snapshot id before the job is queued, so an engine only
 * ever deals with one committed manifest. Selection is by exact path, folder
 * subtree, source item id, or everything (docs/ARCHITECTURE.md, Restore).
 *
 * Two rules on top of plain matching:
 *   - Historical file versions are restored only when selected by their own
 *     path or id. Restoring a folder or a whole drive means the current files;
 *     writing every old version back over them would undo the restore.
 *   - Attachments of a parts-format message travel with their message.
 */
import { loadManifest } from "../engine/snapshot.js";
import {
  type JobContext,
  type RestoreRequest,
  type RestoreSelection,
  type SnapshotRecord,
  matchesSelection,
} from "../engine/types.js";
import type { ManifestObject, SnapshotManifest } from "../manifest.js";
import { SnapshotCatalog } from "./catalog.js";
import { objectTypeOf } from "./conventions.js";

/** Thrown when the request names a snapshot that cannot be restored from. */
export class RestoreSourceError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "RestoreSourceError";
  }
}

export interface ResolvedSource {
  readonly record: SnapshotRecord;
  readonly manifest: SnapshotManifest;
}

/**
 * Load the committed manifest behind a request, refusing snapshots that are
 * still in progress, pruned, or belong to a different protected object.
 */
export async function resolveRestoreSource(
  ctx: Pick<JobContext, "snapshots" | "storage" | "keys">,
  request: Pick<RestoreRequest, "snapshotId" | "protectedObject">,
): Promise<ResolvedSource> {
  const record = await ctx.snapshots.get(request.snapshotId);
  if (!record) {
    throw new RestoreSourceError(`snapshot ${request.snapshotId} does not exist`);
  }
  if (record.protectedObjectId !== request.protectedObject.id) {
    throw new RestoreSourceError(
      `snapshot ${request.snapshotId} belongs to a different protected object`,
    );
  }
  if (record.status !== "active") {
    throw new RestoreSourceError(`snapshot ${request.snapshotId} has been pruned`);
  }
  if (!record.manifestPath) {
    throw new RestoreSourceError(`snapshot ${request.snapshotId} was never completed`);
  }
  const manifest = await loadManifest(ctx.storage, record.manifestPath, ctx.keys);
  return { record, manifest };
}

function comparePaths(a: ManifestObject, b: ManifestObject): number {
  return a.path < b.path ? -1 : a.path > b.path ? 1 : 0;
}

function isExplicitlySelected(object: ManifestObject, selection: RestoreSelection): boolean {
  return (
    (selection.paths?.includes(object.path) ?? false) ||
    (object.id !== undefined && (selection.objectIds?.includes(object.id) ?? false))
  );
}

/** Does a selection cover this object? Versions need an explicit pick. */
export function isSelected(object: ManifestObject, selection: RestoreSelection): boolean {
  if (objectTypeOf(object) === "version") {
    return isExplicitlySelected(object, selection);
  }
  return matchesSelection(object, selection);
}

/**
 * The objects a selection covers, in path order and without duplicates,
 * including the attachments of every selected message.
 */
export function selectObjects(
  manifest: SnapshotManifest,
  selection: RestoreSelection,
  catalog: SnapshotCatalog = SnapshotCatalog.of(manifest),
): ManifestObject[] {
  const selected = new Map<string, ManifestObject>();
  for (const object of manifest.objects) {
    if (isSelected(object, selection)) {
      selected.set(object.path, object);
    }
  }
  for (const object of manifest.objects) {
    if (objectTypeOf(object) !== "attachment" || selected.has(object.path)) {
      continue;
    }
    const owner = catalog.attachmentOwner(object);
    if (owner !== undefined && selected.has(owner)) {
      selected.set(object.path, object);
    }
  }
  return [...selected.values()].sort(comparePaths);
}

/** The selected objects, grouped the way the engines process them. */
export interface RestorePlan {
  /** Everything selected, in path order. */
  readonly objects: readonly ManifestObject[];
  readonly catalog: SnapshotCatalog;
  readonly mail: ManifestObject[];
  /** Attachments by the path of their (selected) message. */
  readonly attachmentsByMessage: Map<string, ManifestObject[]>;
  /** Attachments selected without their message. */
  readonly orphanAttachments: ManifestObject[];
  readonly events: ManifestObject[];
  readonly contacts: ManifestObject[];
  readonly files: ManifestObject[];
  readonly versions: ManifestObject[];
  readonly folders: ManifestObject[];
  /** Packages and shortcuts: recorded as information, no content to restore. */
  readonly informational: ManifestObject[];
  /** Objects with a type no engine knows; reported, never silently dropped. */
  readonly unknown: ManifestObject[];
}

export function planRestore(manifest: SnapshotManifest, selection: RestoreSelection): RestorePlan {
  const catalog = SnapshotCatalog.of(manifest);
  const objects = selectObjects(manifest, selection, catalog);
  const plan: RestorePlan = {
    objects,
    catalog,
    mail: [],
    attachmentsByMessage: new Map(),
    orphanAttachments: [],
    events: [],
    contacts: [],
    files: [],
    versions: [],
    folders: [],
    informational: [],
    unknown: [],
  };
  const selectedMail = new Set(
    objects.filter((object) => objectTypeOf(object) === "mail").map((object) => object.path),
  );
  for (const object of objects) {
    switch (objectTypeOf(object)) {
      case "mail":
        plan.mail.push(object);
        break;
      case "attachment": {
        const owner = catalog.attachmentOwner(object);
        if (owner === undefined || !selectedMail.has(owner)) {
          plan.orphanAttachments.push(object);
          break;
        }
        const list = plan.attachmentsByMessage.get(owner) ?? [];
        list.push(object);
        plan.attachmentsByMessage.set(owner, list);
        break;
      }
      case "event":
        plan.events.push(object);
        break;
      case "contact":
        plan.contacts.push(object);
        break;
      case "file":
        plan.files.push(object);
        break;
      case "version":
        plan.versions.push(object);
        break;
      case "folder":
        plan.folders.push(object);
        break;
      case "package":
      case "shortcut":
        plan.informational.push(object);
        break;
      default:
        plan.unknown.push(object);
    }
  }
  return plan;
}
