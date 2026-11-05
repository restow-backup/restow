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
 * previous objects are carried forward (in a full read under the same
 * UIDVALIDITY those not read again yet; after a UIDVALIDITY change the
 * previous picture as a whole, so the restore point is never worse than the
 * last one); a dropped connection is re-opened. The
 * job checkpoints (packs, partial manifest, cursor) after every folder and
 * every few hundred messages, so a restarted worker resumes without
 * downloading anything it already stored.
 */
import { chunkDataStats, JobAbortedError } from "../../engine/chunkstore.js";
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
import { buildCause, classifyFailure, FailureError } from "../../failures/classify.js";
import type { FailureCause } from "../../failures/types.js";
import type { ManifestObject, SnapshotManifest } from "../../manifest.js";
import { CredentialSource, SessionPool } from "./connections.js";
import { MessageDedupIndex, type StoredContent } from "./dedup.js";
import { ReadWriteGate } from "./gate.js";
import { ImapFlowConnector } from "./imapflow-connector.js";
import type { FetchLike } from "./oauth2.js";
import {
  encodeEnvelope,
  encodeFlags,
  FOLDER_OBJECT_TYPE,
  folderComponents,
  folderObjectId,
  folderObjectPath,
  hasEnvelopeMetadata,
  isMessageObject,
  MESSAGE_OBJECT_TYPE,
  META,
  messageObjectId,
  messageObjectPath,
  objectMailbox,
  objectUid,
} from "./paths.js";
import {
  batchBySize,
  breakdownByUidNext,
  type FolderPlan,
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
  /**
   * Extra metadata FETCHes allowed per refused batch to find the messages the server cannot
   * read (bisection). Past it the server is taken to refuse the folder, not a message.
   */
  readonly metaIsolationCommands: number;
  readonly checkpointEveryMessages: number;
  readonly checkpointEveryBytes: number;
  /** Reconnects tolerated in one run before the job is failed (and resumed by the retry). */
  readonly maxReconnects: number;
}

