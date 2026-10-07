/**
 * One execution of the OneDrive backup: retries from the previous run, the
 * delta walk with streaming downloads, checkpoints, and the commit.
 *
 * Failure model (docs/TESTING.md, honest failure reporting): an item that cannot be read
 * (Graph refuses it, the download breaks off or arrives short) is reported
 * through the progress reporter, keeps its last good copy marked stale in the
 * snapshot, and is fetched again by the next run. Errors that concern the
 * whole drive (token, delta stream) or the storage fail the job; the
 * checkpoint taken on the way out lets the retry continue where it stopped.
 */
import type { Readable } from "node:stream";
import type { DriveItemVersion } from "@microsoft/microsoft-graph-types";
import { JobAbortedError, type WrittenObject } from "../../engine/chunkstore.js";
import type { SnapshotWriter } from "../../engine/snapshot.js";
import type { BackupResult, ItemFailureRecord, JobContext, Logger } from "../../engine/types.js";
import { FailureError, classifyFailure } from "../../failures/classify.js";
import type { GraphClient } from "../../graph/client.js";
import type { DeltaMode } from "../../graph/delta.js";
import { GraphError, isNotFound } from "../../graph/errors.js";
import { collect } from "../../graph/resources/common.js";
import {
  type DriveDeltaItem,
  type ItemDownload,
  driveDeltaUrl,
  getItem,
  listItemVersions,
  openItemDownload,
  openVersionDownload,
} from "../../graph/resources/drive.js";
import type { ManifestObject, SnapshotManifest } from "../../manifest.js";
import { type DriveWalkOutcome, walkDriveDelta } from "./delta.js";
import {
  ONEDRIVE_OBJECT_TYPES,
  canReuseContent,
  classifyItem,
  fileObject,
  folderObject,
  graphPathOf,
  hasContent,
  historicalVersions,
  joinPath,
  reusedFileObject,
  shortcutObject,
  staleFileObject,
  versionObject,
  versionObjectId,
  versionPath,
  versionUnchanged,
} from "./items.js";
import {
  ENGINE_NAME,
  type OneDriveCursor,
  type OneDriveManifestState,
  type RunPlan,
  checkpointState,
} from "./state.js";
import { DriveTree, type Placement } from "./tree.js";

/** Progress phase names: stable identifiers the UI translates. */
export const ONEDRIVE_PHASES = {
  /** Items the previous run could not read are fetched again. */
  retry: "retry",
  /** First or full run: the whole drive is enumerated. */
  enumerate: "enumerate",
  /** Incremental run: only what changed since the last snapshot. */
  changes: "changes",
  /** The delta token expired (410 Gone); the drive is enumerated again. */
  resync: "resync",
  commit: "commit",
} as const;

export type OneDrivePhase = (typeof ONEDRIVE_PHASES)[keyof typeof ONEDRIVE_PHASES];

/** A download whose length disagrees with the Content-Length Graph announced. */
export class TruncatedDownloadError extends Error {
  constructor(
    readonly expected: number,
    readonly received: number,
  ) {
    super(`download delivered ${received} of ${expected} announced bytes`);
    this.name = "TruncatedDownloadError";
  }
}

/** The download stream broke off mid-transfer (connection reset, server abort). */
export class DownloadInterruptedError extends Error {
  constructor(cause: unknown) {
    super(`download interrupted: ${cause instanceof Error ? cause.message : String(cause)}`, {
      cause,
    });
    this.name = "DownloadInterruptedError";
  }
}

/** A human-readable, secret-free reason for an item failure. */
export function describeFailure(error: unknown): string {
  if (error instanceof GraphError) {
    const code = error.code ?? error.innerCode;
    return `Graph ${error.status}${code ? ` ${code}` : ""}: ${error.message}`.slice(0, 500);
  }
  if (error instanceof Error) {
    return `${error.name}: ${error.message}`.slice(0, 500);
  }
  return String(error).slice(0, 500);
}

/** Graph's answer for an item that no longer exists (deleted between delta and download). */
function isItemGone(error: unknown): boolean {
  return isNotFound(error) && (error.code === "itemNotFound" || error.innerCode === "itemNotFound");
}

