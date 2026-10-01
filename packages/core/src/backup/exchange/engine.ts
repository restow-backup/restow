/**
 * ExchangeBackupEngine: the `mailbox` backup engine (mail, calendar, contacts)
 * over Microsoft Graph.
 *
 * One run produces one snapshot of one mailbox. It carries the previous
 * snapshot's objects forward, applies the per-folder message delta, lists
 * calendars and contacts, fetches only content whose fingerprint changed, and
 * commits a manifest whose `state` holds the delta links for the next run.
 * Checkpoints after every folder (and every N items or bytes) let a restarted
 * job resume from the job cursor without fetching anything it already stored.
 *
 * Graph calls within one mailbox are made one at a time: the throttling budget
 * is per mailbox (docs/MICROSOFT.md), so the worker parallelises across
 * mailboxes instead, and the Graph client handles 429/Retry-After.
 *
 * The engine never talks to Postgres or the environment: the Graph client is
 * obtained through the injected {@link ExchangeGraphClientFactory} (the worker
 * builds it from the source's Entra tenant and the app credentials), everything
 * else comes from the JobContext (engine/types.ts).
 */
import { JobAbortedError } from "../../engine/chunkstore.js";
import { SnapshotWriter } from "../../engine/snapshot.js";
import type {
  BackupEngine,
  BackupOptions,
  BackupResult,
  JobContext,
  ProtectedObjectRef,
} from "../../engine/types.js";
import type { GraphClient } from "../../graph/client.js";
import { type InstanceWindow, defaultInstanceWindow } from "../../graph/resources/calendar.js";
import type { WellKnownFolderName } from "../../graph/resources/mail.js";
import { backupCalendar } from "./calendar.js";
import { backupContacts } from "./contacts.js";
import { folderObjectAt } from "./folders.js";
import { DEFAULT_SKIPPED_FOLDERS, type MailPhaseOptions, backupMail } from "./mail.js";
import { CALENDAR_ROOT, CONTACTS_ROOT, MAIL_ROOT } from "./paths.js";
import { BackupRun, EXCHANGE_PHASES, META, type RunCounters, isMailboxAccessError } from "./run.js";
import {
  type ExchangeState,
  MAIL_SELECT_VERSION,
  parseCursor,
  readState,
  serializeState,
} from "./state.js";

/** Builds (or looks up) the throttled Graph client for a protected object's Entra tenant. */
export type ExchangeGraphClientFactory<Db = unknown> = (
  ctx: JobContext<Db>,
  protectedObject: ProtectedObjectRef,
) => Promise<GraphClient> | GraphClient;

export interface ExchangeBackupEngineOptions<Db = unknown> {
  readonly graph: ExchangeGraphClientFactory<Db>;
  /** Back up hidden mail folders too (default true; the backup wants everything). */
  readonly includeHiddenFolders?: boolean;
  /** Well-known folders (and their subtrees) to leave out; default: search folders. */
  readonly skipWellKnownFolders?: Iterable<WellKnownFolderName>;
  /** Requested delta page size (Graph caps it at 200). */
  readonly deltaPageSize?: number;
  /** Instance window for series exceptions; defaults to one year back, two ahead of `ctx.now()`. */
  readonly calendarWindow?: (now: Date) => InstanceWindow;
  readonly includeCalendar?: boolean;
  readonly includeContacts?: boolean;
  /** Checkpoint after this many items (default 250) ... */
  readonly checkpointEveryItems?: number;
  /** ... or this many plaintext bytes (default 256 MiB), whichever comes first. */
  readonly checkpointEveryBytes?: number;
  readonly maxPackBytes?: number;
  /** Injectable id generators (tests pin them). */
  readonly snapshotIdGenerator?: () => string;
  readonly packIdGenerator?: () => string;
}

export const DEFAULT_EXCHANGE_CHECKPOINT_ITEMS = 250;
export const DEFAULT_EXCHANGE_CHECKPOINT_BYTES = 256 * 1024 * 1024;
const MAX_DELTA_PAGE_SIZE = 200;

/** The result of a run, extended with the engine's own per-item counters for logs and tests. */
export interface ExchangeBackupResult extends BackupResult {
  readonly resumed: boolean;
  readonly counters: Readonly<RunCounters>;
}

export class ExchangeBackupEngine<Db = unknown> implements BackupEngine<Db> {
  readonly kind = "mailbox" as const;
  private readonly mailOptions: MailPhaseOptions;

  constructor(private readonly options: ExchangeBackupEngineOptions<Db>) {
    this.mailOptions = {
      includeHiddenFolders: options.includeHiddenFolders ?? true,
      skipWellKnownFolders: new Set(options.skipWellKnownFolders ?? DEFAULT_SKIPPED_FOLDERS),
      deltaPageSize: Math.min(
        MAX_DELTA_PAGE_SIZE,
        Math.max(1, options.deltaPageSize ?? MAX_DELTA_PAGE_SIZE),
      ),
    };
  }

