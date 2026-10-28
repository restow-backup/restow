/**
 * SharePoint restore: files and folders of a site's libraries back into a
 * library, and list items back into their list (docs/MICROSOFT.md,
 * SharePoint).
 *
 * Libraries are drives, so files go up exactly like a OneDrive restore
 * (./onedrive.ts: simple upload or upload session, fileSystemInfo, the
 * rename / replace / skip conflict modes, every upload verified):
 *
 *   original   each library's files go back into that library (the drive id
 *              the snapshot recorded), at their original path
 *   other      everything goes into one library named by the target ref,
 *              `<drive id>` or `<drive id>:/<folder>`, below that folder; when
 *              files of several libraries are restored together, each keeps
 *              its library's name as a folder so nothing collides
 *
 * List items are created anew from their backed-up field values in their
 * original list (SharePoint assigns new ids; created/modified dates and
 * authors are SharePoint's to set). Only writable fields are sent (system,
 * read-only, hidden and calculated columns are left out, see
 * `writableFields`). The mode decides what happens to an item that still
 * exists under its backed-up id:
 *
 *   rename (default)  a new item is added next to it ("keep both"); an item
 *                     an earlier attempt of the same restore already added
 *                     (only on a retry of a job that added list items: created
 *                     since the request, same field values) counts as restored
 *                     instead of being added a second time
 *   replace           its fields are overwritten with the backed-up values
 *   skip              it is left alone
 *
 * List schemas, the site's own metadata and permissions are recorded as
 * information and never written back.
 */

import {
  type ListColumnFacts,
  libraryPath,
  listPath,
  listSchemaPath,
  SITE_OBJECT_TYPES,
  siteAreaOf,
  writableFields,
} from "../backup/sharepoint/layout.js";
import type {
  JobContext,
  Logger,
  RestoreEngine,
  RestoreMode,
  RestoreRequest,
} from "../engine/types.js";
import type { GraphClient } from "../graph/client.js";
import {
  createListItem,
  getDrive,
  getListItem,
  listListItems,
  type SiteListItem,
  updateListItemFields,
} from "../graph/resources/sites.js";
import type { ManifestObject, SnapshotManifest } from "../manifest.js";
import { chunkReaderFor, type RestoreGraphClientFactory, throwIfAborted } from "./common.js";
import { objectTypeOf } from "./conventions.js";
import { OneDriveRestoreSession, parseDriveTargetRef } from "./onedrive.js";
import { isAbortError, RestoreLedger, type RestoreReport } from "./results.js";
import { planRestore, resolveRestoreSource } from "./selection.js";

export interface SharePointRestoreEngineOptions {
  readonly graph: RestoreGraphClientFactory;
  readonly fragmentSize?: number;
}

/** Thrown for a request that cannot be carried out at all (bad target). */
export class SiteRestoreTargetError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SiteRestoreTargetError";
  }
}

interface LibraryGroup {
  readonly folder: string;
  readonly folders: ManifestObject[];
  readonly files: ManifestObject[];
}

interface ListGroup {
  readonly folder: string;
  readonly items: ManifestObject[];
}

/** Objects of the snapshot keyed by path, for the library and list folder records. */
function byPath(manifest: SnapshotManifest): Map<string, ManifestObject> {
  return new Map(manifest.objects.map((object) => [object.path, object]));
}

export class SharePointRestoreEngine implements RestoreEngine {
  readonly kind = "site" as const;

  constructor(private readonly options: SharePointRestoreEngineOptions) {}