/**
 * The bytes of a download, with failures of the source told apart from
 * failures of the consumer: an error raised while reading the stream becomes a
 * {@link DownloadInterruptedError} (the item's problem), while an error the
 * chunk writer raises (storage, cancellation) passes through untouched (the
 * job's problem). Breaking off early destroys the stream.
 */
async function* sourceBytes(stream: Readable): AsyncGenerator<Buffer> {
  try {
    for await (const piece of stream) {
      yield Buffer.isBuffer(piece) ? piece : Buffer.from(piece as Uint8Array);
    }
  } catch (error) {
    throw new DownloadInterruptedError(error);
  }
}

type FetchOutcome =
  | { readonly ok: true; readonly content: WrittenObject; readonly contentType: string | null }
  | { readonly ok: false; readonly error: unknown };

interface PlacedItem {
  readonly item: DriveDeltaItem;
  readonly path: string;
  readonly placement: Placement;
}

/**
 * Stored bytes that unchanged items may reuse instead of downloading again:
 * the previous snapshot's files and versions, plus whatever a 410 restart
 * dropped from the current run.
 */
class ContentPool {
  private readonly byId = new Map<string, ManifestObject>();
  private readonly versionsByItem = new Map<string, Map<string, ManifestObject>>();

  add(object: ManifestObject): void {
    if (object.id === undefined || !hasContent(object)) {
      return;
    }
    this.byId.set(object.id, object);
    const itemId = object.metadata?.itemId;
    if (object.type === ONEDRIVE_OBJECT_TYPES.version && itemId !== undefined) {
      const versions = this.versionsByItem.get(itemId) ?? new Map<string, ManifestObject>();
      versions.set(object.id, object);
      this.versionsByItem.set(itemId, versions);
    }
  }

  get(id: string): ManifestObject | undefined {
    return this.byId.get(id);
  }

  versionsOf(itemId: string): ManifestObject[] {
    return [...(this.versionsByItem.get(itemId)?.values() ?? [])];
  }
}

function sameStrings(a: readonly string[], b: readonly string[]): boolean {
  return a.length === b.length && a.every((value, index) => value === b[index]);
}

function sameRecord(
  a: Readonly<Record<string, string>> = {},
  b: Readonly<Record<string, string>> = {},
): boolean {
  const keys = Object.keys(a);
  return keys.length === Object.keys(b).length && keys.every((key) => a[key] === b[key]);
}

/** True when two manifest entries describe the same thing in the same place. */
export function sameObject(a: ManifestObject, b: ManifestObject): boolean {
  return (
    a.path === b.path &&
    a.type === b.type &&
    a.size === b.size &&
    a.mtime === b.mtime &&
    a.sha256 === b.sha256 &&
    sameStrings(a.chunks, b.chunks) &&
    sameRecord(a.metadata, b.metadata)
  );
}

/** How the committed object list differs from the previous snapshot's. */
export function compareWithPrevious(
  previous: ReadonlyMap<string, ManifestObject>,
  objects: readonly ManifestObject[],
): { changed: number; removed: number } {
  const present = new Set<string>();
  let changed = 0;
  for (const object of objects) {
    const before = object.id === undefined ? undefined : previous.get(object.id);
    if (object.id !== undefined) {
      present.add(object.id);
    }
    if (!before || !sameObject(before, object)) {
      changed++;
    }
  }
  let removed = 0;
  for (const id of previous.keys()) {
    if (!present.has(id)) {
      removed++;
    }
  }
  return { changed, removed };
}

/** Make the writer hold exactly `objects` (by path). */
function replaceObjects(writer: SnapshotWriter, objects: readonly ManifestObject[]): void {
  const paths = new Set(objects.map((object) => object.path));
  for (const existing of writer.listObjects()) {
    if (!paths.has(existing.path)) {
      writer.remove(existing.path);
    }
  }
  for (const object of objects) {
    writer.add(object);
  }
}

export interface RunSettings {
  readonly includeVersions: boolean;
  readonly checkpointEveryItems: number;
  readonly checkpointEveryBytes: number;
  /**
   * Minimum time between two checkpoints. A checkpoint rewrites the whole
   * partial manifest, so on a drive with many cheap items (a resync that
   * reuses everything) the item threshold alone would make checkpoints the
   * dominant cost.
   */
  readonly checkpointMinIntervalMs: number;
  readonly maxRetryIds: number;
}

