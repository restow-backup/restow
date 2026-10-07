/**
 * IMAP backup engine (docs/IMAP.md).
 *
 * One run produces one snapshot of one IMAP account:
 *
 *   connect   -> resolve the credential (password or a fresh OAuth2 access
 *                token) and open the first session; TLS is mandatory.
 *   enumerate -> LIST with SPECIAL-USE, INBOX first, containers skipped.
 *   download  -> up to two sessions work through the folder queue. Per folder:
 *                EXAMINE, one FETCH 1:* (UID FLAGS), then a plan:
 *                  incremental  same UIDVALIDITY as the previous snapshot:
 *                               carry known messages forward (flags refreshed),
 *                               drop the ones whose UID is gone, download the
 *                               UIDs the previous snapshot does not hold.
 *                  full         first backup, `full` requested or UIDVALIDITY
 *                               changed: every message is read again. A message
 *                               whose Message-ID and SHA-256 match one stored
 *                               before reuses its chunks (./dedup.ts); anything
 *                               else still dedupes at chunk level, so nothing
 *                               is stored twice.
 *                Bodies are fetched with BODY.PEEK[] (never sets \Seen) in
 *                size-bounded batches and stored byte-exact.
 *   manifest  -> folder objects, per-folder UIDVALIDITY/UIDNEXT state, commit.
 *
 * Failures are scoped: a message the server does not return is recorded and
 * retried on the next run; a folder that keeps failing is recorded and its
 * previous objects are carried forward; a dropped connection is re-opened. The
 * job checkpoints (packs, partial manifest, cursor) after every folder and
 * every few hundred messages, so a restarted worker resumes without
 * downloading anything it already stored.
 */
import { JobAbortedError } from "../../engine/chunkstore.js";
import { SnapshotWriter } from "../../engine/snapshot.js";
import type {
  BackupEngine,
  BackupOptions,
  BackupResult,
  Cursor,
  ItemFailureRecord,
  JobContext,
  Logger,
  ProtectedObjectRef,
} from "../../engine/types.js";
import { buildCause, classifyFailure } from "../../failures/classify.js";
import type { FailureCause } from "../../failures/types.js";
import type { ManifestObject, SnapshotManifest } from "../../manifest.js";
import { CredentialSource, SessionPool } from "./connections.js";
import { MessageDedupIndex, type StoredContent } from "./dedup.js";
import { ReadWriteGate } from "./gate.js";
import { ImapFlowConnector } from "./imapflow-connector.js";
import type { FetchLike } from "./oauth2.js";
import {
  FOLDER_OBJECT_TYPE,
  MESSAGE_OBJECT_TYPE,
  META,
  encodeEnvelope,
  encodeFlags,
  folderComponents,
  folderObjectId,
  folderObjectPath,
  hasEnvelopeMetadata,
  isMessageObject,
  messageObjectId,
  messageObjectPath,
  objectMailbox,
  objectUid,
} from "./paths.js";
import {
  type FolderPlan,
  batchBySize,
  breakdownByUidNext,
  orderFolders,
  planFolder,
  readImapState,
  selectUidsToFetch,
} from "./planning.js";
import {
  type ImapAccountConfig,
  type ImapAccountResolver,
  type ImapActiveFolderCursor,
  ImapConfigError,
  type ImapConnector,
  type ImapCursor,
  type ImapEngineState,
  type ImapFolderInfo,
  type ImapFolderState,
  type ImapFolderStatus,
  type ImapMessageMeta,
  type ImapMessageSource,
  type ImapSession,
  ImapSessionError,
  isImapSessionError,
} from "./types.js";

export interface ImapEngineLimits {
  /** Upper bound on the summed RFC822.SIZE of one FETCH batch. */
  readonly fetchBatchBytes: number;
  readonly fetchBatchMessages: number;
  /** UIDs per metadata FETCH. */
  readonly metaBatchMessages: number;
  readonly checkpointEveryMessages: number;
  readonly checkpointEveryBytes: number;
  /** Reconnects tolerated in one run before the job is failed (and resumed by the retry). */
  readonly maxReconnects: number;
}

export const DEFAULT_IMAP_LIMITS: ImapEngineLimits = {
  fetchBatchBytes: 32 * 1024 * 1024,
  fetchBatchMessages: 100,
  metaBatchMessages: 1000,
  checkpointEveryMessages: 250,
  checkpointEveryBytes: 128 * 1024 * 1024,
  maxReconnects: 5,
};

