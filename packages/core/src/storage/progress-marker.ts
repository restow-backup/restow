/**
 * Storage progress markers (0.5.0, docs/STORAGE.md "Restore mode and progress markers").
 *
 * Every target records how far the database had come when data was last written to it: before
 * the first write of a tenant's data to a target, and again at most once per interval, the
 * writer allocates the next value of the tenant's progress counter in the database (its own
 * committed statement) and only then writes a new marker object
 *
 *   tenants/<tid>/progress/<floor(seq / 1000), 12 digits>/<seq, 20 digits>.json
 *
 * and then the data. A marker is never overwritten (write-once targets keep working); the
 * newest one wins.
 *
 * The comparison ({@link compareStorageProgress}) lists the markers first and reads the
 * database's value afterwards. On a healthy installation every marker it saw was allocated,
 * and committed, before that read, so none is above the value read. A marker above it, written
 * by this installation, means the database is older than its storage: a dump was restored.
 * Wrapped keys in storage above the database's newest key version say the same.
 *
 * Markers are never copied by the copy mirror or a storage migration (copy.ts), so a copy that
 * is being filled, a promoted copy or a new primary only ever hold markers written since, all
 * at or below the database's value.
 */
import type { Readable } from "node:stream";
import { tenantPrefix } from "../engine/layout.js";
import type { HeadResult, ObjectRetention, PutOptions, StorageBackend } from "./backend.js";
import { WRAPPED_BACKEND } from "./backend.js";
import { isAlwaysDeletable } from "./deletion-guard.js";

export const PROGRESS_MARKER_FORMAT = 1;
/** Markers per folder; the comparison and the pruning work by folder. */
export const PROGRESS_FOLDER_SIZE = 1000;
/** A target gets a new marker at most this often per tenant and process while data is written. */
export const DEFAULT_PROGRESS_MARKER_INTERVAL_MS = 60_000;
/** Ending restore mode raises the database's value by this much above everything seen. */
export const PROGRESS_REBASE_MARGIN = 1_000_000;

export interface ProgressMarkerBody {
  readonly format: number;
  readonly installationId: string | null;
  readonly tenantId: string;
  readonly seq: number;
  readonly writtenAt: string;
  readonly writer: string;
  readonly version: string | null;
}

export function progressPrefix(tenantId: string): string {
  return `${tenantPrefix(tenantId)}progress/`;
}

export function progressFolderOf(seq: number): number {
  return Math.floor(seq / PROGRESS_FOLDER_SIZE);
}

export function progressMarkerKey(tenantId: string, seq: number): string {
  if (!Number.isSafeInteger(seq) || seq < 0) {
    throw new Error(`invalid progress value ${seq}`);
  }
  const folder = String(progressFolderOf(seq)).padStart(12, "0");
  return `${progressPrefix(tenantId)}${folder}/${String(seq).padStart(20, "0")}.json`;
}

const MARKER_KEY = /^tenants\/([^/]+)\/progress\/(\d{12})\/(\d{20})\.json$/;

export function parseProgressMarkerKey(key: string): { tenantId: string; seq: number } | null {
  const match = MARKER_KEY.exec(key);
  if (!match) {
    return null;
  }
  const seq = Number(match[3]);
  if (!Number.isSafeInteger(seq) || Number(match[2]) !== progressFolderOf(seq)) {
    return null;
  }
  return { tenantId: match[1] as string, seq };
}

/** Whether `key` lies in a tenant's progress area (markers are never mirrored or counted). */
export function isProgressKey(key: string): boolean {
  return /^tenants\/[^/]+\/progress\//.test(key);
}