export interface RunInput {
  readonly ctx: JobContext;
  readonly client: GraphClient;
  readonly driveId: string;
  readonly writer: SnapshotWriter;
  /** The last committed snapshot of this drive, if any. */
  readonly previous: SnapshotManifest | null;
  readonly plan: RunPlan;
  readonly settings: RunSettings;
  readonly logger: Logger;
  /** The writer was restored from this job's checkpoint (its objects are the run so far). */
  readonly resumed: boolean;
  /** Deletions the checkpoint had seen but not yet cascaded. */
  readonly resumedDeletions: readonly string[];
}

export class DriveBackupRun {
  private readonly ctx: JobContext;
  private readonly client: GraphClient;
  private readonly driveId: string;
  private readonly writer: SnapshotWriter;
  private readonly plan: RunPlan;
  private readonly settings: RunSettings;
  private readonly logger: Logger;
  private readonly tree: DriveTree;
  private readonly previousById = new Map<string, ManifestObject>();
  private readonly pool = new ContentPool();

  private pageUrl: string;
  private lastItemId: string | undefined;
  private walkMode: DeltaMode;
  private deltaLink: string | null;
  private retriesDone = false;
  private pendingReset = false;

  private readonly failures: ItemFailureRecord[] = [];
  private readonly retryIds = new Set<string>();
  private retryOverflow: boolean;
  private downloaded = 0;
  private reused = 0;
  private vanished = 0;
  private skipped = 0;
  private seen = 0;
  private itemsSinceCheckpoint = 0;
  private bytesSinceCheckpoint = 0;
  private lastCheckpointAt: number;

  constructor(input: RunInput) {
    this.ctx = input.ctx;
    this.client = input.client;
    this.driveId = input.driveId;
    this.writer = input.writer;
    this.plan = input.plan;
    this.settings = input.settings;
    this.logger = input.logger;
    this.pageUrl = input.plan.start.url ?? driveDeltaUrl(input.driveId);
    this.walkMode = input.plan.start.mode;
    this.deltaLink = input.plan.deltaLink;
    this.retryOverflow = input.plan.retryOverflow;
    this.lastCheckpointAt = this.now();

    for (const object of input.previous?.objects ?? []) {
      if (object.id !== undefined) {
        this.previousById.set(object.id, object);
      }
      this.pool.add(object);
    }
    this.tree = this.initialTree(input);
  }

  private initialTree(input: RunInput): DriveTree {
    const rootId = input.plan.rootId;
    if (input.resumed) {
      return DriveTree.fromObjects(input.writer.listObjects(), {
        rootId,
        deleted: input.resumedDeletions,
      });
    }
    if (input.plan.inheritPrevious && input.previous) {
      // With versions switched off, the versions stored earlier are not carried on.
      const keep = (object: ManifestObject) =>
        this.settings.includeVersions || object.type !== ONEDRIVE_OBJECT_TYPES.version;
      return DriveTree.fromObjects(input.previous.objects.filter(keep), { rootId });
    }
    return new DriveTree(rootId);
  }

  async execute(): Promise<BackupResult> {
    let outcome: DriveWalkOutcome;
    try {
      await this.retryPending();
      if (this.plan.walkDone) {
        outcome = this.finishedWalk();
      } else {
        outcome = await this.walk();
        this.deltaLink = outcome.deltaLink;
        this.walkMode = outcome.mode;
        // The walk is the expensive part: make its result durable before the
        // commit, so a failing commit resumes at the commit, not at page one.
        await this.checkpoint();
      }
    } catch (error) {
      await this.checkpointOnTheWayOut(error);
      throw error;
    }
    return this.commit(outcome);
  }

  private finishedWalk(): DriveWalkOutcome {
    if (this.deltaLink === null) {
      throw new Error("resume cursor claims a finished walk but carries no delta link");
    }
    return { mode: this.walkMode, deltaLink: this.deltaLink, pages: 0, items: 0 };
  }

