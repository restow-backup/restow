/**
 * The mail file import engine (docs/IMPORT.md).
 *
 * One run reads a list of input files (uploads from the staging area, files of
 * the server-side import folder, whole directory trees) and produces ONE new
 * snapshot of an "imported mailbox". The snapshot uses the manifest format of
 * the IMAP backup (backup/imap/paths.ts), so restore, preview, download and the
 * archive treat the mailbox like any IMAP account:
 *
 *   mail/<folder components>                 type "folder"
 *   mail/<folder components>/<uid>.eml       type "message", byte-exact RFC 5322
 *
 * Every run is additive: the snapshot starts from everything the previous
 * snapshot held (`SnapshotWriter.inherit`), then adds what the files bring.
 * Nothing is ever removed.
 *
 *   read      `walkMailFile` (./walk.ts) turns each file into folders, messages
 *             and problems. Formats are recognised by content.
 *   store     a message is hashed and parsed for its envelope; a copy of the
 *             same message in the same folder (Message-ID plus SHA-256) is
 *             skipped and counted, never stored twice. Bytes go through the
 *             chunk store (chunk-level dedupe across the whole tenant) and the
 *             Message-ID/hash index of the IMAP engine reuses identical
 *             messages without chunking them again.
 *   report    everything that did not become a message is listed with a
 *             reason: unreadable items are failures (also `item_failures`),
 *             duplicates and non-mail files are skips. Nothing is dropped
 *             silently.
 *
 * Resume: the job checkpoints (packs, partial manifest, cursor) after every
 * finished file and every few hundred messages. The cursor names the unit being
 * read and how many of its items are done, so a restarted worker continues
 * exactly there (`WalkOptions.skipItems`) and never reads a message twice.
 */
import { createHash } from "node:crypto";
import { MessageDedupIndex } from "../backup/imap/dedup.js";
import {
  FOLDER_OBJECT_TYPE,
  MESSAGE_OBJECT_TYPE,
  META,
  encodeEnvelope,
  encodeFlags,
  folderObjectId,
  folderObjectPath,
  isFolderObject,
  isMessageObject,
  messageObjectId,
  messageObjectPath,
  objectMailbox,
  objectUid,
} from "../backup/imap/paths.js";
import type { ImapEngineState, ImapFolderState } from "../backup/imap/types.js";
import { JobAbortedError } from "../engine/chunkstore.js";
import { SnapshotWriter } from "../engine/snapshot.js";
import type { Cursor, JobContext, ProtectedObjectRef } from "../engine/types.js";
import type { ManifestObject } from "../manifest.js";
import { parseMessageMeta } from "./meta.js";
import { detectMailFormat } from "./sniff.js";
import {
  DEFAULT_MAIL_FILE_LIMITS,
  type ImportArchiveReport,
  type ImportFileReport,
  type ImportFileStatus,
  type ImportItemOutcome,
  type ImportReport,
  type ImportReportItem,
  type ImportSkipCode,
  MAX_REPORT_ITEMS,
  type MailFileFormat,
  type MailFileLimits,
  type MailInputFile,
  type MailWalkEvent,
  type MessageMeta,
  type WalkOptions,
} from "./types.js";
import { walkMailFile } from "./walk.js";

// ---------------------------------------------------------------------------
// Input
// ---------------------------------------------------------------------------

/** One requested entry (a file or a directory tree); reports are kept per group. */
export interface ImportGroup {
  /** Display path of the entry ("legacy/Inbox.mbox", "mailstore-export/"). */
  readonly label: string;
  /** Bytes of the entry (0 for a directory: the engine adds up what it reads). */
  readonly size: number;
  readonly kind: "file" | "directory";
}

export interface ImportFileUnit {
  /** Stable, unique key; the resume cursor is tied to the ordered list of keys. */
  readonly key: string;
  /** Index into {@link ImportRunInput.groups}. */
  readonly group: number;
  readonly kind: "file";
  /** Path handed to the walker (relative to the selected entry). */
  readonly path: string;
  readonly size: number;
}

/** An (empty) directory of a tree: the folder exists in the imported mailbox even without mail. */
export interface ImportDirectoryUnit {
  readonly key: string;
  readonly group: number;
  readonly kind: "dir";
  readonly path: readonly string[];
}

export type ImportUnit = ImportFileUnit | ImportDirectoryUnit;

export interface ImportRunInput {
  readonly groups: readonly ImportGroup[];
  /** In a deterministic order: a retry must see the same list. */
  readonly units: readonly ImportUnit[];
  /** Open a file unit for reading. */
  open(unit: ImportFileUnit): MailInputFile | Promise<MailInputFile>;
}