export interface ProgressMarkerOptions {
  readonly tenantId: string;
  /** The storage target's id (`storage_targets.id`, or the installation default's). */
  readonly targetId: string;
  /** The next progress value of the tenant, committed before it returns. */
  readonly allocate: (tenantId: string) => Promise<number>;
  readonly installationId: () => Promise<string | null>;
  readonly writer: string;
  readonly version?: string | null;
  readonly intervalMs?: number;
  readonly now?: () => Date;
  /**
   * The allocated value's marker exists already. Written by this installation (`ours`; an
   * unreadable marker counts as ours), that alone proves the storage is ahead of the database
   * (a dump was restored): the value was handed out before, in a timeline the database no longer
   * has. Called before the next allocation (the worker and the api switch restore mode on with
   * `seq` as the storage's value and `seq - 1` as the database's, then lift the value above the
   * storage's). A marker of another installation is not ours: the writer only takes the next
   * value.
   */
  readonly onCollision?: (
    tenantId: string,
    seq: number,
    collision: { readonly ours: boolean },
  ) => Promise<void>;
  /**
   * Runs once per tenant and target in this process before the first value is allocated (the
   * worker and the api compare the tenant's storage with the database first): an allocation
   * raises the database's value, and a comparison after it could no longer see storage that is
   * only a few values ahead. A failure fails this write; the next write runs it again.
   */
  readonly beforeFirstAllocation?: (tenantId: string) => Promise<void>;
}

/** How often a marker whose value is taken already is allocated again before the write fails. */
const MARKER_COLLISION_TRIES = 3;

interface MarkerState {
  lastAt: number;
  inflight: Promise<void> | null;
}

/** Per tenant and target in this process: when the last marker was written. */
const markerStates = new Map<string, MarkerState>();

/** Per tenant and target in this process: whether `beforeFirstAllocation` succeeded. */
const firstAllocationsDone = new Set<string>();

/** Forget the throttle and the first comparisons (tests). */
export function resetProgressMarkerThrottle(): void {
  markerStates.clear();
  firstAllocationsDone.clear();
}

/** Whether the marker `seq` on `backend` was written by `installationId` (unreadable: yes). */
async function markerIsOurs(
  backend: StorageBackend,
  tenantId: string,
  seq: number,
  installationId: string | null,
): Promise<boolean> {
  try {
    const body = JSON.parse(
      (await backend.get(progressMarkerKey(tenantId, seq))).toString("utf8"),
    ) as Partial<ProgressMarkerBody>;
    return (body.installationId ?? null) === installationId;
  } catch {
    return true;
  }
}

function isDataKey(key: string): boolean {
  return !isProgressKey(key) && !isAlwaysDeletable(key);
}

/** Write a marker for `options` now (the next value, a new object). Returns its value. */
export async function writeProgressMarker(
  backend: StorageBackend,
  options: ProgressMarkerOptions,
): Promise<number> {
  const stateKey = `${options.tenantId}|${options.targetId}`;
  if (options.beforeFirstAllocation && !firstAllocationsDone.has(stateKey)) {
    await options.beforeFirstAllocation(options.tenantId);
    firstAllocationsDone.add(stateKey);
  }
  let seq = await options.allocate(options.tenantId);
  for (let attempt = 1; ; attempt++) {
    if ((await backend.head(progressMarkerKey(options.tenantId, seq))) === null) {
      break;
    }
    if (attempt >= MARKER_COLLISION_TRIES) {
      throw new Error(
        `progress marker ${seq} exists already: the storage is ahead of the database (was a database dump restored?)`,
      );
    }
    if (options.onCollision) {
      const ours = await markerIsOurs(
        backend,
        options.tenantId,
        seq,
        await options.installationId(),
      );
      await options.onCollision(options.tenantId, seq, { ours });
    }
    seq = await options.allocate(options.tenantId);
  }
  const body: ProgressMarkerBody = {
    format: PROGRESS_MARKER_FORMAT,
    installationId: await options.installationId(),
    tenantId: options.tenantId,
    seq,
    writtenAt: (options.now?.() ?? new Date()).toISOString(),
    writer: options.writer,
    version: options.version ?? null,
  };
  await backend.put(progressMarkerKey(options.tenantId, seq), Buffer.from(JSON.stringify(body)), {
    contentType: "application/json",
  });
  return seq;
}

/**
 * `backend` with progress markers: before the first data write for the tenant on this target in
 * this process, and when the last marker is older than the interval, a marker is written first
 * (single-flight per tenant and target). A marker that cannot be written fails the data write.
 */
