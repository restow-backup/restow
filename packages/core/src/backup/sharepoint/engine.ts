/**
 * SharePoint Online backup engine (protected object kind `site`,
 * docs/MICROSOFT.md, SharePoint).
 *
 *   one snapshot per site       ./layout.ts says where everything lies
 *   libraries                   every document library is a drive and is backed
 *                               up by the OneDrive engine's drive run
 *                               (backup/onedrive/run.ts) into its own folder:
 *                               delta with token, item ids, streaming downloads,
 *                               optional versions, retries, 410 resync, item
 *                               failures and checkpoints behave exactly as for a
 *                               OneDrive, through the same throttled client
 *   lists                       columns and items with all field values as JSON,
 *                               read in full each run; an unchanged item (same
 *                               eTag) reuses its stored bytes
 *   site metadata               `site.json`: title, URL, description, site
 *                               collection, the libraries with the sharing
 *                               permissions of their root, the lists
 *   permissions                 recorded as information (the drive items'
 *                               sharing facet, the libraries' root
 *                               permissions), never restored
 *   not covered                 list item attachments (Graph v1.0 has no API
 *                               for them), site designs and themes, workflows,
 *                               web parts outside the Site Pages library
 *
 * A library or list Graph refuses (403/404) is reported as an item failure and
 * keeps its last good copy; the rest of the site is backed up. Errors that
 * concern the whole site (site gone, token, storage) fail the job, which
 * resumes from the last checkpoint: finished libraries are not walked again.
 */
import { Readable } from "node:stream";
import type { Permission } from "@microsoft/microsoft-graph-types";
import { JobAbortedError } from "../../engine/chunkstore.js";
import { SnapshotWriter } from "../../engine/snapshot.js";
import type {
  BackupEngine,
  BackupOptions,
  BackupResult,
  ItemFailureRecord,
  JobContext,
  Logger,
  ProgressReporter,
  ProtectedObjectRef,
} from "../../engine/types.js";
import { buildCause, classifyFailure } from "../../failures/classify.js";
import type { FailureCause } from "../../failures/types.js";
import type { GraphClient } from "../../graph/client.js";
import { isGraphError } from "../../graph/errors.js";
import { collect } from "../../graph/resources/common.js";
import {
  getSite,
  isHiddenList,
  isLibraryList,
  listDriveRootPermissions,
  listListColumns,
  listListItems,
  listSiteDrives,
  listSiteLists,
  type SiteDrive,
  type SiteInfo,
  type SiteList,
  type SiteListItem,
} from "../../graph/resources/sites.js";
import type { ManifestObject, SnapshotManifest } from "../../manifest.js";
import { ONEDRIVE_BACKUP_DEFAULTS } from "../onedrive/engine.js";
import {
  compareWithPrevious,
  DriveBackupRun,
  type DriveObjectSink,
  describeFailure,
  type RunSettings,
} from "../onedrive/run.js";
import {
  checkpointState,
  type OneDriveCheckpointState,
  type OneDriveCursor,
  planRun,
  readCheckpointDeletions,
} from "../onedrive/state.js";
import {
  LIBRARIES_FOLDER,
  LISTS_FOLDER,
  libraryPath,
  listItemObjectId,
  listItemPath,
  listPath,
  listSchemaPath,
  objectsBelow,
  prefixObjects,
  SITE_INFO_PATH,
  SITE_OBJECT_TYPES,
  SITE_ROLES,
  uniqueSegments,
} from "./layout.js";
import {
  checkpointDriveState,
  currentDriveCursor,
  readSiteCursor,
  readSiteManifestState,
  SITE_ENGINE_NAME,
  type SiteCursor,
  type SiteLibraryState,
  type SiteManifestState,
  siteCheckpointState,
} from "./state.js";

/** Progress phases of a site run, besides the drive run's own (enumerate, changes, ...). */
export const SHAREPOINT_PHASES = {
  site: "site",
  lists: "lists",
  commit: "commit",
} as const;

/**
 * Hands the engine a throttled Graph client for the source that owns the site
 * (the same resolver the OneDrive engine takes).
 */
export type SharePointGraphClientResolver<Db = unknown> = (
  ctx: JobContext<Db>,
  protectedObject: ProtectedObjectRef,
) => Promise<GraphClient> | GraphClient;

