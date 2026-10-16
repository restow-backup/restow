/**
 * Immutable backups (docs/STORAGE.md, "Immutable backups").
 *
 * A storage target (a repository in the web interface) can be given an
 * immutability period. What that means depends on the kind of target:
 *
 *   - S3 with Object Lock (`compliance` or `governance`): every object a
 *     backup needs is written with an Object Lock retention, so the storage
 *     itself refuses to delete or overwrite that version before the date,
 *     whoever asks: Restow, an attacker holding Restow's access key, an
 *     administrator of Restow. In COMPLIANCE mode not even the bucket's root
 *     account can shorten it; GOVERNANCE can be lifted by a principal with
 *     `s3:BypassGovernanceRetention`, a permission Restow never uses.
 *   - A directory (local disk, NFS mount; `delayed_deletion`): Restow's own
 *     code refuses to delete or overwrite a backup file before the period has
 *     passed. That protects against misuse of Restow (a stolen admin account,
 *     a retention policy shortened by mistake or on purpose), never against
 *     someone with access to the server or the share: it is not immutability,
 *     and the interface says so.
 *
 * Which objects are protected is decided by key ({@link lockClassOf}): packs,
 * committed manifests and wrapped tenant keys of the chunk store, and the
 * packs, snapshots, keys and config of a restic repository (endpoints, file
 * shares, PVE containers); restic's lock and index files are not locked. Checkpoints, uploads in staging, exports,
 * downloads and probes are transient and stay unlocked; archive records
 * carry their own retention (docs/ARCHIVE.md) and pass through unchanged.
 *
 * Deduplication reuses old objects: an incremental backup today can rest on a
 * pack written months ago, whose own retention ran out long ago. So objects
 * are locked for the period plus a renewal buffer ({@link RENEWAL_BUFFER_DAYS}),
 * and a renewal pass ({@link renewRetention}, run by the worker's daily
 * retention job) moves the retention of every object still in use to
 * `now + period + buffer` whenever the last pass is older than the buffer
 * minus a day. Between two passes every object in use stays locked for at
 * least the period beyond "now", so a restore point made now is covered for
 * its whole period, including what it reuses.
 */
import type { Readable } from "node:stream";
import {
  type HeadResult,
  listWithSizes,
  ObjectLockedError,
  type ObjectLockMode,
  type ObjectRetention,
  type PutOptions,
  readRange,
  type StorageBackend,
} from "./backend.js";

/** How a target protects its backups. */
export type ImmutabilityMode = "compliance" | "governance" | "delayed_deletion";

export const IMMUTABILITY_MODES: readonly ImmutabilityMode[] = [
  "compliance",
  "governance",
  "delayed_deletion",
];

/** The shortest and longest period a target can be given, in days. */
export const MIN_IMMUTABILITY_DAYS = 1;
export const MAX_IMMUTABILITY_DAYS = 3650;

/**
 * Days added to every lock beyond the period, so a renewal pass every few
 * days keeps everything in use locked for at least the period beyond "now".
 */
export const RENEWAL_BUFFER_DAYS = 7;

/** A renewal pass is due once the last one is this old (the buffer minus a day of slack). */
export const RENEWAL_INTERVAL_DAYS = RENEWAL_BUFFER_DAYS - 1;

const DAY_MS = 24 * 60 * 60 * 1000;

/** One period in a target's history: from `since` on, new objects got `days` (0 = off). */
export interface ImmutabilityPeriod {
  /** ISO 8601. */
  readonly since: string;
  readonly days: number;
  readonly mode: ImmutabilityMode | null;
}

/**
 * The stored immutability of a target (`storage_targets.immutability`):
 * the current setting and every earlier one, so a lowered or disabled period
 * never applies to what was written before (the deletion delay of a directory
 * follows the history; S3 enforces it by itself).
 */
export interface ImmutabilitySettings {
  readonly mode: ImmutabilityMode | null;
  readonly days: number;
  readonly history: readonly ImmutabilityPeriod[];
}

/** Whether the setting protects anything right now. */
export function immutabilityActive(
  settings: ImmutabilitySettings | null | undefined,
): settings is ImmutabilitySettings & { mode: ImmutabilityMode } {
  return !!settings && settings.mode !== null && settings.days > 0;
}