export interface ImapBackupEngineOptions {
  /** Looks up host, port, security, login and secret for a protected object. */
  readonly resolveAccount: ImapAccountResolver;
  /** Defaults to the imapflow connector. */
  readonly connector?: ImapConnector;
  /** Permit `security: "none"` accounts (development only). */
  readonly allowInsecure?: boolean;
  /** At most 2 (docs/IMAP.md); lower it for servers that allow a single session. */
  readonly maxConnections?: number;
  /** Used for OAuth2 token refreshes. */
  readonly fetch?: FetchLike;
  /** Persist a rotated OAuth2 refresh token. */
  readonly onRefreshTokenRotated?: (secretId: string, secretJson: string) => Promise<void>;
  readonly limits?: Partial<ImapEngineLimits>;
}

export class ImapBackupEngine implements BackupEngine {
  readonly kind = "imap" as const;
  private readonly connector: ImapConnector;
  private readonly limits: ImapEngineLimits;

  constructor(private readonly options: ImapBackupEngineOptions) {
    this.connector = options.connector ?? new ImapFlowConnector();
    this.limits = { ...DEFAULT_IMAP_LIMITS, ...options.limits };
  }

  async run(
    ctx: JobContext,
    protectedObject: ProtectedObjectRef,
    options: BackupOptions,
  ): Promise<BackupResult> {
    const logger = ctx.logger.child({
      engine: "imap",
      protectedObjectId: protectedObject.id,
      account: protectedObject.externalId,
    });
    const account = await this.options.resolveAccount(ctx, protectedObject);
    assertTransport(account, this.options.allowInsecure === true);

    ctx.progress.phase("connect");
    const credentials = new CredentialSource({
      secrets: ctx.secrets,
      account,
      fetch: this.options.fetch,
      onRefreshTokenRotated: this.options.onRefreshTokenRotated,
      logger,
    });
    const pool = new SessionPool({
      connector: this.connector,
      account,
      credentials,
      logger,
      signal: ctx.signal,
      maxConnections: this.options.maxConnections,
    });

    const cursor = await ctx.cursor.load();
    const writer = await SnapshotWriter.begin(ctx, {
      protectedObject,
      sourceType: "imap",
      checkpoint: cursor?.snapshot,
    });
    const resumed =
      cursor?.snapshot && cursor.snapshot.snapshotId === writer.snapshotId
        ? readImapCursor(cursor)
        : emptyCursor();
    const previous = await writer.loadPreviousManifest();

    const run = new BackupRun({
      ctx,
      writer,
      pool,
      previous,
      resumed,
      full: options.full === true,
      logger,
      limits: this.limits,
    });
    try {
      await run.execute();
    } catch (error) {
      await run.preserveForRetry(error);
      throw error;
    } finally {
      await pool.closeAll();
    }

    ctx.progress.phase("manifest");
    const committed = await writer.commit();
    await ctx.cursor.clear();
    logger.info("imap backup finished", {
      snapshotId: committed.snapshotId,
      sequence: committed.sequence,
      objectsWritten: run.objectsWritten,
      objectsDeduplicated: run.objectsDeduplicated,
      objectsTotal: committed.itemCount,
      newBytes: writer.chunks.stats.bytesNew,
      failures: run.failures.length,
    });
    return {
      snapshotId: committed.snapshotId,
      sequence: committed.sequence,
      objectsWritten: run.objectsWritten,
      objectsTotal: committed.itemCount,
      bytes: writer.chunks.stats.bytesNew,
      failures: run.failures,
    };
  }
}

export function assertTransport(account: ImapAccountConfig, allowInsecure: boolean): void {
  if (account.security === "none" && !allowInsecure) {
    throw new ImapConfigError(
      `account ${account.username}@${account.host} has transport security "none"; TLS is required`,
    );
  }
}

// ---------------------------------------------------------------------------
// Cursor helpers
// ---------------------------------------------------------------------------

function emptyCursor(): ImapCursor {
  return { completed: [], active: {} };
}

/** The engine's part of a job cursor, tolerant of anything malformed. */
export function readImapCursor(cursor: Cursor): ImapCursor {
  const raw = cursor.imap;
  if (!raw || typeof raw !== "object") {
    return emptyCursor();
  }
  const { completed, active } = raw as { completed?: unknown; active?: unknown };
  const cleanCompleted = Array.isArray(completed)
    ? completed.filter((path): path is string => typeof path === "string")
    : [];
  const cleanActive: Record<string, ImapActiveFolderCursor> = {};
  if (active && typeof active === "object") {
    for (const [path, value] of Object.entries(active as Record<string, unknown>)) {
      const entry = value as { uidValidity?: unknown; lastUid?: unknown } | null;
      if (
        entry &&
        typeof entry.uidValidity === "string" &&
        typeof entry.lastUid === "number" &&
        Number.isInteger(entry.lastUid)
      ) {
        cleanActive[path] = { uidValidity: entry.uidValidity, lastUid: entry.lastUid };
      }
    }
  }
  return { completed: cleanCompleted, active: cleanActive };
}

