import * as fs from "node:fs/promises";
import * as path from "node:path";
import { z } from "zod";
import type { Logger } from "./logger.js";
import {
  type JournalEvent,
  type Run,
  type RunSummary,
  UPDATER_PHASES,
  type UpdaterPhase,
  journalEventSchema,
  releaseRefSchema,
  runSchema,
  runSummarySchema,
  selfUpdateRecordSchema,
  sourceRefSchema,
} from "./protocol.js";

/**
 * The updater's state: one document, `status.json`, in the state volume. It is
 * written atomically (temporary file, fsync, rename) after every state change and
 * before the side effect that follows it, so a crash never leaves the run
 * undocumented. A file that cannot be read is moved aside, never overwritten, and
 * the updater continues idle: history is best effort, the running installation
 * is not affected by losing it.
 */

export const STATE_SCHEMA_VERSION = 1;
export const STATE_FILE = "status.json";
export const HISTORY_LIMIT = 10;
export const EVENT_LIMIT = 200;
const CORRUPT_FILES_KEPT = 5;

const capturedKeySchema = z.object({
  present: z.boolean(),
  line: z.string().nullable(),
  value: z.string().nullable(),
});

/**
 * Bookkeeping of the current run that is not part of the public run document:
 * what a rollback or the recovery after an updater restart needs.
 */
export const runContextSchema = z.object({
  /** `.env` before the update (RESTOW_IMAGE, RESTOW_WEB_IMAGE), for an exact rollback. */
  previousEnv: z.record(capturedKeySchema).nullable().default(null),
  previousImages: z
    .object({ app: z.string().nullable(), web: z.string().nullable() })
    .nullable()
    .default(null),
  /** File name of this run's dump once it was taken and verified. */
  dumpFile: z.string().nullable().default(null),
  /** Number of applied migrations before the update; null until measured. */
  baselineMigrations: z.number().int().nonnegative().nullable().default(null),
  /** Digests the release published for its images (checked after the pull). */
  digests: releaseRefSchema.shape.digests.default({}),
  /** Where `source` mode fetches from (the run document does not carry it). */
  source: sourceRefSchema.nullable().default(null),
});
export type RunContext = z.infer<typeof runContextSchema>;

export function emptyRunContext(): RunContext {
  return {
    previousEnv: null,
    previousImages: null,
    dumpFile: null,
    baselineMigrations: null,
    digests: {},
    source: null,
  };
}

export const stateFileSchema = z
  .object({
    schemaVersion: z.literal(STATE_SCHEMA_VERSION),
    phase: z.enum(UPDATER_PHASES),
    run: runSchema.nullable(),
    runContext: runContextSchema.nullable().default(null),
    history: z.array(runSummarySchema).max(HISTORY_LIMIT),
    events: z.array(journalEventSchema).max(EVENT_LIMIT),
    eventCounter: z.number().int().nonnegative(),
    /** The updater's last update of itself (self-update.ts); null when there never was one. */
    selfUpdate: selfUpdateRecordSchema.nullable().default(null),
  })
  .superRefine((state, ctx) => {
    if (state.phase !== "idle" && state.run === null) {
      ctx.addIssue({ code: "custom", message: "phase requires a run", path: ["run"] });
    }
  });
export type StateFile = z.infer<typeof stateFileSchema>;

export function initialState(): StateFile {
  return {
    schemaVersion: STATE_SCHEMA_VERSION,
    phase: "idle",
    run: null,
    runContext: null,
    history: [],
    events: [],
    eventCounter: 0,
    selfUpdate: null,
  };
}

export function summaryOf(run: Run): RunSummary {
  const { log: _log, ...summary } = run;
  return summary;
}

function eventIdOf(epochMs: number, counter: number): string {
  return `${String(epochMs).padStart(15, "0")}-${String(counter).padStart(6, "0")}`;
}

export class StatusStore {
  /** Name of the file the previous status.json was moved to because it was unreadable. */
  recoveredFrom: string | null = null;
  private chain: Promise<void> = Promise.resolve();

  private constructor(
    readonly filePath: string,
    private doc: StateFile,
    private readonly logger: Logger,
  ) {}