/** The S3 mode of an Object Lock setting, or null for a directory's deletion delay. */
export function s3LockMode(mode: ImmutabilityMode | null): ObjectLockMode | null {
  if (mode === "compliance") {
    return "COMPLIANCE";
  }
  if (mode === "governance") {
    return "GOVERNANCE";
  }
  return null;
}

/** Read the stored JSON leniently: anything malformed counts as "off". */
export function parseImmutabilitySettings(value: unknown): ImmutabilitySettings | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return null;
  }
  const raw = value as Record<string, unknown>;
  const mode =
    typeof raw.mode === "string" && (IMMUTABILITY_MODES as readonly string[]).includes(raw.mode)
      ? (raw.mode as ImmutabilityMode)
      : null;
  const days =
    typeof raw.days === "number" && Number.isInteger(raw.days) && raw.days > 0 ? raw.days : 0;
  const history: ImmutabilityPeriod[] = [];
  if (Array.isArray(raw.history)) {
    for (const entry of raw.history) {
      if (!entry || typeof entry !== "object") {
        continue;
      }
      const item = entry as Record<string, unknown>;
      if (typeof item.since !== "string" || Number.isNaN(Date.parse(item.since))) {
        continue;
      }
      const itemDays =
        typeof item.days === "number" && Number.isInteger(item.days) && item.days > 0
          ? item.days
          : 0;
      const itemMode =
        typeof item.mode === "string" &&
        (IMMUTABILITY_MODES as readonly string[]).includes(item.mode)
          ? (item.mode as ImmutabilityMode)
          : null;
      history.push({ since: item.since, days: itemDays, mode: itemMode });
    }
  }
  history.sort((a, b) => Date.parse(a.since) - Date.parse(b.since));
  return { mode: mode && days > 0 ? mode : null, days: mode ? days : 0, history };
}

/** How strong a setting is, to tell raising from lowering. */
const STRENGTH: Record<ImmutabilityMode, number> = {
  delayed_deletion: 1,
  governance: 2,
  compliance: 3,
};

/**
 * Whether going from `current` to `next` weakens the protection of what is
 * written from now on: fewer days, off, or a weaker mode. Lowering is for the
 * provider owner with a recent sign-in only, and never reaches back.
 */
export function lowersImmutability(
  current: Pick<ImmutabilitySettings, "mode" | "days"> | null,
  next: Pick<ImmutabilitySettings, "mode" | "days">,
): boolean {
  const before = current?.mode && current.days > 0 ? current : null;
  if (!before) {
    return false;
  }
  if (!next.mode || next.days <= 0) {
    return true;
  }
  if (next.days < before.days) {
    return true;
  }
  return STRENGTH[next.mode] < STRENGTH[before.mode as ImmutabilityMode];
}

/** The settings after a change at `at`: the new values, with the change appended to the history. */
export function changeImmutability(
  current: ImmutabilitySettings | null,
  next: { mode: ImmutabilityMode | null; days: number },
  at: Date,
): ImmutabilitySettings {
  const mode = next.mode && next.days > 0 ? next.mode : null;
  const days = mode ? next.days : 0;
  return {
    mode,
    days,
    history: [...(current?.history ?? []), { since: at.toISOString(), days, mode }],
  };
}

/**
 * Until when the deletion delay protects a file written at `writtenAt`: the
 * longest period in force at any time since it was written. A period lowered
 * or switched off later therefore never shortens it; a period raised later
 * lengthens it.
 */
export function delayedUntil(writtenAt: Date, history: readonly ImmutabilityPeriod[]): Date | null {
  const written = writtenAt.getTime();
  let days = 0;
  for (let index = 0; index < history.length; index++) {
    const entry = history[index] as ImmutabilityPeriod;
    const next = history[index + 1];
    const endsAt = next ? Date.parse(next.since) : Number.POSITIVE_INFINITY;
    // The entry was in force during [since, endsAt); it applies when that overlaps [written, ∞).
    if (endsAt > written && entry.mode === "delayed_deletion") {
      days = Math.max(days, entry.days);
    }
  }
  return days > 0 ? new Date(written + days * DAY_MS) : null;
}

/** What a key holds, as far as immutability is concerned. */
export type LockClass =
  /** Backup data: locked for the period and renewed while in use. */
  | "backup"
  /** Archive records: they carry their own retention (docs/ARCHIVE.md); passed through. */
  | "archive"
  /** Transient (checkpoints, staging, exports, downloads, probes, restic locks): never locked. */
  | "transient";