  async run(ctx: JobContext, request: RestoreRequest): Promise<RestoreReport> {
    if (request.target.type === "download") {
      throw new Error("download restores are produced by the download engine");
    }
    const logger = ctx.logger.child({
      component: "restore-sharepoint",
      restoreJobId: request.restoreJobId,
      snapshotId: request.snapshotId,
    });
    const ledger = new RestoreLedger(ctx.progress);
    ctx.progress.phase("resolve");
    const { manifest } = await resolveRestoreSource(ctx, request);
    const plan = planRestore(manifest, request.selection);
    ctx.progress.total(plan.objects.length);
    const client = await this.options.graph(ctx, request.protectedObject);
    const objects = byPath(manifest);

    const libraries = new Map<string, LibraryGroup>();
    const lists = new Map<string, ListGroup>();
    const library = (folder: string) => {
      const group = libraries.get(folder) ?? { folder, folders: [], files: [] };
      libraries.set(folder, group);
      return group;
    };
    for (const object of plan.objects) {
      const area = siteAreaOf(object.path);
      const type = objectTypeOf(object);
      if (area?.area === "library") {
        if (area.rest === "" || type === "folder") {
          library(area.folder).folders.push(object);
        } else if (type === "file" || type === "version") {
          library(area.folder).files.push(object);
        } else {
          ledger.skipped(
            object,
            "not_restorable",
            type === "shortcut"
              ? "shortcuts to items in other drives are recorded, not restored"
              : "OneNote notebooks and other packages are recorded without content and cannot be restored",
          );
        }
        continue;
      }
      if (area?.area === "list" && object.type === SITE_OBJECT_TYPES.listItem) {
        const group = lists.get(area.folder) ?? { folder: area.folder, items: [] };
        group.items.push(object);
        lists.set(area.folder, group);
        continue;
      }
      if (
        area?.area === "list" &&
        (area.rest === "" || object.type === SITE_OBJECT_TYPES.listSchema)
      ) {
        // The list folder and its schema describe the list; its items are what is restored.
        ledger.skipped(
          object,
          "not_restorable",
          "the list and its columns are recorded as information",
        );
        continue;
      }
      if (area?.area === "info") {
        ledger.skipped(
          object,
          "not_restorable",
          "the site's settings, design and permissions are recorded as information, not restored",
        );
        continue;
      }
      ledger.failed(
        object,
        new Error(
          `objects of type "${object.type ?? ""}" cannot be restored into a SharePoint site`,
        ),
        "not_restorable",
      );
    }

    logger.info("restore planned", {
      libraries: libraries.size,
      files: [...libraries.values()].reduce((sum, group) => sum + group.files.length, 0),
      lists: lists.size,
      listItems: [...lists.values()].reduce((sum, group) => sum + group.items.length, 0),
      target: request.target.type,
      mode: request.mode,
    });

    const reader = chunkReaderFor(ctx);
    if (libraries.size > 0) {
      ctx.progress.phase("files");
      await this.restoreLibraries(
        ctx,
        request,
        client,
        objects,
        [...libraries.values()],
        ledger,
        logger,
      );
    }
    if (lists.size > 0) {
      ctx.progress.phase("lists");
      const session = new ListRestoreSession({
        ctx,
        client,
        siteId: request.protectedObject.externalId,
        mode: request.mode,
        restoreJobId: request.restoreJobId,
        requestedAt: validDate(request.requestedAt),
        reader,
        ledger,
        objects,
      });
      for (const group of lists.values()) {
        if (request.target.type === "other") {
          for (const item of group.items) {
            ledger.failed(
              item,
              new Error("list items are restored into their original list only"),
              "wrong_target",
            );
          }
          continue;
        }
        await session.restoreList(group);
      }
    }

    ledger.settle(plan.objects);
    await ctx.progress.flush();
    const report = ledger.report();
    logger.info("restore finished", {
      restored: report.restored,
      skipped: report.skipped,
      failed: report.failures.length,
      unverified: report.unverified,
    });
    return report;
  }