  private now(): number {
    return this.ctx.now().getTime();
  }

  // -------------------------------------------------------------------------
  // Phases

  /** Fetch the items the previous run (or an earlier attempt) could not read. */
  private async retryPending(): Promise<void> {
    if (this.plan.retryIds.length === 0) {
      this.retriesDone = true;
      return;
    }
    this.ctx.progress.phase(ONEDRIVE_PHASES.retry);
    this.seen += this.plan.retryIds.length;
    this.ctx.progress.total(this.seen);
    for (const id of this.plan.retryIds) {
      this.throwIfAborted();
      let item: DriveDeltaItem;
      try {
        item = await getItem(this.client, this.driveId, id);
      } catch (error) {
        if (isNotFound(error)) {
          // Gone for good: the snapshot drops it, the previous snapshots keep it.
          this.forget(id);
        } else {
          this.recordFailure(id, this.knownPath(id), error);
        }
        continue;
      }
      await this.processItem(item, { retry: true });
      await this.maybeCheckpoint();
    }
    this.retriesDone = true;
  }

  private async walk(): Promise<DriveWalkOutcome> {
    this.ctx.progress.phase(
      this.plan.start.mode === "incremental" ? ONEDRIVE_PHASES.changes : ONEDRIVE_PHASES.enumerate,
    );
    const walker = walkDriveDelta({
      client: this.client,
      driveId: this.driveId,
      start: this.plan.start,
      onResync: (info) => {
        this.logger.warn("delta token expired (410), enumerating the drive again", {
          discardedPages: info.discardedPages,
        });
        this.pendingReset = true;
        this.ctx.progress.phase(ONEDRIVE_PHASES.resync);
      },
    });
    let skipThrough = this.plan.skipThroughItemId;

    for (;;) {
      const next = await walker.next();
      if (next.done) {
        return next.value;
      }
      const page = next.value;
      if (this.pendingReset) {
        this.pendingReset = false;
        skipThrough = undefined;
        this.restartEnumeration();
      }
      this.pageUrl = page.url;
      this.walkMode = page.mode;
      this.lastItemId = undefined;

      let items = page.items;
      if (skipThrough !== undefined) {
        const index = items.findIndex((item) => item.id === skipThrough);
        if (index !== -1) {
          items = items.slice(index + 1);
          this.lastItemId = skipThrough;
        }
        skipThrough = undefined;
      }
      // The root item is bookkeeping, not an object the user sees in the count.
      this.seen += items.filter((item) => classifyItem(item) !== "root").length;
      this.ctx.progress.total(this.seen);

      for (const item of items) {
        this.throwIfAborted();
        await this.processItem(item);
        this.lastItemId = item.id;
        await this.maybeCheckpoint();
      }
    }
  }

  /**
   * Everything assembled so far belongs to an enumeration Graph declared void.
   * The bytes stay usable: unchanged items of the new enumeration reuse them.
   */
  private restartEnumeration(): void {
    const dropped = this.tree.clear();
    for (const object of dropped) {
      this.pool.add(object);
    }
    this.logger.info("restarted the enumeration from scratch", { droppedObjects: dropped.length });
  }