export function withProgressMarkers(
  backend: StorageBackend,
  options: ProgressMarkerOptions,
): StorageBackend {
  const stateKey = `${options.tenantId}|${options.targetId}`;
  const interval = options.intervalMs ?? DEFAULT_PROGRESS_MARKER_INTERVAL_MS;
  const clock = () => (options.now?.() ?? new Date()).getTime();
  const ensureMarker = async (): Promise<void> => {
    for (;;) {
      const state = markerStates.get(stateKey) ?? {
        lastAt: Number.NEGATIVE_INFINITY,
        inflight: null,
      };
      markerStates.set(stateKey, state);
      if (state.inflight) {
        await state.inflight;
        continue;
      }
      if (clock() - state.lastAt < interval) {
        return;
      }
      const writing = (async () => {
        await writeProgressMarker(backend, options);
        state.lastAt = clock();
      })();
      state.inflight = writing;
      try {
        await writing;
      } finally {
        state.inflight = null;
      }
      return;
    }
  };
  const wrapped: StorageBackend & { [WRAPPED_BACKEND]: StorageBackend } = {
    [WRAPPED_BACKEND]: backend,
    async put(key: string, data: Buffer | Readable, putOptions?: PutOptions): Promise<void> {
      if (isDataKey(key)) {
        try {
          await ensureMarker();
        } catch (error) {
          if (!Buffer.isBuffer(data)) {
            data.destroy();
          }
          throw new Error("the storage progress marker could not be written", { cause: error });
        }
      }
      await backend.put(key, data, putOptions);
    },
    get: (key: string): Promise<Buffer> => backend.get(key),
    getStream: (key: string): Promise<Readable> => backend.getStream(key),
    head: (key: string): Promise<HeadResult | null> => backend.head(key),
    list: (prefix: string): Promise<string[]> => backend.list(prefix),
    delete: (key: string): Promise<void> => backend.delete(key),
  };
  if (backend.getRange) {
    const getRange = backend.getRange.bind(backend);
    wrapped.getRange = (key: string, start: number, end: number) => getRange(key, start, end);
  }
  if (backend.listWithSizes) {
    const listWithSizes = backend.listWithSizes.bind(backend);
    wrapped.listWithSizes = (prefix: string) => listWithSizes(prefix);
  }
  if (backend.retention) {
    const retention = backend.retention.bind(backend);
    wrapped.retention = (key: string): Promise<ObjectRetention | null> => retention(key);
  }
  if (backend.setRetention) {
    const setRetention = backend.setRetention.bind(backend);
    wrapped.setRetention = (key, until, mode) => setRetention(key, until, mode);
  }
  if (backend.deleteAllVersions) {
    const deleteAllVersions = backend.deleteAllVersions.bind(backend);
    wrapped.deleteAllVersions = (key, now) => deleteAllVersions(key, now);
  }
  if (backend.rootState) {
    const rootState = backend.rootState.bind(backend);
    wrapped.rootState = () => rootState();
  }
  if (backend.freeSpace) {
    const freeSpace = backend.freeSpace.bind(backend);
    wrapped.freeSpace = () => freeSpace();
  }
  return wrapped;
}

// ---------------------------------------------------------------------------
// Comparison
// ---------------------------------------------------------------------------

export type ProgressOutcome = "ok" | "ahead" | "unreachable" | "foreign" | "none";

export interface TargetProgress {
  readonly targetId: string;
  readonly outcome: ProgressOutcome;
  /** The newest marker on the target (any installation), null without one. */
  readonly storageMaxSeq: number | null;
  /** The newest marker of this installation above the database's value, when there is one. */
  readonly aheadSeq: number | null;
  readonly dbSeq: number;
  /** Wrapped key versions in storage above the database's newest one. */
  readonly unknownKeyVersions: readonly number[];
  readonly detail: string | null;
}