export interface ImportEngineOptions {
  readonly limits?: Partial<MailFileLimits>;
  /** Injectable for tests. */
  readonly walk?: (file: MailInputFile, options: WalkOptions) => AsyncGenerator<MailWalkEvent>;
  readonly parseMeta?: (raw: Buffer, signal?: AbortSignal) => Promise<MessageMeta>;
  readonly detect?: (head: Buffer) => { format: MailFileFormat };
  readonly checkpointEveryMessages?: number;
  readonly checkpointEveryBytes?: number;
  /** Called at most once a second with the live counters (the worker persists them). */
  readonly onStats?: (stats: ImportLiveStats) => void;
}

/** Live counters for the job page while the import runs. */
export interface ImportLiveStats {
  readonly messages: number;
  readonly duplicates: number;
  readonly skipped: number;
  readonly failed: number;
  readonly unitsDone: number;
  readonly unitsTotal: number;
}

export interface ImportRunResult {
  readonly snapshotId: string;
  readonly sequence: number;
  /** The report without the archive part (the worker adds it when the archive runs). */
  readonly report: ImportReport;
  /** New plaintext bytes written to the chunk store (after chunk-level dedupe). */
  readonly bytesNew: number;
}

/** Message metadata: the job that stored the message (finds this run's messages later). */
export const IMPORT_JOB_META = "importJob";
/** Message metadata: where the message came from ("legacy.mbox#17"). */
export const IMPORT_REF_META = "importRef";

/** Nothing new could be read; the run stored no snapshot. `report` explains why. */
export class ImportNothingError extends Error {
  constructor(
    message: string,
    readonly report: ImportReport,
  ) {
    super(message);
    this.name = "ImportNothingError";
  }

  /**
   * How many messages the files held, all of them already in the mailbox: the run found
   * every message to be a duplicate and nothing it could not read. That is a finished
   * re-import, not a failed one. Null when anything else kept the run from storing a message
   * (unreadable items, no mail at all).
   */
  get alreadyImported(): number | null {
    const { messages, duplicates, failed } = this.report.totals;
    return messages === 0 && failed === 0 && duplicates > 0 ? duplicates : null;
  }
}

// ---------------------------------------------------------------------------
// Report accumulation (serialisable: it travels in the job cursor)
// ---------------------------------------------------------------------------

interface GroupStats {
  format: MailFileFormat | "directory" | null;
  sha256: string | null;
  bytesRead: number;
  messages: number;
  folders: number;
  attachments: number;
  duplicates: number;
  skipped: number;
  failed: number;
  /** A refused or unsupported file (nothing of it could be imported). */
  refused: boolean;
}

interface Accumulator {
  messages: number;
  folders: number;
  attachments: number;
  duplicates: number;
  skipped: number;
  failed: number;
  messageBytes: number;
  sourceBytes: number;
  synthesizedMessages: number;
  /** Messages stored without metadata because their parse failed or ran over its limits. */
  metadataUnavailable?: number;
  groups: GroupStats[];
  failedItems: ImportReportItem[];
  skippedItems: ImportReportItem[];
  startedAt: string;
}

function emptyGroup(): GroupStats {
  return {
    format: null,
    sha256: null,
    bytesRead: 0,
    messages: 0,
    folders: 0,
    attachments: 0,
    duplicates: 0,
    skipped: 0,
    failed: 0,
    refused: false,
  };
}

function newAccumulator(groups: number, startedAt: Date): Accumulator {
  return {
    messages: 0,
    folders: 0,
    attachments: 0,
    duplicates: 0,
    skipped: 0,
    failed: 0,
    messageBytes: 0,
    sourceBytes: 0,
    synthesizedMessages: 0,
    groups: Array.from({ length: groups }, emptyGroup),
    failedItems: [],
    skippedItems: [],
    startedAt: startedAt.toISOString(),
  };
}

/** What a problem code means for the report: damaged input is a failure, harmless input a skip. */
export function outcomeOfProblem(code: ImportSkipCode): ImportItemOutcome {
  switch (code) {
    case "not_mail":
    case "empty":
    case "duplicate":
      return "skipped";
    default:
      return "failed";
  }
}

/** The cursor block of this engine (`cursor.import`). */
interface ImportCursorState {
  readonly version: 1;
  /** Fingerprint of the ordered unit keys: a changed input list invalidates the checkpoint. */
  readonly fingerprint: string;
  /** Units 0..unitsDone-1 are complete. */
  readonly unitsDone: number;
  /** Items of unit `unitsDone` already stored. */
  readonly itemsDone: number;
  /** Source bytes of unit `unitsDone` already counted. */
  readonly unitBytes: number;
  readonly acc: Accumulator;
}

function fingerprintOf(units: readonly ImportUnit[]): string {
  const hash = createHash("sha256");
  for (const unit of units) {
    hash.update(unit.key);
    hash.update("\n");
  }
  return hash.digest("hex");
}

function readImportCursor(cursor: Cursor | null, fingerprint: string): ImportCursorState | null {
  const raw = cursor?.import as Partial<ImportCursorState> | undefined;
  if (
    !raw ||
    raw.version !== 1 ||
    raw.fingerprint !== fingerprint ||
    typeof raw.unitsDone !== "number" ||
    typeof raw.itemsDone !== "number" ||
    !raw.acc ||
    !Array.isArray(raw.acc.groups)
  ) {
    return null;
  }
  return raw as ImportCursorState;
}