export const DEFAULT_IMAP_LIMITS: ImapEngineLimits = {
  fetchBatchBytes: 32 * 1024 * 1024,
  fetchBatchMessages: 100,
  metaBatchMessages: 1000,
  metaIsolationCommands: 100,
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

  /**
   * Log in once and log out again: the weekly probe of an account an admin confirmed as shut
   * down (docs/IMAP.md). It takes the same way as a backup run (account resolution, the
   * transport rule, the credential source with OAuth2 token rotation, the connector) and opens
   * no folder. Throws what the connect throws: an {@link ImapAuthError} for a refused login.
   */
  async probeLogin(ctx: JobContext, protectedObject: ProtectedObjectRef): Promise<void> {
    const logger = ctx.logger.child({
      engine: "imap",
      protectedObjectId: protectedObject.id,
      account: protectedObject.externalId,
    });
    const account = await this.options.resolveAccount(ctx, protectedObject);
    assertTransport(account, this.options.allowInsecure === true);
    const credentials = new CredentialSource({
      secrets: ctx.secrets,
      account,
      fetch: this.options.fetch,
      onRefreshTokenRotated: this.options.onRefreshTokenRotated,
      logger,
    });
    const session = await this.connector.connect(account, await credentials.resolve(), {
      logger,
      signal: ctx.signal,
    });
    try {
      await session.logout();
    } catch (error) {
      logger.debug("imap logout failed", { error });
    }
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
      chunkStats: chunkDataStats(writer.chunks.stats),
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
  /** Plan and FLAGS listing of folders reconciled in this attempt (what a failure falls back to). */
  private readonly planned = new Map<
    string,
    { readonly plan: FolderPlan; readonly liveFlags: ReadonlyMap<number, readonly string[]> }
  >();
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
    this.dropUnlistedFromEarlierAttempt(folders);

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
        // Classified as what it is (connections lost, transient), with the last drop as the
        // cause for the log: a plain Error read as "cause not identified".
        throw new FailureError(
          `imap connection dropped ${this.reconnects} times in one run; giving up (the retry resumes from the checkpoint)`,
          { code: "imap.connection_lost", transient: true },
          { cause: error },
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
    this.planned.set(folder.path, { plan, liveFlags });

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
      metas = await this.fetchMetas(worker.session, uids, folder.path);
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
    const planned = this.planned.get(folder.path);
    if (this.reconciled.has(folder.path) && status && planned?.plan.mode === "full") {
      this.fullReadFailed(folder, status, planned.liveFlags);
    } else if (this.reconciled.has(folder.path) && status) {
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

  /**
   * A full read (requested, or after a UIDVALIDITY change) that failed after reconcile: it
   * carried nothing forward, so the folder would hold only what this attempt read. The
   * restore point must not be worse than the previous one.
   *
   *  - Same UIDVALIDITY as the previous snapshot (`full` requested): the previous objects
   *    whose UID was not read again and is still in the folder are carried forward with
   *    their current flags. The live state is kept only when that covers every live UID;
   *    otherwise the previous state stays and the next run plans the folder again.
   *  - UIDVALIDITY changed: the old objects cannot be mixed with the new UIDs (same paths,
   *    other messages). What this attempt stored for the folder is dropped and the previous
   *    picture is kept as it was, state included, so the next run reads it in full again.
   */
  private fullReadFailed(
    folder: ImapFolderInfo,
    status: ImapFolderStatus,
    liveFlags: ReadonlyMap<number, readonly string[]>,
  ): void {
    const previousState = this.previousState.imap.folders[folder.path];
    const previousObjects = this.previousByFolder.get(folder.path) ?? [];
    if (!previousState) {
      // A first backup: nothing older to fall back to; the next run fetches what is missing.
      this.folderState[folder.path] = folderStateOf(folder, status);
      return;
    }
    if (previousState.uidValidity !== status.uidValidity) {
      let dropped = 0;
      for (const object of this.writer.listObjects()) {
        if (objectMailbox(object) === folder.path && this.writer.remove(object.path)) {
          dropped++;
        }
      }
      for (const object of previousObjects) {
        this.writer.add(object);
      }
      this.folderState[folder.path] = previousState;
      this.logger.warn(
        "imap folder re-read after a UIDVALIDITY change failed, previous copy kept",
        {
          folder: folder.path,
          dropped,
          carried: previousObjects.length,
        },
      );
      return;
    }
    const components = folderComponents(folder);
    let carried = 0;
    for (const object of previousObjects) {
      if (!isMessageObject(object) || object.metadata?.[META.uidValidity] !== status.uidValidity) {
        continue;
      }
      const uid = objectUid(object);
      const flags = uid === null ? undefined : liveFlags.get(uid);
      if (uid === null || flags === undefined || this.writer.has(object.path)) {
        continue;
      }
      this.writer.add(withFlags(object, flags));
      carried++;
    }
    const covered = [...liveFlags.keys()].every((uid) =>
      this.writer.has(messageObjectPath(components, uid)),
    );
    this.writer.add(this.folderObject(folder, status, components));
    this.folderState[folder.path] = covered ? folderStateOf(folder, status) : previousState;
    this.logger.warn("imap folder full read failed, previous messages carried forward", {
      folder: folder.path,
      carried,
      covered,
    });
  }

  private logVanishedFolders(folders: readonly ImapFolderInfo[]): void {
    const listed = new Set(folders.map((folder) => folder.path));
    const vanished = Object.keys(this.previousState.imap.folders).filter(
      (path) => !listed.has(path),
    );
    if (vanished.length > 0) {
      this.logger.info(
        "imap folders no longer on the server, not in this restore point (older restore points keep them)",
        { folders: vanished },
      );
    }
  }

  /**
   * A resumed attempt starts from the partial manifest of the earlier one. A folder that
   * attempt completed or had begun, and that the server no longer lists (renamed or deleted
   * in between), would otherwise stay in the restore point next to its new name: a restore
   * would bring it back and duplicate every message of a renamed folder. Its objects, state
   * and cursor entries go, as for any folder that vanished between runs.
   */
  private dropUnlistedFromEarlierAttempt(folders: readonly ImapFolderInfo[]): void {
    const listed = new Set(folders.map((folder) => folder.path));
    const earlier = new Set([
      ...this.partialByFolder.keys(),
      ...this.completed,
      ...this.active.keys(),
      ...Object.keys(this.folderState),
    ]);
    const dropped: string[] = [];
    let objects = 0;
    for (const path of earlier) {
      if (listed.has(path)) {
        continue;
      }
      for (const object of this.partialByFolder.get(path) ?? []) {
        if (this.writer.remove(object.path)) {
          objects++;
        }
      }
      this.partialByFolder.delete(path);
      this.completed.delete(path);
      this.active.delete(path);
      delete this.folderState[path];
      dropped.push(path);
    }
    if (dropped.length > 0) {
      this.publishState();
      this.logger.info(
        "imap folder from an earlier attempt no longer listed, dropped from this restore point",
        { folders: dropped, objects },
      );
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
    const metas = await this.fetchMetas(worker.session, uids, folder.path);
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
      await this.dropExpunged(worker, folder, remaining);
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

  /**
   * Leave out of `remaining` the UIDs the folder no longer has: a long first backup of a
   * busy mailbox sees messages deleted or moved after the FLAGS snapshot, and those are not
   * a server fault. One `UID SEARCH UID <lowest>:*`; a UID still listed but not delivered
   * stays a failure (imap.message_missing). When the check itself fails they all stay.
   */
  private async dropExpunged(
    worker: FolderWorker,
    folder: ImapFolderInfo,
    remaining: Set<number>,
  ): Promise<void> {
    if (remaining.size === 0) {
      return;
    }
    let present: Set<number>;
    try {
      present = new Set(await worker.session.uidsAbove(Math.min(...remaining) - 1));
    } catch (error) {
      if (!isImapSessionError(error)) {
        throw error;
      }
      return;
    }
    let vanished = 0;
    for (const uid of [...remaining]) {
      if (!present.has(uid)) {
        remaining.delete(uid);
        vanished++;
      }
    }
    if (vanished > 0) {
      this.discoveredTotal = Math.max(0, this.discoveredTotal - vanished);
      this.ctx.progress.total(this.discoveredTotal);
      this.logger.info("imap messages expunged during the run, not counted as failures", {
        folder: folder.path,
        vanished,
      });
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
        const cause = classifyFailure(error, { role: "imap" });
        if (cause.code === "imap.server_limit") {
          // A download or command cap of the account: every further single FETCH (each after
          // a re-EXAMINE) only hits it again and records one failure per message. The folder
          // fails as a whole (transient) and the next run resumes from the checkpoint.
          throw error;
        }
        await this.reopenAfterError(worker, folder, status, error);
        this.itemFailed(components, uid, `fetch failed: ${error.message}`, cause);
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

  /**
   * Metadata of `uids`, slice by slice. Dovecot and Gmail refuse a whole UID FETCH with a NO
   * ("Some messages could not be FETCHed") when one message of the set cannot be read; such a
   * slice is split in halves until the unreadable UIDs are isolated, so they alone go without
   * metadata (the body FETCH then records each as an item failure) and the rest of the folder
   * is backed up. A dropped connection is rethrown (reconnect); a server that keeps refusing
   * past {@link ImapEngineLimits.metaIsolationCommands} refuses the folder, not a message.
   */
  private async fetchMetas(
    session: ImapSession,
    uids: readonly number[],
    folderPath?: string,
  ): Promise<Map<number, ImapMessageMeta>> {
    const metas = new Map<number, ImapMessageMeta>();
    const unreadable: number[] = [];
    for (let i = 0; i < uids.length; i += this.limits.metaBatchMessages) {
      this.throwIfStopping();
      const slice = uids.slice(i, i + this.limits.metaBatchMessages);
      try {
        for (const meta of await session.fetchMeta(slice)) {
          metas.set(meta.uid, meta);
        }
      } catch (error) {
        if (!isImapSessionError(error) || error.connectionLost) {
          throw error;
        }
        unreadable.push(...(await this.isolateUnreadable(session, slice, metas, error)));
      }
    }
    if (unreadable.length > 0) {
      this.logger.warn("imap messages whose metadata the server refuses, isolated", {
        folder: folderPath,
        uids: unreadable.slice(0, 50),
        count: unreadable.length,
      });
    }
    return metas;
  }

  /** Bisect a refused metadata slice; the UIDs that are refused on their own. */
  private async isolateUnreadable(
    session: ImapSession,
    slice: readonly number[],
    metas: Map<number, ImapMessageMeta>,
    refusal: ImapSessionError,
  ): Promise<number[]> {
    const unreadable: number[] = [];
    let budget = this.limits.metaIsolationCommands;
    const visit = async (part: readonly number[]): Promise<void> => {
      if (part.length === 0) {
        return;
      }
      this.throwIfStopping();
      if (budget-- <= 0) {
        throw refusal;
      }
      try {
        for (const meta of await session.fetchMeta(part)) {
          metas.set(meta.uid, meta);
        }
      } catch (error) {
        if (!isImapSessionError(error) || error.connectionLost) {
          throw error;
        }
        if (part.length === 1) {
          unreadable.push(part[0] as number);
          return;
        }
        await split(part);
      }
    };
    const split = async (part: readonly number[]): Promise<void> => {
      const middle = Math.ceil(part.length / 2);
      await visit(part.slice(0, middle));
      await visit(part.slice(middle));
    };
    if (slice.length === 1) {
      return [slice[0] as number];
    }
    await split(slice);
    return unreadable;
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