// ---------------------------------------------------------------------------
// One run
// ---------------------------------------------------------------------------

interface BackupRunOptions {
  readonly ctx: JobContext;
  readonly writer: SnapshotWriter;
  readonly pool: SessionPool;
  readonly previous: SnapshotManifest | null;
  readonly resumed: ImapCursor;
  readonly full: boolean;
  readonly logger: Logger;
  readonly limits: ImapEngineLimits;
}

/** A worker owns one session and walks the shared folder queue. */
class FolderWorker {
  constructor(
    readonly index: number,
    public session: ImapSession,
  ) {}
}

class BackupRun {
  readonly failures: ItemFailureRecord[] = [];
  objectsWritten = 0;
  /** Of `objectsWritten`, how many reused the chunks of an identical stored message. */
  objectsDeduplicated = 0;

  private readonly ctx: JobContext;
  private readonly writer: SnapshotWriter;
  private readonly pool: SessionPool;
  private readonly logger: Logger;
  private readonly limits: ImapEngineLimits;
  private readonly full: boolean;
  private readonly gate = new ReadWriteGate();
  private readonly dedup: MessageDedupIndex;

  private readonly previousState: ImapEngineState;
  private readonly previousByFolder: Map<string, ManifestObject[]>;
  /** Objects a resumed partial manifest already holds, by folder; consumed as folders are (re)visited. */
  private readonly partialByFolder: Map<string, ManifestObject[]>;
  private readonly folderState: Record<string, ImapFolderState>;

  private readonly completed: Set<string>;
  private readonly active = new Map<string, ImapActiveFolderCursor>();
  /** EXAMINE results of folders opened in this attempt. */
  private readonly opened = new Map<string, ImapFolderStatus>();
  private readonly reconciled = new Set<string>();
  private readonly queue: ImapFolderInfo[] = [];

  private touched = false;
  private failure: unknown = null;
  private discoveredTotal = 0;
  private messagesSinceCheckpoint = 0;
  private bytesSinceCheckpoint = 0;
  private reconnects = 0;

  constructor(options: BackupRunOptions) {
    this.ctx = options.ctx;
    this.writer = options.writer;
    this.pool = options.pool;
    this.logger = options.logger;
    this.limits = options.limits;
    this.full = options.full;
    this.previousState = readImapState(options.previous?.state);
    this.previousByFolder = groupByFolder(options.previous?.objects ?? []);
    this.partialByFolder = groupByFolder(options.writer.listObjects());
    // Everything already committed or checkpointed is durable and safe to reference.
    this.dedup = MessageDedupIndex.fromObjects([
      ...(options.previous?.objects ?? []),
      ...options.writer.listObjects(),
    ]);
    this.folderState = { ...readImapState(options.writer.state).imap.folders };
    this.completed = new Set(options.resumed.completed);
    for (const [path, entry] of Object.entries(options.resumed.active)) {
      this.active.set(path, entry);
    }
    // A resumed run already has stored data worth keeping on the next failure.
    this.touched = this.completed.size > 0 || this.active.size > 0;
  }

  async execute(): Promise<void> {
    const firstSession = await this.pool.acquire();
    this.ctx.progress.phase("enumerate");
    const folders = orderFolders(await firstSession.listFolders());
    this.logVanishedFolders(folders);

    for (const folder of folders) {
      if (!this.completed.has(folder.path)) {
        this.queue.push(folder);
      }
    }
    this.logger.info("imap folders enumerated", {
      folders: folders.length,
      pending: this.queue.length,
      resumedCompleted: this.completed.size,
    });

    this.ctx.progress.phase("download");
    const workers = await this.openWorkers(firstSession);
    // Every worker stops at its next message boundary once one of them failed,
    // so the run ends with all sessions quiet and the checkpoint consistent.
    await Promise.allSettled(workers.map((worker) => this.drainQueue(worker)));
    if (this.failure !== null) {
      throw this.failure;
    }
  }

  /** On failure, keep whatever was stored so the retry resumes; discard an untouched snapshot. */
  async preserveForRetry(error: unknown): Promise<void> {
    const aborted = error instanceof JobAbortedError;
    this.logger[aborted ? "warn" : "error"](
      aborted ? "imap backup interrupted, checkpointing" : "imap backup failed, checkpointing",
      { error },
    );
    try {
      if (this.touched) {
        await this.checkpoint("failure");
      } else {
        await this.writer.abort();
      }
    } catch (checkpointError) {
      this.logger.error("checkpoint after failure did not succeed", { error: checkpointError });
    }
  }