// ---------------------------------------------------------------------------
// Crash guard
// ---------------------------------------------------------------------------
//
// A worker that dies in the middle of a file (out of memory, killed) leaves the job
// "active" until the queue expires it, and the retry starts from the last checkpoint:
// the same file, the same death, up to the retry limit, and every other job of the
// process is interrupted each time. The cursor therefore says whether an attempt is
// running (`running`) and an orderly end (an error, a cancel, a shutdown) clears it. An
// attempt that finds it set knows the previous one died, in the unit the checkpoint
// points at. The first death gets a plain retry (a restart or an out-of-memory kill of
// the whole host says nothing about the file); a second death in the same unit marks
// the rest of that file as failed, with the reason in the report, and the import goes
// on with the next file.

/** `cursor.importGuard`. */
interface CrashGuard {
  /** True while an attempt runs; cleared by every orderly end of an attempt. */
  readonly running: boolean;
  /** The unit the last unexpected stop happened in. */
  readonly crashedUnit: string | null;
  /** How many attempts in a row stopped unexpectedly in `crashedUnit`. */
  readonly crashCount: number;
  /**
   * Units finished at the last checkpoint: the one an unexpected stop happened in. It is kept
   * here as well because a run that has stored nothing yet has no snapshot checkpoint to say it.
   */
  readonly unitsDone: number;
}

/** While nothing is stored yet, the position is saved this often at most ... */
const GUARD_SAVE_INTERVAL_MS = 1000;
/** ... but always in front of a file of at least this size. */
const GUARD_ALWAYS_BYTES = 1024 * 1024;

/** A file whose reading stopped the worker this many times in a row is not read again. */
export const CRASHES_BEFORE_QUARANTINE = 2;

function readGuard(cursor: Cursor | null): CrashGuard {
  const raw = cursor?.importGuard as Partial<CrashGuard> | undefined;
  return {
    running: raw?.running === true,
    crashedUnit: typeof raw?.crashedUnit === "string" ? raw.crashedUnit : null,
    crashCount: typeof raw?.crashCount === "number" ? raw.crashCount : 0,
    unitsDone: typeof raw?.unitsDone === "number" ? raw.unitsDone : 0,
  };
}

/** Write the guard into the cursor, keeping everything else the cursor holds. */
async function saveGuard(ctx: JobContext, guard: CrashGuard): Promise<void> {
  const current = (await ctx.cursor.load()) ?? {};
  await ctx.cursor.save({ ...current, importGuard: guard });
}

// ---------------------------------------------------------------------------
// The engine
// ---------------------------------------------------------------------------

export class MailImportEngine {
  private readonly limits: MailFileLimits;
  private readonly walk: NonNullable<ImportEngineOptions["walk"]>;
  private readonly checkpointEveryMessages: number;
  private readonly checkpointEveryBytes: number;

  constructor(private readonly options: ImportEngineOptions = {}) {
    this.limits = { ...DEFAULT_MAIL_FILE_LIMITS, ...options.limits };
    this.walk = options.walk ?? walkMailFile;
    this.checkpointEveryMessages = options.checkpointEveryMessages ?? 500;
    this.checkpointEveryBytes = options.checkpointEveryBytes ?? 256 * 1024 * 1024;
  }

  async run(
    ctx: JobContext,
    protectedObject: ProtectedObjectRef,
    input: ImportRunInput,
  ): Promise<ImportRunResult> {
    const logger = ctx.logger.child({
      engine: "import",
      protectedObjectId: protectedObject.id,
      units: input.units.length,
    });
    const fingerprint = fingerprintOf(input.units);
    const cursor = await ctx.cursor.load();
    let writer = await SnapshotWriter.begin(ctx, {
      protectedObject,
      sourceType: "imap",
      checkpoint: cursor?.snapshot,
    });
    const resumedFromCheckpoint =
      cursor?.snapshot !== undefined && cursor.snapshot.snapshotId === writer.snapshotId;
    let resume = resumedFromCheckpoint ? readImportCursor(cursor, fingerprint) : null;
    if (resumedFromCheckpoint && !resume) {
      // The list of files changed since the checkpoint: what it holds cannot be
      // matched to the new list, so the partial snapshot is dropped, not mixed in.
      logger.warn("the input list changed since the checkpoint; starting the snapshot over");
      await writer.abort();
      await ctx.cursor.clear();
      writer = await SnapshotWriter.begin(ctx, { protectedObject, sourceType: "imap" });
      resume = null;
    }

    // An attempt that finds `running` set follows one that stopped without a word.
    const before = readGuard(await ctx.cursor.load());
    // The position carries over: a death before the first checkpoint of this attempt must still
    // point at the unit this attempt started in.
    let guard: CrashGuard = {
      running: true,
      crashedUnit: null,
      crashCount: 0,
      unitsDone: resume?.unitsDone ?? before.unitsDone,
    };
    let quarantine: string | null = null;
    if (before.running) {
      const unit = input.units[before.unitsDone];
      if (unit?.kind === "file") {
        const crashCount = before.crashedUnit === unit.key ? before.crashCount + 1 : 1;
        logger.error("the previous attempt of this import stopped unexpectedly", {
          unit: unit.path,
          crashCount,
        });
        if (crashCount >= CRASHES_BEFORE_QUARANTINE) {
          quarantine = unit.key;
        } else {
          guard = { ...guard, crashedUnit: unit.key, crashCount };
        }
      }
    }
    await saveGuard(ctx, guard);

    const run = new ImportRun({
      ctx,
      writer,
      input,
      engine: this,
      logger,
      fingerprint,
      resume,
      guard,
      quarantine,
    });
    try {
      await run.execute();
    } catch (error) {
      await run.preserveForRetry(error);
      throw error;
    }
    return run.finish();
  }