const TENANT_BACKUP = /^tenants\/[^/]+\/(?:packs\/.+|manifests\/[^/]+\.json\.zst|keys\/[^/]+)$/;
const TENANT_ARCHIVE = /^tenants\/[^/]+\/archive\//;
const RESTIC_REPOSITORY = /^(?:endpoints|file-shares|pve-guests)\/[^/]+\/(.+)$/;

/** The {@link LockClass} of a storage key. */
export function lockClassOf(key: string): LockClass {
  if (TENANT_BACKUP.test(key)) {
    return "backup";
  }
  if (TENANT_ARCHIVE.test(key)) {
    return "archive";
  }
  const restic = RESTIC_REPOSITORY.exec(key);
  if (restic) {
    const path = restic[1] as string;
    // restic writes and removes its lock files all the time; locking them would block every
    // run. Index files are rewritten by every prune, and restic stops a prune for good when it
    // cannot remove an old one; they only list what the packs hold, so `restic repair index`
    // rebuilds them from the locked packs (docs/STORAGE.md, "Immutable backups").
    return path.startsWith("locks/") || path.startsWith("index/") ? "transient" : "backup";
  }
  return "transient";
}

/** The retain-until date a write at `now` gets: the period plus the renewal buffer. */
export function lockUntil(now: Date, days: number): Date {
  return new Date(now.getTime() + (days + RENEWAL_BUFFER_DAYS) * DAY_MS);
}

/** Whether a renewal pass is due, given the start of the last complete one. */
export function renewalDue(lastRenewedAt: Date | null, now: Date): boolean {
  return (
    lastRenewedAt === null ||
    now.getTime() - lastRenewedAt.getTime() >= RENEWAL_INTERVAL_DAYS * DAY_MS
  );
}

/**
 * Whether an unfinished renewal pass that started at `startedAt` may still be continued: its
 * retain-until date is at most a renewal interval old, as if the pass had not been interrupted.
 */
export function renewalResumable(startedAt: Date, now: Date): boolean {
  const age = now.getTime() - startedAt.getTime();
  return age >= 0 && age < RENEWAL_INTERVAL_DAYS * DAY_MS;
}

/**
 * Whether the renewal is late enough that reused data may no longer be locked
 * for the whole period: the last complete pass is older than the buffer.
 */
export function renewalOverdue(lastRenewedAt: Date | null, since: Date, now: Date): boolean {
  const reference = lastRenewedAt ?? since;
  return now.getTime() - reference.getTime() > RENEWAL_BUFFER_DAYS * DAY_MS;
}

/** What a target says about one object's protection. */
export interface ObjectProtection {
  /** Null: not protected (no retention, or the deletion delay has passed). */
  readonly until: Date | null;
  /** `object_lock`: the storage reported it (S3); `deletion_delay`: Restow computed it. */
  readonly source: "object_lock" | "deletion_delay";
  readonly mode: ObjectLockMode | null;
  /** False when the object does not exist. */
  readonly exists: boolean;
}

export interface ImmutableStorageOptions {
  readonly settings: ImmutabilitySettings;
  readonly now?: () => Date;
  /** The `storage_targets` row this backend opens, so deferred deletions can name it. */
  readonly targetId?: string;
}

/**
 * A backend with a target's immutability applied (see the module comment).
 * Reads and listings pass straight through.
 */
export class ImmutableStorageBackend implements StorageBackend {
  readonly settings: ImmutabilitySettings;
  readonly targetId: string | null;
  private readonly now: () => Date;

  constructor(
    readonly inner: StorageBackend,
    options: ImmutableStorageOptions,
  ) {
    this.settings = options.settings;
    this.targetId = options.targetId ?? null;
    this.now = options.now ?? (() => new Date());
  }

  /** Object Lock on S3 (COMPLIANCE or GOVERNANCE), else null (the deletion delay of a directory). */
  get lockMode(): ObjectLockMode | null {
    return s3LockMode(this.settings.mode);
  }

  /** Whether new backup objects are protected (the setting is on). */
  get active(): boolean {
    return immutabilityActive(this.settings);
  }

