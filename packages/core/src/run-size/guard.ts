import type { StorageSpace } from "../storage/backend.js";

/**
 * The size and space guard of backup runs (#99, docs/STORAGE.md "Unusually large runs"): one
 * run that adds far more than usual (an 879 GB recycle bin someone put into a backup) stops
 * before it fills the storage, and waits for an administrator.
 *
 * Every run is measured while it writes: the bytes it uploads (restic: what the server's REST
 * endpoint stores for it; the chunk store: the packs it writes). Before each upload the guard asks
 *
 *   size   does the run pass its limit? The limit is the larger of `factor` (10) times the
 *          median of the object's last `historyRuns` (10) successful runs, `minBytes` (10 GiB:
 *          small objects never trip it) and the object's own `limitBytes`. With fewer than
 *          `minHistory` (3) runs behind it a run counts as a first run: exempt, unless
 *          `firstRunBytes` sets a limit for it.
 *   space  would the upload leave the storage target less than `minFreePercent` (2) of its size
 *          free? Only where the target reports its space (a directory, an NFS or SMB mount);
 *          an S3 bucket reports none, there the size rule alone applies.
 *
 * Either one holds the run: the upload is refused, the run ends, an administrator is alerted
 * (`backup.unusually_large`) and decides: continue once, raise the object's limit, or switch the
 * guard off for it. Until then every further run of the object is held at its first upload.
 * Settings layer: these defaults, then the tenant's, then the object's.
 */

export const RUN_SIZE_OBJECT_KINDS = ["endpoint", "file_share", "pve_guest", "m365"] as const;
export type RunSizeObjectKind = (typeof RUN_SIZE_OBJECT_KINDS)[number];

const GIB = 1024 ** 3;

export interface RunSizeGuardSettings {
  /** False switches the whole guard off (size and space). */
  readonly enabled: boolean;
  /** A run may add this many times the median of the object's earlier runs. */
  readonly factor: number;
  /** Runs needed before the factor applies; with fewer, a run counts as a first run. */
  readonly minHistory: number;
  /** How many of the newest successful runs the median is taken over. */
  readonly historyRuns: number;
  /** A run is never held for its size below this. */
  readonly minBytes: number;
  /** The object's own allowance: the limit is at least this (null: none). */
  readonly limitBytes: number | null;
  /** A first run's limit (null: first runs are exempt from the size rule). */
  readonly firstRunBytes: number | null;
  /** A run is held when it would leave the target less than this share free (0: off). */
  readonly minFreePercent: number;
}

export const DEFAULT_RUN_SIZE_GUARD: RunSizeGuardSettings = {
  enabled: true,
  factor: 10,
  minHistory: 3,
  historyRuns: 10,
  minBytes: 10 * GIB,
  limitBytes: null,
  firstRunBytes: null,
  minFreePercent: 2,
};

/** What a tenant or an object sets; anything left out comes from the layer below. */
export interface RunSizeGuardOverride {
  enabled?: boolean;
  factor?: number;
  minBytes?: number;
  limitBytes?: number | null;
  firstRunBytes?: number | null;
  minFreePercent?: number;
}

export const RUN_SIZE_FACTOR_RANGE = { min: 2, max: 1000 } as const;
export const RUN_SIZE_MAX_BYTES = 1024 ** 5; // 1 PiB
export const RUN_SIZE_FREE_PERCENT_MAX = 50;

function finiteNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value);
}

function bytesOrNull(value: unknown): number | null | undefined {
  if (value === null) {
    return null;
  }
  return finiteNumber(value) && value >= 0 && value <= RUN_SIZE_MAX_BYTES
    ? Math.round(value)
    : undefined;
}

/** A stored override as far as it is valid; what is not is left out (the layer below applies). */
export function parseRunSizeOverride(value: unknown): RunSizeGuardOverride {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    return {};
  }
  const v = value as Record<string, unknown>;
  const out: RunSizeGuardOverride = {};
  if (typeof v.enabled === "boolean") {
    out.enabled = v.enabled;
  }
  if (
    finiteNumber(v.factor) &&
    v.factor >= RUN_SIZE_FACTOR_RANGE.min &&
    v.factor <= RUN_SIZE_FACTOR_RANGE.max
  ) {
    out.factor = v.factor;
  }
  const minBytes = bytesOrNull(v.minBytes);
  if (typeof minBytes === "number") {
    out.minBytes = minBytes;
  }
  const limitBytes = bytesOrNull(v.limitBytes);
  if (limitBytes !== undefined) {
    out.limitBytes = limitBytes;
  }
  const firstRunBytes = bytesOrNull(v.firstRunBytes);
  if (firstRunBytes !== undefined) {
    out.firstRunBytes = firstRunBytes;
  }
  if (
    finiteNumber(v.minFreePercent) &&
    v.minFreePercent >= 0 &&
    v.minFreePercent <= RUN_SIZE_FREE_PERCENT_MAX
  ) {
    out.minFreePercent = v.minFreePercent;
  }
  return out;
}