  get walkLimits(): MailFileLimits {
    return this.limits;
  }

  get walker(): NonNullable<ImportEngineOptions["walk"]> {
    return this.walk;
  }

  get parseMeta(): NonNullable<ImportEngineOptions["parseMeta"]> {
    return (
      this.options.parseMeta ?? ((raw, signal) => parseMessageMeta(raw, signal ? { signal } : {}))
    );
  }

  get detect(): NonNullable<ImportEngineOptions["detect"]> {
    return this.options.detect ?? detectMailFormat;
  }

  get thresholds(): { messages: number; bytes: number } {
    return { messages: this.checkpointEveryMessages, bytes: this.checkpointEveryBytes };
  }

  get statsSink(): ImportEngineOptions["onStats"] {
    return this.options.onStats;
  }
}

interface RunOptions {
  readonly ctx: JobContext;
  readonly writer: SnapshotWriter;
  readonly input: ImportRunInput;
  readonly engine: MailImportEngine;
  readonly logger: JobContext["logger"];
  readonly fingerprint: string;
  readonly resume: ImportCursorState | null;
  readonly guard: CrashGuard;
  /** Key of a unit that stopped the worker repeatedly: its remainder is reported, not read. */
  readonly quarantine: string | null;
}

/** Per folder: the next UID and the (Message-ID, hash) pairs already in it. */
interface FolderBook {
  readonly components: readonly string[];
  nextUid: number;
  readonly seen: Set<string>;
  messages: number;
}

class ImportRun {
  private readonly ctx: JobContext;
  private readonly writer: SnapshotWriter;
  private readonly input: ImportRunInput;
  private readonly engine: MailImportEngine;
  private readonly logger: JobContext["logger"];
  private readonly fingerprint: string;
  private guard: CrashGuard;
  private readonly quarantine: string | null;
  private readonly startedAt: Date;
  private readonly folders = new Map<string, FolderBook>();
  private readonly dedup = new MessageDedupIndex();
  private acc: Accumulator;
  private previousMessages = 0;
  private previousFolders = 0;
  private unitsDone: number;
  private itemsDone: number;
  private unitBytes: number;
  private touched = false;
  private guardSavedAt = 0;
  private messagesSinceCheckpoint = 0;
  private bytesSinceCheckpoint = 0;
  private pendingProgressBytes = 0;
  private lastProgressAt = 0;
  private lastStatsAt = 0;
  private readonly totalSourceBytes: number;
  private readonly unitsTotal: number;

  constructor(options: RunOptions) {
    this.ctx = options.ctx;
    this.writer = options.writer;
    this.input = options.input;
    this.engine = options.engine;
    this.logger = options.logger;
    this.fingerprint = options.fingerprint;
    this.guard = options.guard;
    this.quarantine = options.quarantine;
    this.startedAt = options.ctx.now();
    this.unitsTotal = options.input.units.length;
    this.totalSourceBytes = options.input.units.reduce(
      (sum, unit) => sum + (unit.kind === "file" ? unit.size : 0),
      0,
    );
    if (options.resume) {
      this.acc = options.resume.acc;
      this.unitsDone = options.resume.unitsDone;
      this.itemsDone = options.resume.itemsDone;
      this.unitBytes = options.resume.unitBytes;
      this.touched = true;
    } else {
      this.acc = newAccumulator(options.input.groups.length, this.startedAt);
      this.unitsDone = 0;
      this.itemsDone = 0;
      this.unitBytes = 0;
    }
  }