  // -- workers ---------------------------------------------------------------

  private async openWorkers(firstSession: ImapSession): Promise<FolderWorker[]> {
    const wanted = Math.min(this.pool.maxConnections, this.queue.length);
    if (wanted === 0) {
      await this.pool.release(firstSession);
      return [];
    }
    const workers = [new FolderWorker(0, firstSession)];
    for (let index = 1; index < wanted; index++) {
      try {
        workers.push(new FolderWorker(index, await this.pool.acquire()));
      } catch (error) {
        // A server that allows fewer sessions than our budget is not an error; work with what we have.
        this.logger.warn("additional imap session refused, continuing with fewer", {
          sessions: workers.length,
          error,
        });
        break;
      }
    }
    return workers;
  }

  private async drainQueue(worker: FolderWorker): Promise<void> {
    const logger = this.logger.child({ worker: worker.index });
    try {
      for (;;) {
        this.throwIfStopping();
        const folder = this.queue.shift();
        if (!folder) {
          return;
        }
        await this.processFolderWithRetry(worker, folder);
      }
    } catch (error) {
      if (this.failure === null) {
        this.failure = error;
      } else if (!(error instanceof JobAbortedError)) {
        logger.warn("worker stopped after another failure", { error });
      }
      throw error;
    } finally {
      await this.pool.release(worker.session);
    }
  }

  private async processFolderWithRetry(
    worker: FolderWorker,
    folder: ImapFolderInfo,
  ): Promise<void> {
    const attempts = 2;
    for (let attempt = 1; attempt <= attempts; attempt++) {
      try {
        await this.processFolder(worker, folder);
        return;
      } catch (error) {
        if (!isImapSessionError(error)) {
          throw error;
        }
        await this.recoverSession(worker, error);
        if (attempt === attempts) {
          this.folderFailed(folder, error);
          return;
        }
        this.logger.warn("imap folder failed, retrying once", { folder: folder.path, error });
      }
    }
  }

  /** Replace a dead session; a live one just gets its folder closed. */
  private async recoverSession(worker: FolderWorker, error: ImapSessionError): Promise<void> {
    if (error.connectionLost || !worker.session.usable) {
      this.reconnects++;
      if (this.reconnects > this.limits.maxReconnects) {
        throw new Error(
          `imap connection dropped ${this.reconnects} times in one run; giving up (the retry resumes from the checkpoint)`,
        );
      }
      this.logger.warn("imap session lost, reconnecting", { reconnects: this.reconnects, error });
      await this.pool.release(worker.session);
      worker.session = await this.pool.acquire();
      return;
    }
    await this.closeFolderQuietly(worker);
  }

  // -- folders ---------------------------------------------------------------

  private async processFolder(worker: FolderWorker, folder: ImapFolderInfo): Promise<void> {
    const status = await worker.session.openFolder(folder.path);
    this.opened.set(folder.path, status);
    const previous = this.previousState.imap.folders[folder.path];
    const plan = planFolder(previous, status, { full: this.full });
    const resumeAfterUid = this.resumePoint(folder.path, status);
    const live = await worker.session.listFlags();
    const liveFlags = new Map(live.map((message) => [message.uid, message.flags]));
    const components = folderComponents(folder);

    const { known, deleted } = await this.reconcile(
      worker,
      folder,
      status,
      plan,
      liveFlags,
      components,
    );
    const toFetch = selectUidsToFetch(plan.mode, liveFlags.keys(), known, resumeAfterUid);
    this.discoveredTotal += toFetch.length;
    this.ctx.progress.total(this.discoveredTotal);
    this.active.set(folder.path, { uidValidity: status.uidValidity, lastUid: resumeAfterUid });
    this.logger.info("imap folder planned", {
      folder: folder.path,
      mode: plan.mode,
      reason: plan.reason,
      uidValidity: status.uidValidity,
      uidNext: status.uidNext,
      messages: status.exists,
      toFetch: toFetch.length,
      ...(plan.mode === "incremental" && previous
        ? breakdownByUidNext(toFetch, previous.uidNext)
        : {}),
      carried: known.size,
      deleted,
      resumeAfterUid,
    });

    await this.downloadAll(worker, folder, status, components, toFetch);

    this.writer.add(this.folderObject(folder, status, components));
    this.folderState[folder.path] = folderStateOf(folder, status);
    this.publishState();
    this.active.delete(folder.path);
    this.completed.add(folder.path);
    this.touched = true;
    await this.closeFolderQuietly(worker);
    await this.checkpoint("folder");
  }