/**
 * The site no longer exists (deleted, or its URL changed). Retrying does not
 * help; the directory marks it orphaned on its next discovery run, and its
 * restore points stay.
 */
export class SiteUnavailableError extends Error {
  /** Read by the failure classifier (failures/classify.ts). */
  readonly failure: FailureCause;

  constructor(
    readonly protectedObjectId: string,
    readonly externalId: string,
  ) {
    super(`the SharePoint site ${externalId} no longer exists`);
    this.name = "SiteUnavailableError";
    this.failure = buildCause(
      "graph.site_unavailable",
      { resource: "sharepoint" },
      {
        message: this.message,
      },
    );
  }
}

export interface SharePointBackupEngineOptions<Db = unknown> {
  readonly graph: SharePointGraphClientResolver<Db>;
  /** Also store historical file versions of the libraries (extra Graph calls per file). */
  readonly includeVersions?: boolean;
  readonly checkpointEveryItems?: number;
  readonly checkpointEveryBytes?: number;
  readonly checkpointMinIntervalMs?: number;
  readonly maxRetryIds?: number;
  readonly maxPackBytes?: number;
  readonly snapshotIdGenerator?: () => string;
  readonly packIdGenerator?: () => string;
}

/** What `site.json` records about a library. */
interface LibraryInfo {
  readonly folder: string;
  readonly driveId: string;
  readonly name: string | null;
  readonly description: string | null;
  readonly webUrl: string | null;
  readonly driveType: string | null;
  /** Sharing permissions of the library's root; null when Graph did not give them. */
  readonly rootPermissions: unknown[] | null;
}

/** What `site.json` records about a list. */
interface ListInfo {
  readonly folder: string;
  readonly listId: string;
  readonly name: string | null;
  readonly displayName: string | null;
  readonly template: string | null;
  readonly webUrl: string | null;
  readonly items: number;
}

function compactMetadata(
  entries: Record<string, string | null | undefined>,
): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [key, value] of Object.entries(entries)) {
    if (typeof value === "string" && value.length > 0) {
      out[key] = value;
    }
  }
  return out;
}

function identityLabel(value: unknown): string | undefined {
  const user = (value as { user?: { displayName?: string; email?: string; id?: string } })?.user;
  return user?.displayName ?? user?.email ?? user?.id ?? undefined;
}

function timeOf(value: string | null | undefined, fallback: number): number {
  const parsed = value ? Date.parse(value) : Number.NaN;
  return Number.isNaN(parsed) ? fallback : parsed;
}

function jsonBytes(value: unknown): Buffer {
  return Buffer.from(`${JSON.stringify(value, null, 2)}\n`, "utf8");
}

/** Progress of one library inside the site's: totals add up across libraries. */
function libraryProgress(base: ProgressReporter, offset: number, prefix: string): ProgressReporter {
  return {
    total: (count) => base.total(offset + count),
    advance: (done, bytes, processed) => base.advance(done, bytes, processed),
    transfer: base.transfer ? (bytes) => base.transfer?.(bytes) : undefined,
    fail: (itemRef, reason, cause, details) =>
      base.fail(`${prefix}/${itemRef}`, reason, cause, details),
    phase: (name) => base.phase(name),
    firstBackup: undefined,
    snapshot: () => base.snapshot(),
    flush: () => base.flush(),
  };
}

/** A library or list Graph refuses to show: reported, its last copy kept. */
function isRefused(error: unknown): boolean {
  return isGraphError(error) && [403, 404, 423].includes(error.status);
}

export class SharePointBackupEngine<Db = unknown> implements BackupEngine<Db> {
  readonly kind = "site" as const;
  private readonly settings: RunSettings;

  constructor(private readonly options: SharePointBackupEngineOptions<Db>) {
    const defaults = ONEDRIVE_BACKUP_DEFAULTS;
    this.settings = {
      includeVersions: options.includeVersions ?? false,
      checkpointEveryItems: Math.max(
        1,
        options.checkpointEveryItems ?? defaults.checkpointEveryItems,
      ),
      checkpointEveryBytes: Math.max(
        1,
        options.checkpointEveryBytes ?? defaults.checkpointEveryBytes,
      ),
      checkpointMinIntervalMs: Math.max(
        0,
        options.checkpointMinIntervalMs ?? defaults.checkpointMinIntervalMs,
      ),
      maxRetryIds: Math.max(0, options.maxRetryIds ?? defaults.maxRetryIds),
    };
  }