  async execute(): Promise<void> {
    const { ctx, writer } = this;
    ctx.progress.phase("prepare");
    const previous = await writer.loadPreviousManifest();
    if (previous && writer.objectCount === 0) {
      writer.inherit(previous);
    }
    this.indexExisting(writer.listObjects());
    ctx.progress.total(this.totalSourceBytes);
    if (this.unitsDone > 0 || this.itemsDone > 0) {
      // A retry starts a fresh progress tracker: bring it to where the checkpoint was.
      ctx.progress.advance(this.acc.sourceBytes, this.acc.messageBytes);
    }

    ctx.progress.phase("import");
    const units = this.input.units;
    for (let index = this.unitsDone; index < units.length; index++) {
      this.throwIfStopping();
      const unit = units[index] as ImportUnit;
      const startItem = index === this.unitsDone ? this.itemsDone : 0;
      const startBytes = index === this.unitsDone ? this.unitBytes : 0;
      if (this.quarantine !== null && unit.kind === "file" && unit.key === this.quarantine) {
        this.quarantineUnit(unit, startItem);
      } else {
        await this.processUnit(unit, startItem, startBytes);
      }
      this.unitsDone = index + 1;
      this.itemsDone = 0;
      this.unitBytes = 0;
      this.publishStats(true);
      await this.checkpoint("unit");
    }
    this.flushProgress(true);
  }

  /** Index the messages the snapshot already holds so a repeat is recognised. */
  private indexExisting(objects: readonly ManifestObject[]): void {
    for (const object of objects) {
      if (isFolderObject(object)) {
        this.bookOf(object.metadata?.[META.mailbox] as string);
        this.previousFolders++;
      }
    }
    for (const object of objects) {
      if (!isMessageObject(object)) {
        continue;
      }
      const mailbox = objectMailbox(object) as string;
      const book = this.bookOf(mailbox);
      const uid = objectUid(object);
      if (uid !== null && uid >= book.nextUid) {
        book.nextUid = uid + 1;
      }
      book.messages++;
      this.previousMessages++;
      book.seen.add(dedupKey(object.metadata?.[META.messageId] ?? null, object.sha256 ?? ""));
      if (object.sha256 !== undefined) {
        this.dedup.remember(object.metadata?.[META.messageId] ?? null, {
          size: object.size,
          sha256: object.sha256,
          chunks: object.chunks,
        });
      }
    }
  }

  private bookOf(mailbox: string, components?: readonly string[]): FolderBook {
    let book = this.folders.get(mailbox);
    if (!book) {
      book = {
        components: components ?? mailbox.split("/"),
        nextUid: 1,
        seen: new Set(),
        messages: 0,
      };
      this.folders.set(mailbox, book);
    }
    return book;
  }

  // -- units ----------------------------------------------------------------

  private async processUnit(
    unit: ImportUnit,
    startItem: number,
    startBytes: number,
  ): Promise<void> {
    const group = this.acc.groups[unit.group] as GroupStats;
    if (unit.kind === "dir") {
      this.ensureFolder(unit.path, unit.group);
      return;
    }
    const file = await this.input.open(unit);
    if (startItem === 0 && group.format === null) {
      const head = await file.read(0, 64 * 1024);
      group.format = this.engine.detect(head).format;
    }
    if (this.input.groups[unit.group]?.kind === "file" && startItem === 0) {
      group.sha256 = await hashFile(file, this.ctx.signal);
    }
    this.unitBytes = startBytes;
    let itemIndex = startItem;
    const events = this.engine.walker(file, {
      limits: this.engine.walkLimits,
      skipItems: startItem,
      signal: this.ctx.signal,
    });
    try {
      for await (const event of events) {
        this.throwIfStopping();
        if (event.type === "folder") {
          this.ensureFolder(event.path, unit.group);
          continue;
        }
        if (event.type === "problem") {
          this.recordProblem(unit, event.ref, event.code, event.reason);
          itemIndex = event.index + 1;
        } else {
          await this.storeMessage(unit, event);
          itemIndex = event.index + 1;
          this.countSourceBytes(unit, event.sourceBytes);
        }
        this.itemsDone = itemIndex;
        await this.maybeCheckpoint();
      }
    } catch (error) {
      if (this.ctx.signal.aborted || error instanceof JobAbortedError) {
        throw new JobAbortedError();
      }
      throw error;
    }
    // The rest of the unit's bytes count as read, so progress ends at 100 percent.
    this.countSourceBytes(unit, Math.max(0, unit.size - this.unitBytes));
  }

  /** Report the rest of a file that stopped the worker repeatedly as failed, without reading it. */
  private quarantineUnit(unit: ImportFileUnit, itemsDone: number): void {
    this.logger.error("not reading the rest of a file that stopped the worker repeatedly", {
      unit: unit.path,
      itemsDone,
    });
    this.recordProblem(
      unit,
      unit.path,
      "unreadable",
      `The worker process stopped unexpectedly ${CRASHES_BEFORE_QUARANTINE} times in a row while it was reading this file${itemsDone > 0 ? `, after ${itemsDone} item${itemsDone === 1 ? "" : "s"}` : ""}. The rest of the file was not imported. If the file itself is not the cause, import it again: messages that are already in the mailbox are skipped.`,
    );
    this.touched = true;
    // The bytes of the rest count as read, so progress still ends at 100 percent.
    this.unitBytes = Math.min(this.unitBytes, unit.size);
    this.countSourceBytes(unit, Math.max(0, unit.size - this.unitBytes));
  }