  async put(key: string, data: Buffer | Readable, options?: PutOptions): Promise<void> {
    const lockClass = lockClassOf(key);
    const lockMode = this.lockMode;
    if (lockClass === "backup" && this.active && lockMode) {
      await this.inner.put(key, data, {
        ...options,
        retainUntil: lockUntil(this.now(), this.settings.days),
        lockMode,
      });
      return;
    }
    if (lockClass === "backup" && !lockMode) {
      // A directory: an existing file still inside its deletion delay is not overwritten.
      const head = await this.inner.head(key);
      const until = head ? this.delayOf(head) : null;
      if (until && until.getTime() > this.now().getTime()) {
        if (!Buffer.isBuffer(data)) {
          data.destroy();
        }
        throw new ObjectLockedError(key, until, "deletion_delay");
      }
    }
    await this.inner.put(key, data, options);
  }

  async delete(key: string): Promise<void> {
    if (this.inner.deleteAllVersions && this.isObjectLockTarget()) {
      // Every version goes (a delete marker alone frees nothing), and none while one is locked.
      await this.inner.deleteAllVersions(key, this.now());
      return;
    }
    if (lockClassOf(key) === "backup") {
      const head = await this.inner.head(key);
      if (!head) {
        return;
      }
      const until = this.delayOf(head);
      if (until && until.getTime() > this.now().getTime()) {
        throw new ObjectLockedError(key, until, "deletion_delay");
      }
    }
    await this.inner.delete(key);
  }

  /**
   * Whether this target uses Object Lock: set to an S3 mode now, or ever was
   * (objects written then are still locked and must be deleted version by version).
   */
  private isObjectLockTarget(): boolean {
    return (
      this.lockMode !== null ||
      this.settings.history.some((entry) => s3LockMode(entry.mode) !== null)
    );
  }

  private delayOf(head: HeadResult): Date | null {
    return head.lastModified ? delayedUntil(head.lastModified, this.settings.history) : null;
  }

  /** How `key` is protected right now, asked of the storage where it can answer. */
  async protection(key: string): Promise<ObjectProtection> {
    if (this.inner.retention && this.isObjectLockTarget()) {
      const retention = await this.inner.retention(key);
      if (!retention) {
        return { until: null, source: "object_lock", mode: null, exists: false };
      }
      const locked =
        retention.retainUntil !== null && retention.retainUntil.getTime() > this.now().getTime();
      return {
        until: locked ? retention.retainUntil : null,
        source: "object_lock",
        mode: locked ? retention.mode : null,
        exists: true,
      };
    }
    const head = await this.inner.head(key);
    if (!head) {
      return { until: null, source: "deletion_delay", mode: null, exists: false };
    }
    const until = lockClassOf(key) === "backup" ? this.delayOf(head) : null;
    return {
      until: until && until.getTime() > this.now().getTime() ? until : null,
      source: "deletion_delay",
      mode: null,
      exists: true,
    };
  }

  get(key: string): Promise<Buffer> {
    return this.inner.get(key);
  }

  getStream(key: string): Promise<Readable> {
    return this.inner.getStream(key);
  }

  head(key: string): Promise<HeadResult | null> {
    return this.inner.head(key);
  }

  list(prefix: string): Promise<string[]> {
    return this.inner.list(prefix);
  }

  getRange(key: string, start: number, end: number): Promise<Readable> {
    return readRange(this.inner, key, start, end);
  }

  listWithSizes(prefix: string): Promise<{ key: string; size: number }[]> {
    return listWithSizes(this.inner, prefix);
  }

  retention(key: string): Promise<ObjectRetention | null> {
    if (!this.inner.retention) {
      return Promise.reject(new Error("this storage does not report retention"));
    }
    return this.inner.retention(key);
  }
}

/** The immutable view of a backend, when it has one (unwrapping read-only fallbacks is the caller's). */
export function immutableBackendOf(backend: StorageBackend): ImmutableStorageBackend | null {
  return backend instanceof ImmutableStorageBackend ? backend : null;
}

/** Apply a target's stored immutability to its backend; without a setting or history it stays as is. */
export function withImmutability(
  backend: StorageBackend,
  settings: ImmutabilitySettings | null,
  options: { readonly now?: () => Date; readonly targetId?: string } = {},
): StorageBackend {
  if (!settings || (settings.mode === null && settings.history.length === 0)) {
    return backend;
  }
  return new ImmutableStorageBackend(backend, { settings, ...options });
}

// ---------------------------------------------------------------------------
// Renewal
// ---------------------------------------------------------------------------