  /** Where a checkpointed earlier attempt stopped in this folder, if the UIDs still mean the same thing. */
  private resumePoint(path: string, status: ImapFolderStatus): number {
    const entry = this.active.get(path);
    return entry && entry.uidValidity === status.uidValidity ? entry.lastUid : 0;
  }

  /**
   * Bring the manifest in line with the folder as it is now, before any
   * download: stale objects from an earlier attempt go, deleted messages go,
   * unchanged messages are carried forward with their current flags. Returns
   * the UIDs the snapshot already covers and how many messages the server no
   * longer has (older snapshots keep them).
   */
  private async reconcile(
    worker: FolderWorker,
    folder: ImapFolderInfo,
    status: ImapFolderStatus,
    plan: FolderPlan,
    liveFlags: ReadonlyMap<number, readonly string[]>,
    components: readonly string[],
  ): Promise<{ known: Set<number>; deleted: number }> {
    this.purgeStale(folder.path, status.uidValidity);

    const known = new Set<number>();
    const needsEnvelope: number[] = [];
    let deleted = 0;
    if (plan.mode === "incremental") {
      for (const object of this.previousByFolder.get(folder.path) ?? []) {
        if (
          !isMessageObject(object) ||
          object.metadata?.[META.uidValidity] !== status.uidValidity
        ) {
          continue;
        }
        const uid = objectUid(object);
        const flags = uid === null ? undefined : liveFlags.get(uid);
        if (uid === null || flags === undefined) {
          this.writer.remove(object.path);
          deleted++;
          continue;
        }
        this.writer.add(withFlags(object, flags));
        known.add(uid);
        if (!hasEnvelopeMetadata(object)) {
          needsEnvelope.push(uid);
        }
      }
    }
    this.reconciled.add(folder.path);
    if (needsEnvelope.length > 0) {
      await this.backfillEnvelopes(worker, folder, components, needsEnvelope);
    }
    return { known, deleted };
  }

  /**
   * Carried-forward messages stored before this backup recorded envelope
   * metadata (subject, from, to, cc, ...) get it through a metadata-only
   * FETCH here: no body download, no new chunks, so an existing mailbox shows
   * subjects after one more incremental backup. Only the restore point being
   * written changes; older, already-sealed manifests keep their old metadata
   * (docs/ARCHITECTURE.md: manifests are immutable once committed).
   */
  private async backfillEnvelopes(
    worker: FolderWorker,
    folder: ImapFolderInfo,
    components: readonly string[],
    uids: readonly number[],
  ): Promise<void> {
    let metas: Map<number, ImapMessageMeta>;
    try {
      metas = await this.fetchMetas(worker.session, uids);
    } catch (error) {
      if (!isImapSessionError(error)) {
        throw error;
      }
      if (error.connectionLost) {
        // A dead session must not carry into the next folder; let processFolderWithRetry
        // reconnect (and re-attempt this same backfill) instead of pretending it is done.
        throw error;
      }
      // A command-level refusal, not a failure of the message itself (it backed up fine
      // before and still does): the next run's reconcile sees the same objects still
      // lacking envelope metadata and tries again.
      this.logger.warn("imap envelope backfill failed, retrying on a later run", {
        folder: folder.path,
        messages: uids.length,
        error,
      });
      return;
    }
    let backfilled = 0;
    for (const [uid, meta] of metas) {
      if (!meta.envelope) {
        continue;
      }
      const path = messageObjectPath(components, uid);
      const object = this.writer.get(path);
      if (!object) {
        continue;
      }
      this.writer.add({
        ...object,
        metadata: { ...object.metadata, ...encodeEnvelope(meta.envelope) },
      });
      backfilled++;
    }
    if (backfilled > 0) {
      this.logger.info("imap envelope metadata backfilled", { folder: folder.path, backfilled });
      this.touched = true;
    }
  }

  /**
   * Objects an earlier attempt stored for this folder under another
   * UIDVALIDITY describe messages that no longer exist under those UIDs. The
   * partial manifest's objects are known up front; objects added earlier in
   * this very attempt need a scan, which only happens when the validity moved.
   */
  private purgeStale(folderPath: string, uidValidity: string): void {
    const fromPartial = this.partialByFolder.get(folderPath);
    this.partialByFolder.delete(folderPath);
    const previousAttempt = this.active.get(folderPath);
    const movedWithinRun =
      previousAttempt !== undefined && previousAttempt.uidValidity !== uidValidity;
    const candidates =
      fromPartial ??
      (movedWithinRun
        ? this.writer.listObjects().filter((object) => objectMailbox(object) === folderPath)
        : []);
    let purged = 0;
    for (const object of candidates) {
      if (object.metadata?.[META.uidValidity] !== uidValidity && this.writer.remove(object.path)) {
        purged++;
      }
    }
    if (purged > 0) {
      this.logger.info("imap objects from a previous attempt discarded (UIDVALIDITY changed)", {
        folder: folderPath,
        purged,
      });
    }
  }