  private countSourceBytes(unit: ImportFileUnit, bytes: number): void {
    const room = Math.max(0, unit.size - this.unitBytes);
    const counted = Math.min(bytes, room);
    this.unitBytes += counted;
    this.acc.sourceBytes += counted;
    (this.acc.groups[unit.group] as GroupStats).bytesRead += counted;
    this.pendingProgressBytes += counted;
    this.flushProgress(false);
  }

  private flushProgress(force: boolean): void {
    const now = Date.now();
    if (
      this.pendingProgressBytes > 0 &&
      (force || this.pendingProgressBytes >= 512 * 1024 || now - this.lastProgressAt >= 1000)
    ) {
      this.ctx.progress.advance(this.pendingProgressBytes, 0);
      this.pendingProgressBytes = 0;
      this.lastProgressAt = now;
    }
    this.publishStats(false);
  }

  private publishStats(force: boolean): void {
    const sink = this.engine.statsSink;
    if (!sink) {
      return;
    }
    const now = Date.now();
    if (!force && now - this.lastStatsAt < 1000) {
      return;
    }
    this.lastStatsAt = now;
    sink({
      messages: this.acc.messages,
      duplicates: this.acc.duplicates,
      skipped: this.acc.skipped,
      failed: this.acc.failed,
      unitsDone: this.unitsDone,
      unitsTotal: this.unitsTotal,
    });
  }

  // -- problems ---------------------------------------------------------------

  private recordProblem(
    unit: ImportFileUnit,
    ref: string,
    code: ImportSkipCode,
    reason: string,
  ): void {
    const outcome = outcomeOfProblem(code);
    const group = this.acc.groups[unit.group] as GroupStats;
    const label = this.input.groups[unit.group]?.label ?? unit.path;
    const item: ImportReportItem = { ref, file: label, outcome, code, reason };
    if (outcome === "failed") {
      this.acc.failed++;
      group.failed++;
      if (code === "pst_not_supported" || code === "unsupported") {
        group.refused = group.refused || (group.messages === 0 && group.format !== "directory");
      }
      if (this.acc.failedItems.length < MAX_REPORT_ITEMS) {
        this.acc.failedItems.push(item);
        // One `item_failures` row per listed item: the report and the table stay as small as the
        // list, however many entries a hostile archive makes unreadable (the counters stay exact).
        this.ctx.progress.fail(ref, reason);
      }
    } else {
      this.acc.skipped++;
      group.skipped++;
      if (this.acc.skippedItems.length < MAX_REPORT_ITEMS) {
        this.acc.skippedItems.push(item);
      }
    }
  }

  // -- messages ---------------------------------------------------------------

  private ensureFolder(components: readonly string[], groupIndex: number): FolderBook {
    let book: FolderBook | null = null;
    // Ancestors first: an explorer tree shows "Inbox" above "Inbox/Projects" even
    // when the source only had messages in the child.
    for (let depth = 1; depth <= components.length; depth++) {
      const chain = components.slice(0, depth);
      const mailbox = chain.join("/");
      const known = this.folders.has(mailbox);
      book = this.bookOf(mailbox, chain);
      if (!known || !this.writer.has(folderObjectPath(chain))) {
        this.writer.add(this.folderObject(mailbox, chain));
        if (!known) {
          this.acc.folders++;
          (this.acc.groups[groupIndex] as GroupStats).folders++;
        }
        this.touched = true;
      }
    }
    return book as FolderBook;
  }

  private folderObject(mailbox: string, components: readonly string[]): ManifestObject {
    return {
      path: folderObjectPath(components),
      id: folderObjectId(mailbox, "1"),
      type: FOLDER_OBJECT_TYPE,
      size: 0,
      mtime: this.ctx.now().getTime(),
      metadata: { [META.mailbox]: mailbox, [META.delimiter]: "/", [META.uidValidity]: "1" },
      chunks: [],
    };
  }