  static async open(stateDir: string, logger: Logger, now: () => Date): Promise<StatusStore> {
    await fs.mkdir(stateDir, { recursive: true, mode: 0o700 });
    const filePath = path.join(stateDir, STATE_FILE);
    let raw: string;
    try {
      raw = await fs.readFile(filePath, "utf8");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") {
        return new StatusStore(filePath, initialState(), logger);
      }
      throw error;
    }
    const parsed = parseState(raw);
    if (parsed.ok) {
      return new StatusStore(filePath, parsed.state, logger);
    }
    const store = new StatusStore(filePath, initialState(), logger);
    const aside = `${STATE_FILE}.corrupt-${now().getTime()}`;
    try {
      await fs.rename(filePath, path.join(stateDir, aside));
      store.recoveredFrom = aside;
      logger.error(
        `status.json could not be read (${parsed.reason}); moved to ${aside}. Continuing idle without history.`,
      );
    } catch (error) {
      logger.error(
        `status.json could not be read (${parsed.reason}) and could not be moved aside (${(error as Error).message}). Continuing idle without history.`,
      );
    }
    await pruneCorruptFiles(stateDir, logger);
    return store;
  }

  /** The live document. Mutate it, then `await save()`. */
  get state(): StateFile {
    return this.doc;
  }

  /** A deep copy, safe to hand out. */
  snapshot(): StateFile {
    return structuredClone(this.doc);
  }

  setPhase(phase: UpdaterPhase): void {
    this.doc.phase = phase;
  }

  /** Put a run into the history (newest first), replacing an entry with the same id. */
  recordHistory(run: Run): void {
    const summary = summaryOf(structuredClone(run));
    this.doc.history = [summary, ...this.doc.history.filter((entry) => entry.id !== run.id)].slice(
      0,
      HISTORY_LIMIT,
    );
  }

  /** Append a journal event; ids sort chronologically and are unique across restarts. */
  addEvent(event: Omit<JournalEvent, "id">, nowMs: number): JournalEvent {
    const last = this.doc.events[this.doc.events.length - 1];
    const lastMs = last ? Number(last.id.slice(0, last.id.indexOf("-"))) : 0;
    // A clock that stepped back must not reorder ids.
    const epochMs = Math.max(nowMs, Number.isFinite(lastMs) ? lastMs : 0);
    this.doc.eventCounter += 1;
    const full: JournalEvent = { ...event, id: eventIdOf(epochMs, this.doc.eventCounter) };
    this.doc.events = [...this.doc.events, full].slice(-EVENT_LIMIT);
    return full;
  }

  /** Persist the document. Writes are strictly ordered; the promise resolves once the file is durable. */
  save(): Promise<void> {
    trimDocument(this.doc);
    const payload = `${JSON.stringify(this.doc)}\n`;
    const write = this.chain.then(() => writeAtomic(this.filePath, payload));
    // A failed write must not poison later writes; the caller of this write still sees the error.
    this.chain = write.catch(() => undefined);
    return write;
  }

  /** Resolves when every write started so far has finished. */
  async flush(): Promise<void> {
    await this.chain;
  }
}

function trimDocument(doc: StateFile): void {
  doc.history = doc.history.slice(0, HISTORY_LIMIT);
  doc.events = doc.events.slice(-EVENT_LIMIT);
}

type ParseResult = { ok: true; state: StateFile } | { ok: false; reason: string };

export function parseState(raw: string): ParseResult {
  let json: unknown;
  try {
    json = JSON.parse(raw);
  } catch {
    return { ok: false, reason: "not valid JSON" };
  }
  const result = stateFileSchema.safeParse(json);
  if (!result.success) {
    const issue = result.error.issues[0];
    return {
      ok: false,
      reason: `schema mismatch at ${issue ? issue.path.join(".") || "root" : "root"}`,
    };
  }
  return { ok: true, state: result.data };
}

async function writeAtomic(filePath: string, payload: string): Promise<void> {
  const directory = path.dirname(filePath);
  const temporary = `${filePath}.${process.pid}.tmp`;
  const handle = await fs.open(temporary, "w", 0o600);
  try {
    await handle.writeFile(payload, "utf8");
    await handle.sync();
  } catch (error) {
    await handle.close().catch(() => undefined);
    await fs.rm(temporary, { force: true });
    throw error;
  }
  await handle.close();
  try {
    await fs.rename(temporary, filePath);
  } catch (error) {
    await fs.rm(temporary, { force: true });
    throw error;
  }
  try {
    const dir = await fs.open(directory, "r");
    try {
      await dir.sync();
    } finally {
      await dir.close();
    }
  } catch {
    // Directory fsync is not supported everywhere; the rename is atomic regardless.
  }
}

async function pruneCorruptFiles(stateDir: string, logger: Logger): Promise<void> {
  try {
    const names = (await fs.readdir(stateDir))
      .filter((name) => name.startsWith(`${STATE_FILE}.corrupt-`))
      .sort();
    for (const name of names.slice(0, Math.max(0, names.length - CORRUPT_FILES_KEPT))) {
      await fs.rm(path.join(stateDir, name), { force: true });
    }
  } catch (error) {
    logger.warn(`Could not prune old corrupt status files: ${(error as Error).message}`);
  }
}