export interface CompareProgressInput {
  readonly tenantId: string;
  readonly targetId: string;
  readonly backend: StorageBackend;
  /** The database's progress value, read after the listing. */
  readonly readDbSeq: () => Promise<number>;
  /** The database's newest key version of the tenant, read after the listing. */
  readonly readDbKeyMax: () => Promise<number>;
  readonly installationId: string | null;
  /** How many of the markers above the database's value are read for their installation. */
  readonly bodiesToRead?: number;
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message.slice(0, 300) : String(error).slice(0, 300);
}

/**
 * Compare one target with the database (the order matters: storage first, the database after).
 * Never throws for the storage: a target that cannot be read is `unreachable`.
 */
export async function compareStorageProgress(input: CompareProgressInput): Promise<TargetProgress> {
  let markerKeys: string[];
  let keyKeys: string[];
  try {
    markerKeys = await input.backend.list(progressPrefix(input.tenantId));
    keyKeys = await input.backend.list(`${tenantPrefix(input.tenantId)}keys/`);
  } catch (error) {
    const dbSeq = await input.readDbSeq();
    return {
      targetId: input.targetId,
      outcome: "unreachable",
      storageMaxSeq: null,
      aheadSeq: null,
      dbSeq,
      unknownKeyVersions: [],
      detail: messageOf(error),
    };
  }
  const dbSeq = await input.readDbSeq();
  const dbKeyMax = await input.readDbKeyMax();
  const seqs = markerKeys
    .map((key) => parseProgressMarkerKey(key))
    .filter(
      (marker): marker is { tenantId: string; seq: number } => marker?.tenantId === input.tenantId,
    )
    .map((marker) => marker.seq)
    .sort((a, b) => b - a);
  const unknownKeyVersions = keyKeys
    .map((key) => /\/keys\/(\d+)$/.exec(key)?.[1])
    .filter((version): version is string => version !== undefined)
    .map(Number)
    .filter((version) => version > dbKeyMax)
    .sort((a, b) => a - b);
  const storageMaxSeq = seqs[0] ?? null;
  const above = seqs.filter((seq) => seq > dbSeq);
  let aheadSeq: number | null = null;
  let foreign = false;
  let detail: string | null = null;
  for (const seq of above.slice(0, input.bodiesToRead ?? 5)) {
    let body: Partial<ProgressMarkerBody>;
    try {
      body = JSON.parse(
        (await input.backend.get(progressMarkerKey(input.tenantId, seq))).toString("utf8"),
      ) as Partial<ProgressMarkerBody>;
    } catch (error) {
      // A marker above the database that cannot be read still says the storage is ahead.
      aheadSeq = aheadSeq ?? seq;
      detail = `marker ${seq} unreadable: ${messageOf(error)}`;
      continue;
    }
    if ((body.installationId ?? null) === input.installationId) {
      aheadSeq = aheadSeq ?? seq;
    } else {
      foreign = true;
      detail = `marker ${seq} written by installation ${String(body.installationId)}`;
    }
  }
  const outcome: ProgressOutcome =
    aheadSeq !== null || unknownKeyVersions.length > 0
      ? "ahead"
      : foreign
        ? "foreign"
        : storageMaxSeq === null
          ? "none"
          : "ok";
  return {
    targetId: input.targetId,
    outcome,
    storageMaxSeq,
    aheadSeq,
    dbSeq,
    unknownKeyVersions,
    detail:
      outcome === "ahead" && !detail
        ? aheadSeq !== null
          ? `storage marker ${aheadSeq} is above the database's ${dbSeq}`
          : `key versions ${unknownKeyVersions.join(", ")} are not in the database`
        : detail,
  };
}

/**
 * Delete the markers in folders before the one before `currentSeq`'s (a mutable target only;
 * the caller holds a `progress_marker_prune` permit). Returns how many were deleted.
 */
export async function pruneProgressMarkers(
  backend: StorageBackend,
  tenantId: string,
  currentSeq: number,
): Promise<number> {
  const keep = progressFolderOf(currentSeq) - 1;
  let removed = 0;
  for (const key of await backend.list(progressPrefix(tenantId))) {
    const marker = parseProgressMarkerKey(key);
    if (marker && progressFolderOf(marker.seq) < keep) {
      await backend.delete(key);
      removed++;
    }
  }
  return removed;
}