  private async storeMessage(
    unit: ImportFileUnit,
    message: Extract<MailWalkEvent, { type: "message" }>,
  ): Promise<void> {
    const group = this.acc.groups[unit.group] as GroupStats;
    const folderComponents = message.folder.length > 0 ? message.folder : ["Imported"];
    const mailbox = folderComponents.join("/");
    const book = this.ensureFolder(folderComponents, unit.group);

    let meta: MessageMeta;
    try {
      meta = await this.engine.parseMeta(message.raw, this.ctx.signal);
    } catch (error) {
      if (this.ctx.signal.aborted || (error instanceof Error && error.name === "AbortError")) {
        throw new JobAbortedError();
      }
      throw error;
    }
    if (meta.unavailable) {
      this.acc.metadataUnavailable = (this.acc.metadataUnavailable ?? 0) + 1;
    }
    const sha256 = createHash("sha256").update(message.raw).digest("hex");
    const key = dedupKey(meta.messageId, sha256);
    if (book.seen.has(key)) {
      this.acc.duplicates++;
      group.duplicates++;
      this.acc.skipped++;
      group.skipped++;
      if (this.acc.skippedItems.length < MAX_REPORT_ITEMS) {
        this.acc.skippedItems.push({
          ref: message.ref,
          file: this.input.groups[unit.group]?.label ?? unit.path,
          outcome: "skipped",
          code: "duplicate",
          reason: `The same message (Message-ID and content) is already in the folder ${mailbox}.`,
        });
      }
      return;
    }
    book.seen.add(key);

    const content =
      this.dedup.find(meta.messageId, message.raw) ?? (await this.writer.chunks.write(message.raw));
    this.dedup.remember(meta.messageId, content);

    const uid = book.nextUid++;
    book.messages++;
    const internalDate = message.internalDate ?? meta.sentAt ?? null;
    const metadata: Record<string, string> = {
      [META.mailbox]: mailbox,
      [META.delimiter]: "/",
      [META.uid]: String(uid),
      [META.uidValidity]: "1",
      [META.flags]: encodeFlags(message.flags),
      [META.reportedSize]: String(content.size),
      ...encodeEnvelope({
        subject: meta.subject,
        from: meta.from,
        to: meta.to,
        toCount: meta.toCount,
        cc: meta.cc,
        ccCount: meta.ccCount,
        hasAttachments: meta.hasAttachments,
        sentDateTime: meta.sentAt,
        protection: meta.protection,
      }),
      [IMPORT_JOB_META]: this.ctx.jobId,
      [IMPORT_REF_META]: message.ref.slice(0, 500),
    };
    if (internalDate) {
      metadata[META.internalDate] = internalDate.toISOString();
    }
    if (meta.messageId) {
      metadata[META.messageId] = meta.messageId;
    }
    this.writer.add({
      path: messageObjectPath(folderComponents, uid),
      id: messageObjectId(mailbox, "1", uid),
      type: MESSAGE_OBJECT_TYPE,
      size: content.size,
      mtime: internalDate?.getTime() ?? this.ctx.now().getTime(),
      sha256: content.sha256,
      metadata,
      chunks: [...content.chunks],
    });

    this.acc.messages++;
    group.messages++;
    this.acc.attachments += meta.attachmentCount;
    group.attachments += meta.attachmentCount;
    this.acc.messageBytes += content.size;
    if (message.synthesized) {
      this.acc.synthesizedMessages++;
    }
    this.touched = true;
    this.messagesSinceCheckpoint++;
    this.bytesSinceCheckpoint += content.size;
    this.ctx.progress.advance(0, content.size);
  }

  // -- checkpoints --------------------------------------------------------------

  private cursorBlock(): ImportCursorState {
    return {
      version: 1,
      fingerprint: this.fingerprint,
      unitsDone: this.unitsDone,
      itemsDone: this.itemsDone,
      unitBytes: this.unitBytes,
      acc: this.acc,
    };
  }

  private async maybeCheckpoint(): Promise<void> {
    const { messages, bytes } = this.engine.thresholds;
    if (this.messagesSinceCheckpoint >= messages || this.bytesSinceCheckpoint >= bytes) {
      await this.checkpoint("interval");
    }
  }

  private async checkpoint(reason: "interval" | "unit" | "failure"): Promise<void> {
    this.guard = { ...this.guard, unitsDone: this.unitsDone };
    if (!this.touched && reason !== "failure") {
      // Nothing stored yet, so no snapshot to checkpoint; the guard still says where the run is.
      // A tree of thousands of small non-mail files would otherwise cost two queries per file, so
      // the position is saved at most once a second, and always in front of a file big enough
      // to be a danger (the parsers are isolated, a small file cannot bring the process down).
      const next = this.input.units[this.unitsDone];
      const big = next?.kind === "file" && next.size >= GUARD_ALWAYS_BYTES;
      if (big || Date.now() - this.guardSavedAt >= GUARD_SAVE_INTERVAL_MS) {
        await saveGuard(this.ctx, this.guard);
        this.guardSavedAt = Date.now();
      }
      return;
    }
    this.publishStats(true);
    this.flushProgress(true);
    await this.writer.checkpoint({ import: this.cursorBlock(), importGuard: this.guard });
    this.messagesSinceCheckpoint = 0;
    this.bytesSinceCheckpoint = 0;
    this.logger.debug("import checkpoint", { reason, unitsDone: this.unitsDone });
  }