  private async commit(outcome: DriveWalkOutcome): Promise<BackupResult> {
    const tree = this.tree.materialize({ cascadeDeletions: true });
    this.reportCollisions(tree.collisions);
    replaceObjects(this.writer, tree.objects);
    const changes = compareWithPrevious(this.previousById, tree.objects);

    const state: OneDriveManifestState = {
      engine: ENGINE_NAME,
      driveId: this.driveId,
      rootId: this.tree.rootId,
      deltaLink: outcome.deltaLink,
      mode: outcome.mode,
      retry: [...this.retryIds],
      fullResyncRequired: this.retryOverflow,
      versions: this.settings.includeVersions,
      completedAt: this.now(),
    };
    this.writer.setState(state as unknown as Record<string, unknown>);
    this.ctx.progress.phase(ONEDRIVE_PHASES.commit);
    const committed = await this.writer.commit();
    await this.ctx.cursor.clear();

    const bytes = this.writer.chunks.stats.bytesNew;
    this.logger.info("onedrive backup completed", {
      snapshotId: committed.snapshotId,
      sequence: committed.sequence,
      mode: outcome.mode,
      objectsTotal: committed.itemCount,
      objectsChanged: changes.changed,
      objectsRemoved: changes.removed,
      downloaded: this.downloaded,
      reused: this.reused,
      vanished: this.vanished,
      skipped: this.skipped,
      failures: this.failures.length,
      fullResyncRequired: this.retryOverflow,
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

  // -------------------------------------------------------------------------
  // Items

  private async processItem(
    item: DriveDeltaItem,
    options: { retry?: boolean } = {},
  ): Promise<void> {
    const kind = classifyItem(item);
    if (kind === "root") {
      this.tree.rootId = item.id;
      return;
    }
    if (kind === "deleted") {
      this.tree.remove(item.id);
      this.ctx.progress.advance(1);
      return;
    }
    if (kind === "unknown") {
      this.skipped++;
      this.logger.warn("item has no file, folder or shortcut facet, skipped", { itemId: item.id });
      this.ctx.progress.advance(1);
      return;
    }
    const placed = await this.place(item);
    if (!placed) {
      return;
    }
    const now = this.now();
    switch (kind) {
      case "folder":
        this.tree.put(folderObject(placed.item, placed.path, now), placed.placement);
        this.ctx.progress.advance(1);
        return;
      case "shortcut":
        this.tree.put(shortcutObject(placed.item, placed.path, now), placed.placement);
        this.ctx.progress.advance(1);
        return;
      case "file":
        await this.processFile(placed, options.retry === true);
        return;
    }
  }

  /**
   * Where an item lives. The delta entry's own path or its parent in the tree
   * normally answer that; when neither does (Graph sent a child before its
   * parent and without a path), the item is fetched once, which always
   * carries the path.
   */
  private async place(item: DriveDeltaItem): Promise<PlacedItem | null> {
    const name = item.name ?? "";
    if (name.length === 0) {
      this.recordFailure(
        item.id,
        item.id,
        incompleteItem("Graph returned the item without a name"),
      );
      return null;
    }
    const parentId = item.parentReference?.id ?? null;
    const path = graphPathOf(item) ?? this.pathBelow(parentId, name);
    if (path !== undefined) {
      return { item, path, placement: { parentId, name } };
    }

    let fresh: DriveDeltaItem;
    try {
      fresh = await getItem(this.client, this.driveId, item.id);
    } catch (error) {
      if (isNotFound(error)) {
        this.forget(item.id);
      } else {
        this.recordFailure(item.id, name, error);
      }
      return null;
    }
    const located: DriveDeltaItem = {
      ...item,
      name: fresh.name ?? name,
      parentReference: fresh.parentReference,
    };
    const freshPath = graphPathOf(located);
    if (freshPath === undefined) {
      this.recordFailure(item.id, name, incompleteItem("Graph did not report the item's folder"));
      return null;
    }
    return {
      item: located,
      path: freshPath,
      placement: { parentId: located.parentReference?.id ?? null, name: located.name ?? name },
    };
  }

  private pathBelow(parentId: string | null, name: string): string | undefined {
    if (parentId === null) {
      return undefined;
    }
    const parentPath = this.tree.pathOf(parentId);
    return parentPath === undefined ? undefined : joinPath(parentPath, name);
  }

  private async processFile(placed: PlacedItem, retry: boolean): Promise<void> {
    const { item, path, placement } = placed;
    const existing = this.tree.get(item.id) ?? this.pool.get(item.id);
    const now = this.now();

    if (existing !== undefined && canReuseContent(existing, item)) {
      this.tree.put(reusedFileObject(existing, item, path, now), placement);
      this.reused++;
      this.ctx.progress.advance(1);
      await this.versionsOfUnchanged(item, path, retry);
      return;
    }

    const fetched = await this.fetchContent(() =>
      openItemDownload(this.client, this.driveId, item),
    );
    if (!fetched.ok) {
      if (isItemGone(fetched.error)) {
        this.forget(item.id);
        return;
      }
      this.recordFailure(item.id, path, fetched.error);
      if (existing?.type === ONEDRIVE_OBJECT_TYPES.file) {
        this.tree.put(staleFileObject(existing, item, path, now), placement);
        this.carryVersions(item.id);
      }
      return;
    }

    const { content, contentType } = fetched;
    this.tree.put(fileObject(item, path, content, { now, contentType }), placement);
    this.downloaded++;
    this.bytesSinceCheckpoint += content.size;
    this.ctx.progress.advance(1, content.size);
    if (this.settings.includeVersions) {
      await this.collectVersions(item, path);
    }
  }

  /**
   * Download one stream into the chunk store. Failures on the source side come
   * back as a value for the caller to report; storage failures and
   * cancellation propagate and end the job.
   */
  private async fetchContent(open: () => Promise<ItemDownload>): Promise<FetchOutcome> {
    let download: ItemDownload;
    try {
      download = await open();
    } catch (error) {
      return { ok: false, error };
    }
    let content: WrittenObject;
    try {
      content = await this.writer.chunks.write(sourceBytes(download.stream));
    } catch (error) {
      if (error instanceof DownloadInterruptedError) {
        return { ok: false, error };
      }
      throw error;
    }
    if (download.contentLength !== null && download.contentLength !== content.size) {
      return { ok: false, error: new TruncatedDownloadError(download.contentLength, content.size) };
    }
    return { ok: true, content, contentType: download.contentType };
  }

  /** The item no longer exists at the source: drop it from this snapshot. */
  private forget(itemId: string): void {
    this.tree.remove(itemId);
    this.vanished++;
    this.ctx.progress.advance(1);
    this.logger.info("item no longer exists at the source", { itemId });
  }

  private knownPath(itemId: string): string {
    return this.tree.pathOf(itemId) ?? this.previousById.get(itemId)?.path ?? itemId;
  }

  // -------------------------------------------------------------------------
  // Versions (optional; docs/MICROSOFT.md: costly, off by default)

  /**
   * An unchanged file keeps the versions stored for it. They are listed again
   * only when versions were just switched on, or when the file is being
   * retried (a version may have been the part that failed).
   */
  private async versionsOfUnchanged(
    item: DriveDeltaItem,
    path: string,
    retry: boolean,
  ): Promise<void> {
    if (!this.settings.includeVersions) {
      return;
    }
    if (this.plan.backfillVersions || retry) {
      await this.collectVersions(item, path);
    } else {
      this.carryVersions(item.id);
    }
  }

  /** Versions stored earlier follow a file whose own entry was rebuilt (full run, resync, stale copy). */
  private carryVersions(itemId: string): void {
    if (!this.settings.includeVersions) {
      return;
    }
    for (const version of this.pool.versionsOf(itemId)) {
      const versionId = version.metadata?.versionId;
      if (version.id === undefined || versionId === undefined || this.tree.get(version.id)) {
        continue;
      }
      this.tree.put(version, { parentId: itemId, name: versionId });
    }
  }

  private async collectVersions(item: DriveDeltaItem, path: string): Promise<void> {
    let listed: DriveItemVersion[];
    try {
      listed = await collect(listItemVersions(this.client, this.driveId, item.id));
    } catch (error) {
      this.recordFailure(item.id, path, error, "listing versions");
      this.carryVersions(item.id);
      return;
    }

    const current = new Set<string>();
    for (const version of historicalVersions(listed)) {
      this.throwIfAborted();
      const id = versionObjectId(item.id, version.id);
      const placement: Placement = { parentId: item.id, name: version.id };
      const target = versionPath(path, version.id);
      current.add(id);
      const known = this.tree.get(id) ?? this.pool.get(id);
      if (known !== undefined && versionUnchanged(known, version)) {
        this.tree.put(known, placement);
        continue;
      }
      this.seen++;
      this.ctx.progress.total(this.seen);
      const fetched = await this.fetchContent(() =>
        openVersionDownload(this.client, this.driveId, item.id, version.id),
      );
      if (!fetched.ok) {
        this.recordFailure(item.id, target, fetched.error);
        if (known?.type === ONEDRIVE_OBJECT_TYPES.version) {
          this.tree.put(known, placement);
        }
        continue;
      }
      this.tree.put(versionObject(item, path, version, fetched.content, this.now()), placement);
      this.downloaded++;
      this.bytesSinceCheckpoint += fetched.content.size;
      this.ctx.progress.advance(1, fetched.content.size);
    }
    // Versions the source no longer lists (retention trimmed them) leave this
    // snapshot; earlier snapshots keep them.
    for (const stored of this.tree.versionsOf(item.id)) {
      if (stored.id !== undefined && !current.has(stored.id)) {
        this.tree.remove(stored.id);
      }
    }
  }

  // -------------------------------------------------------------------------
  // Failures, checkpoints, cancellation

  private recordFailure(itemId: string, itemRef: string, error: unknown, activity?: string): void {
    const described = describeFailure(error);
    const reason = activity === undefined ? described : `${activity}: ${described}`;
    const cause = classifyFailure(error);
    this.failures.push({ itemRef, reason, cause });
    this.ctx.progress.fail(itemRef, reason, cause);
    if (!this.retryIds.has(itemId)) {
      if (this.retryIds.size < this.settings.maxRetryIds) {
        this.retryIds.add(itemId);
      } else {
        this.retryOverflow = true;
      }
    }
    this.logger.warn("item failed", { itemId, itemRef, reason });
  }

  private reportCollisions(paths: readonly string[]): void {
    if (paths.length > 0) {
      this.logger.warn("several items claimed the same path; the latest was kept", {
        paths: paths.slice(0, 20),
        count: paths.length,
      });
    }
  }

  private cursor(): Omit<OneDriveCursor, "snapshot"> {
    return {
      engine: ENGINE_NAME,
      driveId: this.driveId,
      rootId: this.tree.rootId,
      mode: this.walkMode,
      pageUrl: this.pageUrl,
      lastItemId: this.lastItemId,
      deltaLink: this.deltaLink ?? undefined,
      retriesDone: this.retriesDone,
      retry: [...this.retryIds],
      retryOverflow: this.retryOverflow,
    };
  }

  private async checkpoint(): Promise<void> {
    const tree = this.tree.materialize({ cascadeDeletions: false });
    replaceObjects(this.writer, tree.objects);
    this.writer.setState(
      checkpointState(this.driveId, this.tree.deletedIds()) as unknown as Record<string, unknown>,
    );
    await this.writer.checkpoint(this.cursor());
    this.itemsSinceCheckpoint = 0;
    this.bytesSinceCheckpoint = 0;
    this.lastCheckpointAt = this.now();
  }

  private async maybeCheckpoint(): Promise<void> {
    this.itemsSinceCheckpoint++;
    const due =
      this.itemsSinceCheckpoint >= this.settings.checkpointEveryItems ||
      this.bytesSinceCheckpoint >= this.settings.checkpointEveryBytes;
    if (due && this.now() - this.lastCheckpointAt >= this.settings.checkpointMinIntervalMs) {
      await this.checkpoint();
    }
  }

  /**
   * Whatever ends the run early (cancellation, shutdown, a drive-level error)
   * leaves a checkpoint behind so the retry continues instead of starting over,
   * unless a pack was lost: the snapshot writer then refuses the checkpoint
   * (engine/snapshot.ts) and the retry resumes from the last good one. A
   * failing checkpoint must not mask the original error.
   */
  private async checkpointOnTheWayOut(cause: unknown): Promise<void> {
    const reason = cause instanceof JobAbortedError ? "aborted" : "failed";
    if (this.writer.chunks.failed) {
      this.logger.warn(`run ${reason} after a storage failure, keeping the last good checkpoint`, {
        error: describeFailure(cause),
      });
      return;
    }
    try {
      await this.checkpoint();
      this.logger.info(`run ${reason}, checkpoint saved`, {
        objects: this.tree.size,
        lastItemId: this.lastItemId,
      });
    } catch (error) {
      this.logger.error("could not save the checkpoint", { error: describeFailure(error) });
    }
  }

  private throwIfAborted(): void {
    if (this.ctx.signal.aborted) {
      throw new JobAbortedError();
    }
  }
}

/** Graph listed an item without what is needed to place it (its name or its folder). */
function incompleteItem(message: string): FailureError {
  return new FailureError(message, { code: "graph.item_incomplete", technical: { message } });
}