  async run(
    ctx: JobContext<Db>,
    protectedObject: ProtectedObjectRef,
    options: BackupOptions,
  ): Promise<BackupResult> {
    if (protectedObject.kind !== this.kind) {
      throw new Error(
        `sharepoint engine cannot back up a protected object of kind ${protectedObject.kind}`,
      );
    }
    const context = ctx as unknown as JobContext;
    const logger = context.logger.child({
      engine: SITE_ENGINE_NAME,
      protectedObjectId: protectedObject.id,
    });
    const client = await this.options.graph(ctx, protectedObject);
    context.progress.phase(SHAREPOINT_PHASES.site);
    const site = await getSite(client, protectedObject.externalId);
    if (!site) {
      throw new SiteUnavailableError(protectedObject.id, protectedObject.externalId);
    }
    const siteId = protectedObject.externalId;
    const resume = readSiteCursor(await context.cursor.load(), siteId);
    const writer = await SnapshotWriter.begin(context, {
      protectedObject,
      sourceType: "m365",
      checkpoint: resume?.snapshot,
      maxPackBytes: this.options.maxPackBytes,
      snapshotIdGenerator: this.options.snapshotIdGenerator,
      packIdGenerator: this.options.packIdGenerator,
    });
    const resumed = resume !== null && writer.snapshotId === resume.snapshot?.snapshotId;
    const previous = await writer.loadPreviousManifest();
    if (!previous) {
      context.progress.firstBackup?.({
        itemsBefore: resumed ? writer.objectCount : 0,
        itemsTotal: null,
      });
    }
    const run = new SiteBackupRun({
      ctx: context,
      client,
      site,
      siteId,
      writer,
      previous,
      previousState: previous ? readSiteManifestState(previous.state, siteId) : null,
      resume: resumed ? resume : null,
      full: options.full === true,
      settings: this.settings,
      logger,
    });
    return run.execute();
  }
}

interface SiteRunInput {
  readonly ctx: JobContext;
  readonly client: GraphClient;
  readonly site: SiteInfo;
  readonly siteId: string;
  readonly writer: SnapshotWriter;
  readonly previous: SnapshotManifest | null;
  readonly previousState: SiteManifestState | null;
  readonly resume: SiteCursor | null;
  readonly full: boolean;
  readonly settings: RunSettings;
  readonly logger: Logger;
}

class SiteBackupRun {
  private readonly failures: ItemFailureRecord[] = [];
  /** Libraries finished in this job, by drive id. */
  private readonly done = new Map<string, SiteLibraryState>();
  private readonly libraries: LibraryInfo[] = [];
  private readonly lists: ListInfo[] = [];
  private readonly previousObjects: ManifestObject[];
  /** A drive run threw: it checkpointed on its way out already. */
  private driveRunFailed = false;

  constructor(private readonly input: SiteRunInput) {
    this.previousObjects = input.previous?.objects ?? [];
    for (const library of input.resume?.done ?? []) {
      this.done.set(library.driveId, library);
    }
  }

  private now(): number {
    return this.input.ctx.now().getTime();
  }

  private throwIfAborted(): void {
    if (this.input.ctx.signal.aborted) {
      throw new JobAbortedError();
    }
  }

  async execute(): Promise<BackupResult> {
    const { ctx, client, siteId, writer, logger } = this.input;
    const drives = await collect(listSiteDrives(client, siteId));
    const lists = (await collect(listSiteLists(client, siteId))).filter(
      (list) => !isHiddenList(list) && !isLibraryList(list),
    );
    logger.info("sharepoint backup started", {
      libraries: drives.length,
      lists: lists.length,
      resumed: this.input.resume !== null,
      sequence: writer.sequence,
    });

    const libraryFolders = uniqueSegments(drives, (drive) => drive.name);
    try {
      for (const drive of drives) {
        this.throwIfAborted();
        await this.backupLibrary(drive, libraryFolders.get(drive) ?? drive.id);
      }
      this.sweep(
        LIBRARIES_FOLDER,
        new Set(drives.map((drive) => libraryFolders.get(drive) ?? drive.id)),
      );

      ctx.progress.phase(SHAREPOINT_PHASES.lists);
      const listFolders = uniqueSegments(lists, (list) => list.displayName ?? list.name);
      for (const list of lists) {
        this.throwIfAborted();
        await this.backupList(list, listFolders.get(list) ?? list.id);
      }
      this.sweep(LISTS_FOLDER, new Set(lists.map((list) => listFolders.get(list) ?? list.id)));
    } catch (error) {
      await this.checkpointOnTheWayOut(error);
      throw error;
    }
    return this.commit();
  }