  private folderFailed(folder: ImapFolderInfo, error: ImapSessionError): void {
    const reason = `folder could not be read: ${error.message}`;
    const cause = classifyFailure(error, { role: "imap" });
    this.failures.push({ itemRef: folder.path, reason, cause });
    this.ctx.progress.fail(folder.path, reason, cause);
    this.logger.error("imap folder failed", { folder: folder.path, error });

    const status = this.opened.get(folder.path);
    if (this.reconciled.has(folder.path) && status) {
      // Reconciled against the live folder: what was not downloaded is absent and retried next run.
      this.folderState[folder.path] = folderStateOf(folder, status);
    } else if (this.partialByFolder.has(folder.path)) {
      // An earlier attempt of this run already reconciled it; its objects are in the partial manifest.
      this.partialByFolder.delete(folder.path);
      this.logger.warn("imap folder kept as stored by the previous attempt", {
        folder: folder.path,
      });
    } else {
      // Never seen this run: keep the last known good picture of the folder.
      let carried = 0;
      for (const object of this.previousByFolder.get(folder.path) ?? []) {
        this.writer.add(object);
        carried++;
      }
      const previous = this.previousState.imap.folders[folder.path];
      if (previous) {
        this.folderState[folder.path] = previous;
      }
      this.logger.warn("imap folder carried forward unchanged", { folder: folder.path, carried });
    }
    this.publishState();
    this.active.delete(folder.path);
    this.completed.add(folder.path);
  }

  private logVanishedFolders(folders: readonly ImapFolderInfo[]): void {
    const listed = new Set(folders.map((folder) => folder.path));
    const vanished = Object.keys(this.previousState.imap.folders).filter(
      (path) => !listed.has(path),
    );
    if (vanished.length > 0) {
      this.logger.info("imap folders no longer on the server; their messages leave the snapshot", {
        folders: vanished,
      });
    }
  }

  // -- downloads -------------------------------------------------------------

  private async downloadAll(
    worker: FolderWorker,
    folder: ImapFolderInfo,
    status: ImapFolderStatus,
    components: readonly string[],
    uids: readonly number[],
  ): Promise<void> {
    if (uids.length === 0) {
      return;
    }
    const metas = await this.fetchMetas(worker.session, uids);
    const ordered: Pick<ImapMessageMeta, "uid" | "size">[] = uids.map(
      (uid) => metas.get(uid) ?? { uid, size: 0 },
    );
    const batches = batchBySize(ordered, {
      maxBytes: this.limits.fetchBatchBytes,
      maxMessages: this.limits.fetchBatchMessages,
    });

    for (const batch of batches) {
      this.throwIfStopping();
      const remaining = new Set(batch);
      try {
        await this.consume(
          worker.session.fetchSources(batch),
          folder,
          status,
          components,
          remaining,
          metas,
        );
      } catch (error) {
        if (!isImapSessionError(error)) {
          throw error;
        }
        this.logger.warn("imap batch fetch failed, retrying the rest one by one", {
          folder: folder.path,
          remaining: remaining.size,
          error,
        });
        await this.reopenAfterError(worker, folder, status, error);
        await this.downloadSingly(worker, folder, status, components, remaining, metas);
      }
      for (const uid of remaining) {
        this.itemFailed(
          components,
          uid,
          "message not returned by the server",
          buildCause(
            "imap.message_missing",
            {},
            { message: "message not returned by the server", path: folder.path },
          ),
        );
      }
    }
  }

  private async downloadSingly(
    worker: FolderWorker,
    folder: ImapFolderInfo,
    status: ImapFolderStatus,
    components: readonly string[],
    remaining: Set<number>,
    metas: ReadonlyMap<number, ImapMessageMeta>,
  ): Promise<void> {
    for (const uid of [...remaining].sort((a, b) => a - b)) {
      this.throwIfStopping();
      const single = new Set([uid]);
      try {
        await this.consume(
          worker.session.fetchSources([uid]),
          folder,
          status,
          components,
          single,
          metas,
        );
      } catch (error) {
        if (!isImapSessionError(error)) {
          throw error;
        }
        await this.reopenAfterError(worker, folder, status, error);
        this.itemFailed(
          components,
          uid,
          `fetch failed: ${error.message}`,
          classifyFailure(error, { role: "imap" }),
        );
        remaining.delete(uid);
        continue;
      }
      if (single.size === 0) {
        remaining.delete(uid);
      }
    }
  }