  async run(
    ctx: JobContext<Db>,
    protectedObject: ProtectedObjectRef,
    options: BackupOptions = {},
  ): Promise<ExchangeBackupResult> {
    if (protectedObject.kind !== "mailbox") {
      throw new Error(
        `ExchangeBackupEngine handles mailboxes, not ${protectedObject.kind} (${protectedObject.id})`,
      );
    }
    const logger = ctx.logger.child({
      component: "exchange-backup",
      protectedObjectId: protectedObject.id,
    });
    const full = options.full === true;
    const client = await this.options.graph(ctx, protectedObject);
    const cursor = parseCursor(await ctx.cursor.load());

    const writer = await SnapshotWriter.begin(ctx, {
      protectedObject,
      sourceType: "m365",
      checkpoint: cursor.checkpoint,
      maxPackBytes: this.options.maxPackBytes,
      snapshotIdGenerator: this.options.snapshotIdGenerator,
      packIdGenerator: this.options.packIdGenerator,
    });
    const resumed =
      cursor.checkpoint !== undefined && cursor.checkpoint.snapshotId === writer.snapshotId;

    const run = new BackupRun({
      ctx,
      client,
      userId: protectedObject.externalId,
      writer,
      full,
      state: await this.initialState(writer, resumed, full),
      progress: resumed
        ? cursor.progress
        : { completedFolders: [], calendarDone: false, contactsDone: false },
      deltaTokens: resumed ? cursor.deltaTokens : {},
      checkpoints: {
        everyItems: Math.max(
          1,
          this.options.checkpointEveryItems ?? DEFAULT_EXCHANGE_CHECKPOINT_ITEMS,
        ),
        everyBytes: Math.max(
          1,
          this.options.checkpointEveryBytes ?? DEFAULT_EXCHANGE_CHECKPOINT_BYTES,
        ),
      },
    });
    logger.info("mailbox backup started", {
      sequence: writer.sequence,
      resumed,
      full,
      inherited: writer.objectCount,
      completedFolders: run.progress.completedFolders.length,
    });

    try {
      addRootFolders(run);
      await backupMail(run, this.mailOptions);
      if (this.options.includeCalendar ?? true) {
        await backupCalendar(run, {
          window: (this.options.calendarWindow ?? defaultInstanceWindow)(ctx.now()),
        });
      }
      if (this.options.includeContacts ?? true) {
        await backupContacts(run);
      }

      run.report(EXCHANGE_PHASES.commit);
      writer.setState(serializeState(run.state));
      const committed = await writer.commit();
      await ctx.cursor.clear();
      await ctx.progress.flush();

      const result: ExchangeBackupResult = {
        snapshotId: committed.snapshotId,
        sequence: committed.sequence,
        objectsWritten: run.counters.written + run.counters.updated,
        objectsTotal: committed.itemCount,
        bytes: writer.chunks.stats.bytesNew,
        failures: [...run.failures],
        resumed,
        counters: { ...run.counters },
      };
      logger.info("mailbox backup committed", {
        sequence: result.sequence,
        objects: result.objectsTotal,
        ...run.counters,
        newBytes: result.bytes,
      });
      return result;
    } catch (error) {
      if (isMailboxAccessError(error)) {
        // Nothing of this run is worth keeping: no consent, excluded by policy, no mailbox.
        logger.error("mailbox is not accessible, snapshot abandoned", { error });
        await writer.abort();
        await ctx.cursor.clear();
        throw error;
      }
      // Cancellation, shutdown, throttling beyond retries, storage trouble: keep the
      // position so the next attempt continues where this one stopped.
      const reason = error instanceof JobAbortedError ? "aborted" : "failed";
      logger.warn(`mailbox backup ${reason}, checkpointing`, { error });
      try {
        await run.checkpoint();
      } catch (checkpointError) {
        logger.error("checkpoint after failure did not succeed", { error: checkpointError });
      }
      throw error;
    }
  }

  /**
   * The state a run starts from: the partial's own state when resuming, the
   * previous snapshot's otherwise (with its objects carried forward). A `full`
   * run forgets the delta links so every folder is enumerated from scratch,
   * but still inherits the objects so a failed item keeps its last good copy.
   * An installation upgrade that changed the mail delta `$select` does the
   * same, once, for whichever links predate it (state.ts MAIL_SELECT_VERSION):
   * otherwise Graph would keep replaying the old `$select` from those stored
   * links forever and the new properties would never appear.
   */
  private async initialState(
    writer: SnapshotWriter,
    resumed: boolean,
    full: boolean,
  ): Promise<ExchangeState> {
    if (resumed) {
      return readState(writer.state);
    }
    const previous = await writer.loadPreviousManifest();
    if (!previous) {
      return readState(undefined);
    }
    writer.inherit(previous);
    const state = readState(previous.state);
    if (full || state.mailSelectVersion !== MAIL_SELECT_VERSION) {
      state.mailDeltaLinks = {};
    }
    state.mailSelectVersion = MAIL_SELECT_VERSION;
    return state;
  }
}

/** The three top-level folders every mailbox snapshot has. */
function addRootFolders(run: BackupRun): void {
  for (const path of [MAIL_ROOT, CALENDAR_ROOT, CONTACTS_ROOT]) {
    if (!run.writer.has(path)) {
      run.index.put(folderObjectAt(path, undefined, { [META.folderKind]: "root" }));
    }
  }
}

/** Convenience for hosts that just want an engine instance for a client factory. */
export function createExchangeBackupEngine<Db = unknown>(
  graph: ExchangeGraphClientFactory<Db>,
  options: Omit<ExchangeBackupEngineOptions<Db>, "graph"> = {},
): ExchangeBackupEngine<Db> {
  return new ExchangeBackupEngine<Db>({ ...options, graph });
}