  // -------------------------------------------------------------------------
  // Libraries

  private async backupLibrary(drive: SiteDrive, folder: string): Promise<void> {
    const { ctx, client, writer, siteId, logger, resume } = this.input;
    const prefix = libraryPath(folder);
    writer.add(this.libraryFolderObject(drive, folder));
    const rootPermissions = await this.rootPermissions(drive.id);
    this.libraries.push({
      folder,
      driveId: drive.id,
      name: drive.name ?? null,
      description: drive.description ?? null,
      webUrl: drive.webUrl ?? null,
      driveType: drive.driveType ?? null,
      rootPermissions,
    });

    const finished = this.done.get(drive.id);
    if (finished && finished.folder === folder) {
      return;
    }
    const previousLibrary =
      this.input.previousState?.libraries.find((library) => library.driveId === drive.id) ?? null;
    const previousObjects = previousLibrary
      ? objectsBelow(this.previousObjects, libraryPath(previousLibrary.folder))
      : null;
    const driveCursor = currentDriveCursor(resume, drive.id, folder);
    const plan = planRun({
      full: this.input.full,
      includeVersions: this.input.settings.includeVersions,
      resume: driveCursor,
      previous: previousLibrary?.drive ?? null,
    });
    const progress = libraryProgress(ctx.progress, ctx.progress.snapshot().total, prefix);
    const run = new DriveBackupRun({
      ctx: { ...ctx, progress },
      client,
      driveId: drive.id,
      writer,
      previous: previousObjects ? { objects: previousObjects } : null,
      plan,
      settings: this.input.settings,
      logger: logger.child({ driveId: drive.id, library: folder }),
      resumed: driveCursor !== null,
      resumedDeletions: driveCursor
        ? readCheckpointDeletions(checkpointDriveState(writer.state, siteId), drive.id)
        : [],
      sink: this.librarySink(drive.id, folder),
    });
    try {
      let outcome: Awaited<ReturnType<DriveBackupRun["collect"]>>;
      try {
        outcome = await run.collect();
      } catch (error) {
        this.driveRunFailed = !isRefused(error);
        throw error;
      }
      for (const failure of outcome.failures) {
        this.failures.push({ ...failure, itemRef: `${prefix}/${failure.itemRef}` });
      }
      this.done.set(drive.id, { driveId: drive.id, folder, drive: outcome.state });
    } catch (error) {
      if (!isRefused(error)) {
        throw error;
      }
      // The library cannot be read (permissions, locked): keep what the last
      // backup had of it and its drive state, so nothing is lost and the next
      // run continues from there.
      this.recordFailure(prefix, error);
      if (previousObjects && previousLibrary) {
        this.replaceBelow(prefix, previousObjects);
        this.done.set(drive.id, { driveId: drive.id, folder, drive: previousLibrary.drive });
      }
    }
    // A finished library is never walked again by a retry of this job.
    await this.checkpoint(null);
  }

  private libraryFolderObject(drive: SiteDrive, folder: string): ManifestObject {
    return {
      path: libraryPath(folder),
      id: `library:${drive.id}`,
      type: "folder",
      size: 0,
      mtime: timeOf(drive.lastModifiedDateTime, this.now()),
      metadata: compactMetadata({
        siteRole: SITE_ROLES.library,
        driveId: drive.id,
        libraryName: drive.name,
        description: drive.description,
        webUrl: drive.webUrl,
        createdDateTime: drive.createdDateTime,
        lastModifiedDateTime: drive.lastModifiedDateTime,
      }),
      chunks: [],
    };
  }