  /** Reconnect if needed and re-EXAMINE the folder; a UIDVALIDITY that moved mid-run restarts the folder. */
  private async reopenAfterError(
    worker: FolderWorker,
    folder: ImapFolderInfo,
    status: ImapFolderStatus,
    error: ImapSessionError,
  ): Promise<void> {
    await this.recoverSession(worker, error);
    const reopened = await worker.session.openFolder(folder.path);
    if (reopened.uidValidity !== status.uidValidity) {
      throw new ImapSessionError(
        `UIDVALIDITY of ${folder.path} changed during the run (${status.uidValidity} -> ${reopened.uidValidity})`,
        false,
      );
    }
  }

  private async fetchMetas(
    session: ImapSession,
    uids: readonly number[],
  ): Promise<Map<number, ImapMessageMeta>> {
    const metas = new Map<number, ImapMessageMeta>();
    for (let i = 0; i < uids.length; i += this.limits.metaBatchMessages) {
      this.throwIfStopping();
      const slice = uids.slice(i, i + this.limits.metaBatchMessages);
      for (const meta of await session.fetchMeta(slice)) {
        metas.set(meta.uid, meta);
      }
    }
    return metas;
  }

  /**
   * Store each message the server returns; `remaining` shrinks as UIDs arrive.
   * `fetchSources` no longer asks for the envelope itself (redundant with the
   * `fetchMeta` call `downloadAll` already made for these same UIDs, see
   * imapflow-connector.ts), so `metas` supplies Message-ID and envelope here.
   */
  private async consume(
    messages: AsyncIterable<ImapMessageSource>,
    folder: ImapFolderInfo,
    status: ImapFolderStatus,
    components: readonly string[],
    remaining: Set<number>,
    metas: ReadonlyMap<number, ImapMessageMeta>,
  ): Promise<void> {
    for await (const message of messages) {
      this.throwIfStopping();
      if (!remaining.has(message.uid)) {
        continue;
      }
      const meta = metas.get(message.uid);
      const withMeta: ImapMessageSource = {
        ...message,
        messageId: meta?.messageId ?? message.messageId,
        envelope: meta?.envelope ?? message.envelope,
      };
      await this.gate.shared(async () => {
        const content = await this.store(withMeta);
        this.writer.add(this.messageObject(folder, status, components, withMeta, content));
        this.noteStored(folder.path, message.uid, message.source.length);
      });
      remaining.delete(message.uid);
      await this.maybeCheckpoint();
    }
  }

  /** Reuse the chunks of an identical stored message, or write the bytes. */
  private async store(message: ImapMessageSource): Promise<StoredContent> {
    const reused = this.dedup.find(message.messageId, message.source);
    if (reused) {
      this.objectsDeduplicated++;
      return reused;
    }
    const written = await this.writer.chunks.write(message.source);
    this.dedup.remember(message.messageId, written);
    return written;
  }

  private noteStored(folderPath: string, uid: number, bytes: number): void {
    const entry = this.active.get(folderPath);
    if (entry && uid > entry.lastUid) {
      this.active.set(folderPath, { uidValidity: entry.uidValidity, lastUid: uid });
    }
    this.objectsWritten++;
    this.touched = true;
    this.messagesSinceCheckpoint++;
    this.bytesSinceCheckpoint += bytes;
    this.ctx.progress.advance(1, bytes);
  }

  private itemFailed(
    components: readonly string[],
    uid: number,
    reason: string,
    cause?: FailureCause,
  ): void {
    const itemRef = messageObjectPath(components, uid);
    this.failures.push(cause ? { itemRef, reason, cause } : { itemRef, reason });
    this.ctx.progress.fail(itemRef, reason, cause);
  }

  // -- manifest objects ------------------------------------------------------