/** The settings of one object: the defaults, then the tenant's, then the object's own. */
export function resolveRunSizeGuard(
  tenant?: RunSizeGuardOverride | null,
  object?: RunSizeGuardOverride | null,
): RunSizeGuardSettings {
  return {
    ...DEFAULT_RUN_SIZE_GUARD,
    ...parseRunSizeOverride(tenant),
    ...parseRunSizeOverride(object),
  };
}

export function median(values: readonly number[]): number | null {
  const sorted = values.filter((value) => finiteNumber(value) && value >= 0).sort((a, b) => a - b);
  if (sorted.length === 0) {
    return null;
  }
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 1
    ? (sorted[middle] as number)
    : ((sorted[middle - 1] as number) + (sorted[middle] as number)) / 2;
}

export interface RunSizeLimit {
  /** The bytes a run may add; null: no size limit for this run. */
  readonly limitBytes: number | null;
  /** The median of the object's earlier runs (null without any). */
  readonly medianBytes: number | null;
  /** How many earlier runs it was taken over. */
  readonly historyRuns: number;
  /**
   * `history` the factor applies; `first_run` too little history, `firstRunBytes` applies;
   * `exempt` too little history and no first-run limit; `off` the guard is switched off.
   */
  readonly basis: "history" | "first_run" | "exempt" | "off";
}

/** A run's size limit from the settings and the object's history (newest first, bytes added). */
export function runSizeLimit(
  settings: RunSizeGuardSettings,
  history: readonly number[],
): RunSizeLimit {
  const runs = history.slice(0, settings.historyRuns).filter((value) => finiteNumber(value));
  const typical = median(runs);
  if (!settings.enabled) {
    return { limitBytes: null, medianBytes: typical, historyRuns: runs.length, basis: "off" };
  }
  const own = settings.limitBytes ?? 0;
  if (runs.length < settings.minHistory || typical === null) {
    if (settings.firstRunBytes === null) {
      return {
        limitBytes: null,
        medianBytes: typical,
        historyRuns: runs.length,
        basis: "exempt",
      };
    }
    return {
      limitBytes: Math.max(settings.firstRunBytes, own),
      medianBytes: typical,
      historyRuns: runs.length,
      basis: "first_run",
    };
  }
  return {
    limitBytes: Math.ceil(Math.max(typical * settings.factor, settings.minBytes, own)),
    medianBytes: typical,
    historyRuns: runs.length,
    basis: "history",
  };
}

export type RunSizeVerdict =
  | { readonly hold: false }
  | {
      readonly hold: true;
      readonly reason: "size";
      /** What the run has added with this upload. */
      readonly bytes: number;
      readonly limitBytes: number;
    }
  | {
      readonly hold: true;
      readonly reason: "space";
      readonly bytes: number;
      readonly freeBytes: number;
      readonly totalBytes: number;
      /** The free space the target is to keep. */
      readonly keepBytes: number;
    };

/**
 * Whether the next upload of a run may go: `writtenBytes` it has stored so far, `nextBytes` the
 * upload (its declared length, or a pack's size), `space` the target's as it reports it.
 */
export function judgeRunSize(input: {
  settings: RunSizeGuardSettings;
  limit: RunSizeLimit;
  writtenBytes: number;
  nextBytes: number;
  space: StorageSpace | null;
}): RunSizeVerdict {
  const { settings, limit, space } = input;
  const bytes = Math.max(0, input.writtenBytes) + Math.max(0, input.nextBytes);
  if (!settings.enabled) {
    return { hold: false };
  }
  if (limit.limitBytes !== null && bytes > limit.limitBytes) {
    return { hold: true, reason: "size", bytes, limitBytes: limit.limitBytes };
  }
  if (space && settings.minFreePercent > 0 && space.totalBytes > 0) {
    const keepBytes = Math.ceil((space.totalBytes * settings.minFreePercent) / 100);
    if (space.freeBytes - Math.max(0, input.nextBytes) < keepBytes) {
      return {
        hold: true,
        reason: "space",
        bytes,
        freeBytes: space.freeBytes,
        totalBytes: space.totalBytes,
        keepBytes,
      };
    }
  }
  return { hold: false };
}

/** Bytes in the unit an operator reads (GB/MB with one decimal, binary). */
export function formatRunSizeBytes(bytes: number): string {
  if (bytes >= GIB) {
    return `${(bytes / GIB).toFixed(1)} GiB`;
  }
  return `${(bytes / 1024 ** 2).toFixed(1)} MiB`;
}

/** The English line of a held run, for the log, the notification and the delivery log. */
export function describeRunSizeHold(
  objectName: string,
  verdict: Exclude<RunSizeVerdict, { hold: false }>,
  medianBytes: number | null,
): string {
  if (verdict.reason === "size") {
    const usual = medianBytes !== null ? `, usually ${formatRunSizeBytes(medianBytes)}` : "";
    return `The backup of ${objectName} was held: this run would add more than ${formatRunSizeBytes(verdict.limitBytes)} (${formatRunSizeBytes(verdict.bytes)} so far${usual}). An administrator can let it continue once or raise the limit.`;
  }
  return `The backup of ${objectName} was held: the storage target would keep less than ${formatRunSizeBytes(verdict.keepBytes)} free (${formatRunSizeBytes(verdict.freeBytes)} of ${formatRunSizeBytes(verdict.totalBytes)} free). Free up space, or let it continue once.`;
}