  private async restoreLibraries(
    ctx: JobContext,
    request: RestoreRequest,
    client: GraphClient,
    objects: ReadonlyMap<string, ManifestObject>,
    groups: readonly LibraryGroup[],
    ledger: RestoreLedger,
    logger: Logger,
  ): Promise<void> {
    const other =
      request.target.type === "other" ? parseDriveTargetRef(request.target.ref ?? "") : null;
    if (other && other.drive.length === 0) {
      throw new SiteRestoreTargetError("a restore into another library needs the target drive");
    }
    const keepLibraryFolder = other !== null && groups.length > 1;
    for (const group of groups) {
      throwIfAborted(ctx);
      const prefix = `${libraryPath(group.folder)}/`;
      let driveId: string | null;
      let basePath: readonly string[] = [];
      if (other) {
        driveId = other.drive;
        basePath = keepLibraryFolder ? [...other.basePath, group.folder] : other.basePath;
      } else {
        driveId = objects.get(libraryPath(group.folder))?.metadata?.driveId ?? null;
        if (driveId !== null && (await getDrive(client, driveId)) === null) {
          driveId = null;
        }
      }
      if (driveId === null) {
        const error = new Error(
          `the library "${group.folder}" no longer exists in the site; restore it into another library`,
        );
        for (const object of [...group.folders, ...group.files]) {
          ledger.failed(object, error, "wrong_target");
        }
        continue;
      }
      const session = new OneDriveRestoreSession({
        ctx,
        client,
        driveId,
        basePath,
        mode: request.mode,
        fragmentSize: this.options.fragmentSize,
        reader: chunkReaderFor(ctx),
        ledger,
        logger: logger.child({ library: group.folder, driveId }),
        targetPathOf: (path) => (path.startsWith(prefix) ? path.slice(prefix.length) : ""),
      });
      for (const folder of group.folders) {
        if (folder.path === libraryPath(group.folder)) {
          // The library itself: it exists (or the target was named); nothing to create.
          ledger.restored(folder, { targetRef: driveId, bytes: 0, verified: true });
          continue;
        }
        await session.restoreFolder(folder);
      }
      for (const file of group.files) {
        await session.restoreFile(file);
      }
    }
  }
}

interface ListSessionOptions {
  readonly ctx: JobContext;
  readonly client: GraphClient;
  readonly siteId: string;
  readonly mode: RestoreMode;
  readonly restoreJobId: string;
  /**
   * When the restore was requested (stable across the attempts of a retried
   * job); null for requests that do not carry it, which then cannot tell an
   * earlier attempt's items apart and add them anew.
   */
  readonly requestedAt: Date | null;
  readonly reader: ReturnType<typeof chunkReaderFor>;
  readonly ledger: RestoreLedger;
  readonly objects: ReadonlyMap<string, ManifestObject>;
}

function validDate(value: Date | undefined): Date | null {
  return value instanceof Date && !Number.isNaN(value.getTime()) ? value : null;
}

/** A backed-up list item as the engine wrote it (backup/sharepoint/engine.ts). */
interface StoredListItem {
  readonly id?: string;
  readonly fields?: Record<string, unknown>;
}

/**
 * Cursor key a rename-mode restore sets (to its restore job id) before it adds
 * its first list item: only an attempt that finds it there is a retry that may
 * have added items already. The worker clears the cursor when the job ends.
 */
const LIST_ADDS_CURSOR_KEY = "sharepointListItemsAddedBy";

class ListRestoreSession {
  constructor(private readonly o: ListSessionOptions) {}

  /** Whether an earlier attempt of this restore job may have added list items. */
  private earlierAttemptAdded: boolean | null = null;
  private addsMarked = false;

  private async retriedAfterAdds(): Promise<boolean> {
    if (this.earlierAttemptAdded === null) {
      const cursor = await this.o.ctx.cursor.load();
      this.earlierAttemptAdded = cursor?.[LIST_ADDS_CURSOR_KEY] === this.o.restoreJobId;
      this.addsMarked = this.earlierAttemptAdded;
    }
    return this.earlierAttemptAdded;
  }

  /** Record, before the first item is added, that this restore job adds list items. */
  private async markAdds(): Promise<void> {
    if (this.addsMarked) {
      return;
    }
    const cursor = (await this.o.ctx.cursor.load()) ?? {};
    await this.o.ctx.cursor.save({ ...cursor, [LIST_ADDS_CURSOR_KEY]: this.o.restoreJobId });
    this.addsMarked = true;
  }

  private async readJson<T>(object: ManifestObject): Promise<T> {
    const bytes = await this.o.reader.readObjectToBuffer(object);
    return JSON.parse(bytes.toString("utf8")) as T;
  }

  /** The list's columns as the backup recorded them; null when the schema is missing or unreadable. */
  private async columnsOf(folder: string): Promise<ListColumnFacts[] | null> {
    const schema = this.o.objects.get(listSchemaPath(folder));
    if (!schema) {
      return null;
    }
    try {
      const parsed = await this.readJson<{ columns?: ListColumnFacts[] }>(schema);
      return Array.isArray(parsed.columns) ? parsed.columns : null;
    } catch (error) {
      if (isAbortError(error)) {
        throw error;
      }
      return null;
    }
  }