  /** On failure keep what was stored so the retry resumes; discard an untouched snapshot. */
  async preserveForRetry(error: unknown): Promise<void> {
    const aborted = error instanceof JobAbortedError;
    this.logger[aborted ? "warn" : "error"](
      aborted ? "import interrupted, checkpointing" : "import failed, checkpointing",
      { error },
    );
    // An orderly end: the next attempt must not take this one for a crash.
    this.guard = { ...this.guard, running: false };
    try {
      if (this.touched) {
        await this.checkpoint("failure");
      } else {
        await this.writer.abort();
        await saveGuard(this.ctx, this.guard);
      }
    } catch (checkpointError) {
      this.logger.error("checkpoint after failure did not succeed", { error: checkpointError });
    }
  }

  private throwIfStopping(): void {
    if (this.ctx.signal.aborted) {
      throw new JobAbortedError();
    }
  }

  // -- the end ------------------------------------------------------------------

  async finish(): Promise<ImportRunResult> {
    const { ctx, writer } = this;
    this.flushProgress(true);
    ctx.progress.phase("manifest");
    if (this.acc.messages === 0) {
      const report = this.buildReport(null, ctx.now());
      await writer.abort();
      await ctx.cursor.clear();
      throw new ImportNothingError(
        this.acc.failed > 0
          ? `no readable messages were found in the selected files (${this.acc.failed} item(s) could not be read; see the list)`
          : "the selected files contain no new messages",
        report,
      );
    }
    writer.setState(this.stateOf());
    const committed = await writer.commit();
    await ctx.cursor.clear();
    this.logger.info("import finished", {
      snapshotId: committed.snapshotId,
      sequence: committed.sequence,
      messages: this.acc.messages,
      duplicates: this.acc.duplicates,
      failed: this.acc.failed,
      skipped: this.acc.skipped,
    });
    return {
      snapshotId: committed.snapshotId,
      sequence: committed.sequence,
      report: this.buildReport(committed.snapshotId, ctx.now()),
      bytesNew: writer.chunks.stats.bytesNew,
    };
  }

  private stateOf(): Record<string, unknown> {
    const folders: Record<string, ImapFolderState> = {};
    for (const [mailbox, book] of this.folders) {
      folders[mailbox] = {
        uidValidity: "1",
        uidNext: book.nextUid,
        delimiter: "/",
        messages: book.messages,
      };
    }
    const state: ImapEngineState = { imap: { version: 1, folders } };
    return state as unknown as Record<string, unknown>;
  }

  private buildReport(snapshotId: string | null, completedAt: Date): ImportReport {
    const groups = this.input.groups;
    const files: ImportFileReport[] = this.acc.groups.map((stats, index) => {
      const group = groups[index] as ImportGroup;
      return {
        path: group.label,
        size: group.kind === "directory" ? stats.bytesRead : group.size,
        format: group.kind === "directory" ? "directory" : (stats.format ?? "unknown"),
        sha256: stats.sha256,
        status: fileStatus(stats),
        messages: stats.messages,
        folders: stats.folders,
        attachments: stats.attachments,
        duplicates: stats.duplicates,
        skipped: stats.skipped,
        failed: stats.failed,
      };
    });
    const listed = [...this.acc.failedItems, ...this.acc.skippedItems].slice(0, MAX_REPORT_ITEMS);
    const totalItems = this.acc.failed + this.acc.skipped;
    const notes = ["calendar_contacts_not_imported"];
    if (this.acc.synthesizedMessages > 0) {
      notes.push("msg_reconstructed");
    }
    if ((this.acc.metadataUnavailable ?? 0) > 0) {
      notes.push("metadata_unavailable");
    }
    if (
      this.acc.failed > this.acc.failedItems.length ||
      this.acc.skipped > this.acc.skippedItems.length
    ) {
      notes.push("item_list_truncated");
    }
    return {
      version: 1,
      startedAt: this.acc.startedAt,
      completedAt: completedAt.toISOString(),
      snapshotId,
      totals: {
        files: files.length,
        messages: this.acc.messages,
        folders: this.acc.folders,
        attachments: this.acc.attachments,
        duplicates: this.acc.duplicates,
        skipped: this.acc.skipped,
        failed: this.acc.failed,
        messageBytes: this.acc.messageBytes,
        sourceBytes: this.acc.sourceBytes,
        synthesizedMessages: this.acc.synthesizedMessages,
      },
      files,
      items: listed,
      itemsOmitted: Math.max(0, totalItems - listed.length),
      archive: null satisfies ImportArchiveReport | null,
      notes,
    };
  }
}

function fileStatus(stats: GroupStats): ImportFileStatus {
  if (stats.refused && stats.messages === 0) {
    return "refused";
  }
  if (stats.messages === 0 && stats.failed > 0) {
    return "failed";
  }
  return stats.failed > 0 ? "partial" : "imported";
}

function dedupKey(messageId: string | null, sha256: string): string {
  return `${messageId ?? ""}\u0000${sha256}`;
}

async function hashFile(file: MailInputFile, signal: AbortSignal): Promise<string> {
  const hash = createHash("sha256");
  for await (const part of file.open()) {
    if (signal.aborted) {
      throw new JobAbortedError();
    }
    hash.update(part as Buffer);
  }
  return hash.digest("hex");
}