  private messageObject(
    folder: ImapFolderInfo,
    status: ImapFolderStatus,
    components: readonly string[],
    message: ImapMessageSource,
    content: StoredContent,
  ): ManifestObject {
    const metadata: Record<string, string> = {
      [META.mailbox]: folder.path,
      [META.delimiter]: folder.delimiter,
      [META.uid]: String(message.uid),
      [META.uidValidity]: status.uidValidity,
      [META.flags]: encodeFlags(message.flags),
      [META.reportedSize]: String(message.size),
    };
    if (folder.specialUse) {
      metadata[META.specialUse] = folder.specialUse;
    }
    if (message.internalDate) {
      metadata[META.internalDate] = message.internalDate.toISOString();
    }
    if (message.messageId) {
      metadata[META.messageId] = message.messageId;
    }
    if (message.envelope) {
      Object.assign(metadata, encodeEnvelope(message.envelope));
    }
    return {
      path: messageObjectPath(components, message.uid),
      id: messageObjectId(folder.path, status.uidValidity, message.uid),
      type: MESSAGE_OBJECT_TYPE,
      size: content.size,
      mtime: message.internalDate?.getTime() ?? this.ctx.now().getTime(),
      sha256: content.sha256,
      metadata,
      chunks: [...content.chunks],
    };
  }

  private folderObject(
    folder: ImapFolderInfo,
    status: ImapFolderStatus,
    components: readonly string[],
  ): ManifestObject {
    const metadata: Record<string, string> = {
      [META.mailbox]: folder.path,
      [META.delimiter]: folder.delimiter,
      [META.uidValidity]: status.uidValidity,
    };
    if (folder.specialUse) {
      metadata[META.specialUse] = folder.specialUse;
    }
    return {
      path: folderObjectPath(components),
      id: folderObjectId(folder.path, status.uidValidity),
      type: FOLDER_OBJECT_TYPE,
      size: 0,
      mtime: this.ctx.now().getTime(),
      metadata,
      chunks: [],
    };
  }

  private publishState(): void {
    const state: ImapEngineState = { imap: { version: 1, folders: { ...this.folderState } } };
    this.writer.setState(state as unknown as Record<string, unknown>);
  }

  // -- checkpoints -----------------------------------------------------------

  private cursor(): Omit<Cursor, "snapshot"> {
    const imap: ImapCursor = {
      completed: [...this.completed],
      active: Object.fromEntries(this.active),
    };
    const first = [...this.active.entries()][0];
    return {
      ...(first ? { folderId: first[0], lastItemId: String(first[1].lastUid) } : {}),
      imap,
    };
  }

  private async maybeCheckpoint(): Promise<void> {
    if (this.checkpointDue()) {
      await this.checkpoint("interval");
    }
  }

  private checkpointDue(): boolean {
    return (
      this.messagesSinceCheckpoint >= this.limits.checkpointEveryMessages ||
      this.bytesSinceCheckpoint >= this.limits.checkpointEveryBytes
    );
  }

  private async checkpoint(reason: "interval" | "folder" | "failure"): Promise<void> {
    await this.gate.exclusive(async () => {
      if (reason === "interval" && !this.checkpointDue()) {
        return; // another worker just checkpointed
      }
      await this.writer.checkpoint(this.cursor());
      this.messagesSinceCheckpoint = 0;
      this.bytesSinceCheckpoint = 0;
      this.logger.debug("imap checkpoint", { reason, completed: this.completed.size });
    });
  }

  private async closeFolderQuietly(worker: FolderWorker): Promise<void> {
    try {
      await worker.session.closeFolder();
    } catch (error) {
      this.logger.debug("could not close folder", { error });
    }
  }

  /** Cancellation and a failure in a sibling worker both end this worker at the next boundary. */
  private throwIfStopping(): void {
    if (this.ctx.signal.aborted || this.failure !== null) {
      throw new JobAbortedError();
    }
  }
}

// ---------------------------------------------------------------------------
// Small helpers
// ---------------------------------------------------------------------------

function folderStateOf(folder: ImapFolderInfo, status: ImapFolderStatus): ImapFolderState {
  return {
    uidValidity: status.uidValidity,
    uidNext: status.uidNext,
    delimiter: folder.delimiter,
    ...(folder.specialUse ? { specialUse: folder.specialUse } : {}),
    messages: status.exists,
  };
}

function groupByFolder(objects: readonly ManifestObject[]): Map<string, ManifestObject[]> {
  const groups = new Map<string, ManifestObject[]>();
  for (const object of objects) {
    const folder = objectMailbox(object);
    if (folder === undefined) {
      continue;
    }
    const group = groups.get(folder);
    if (group) {
      group.push(object);
    } else {
      groups.set(folder, [object]);
    }
  }
  return groups;
}

/** The same object with its flags brought up to date (a new object only when they changed). */
function withFlags(object: ManifestObject, flags: readonly string[]): ManifestObject {
  const encoded = encodeFlags(flags);
  if (object.metadata?.[META.flags] === encoded) {
    return object;
  }
  return { ...object, metadata: { ...object.metadata, [META.flags]: encoded } };
}