  /**
   * The list's items created at or after the request: what an earlier attempt
   * of this restore may have added. Filtered here rather than with a Graph
   * `$filter`, which SharePoint refuses on non-indexed columns of large lists;
   * empty without a request time and on an attempt that is not a retry after
   * added items (anything created since then is someone else's).
   */
  private async itemsAddedSinceRequest(listId: string): Promise<SiteListItem[]> {
    const { requestedAt } = this.o;
    if (requestedAt === null || !(await this.retriedAfterAdds())) {
      return [];
    }
    const added: SiteListItem[] = [];
    for await (const item of listListItems(this.o.client, this.o.siteId, listId)) {
      throwIfAborted(this.o.ctx);
      const created = Date.parse(item.createdDateTime ?? "");
      if (!Number.isNaN(created) && created >= requestedAt.getTime()) {
        added.push(item);
      }
    }
    return added;
  }

  async restoreList(group: ListGroup): Promise<void> {
    const { ctx, client, siteId, ledger } = this.o;
    const listFolder = this.o.objects.get(listPath(group.folder));
    const listId = listFolder?.metadata?.listId ?? group.items[0]?.metadata?.listId;
    if (!listId) {
      for (const item of group.items) {
        ledger.failed(
          item,
          new Error("the backup does not name the item's list"),
          "not_restorable",
        );
      }
      return;
    }
    const columns = await this.columnsOf(group.folder);
    const earlier = this.o.mode === "rename" ? await this.itemsAddedSinceRequest(listId) : [];
    for (const object of group.items) {
      throwIfAborted(ctx);
      try {
        const stored = await this.readJson<StoredListItem>(object);
        const fields = writableFields(stored.fields ?? {}, columns);
        const originalId = object.metadata?.listItemId ?? stored.id;
        if (this.o.mode === "rename") {
          // Rename mode always adds, so a retried job (a worker shutdown, an
          // update's drain, an expiry: the queue runs it again from the start)
          // would add every item the interrupted attempt already added. Those
          // are the items created since the request with the same values; each
          // one stands for one backed-up item only, so two identical backed-up
          // items still end up as two.
          // No value to compare (nothing writable) matches any item: not a match.
          const comparable = Object.keys(fields).some((key) => !key.includes("@"));
          const index = comparable
            ? earlier.findIndex((candidate) => sameValues(fields, candidate.fields ?? {}))
            : -1;
          const match = index >= 0 ? earlier.splice(index, 1)[0] : undefined;
          if (match) {
            ledger.restored(object, {
              targetRef: match.id,
              bytes: object.size,
              verified: true,
              note: "already added by an earlier attempt of this restore",
            });
            continue;
          }
        }
        if (this.o.mode !== "rename" && originalId) {
          const existing = await getListItem(client, siteId, listId, originalId);
          if (existing && this.o.mode === "skip") {
            ledger.skipped(object, "exists", "the item still exists in the list", existing.id);
            continue;
          }
          if (existing && this.o.mode === "replace") {
            const updated = await updateListItemFields(client, siteId, listId, originalId, fields);
            if (updated) {
              ledger.restored(object, {
                targetRef: existing.id,
                bytes: object.size,
                verified: sameValues(fields, updated),
                note: "the existing item's fields were overwritten with the backed-up values",
              });
              continue;
            }
          }
        }
        if (this.o.mode === "rename") {
          await this.markAdds();
        }
        const created = await createListItem(client, siteId, listId, fields);
        ledger.restored(object, {
          targetRef: created.id,
          bytes: object.size,
          verified: sameValues(fields, created.fields ?? {}),
          note:
            originalId && created.id !== originalId
              ? `added as item ${created.id} (was ${originalId})`
              : undefined,
        });
      } catch (error) {
        if (isAbortError(error)) {
          throw error;
        }
        ledger.failed(object, error);
      }
    }
  }
}

/** Every value that was sent comes back the same (annotations left aside). */
function sameValues(sent: Record<string, unknown>, received: Record<string, unknown>): boolean {
  return Object.entries(sent).every(
    ([key, value]) => key.includes("@") || JSON.stringify(received[key]) === JSON.stringify(value),
  );
}