  private async rootPermissions(driveId: string): Promise<unknown[] | null> {
    try {
      const permissions = await collect(listDriveRootPermissions(this.input.client, driveId));
      return permissions.map((permission: Permission) => ({
        id: permission.id,
        roles: permission.roles,
        grantedToV2: permission.grantedToV2,
        grantedToIdentitiesV2: permission.grantedToIdentitiesV2,
        link: permission.link
          ? { scope: permission.link.scope, type: permission.link.type }
          : undefined,
        inheritedFrom: permission.inheritedFrom ? true : undefined,
      }));
    } catch (error) {
      if (!isGraphError(error) || error.status >= 500 || error.status === 429) {
        throw error;
      }
      // Information only: a library whose permissions cannot be read is still backed up.
      this.input.logger.info("library permissions not readable", {
        driveId,
        status: error.status,
      });
      return null;
    }
  }

  /** The drive run's view of one library: the objects below its folder. */
  private librarySink(driveId: string, folder: string): DriveObjectSink {
    const prefix = libraryPath(folder);
    return {
      list: () => objectsBelow(this.input.writer.listObjects(), prefix),
      replace: (objects) => this.replaceBelow(prefix, objects),
      checkpoint: async (cursor, deleted) => {
        await this.checkpoint({
          driveId,
          folder,
          cursor,
          state: checkpointState(driveId, deleted),
        });
      },
    };
  }

  // -------------------------------------------------------------------------
  // Lists

  private async backupList(list: SiteList, folder: string): Promise<void> {
    const { client, siteId, writer } = this.input;
    const prefix = listPath(folder);
    writer.add({
      path: prefix,
      id: `list:${list.id}`,
      type: "folder",
      size: 0,
      mtime: timeOf(list.lastModifiedDateTime, this.now()),
      metadata: compactMetadata({
        siteRole: SITE_ROLES.list,
        listId: list.id,
        listName: list.name,
        displayName: list.displayName,
        template: list.list?.template,
        description: list.description,
        webUrl: list.webUrl,
        createdDateTime: list.createdDateTime,
        lastModifiedDateTime: list.lastModifiedDateTime,
      }),
      chunks: [],
    });
    const previousItems = this.previousListItems(list.id);
    const objects: ManifestObject[] = [];
    let items = 0;
    try {
      const columns = await collect(listListColumns(client, siteId, list.id));
      objects.push(
        await this.jsonObject(
          {
            path: listSchemaPath(folder),
            id: `list-schema:${list.id}`,
            type: SITE_OBJECT_TYPES.listSchema,
            mtime: timeOf(list.lastModifiedDateTime, this.now()),
            metadata: compactMetadata({ listId: list.id, contentType: "application/json" }),
          },
          { list, columns },
        ),
      );
      for await (const item of listListItems(client, siteId, list.id)) {
        this.throwIfAborted();
        objects.push(await this.listItemObject(list, folder, item, previousItems));
        items++;
        this.countItem();
      }
    } catch (error) {
      if (!isRefused(error)) {
        throw error;
      }
      this.recordFailure(prefix, error);
      // Keep the items the last backup had; they are what a restore can still offer.
      const schema = this.previousObjects.find(
        (object) =>
          object.type === SITE_OBJECT_TYPES.listSchema && object.metadata?.listId === list.id,
      );
      if (schema) {
        objects.length = 0;
        objects.push({ ...schema, path: listSchemaPath(folder) });
      }
      const kept = [...previousItems.values()].map((object) => ({
        ...object,
        path: listItemPath(folder, object.metadata?.listItemId ?? object.id ?? "item"),
        metadata: { ...object.metadata, stale: "true" },
      }));
      this.replaceBelow(prefix, objectsBelow([...(schema ? objects : []), ...kept], prefix));
      this.lists.push(this.listInfo(list, folder, kept.length));
      return;
    }
    this.replaceBelow(prefix, objectsBelow(objects, prefix));
    this.lists.push(this.listInfo(list, folder, items));
  }

  /** One more list item done; lists say how many items they hold only by being read. */
  private countItem(): void {
    const progress = this.input.ctx.progress;
    const { total, done } = progress.snapshot();
    if (total < done + 1) {
      progress.total(done + 1);
    }
    progress.advance(1);
  }