export interface RenewalReport {
  /** Objects whose retention now reaches `until`. */
  extended: number;
  /** Objects already locked beyond `until` (written with a longer period). */
  alreadyLonger: number;
  /** Objects that were not there (removed meanwhile, or hidden by a delete marker). */
  missing: string[];
  /** Objects whose retention could not be set: the keys, capped, and how many in all. */
  failed: { key: string; error: string }[];
  failedTotal: number;
  until: string;
  /**
   * Every key up to this one (in sorted order) is settled: renewed, already locked longer or
   * gone. An interrupted or partly failed pass continues after it. Null: none yet.
   */
  resumeAfter: string | null;
}

export interface RenewalOptions {
  readonly signal?: AbortSignal;
  /** Requests in flight at once (default {@link RENEWAL_CONCURRENCY}). */
  readonly concurrency?: number;
  /** Continue a pass: keys up to and including this one were settled already. */
  readonly after?: string | null;
  /** Told the new {@link RenewalReport.resumeAfter} every `progressEvery` keys, in order. */
  readonly onProgress?: (resumeAfter: string) => Promise<void> | void;
  readonly progressEvery?: number;
}

/** Retention requests a renewal pass keeps in flight by default. */
export const RENEWAL_CONCURRENCY = 32;

const MAX_REPORTED = 50;
const PROGRESS_EVERY = 5_000;

/**
 * Move the Object Lock retention of `keys` on `backend` to `until`. The
 * storage refuses to shorten one, so a key already locked longer is checked
 * and counted instead of failed. Keys go in sorted order, so a pass that
 * ends early continues from {@link RenewalReport.resumeAfter} instead of
 * from the start.
 */
export async function renewRetention(
  backend: ImmutableStorageBackend,
  keys: Iterable<string>,
  until: Date,
  options: RenewalOptions = {},
): Promise<RenewalReport> {
  const mode = backend.lockMode;
  const inner = backend.inner;
  if (!mode || !inner.setRetention || !inner.retention) {
    throw new Error("renewal needs an S3 target with Object Lock");
  }
  const setRetention = inner.setRetention.bind(inner);
  const retention = inner.retention.bind(inner);
  const after = options.after ?? null;
  const report: RenewalReport = {
    extended: 0,
    alreadyLonger: 0,
    missing: [],
    failed: [],
    failedTotal: 0,
    until: until.toISOString(),
    resumeAfter: after,
  };
  const queue = [...new Set(keys)].filter((key) => after === null || key > after).sort();
  // The resume point: every key before index `settledUpTo` is settled; a failed key stops it.
  const settled = new Uint8Array(queue.length);
  const SETTLED = 1;
  const FAILED = 2;
  let settledUpTo = 0;
  let reported = 0;
  let progress: Promise<void> = Promise.resolve();
  const every = options.progressEvery ?? PROGRESS_EVERY;
  const settle = (index: number, outcome: number) => {
    settled[index] = outcome;
    while (settledUpTo < queue.length && settled[settledUpTo] === SETTLED) {
      settledUpTo++;
    }
    if (settledUpTo > 0) {
      report.resumeAfter = queue[settledUpTo - 1] as string;
    }
    if (options.onProgress && settledUpTo - reported >= every) {
      reported = settledUpTo;
      const point = report.resumeAfter as string;
      const notify = options.onProgress;
      progress = progress.then(() => notify(point));
    }
  };
  let next = 0;
  const worker = async () => {
    while (next < queue.length) {
      if (options.signal?.aborted) {
        return;
      }
      const index = next++;
      const key = queue[index] as string;
      try {
        await setRetention(key, until, mode);
        report.extended++;
        settle(index, SETTLED);
      } catch (error) {
        const current = await retention(key).catch(() => undefined);
        if (current === null) {
          if (report.missing.length < MAX_REPORTED) {
            report.missing.push(key);
          }
          settle(index, SETTLED);
          continue;
        }
        if (current?.retainUntil && current.retainUntil.getTime() >= until.getTime()) {
          report.alreadyLonger++;
          settle(index, SETTLED);
          continue;
        }
        report.failedTotal++;
        settle(index, FAILED);
        if (report.failed.length < MAX_REPORTED) {
          report.failed.push({
            key,
            error: error instanceof Error ? error.message : String(error),
          });
        }
      }
    }
  };
  const concurrency = options.concurrency ?? RENEWAL_CONCURRENCY;
  await Promise.all(
    Array.from({ length: Math.max(1, Math.min(concurrency, queue.length)) }, worker),
  );
  await progress;
  return report;
}

// ---------------------------------------------------------------------------
// Verification
// ---------------------------------------------------------------------------