  private listInfo(list: SiteList, folder: string, items: number): ListInfo {
    return {
      folder,
      listId: list.id,
      name: list.name ?? null,
      displayName: list.displayName ?? null,
      template: list.list?.template ?? null,
      webUrl: list.webUrl ?? null,
      items,
    };
  }

  /** The previous snapshot's items of a list, by list item id (wherever the list lay then). */
  private previousListItems(listId: string): Map<string, ManifestObject> {
    const items = new Map<string, ManifestObject>();
    for (const object of this.previousObjects) {
      if (
        object.type === SITE_OBJECT_TYPES.listItem &&
        object.metadata?.listId === listId &&
        object.metadata.listItemId !== undefined
      ) {
        items.set(object.metadata.listItemId, object);
      }
    }
    return items;
  }

  private async listItemObject(
    list: SiteList,
    folder: string,
    item: SiteListItem,
    previousItems: ReadonlyMap<string, ManifestObject>,
  ): Promise<ManifestObject> {
    const fields = item.fields ?? {};
    const eTag =
      item.eTag ?? (typeof fields["@odata.etag"] === "string" ? fields["@odata.etag"] : undefined);
    const title = typeof fields.Title === "string" ? fields.Title : undefined;
    const metadata = compactMetadata({
      siteRole: SITE_ROLES.listItem,
      listId: list.id,
      listItemId: item.id,
      title,
      eTag: eTag ?? undefined,
      contentType: "application/json",
      itemContentType: item.contentType?.name ?? undefined,
      createdDateTime: item.createdDateTime ?? undefined,
      lastModifiedDateTime: item.lastModifiedDateTime ?? undefined,
      createdBy: identityLabel(item.createdBy),
      lastModifiedBy: identityLabel(item.lastModifiedBy),
      webUrl: item.webUrl ?? undefined,
    });
    const base = {
      path: listItemPath(folder, item.id),
      id: listItemObjectId(list.id, item.id),
      type: SITE_OBJECT_TYPES.listItem,
      mtime: timeOf(item.lastModifiedDateTime, this.now()),
      metadata,
    };
    const before = previousItems.get(item.id);
    if (
      before &&
      eTag !== undefined &&
      before.metadata?.eTag === eTag &&
      before.sha256 !== undefined &&
      before.metadata.stale !== "true"
    ) {
      return { ...base, size: before.size, sha256: before.sha256, chunks: before.chunks };
    }
    return this.jsonObject(base, {
      id: item.id,
      contentType: item.contentType,
      createdDateTime: item.createdDateTime,
      lastModifiedDateTime: item.lastModifiedDateTime,
      createdBy: item.createdBy,
      lastModifiedBy: item.lastModifiedBy,
      webUrl: item.webUrl,
      fields,
    });
  }

  /** Store a JSON document as an object's content. */
  private async jsonObject(
    base: Omit<ManifestObject, "size" | "chunks" | "sha256">,
    value: unknown,
  ): Promise<ManifestObject> {
    const bytes = jsonBytes(value);
    const written = await this.input.writer.chunks.write(Readable.from([bytes]));
    const object: ManifestObject = { ...base, size: written.size, chunks: written.chunks };
    if (written.sha256 !== undefined) {
      object.sha256 = written.sha256;
    }
    return object;
  }

  // -------------------------------------------------------------------------
  // Snapshot

  /** Make the writer hold exactly `objects` (relative paths) below `prefix`. */
  private replaceBelow(prefix: string, objects: readonly ManifestObject[]): void {
    const { writer } = this.input;
    const wanted = new Map(prefixObjects(objects, prefix).map((object) => [object.path, object]));
    const head = `${prefix}/`;
    for (const existing of writer.listObjects()) {
      if (existing.path.startsWith(head) && !wanted.has(existing.path)) {
        writer.remove(existing.path);
      }
    }
    for (const object of wanted.values()) {
      writer.add(object);
    }
  }

  /** Drop library or list folders of an earlier attempt the site no longer has. */
  private sweep(area: string, folders: ReadonlySet<string>): void {
    const { writer } = this.input;
    for (const object of writer.listObjects()) {
      const [top, folder] = object.path.split("/");
      if (top === area && folder !== undefined && !folders.has(folder)) {
        writer.remove(object.path);
      }
    }
  }

  private recordFailure(itemRef: string, error: unknown): void {
    const reason = describeFailure(error);
    const cause = classifyFailure(error);
    this.failures.push({ itemRef, reason, cause });
    this.input.ctx.progress.fail(itemRef, reason, cause);
    this.input.logger.warn("site part failed", { itemRef, reason });
  }

  private async siteInfoObject(): Promise<ManifestObject> {
    const { site } = this.input;
    return this.jsonObject(
      {
        path: SITE_INFO_PATH,
        id: "site",
        type: SITE_OBJECT_TYPES.info,
        mtime: timeOf(site.lastModifiedDateTime, this.now()),
        metadata: compactMetadata({
          siteRole: "site",
          siteId: this.input.siteId,
          displayName: site.displayName,
          webUrl: site.webUrl,
          contentType: "application/json",
        }),
      },
      {
        site: {
          id: site.id,
          name: site.name,
          displayName: site.displayName,
          description: site.description,
          webUrl: site.webUrl,
          createdDateTime: site.createdDateTime,
          lastModifiedDateTime: site.lastModifiedDateTime,
          siteCollection: site.siteCollection,
          sharepointIds: site.sharepointIds,
        },
        libraries: this.libraries,
        lists: this.lists,
      },
    );
  }

  private async checkpoint(
    current: {
      readonly driveId: string;
      readonly folder: string;
      readonly cursor: Omit<OneDriveCursor, "snapshot">;
      readonly state: OneDriveCheckpointState;
    } | null,
  ): Promise<void> {
    const { writer, siteId } = this.input;
    writer.setState(
      siteCheckpointState(siteId, current?.state ?? null) as unknown as Record<string, unknown>,
    );
    const cursor: Omit<SiteCursor, "snapshot"> = {
      engine: SITE_ENGINE_NAME,
      siteId,
      done: [...this.done.values()],
      ...(current
        ? { current: { driveId: current.driveId, folder: current.folder, cursor: current.cursor } }
        : {}),
    };
    await writer.checkpoint(cursor);
  }

  /**
   * Whatever ends the run early leaves a checkpoint behind, so the retry skips
   * the libraries already finished. A drive run that failed has saved its own
   * checkpoint, with the cursor of its library; that one must not be replaced.
   * Nothing is saved after a storage failure (the writer refuses it).
   */
  private async checkpointOnTheWayOut(cause: unknown): Promise<void> {
    if (this.driveRunFailed || this.input.writer.chunks.failed) {
      return;
    }
    try {
      await this.checkpoint(null);
      this.input.logger.info("run ended early, checkpoint saved", {
        reason: cause instanceof JobAbortedError ? "aborted" : "failed",
        librariesDone: this.done.size,
      });
    } catch (error) {
      this.input.logger.error("could not save the checkpoint", { error: describeFailure(error) });
    }
  }

  private async commit(): Promise<BackupResult> {
    const { ctx, writer, siteId, logger } = this.input;
    writer.add(await this.siteInfoObject());
    const objects = writer.listObjects();
    const previousById = new Map<string, ManifestObject>();
    for (const object of this.previousObjects) {
      if (object.id !== undefined) {
        previousById.set(object.id, object);
      }
    }
    const changes = compareWithPrevious(previousById, objects);
    const state: SiteManifestState = {
      engine: SITE_ENGINE_NAME,
      siteId,
      libraries: [...this.done.values()],
      completedAt: this.now(),
    };
    writer.setState(state as unknown as Record<string, unknown>);
    ctx.progress.phase(SHAREPOINT_PHASES.commit);
    const committed = await writer.commit();
    await ctx.cursor.clear();
    const bytes = writer.chunks.stats.bytesNew;
    logger.info("sharepoint backup completed", {
      snapshotId: committed.snapshotId,
      sequence: committed.sequence,
      libraries: this.libraries.length,
      lists: this.lists.length,
      objectsTotal: committed.itemCount,
      objectsChanged: changes.changed,
      objectsRemoved: changes.removed,
      failures: this.failures.length,
      newBytes: bytes,
    });
    return {
      snapshotId: committed.snapshotId,
      sequence: committed.sequence,
      objectsWritten: changes.changed,
      objectsTotal: committed.itemCount,
      bytes,
      failures: this.failures,
    };
  }
}