export interface VerificationSample {
  readonly key: string;
  readonly state: "locked" | "unlocked" | "weaker_mode" | "missing" | "error";
  readonly until: string | null;
  readonly detail?: string;
}

export interface VerificationReport {
  readonly checkedAt: string;
  readonly sampled: number;
  readonly locked: number;
  /** Objects written for backups that carry no retention, or one already over. */
  readonly unlocked: number;
  /** Locked in GOVERNANCE although the target asks for COMPLIANCE. */
  readonly weakerMode: number;
  readonly missing: number;
  readonly errors: number;
  /** The problem cases (capped). */
  readonly problems: readonly VerificationSample[];
}

/**
 * Ask the storage for the retention of a sample of objects that were written
 * while the target was set to Object Lock and are still in use: each must be
 * locked beyond now, in the configured mode (or stronger). An unlocked one
 * means an object was written without lock (a worker with an outdated
 * setting, a storage that ignored the header) and is shown as a warning.
 */
export async function verifyImmutability(
  backend: ImmutableStorageBackend,
  keys: readonly string[],
  now: Date,
): Promise<VerificationReport> {
  const expected = backend.lockMode;
  const problems: VerificationSample[] = [];
  let locked = 0;
  let unlocked = 0;
  let weakerMode = 0;
  let missing = 0;
  let errors = 0;
  for (const key of keys) {
    try {
      const protection = await backend.protection(key);
      if (!protection.exists) {
        missing++;
        problems.push({ key, state: "missing", until: null });
      } else if (!protection.until || protection.until.getTime() <= now.getTime()) {
        unlocked++;
        problems.push({ key, state: "unlocked", until: null });
      } else if (expected === "COMPLIANCE" && protection.mode !== "COMPLIANCE") {
        weakerMode++;
        problems.push({ key, state: "weaker_mode", until: protection.until.toISOString() });
      } else {
        locked++;
      }
    } catch (error) {
      errors++;
      problems.push({
        key,
        state: "error",
        until: null,
        detail: error instanceof Error ? error.message : String(error),
      });
    }
  }
  return {
    checkedAt: now.toISOString(),
    sampled: keys.length,
    locked,
    unlocked,
    weakerMode,
    missing,
    errors,
    problems: problems.slice(0, MAX_REPORTED),
  };
}

/** Pick up to `count` keys spread evenly over `keys` (deterministic, newest last). */
export function spreadSample<T>(items: readonly T[], count: number): T[] {
  if (items.length <= count) {
    return [...items];
  }
  const picked: T[] = [];
  const step = items.length / count;
  for (let index = 0; index < count; index++) {
    picked.push(items[Math.min(items.length - 1, Math.floor(index * step + step / 2))] as T);
  }
  return picked;
}

/**
 * The longest protection any immutable target among `backends` gives `key`
 * right now, or null when none protects it (or none is immutable). Used to
 * leave restore points out of retention while they are locked.
 */
export async function protectionOnTargets(
  backends: readonly StorageBackend[],
  key: string,
): Promise<{ until: Date; source: ObjectProtection["source"] } | null> {
  let best: { until: Date; source: ObjectProtection["source"] } | null = null;
  for (const backend of backends) {
    const immutable = immutableBackendOf(backend);
    if (!immutable) {
      continue;
    }
    const protection = await immutable.protection(key);
    if (protection.until && (!best || protection.until > best.until)) {
      best = { until: protection.until, source: protection.source };
    }
  }
  return best;
}

/**
 * Split restic snapshot ids into those retention may forget and those whose
 * snapshot file the repository's storage still locks. restic itself cannot
 * remove a locked snapshot (its forget ends with a warning, exit code 3), so
 * retention leaves them out and tries again on a later run.
 */
export async function splitLockedSnapshots(
  storage: StorageBackend,
  prefix: string,
  ids: readonly string[],
): Promise<{ remove: string[]; locked: { id: string; until: Date }[] }> {
  const immutable = immutableBackendOf(storage);
  if (!immutable) {
    return { remove: [...ids], locked: [] };
  }
  const remove: string[] = [];
  const locked: { id: string; until: Date }[] = [];
  for (const id of ids) {
    const protection = await immutable.protection(`${prefix}snapshots/${id}`);
    if (protection.until) {
      locked.push({ id, until: protection.until });
    } else {
      remove.push(id);
    }
  }
  return { remove, locked };
}
