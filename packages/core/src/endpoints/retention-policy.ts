/**
 * Retention of an endpoint's repository, decided by the server
 * (docs/AGENT.md, "Aufbewahrung").
 *
 * restic's own `forget --keep-*` sorts snapshots by the time written into
 * each snapshot, and the agent writes that time: a compromised machine could
 * add a few dozen snapshots dated in the future and make the server's next
 * retention run forget every genuine backup. So the server never hands the
 * decision to restic. It works out what to keep from facts it controls:
 *
 *   - which snapshots exist: the files under `snapshots/` in the storage;
 *   - which of them are backups: the snapshots runs reported (`endpoint_runs`);
 *   - when each was made: the earlier of the time the storage received its
 *     file (the agent cannot set it, and cannot change it, because an existing
 *     object is never overwritten) and the end of the run that reported it as
 *     the server recorded it (never after the report arrived, at most a day
 *     before). Taking the earlier of the two keeps a copied storage folder,
 *     whose files all carry the time of the copy, from making every snapshot
 *     look new.
 *
 * The policy itself is restic's (keep the newest snapshot of each of the last
 * N days, weeks and months that have one, plus the oldest while a rule has
 * counts left), evaluated in the tenant's time zone. Snapshots no run reported
 * are never deleted; they and snapshots dated in the future are flagged, and
 * the admin is told. Only the ids chosen here are passed to `restic forget`.
 */
import { DEFAULT_SCHEDULE_TIMEZONE } from "../schedule/defaults.js";

/** The keep rules of an endpoint (`endpoints.settings.retention`). */
export interface RetentionRules {
  keepDaily: number;
  keepWeekly: number;
  keepMonthly: number;
}

/** A snapshot with the time the server attributes to it. */
export interface DatedSnapshot {
  readonly id: string;
  readonly time: Date;
}

export interface RetentionDecision {
  /** Newest first. */
  readonly keep: string[];
  readonly remove: string[];
}

const formatters = new Map<string, Intl.DateTimeFormat>();

function formatterFor(timeZone: string): Intl.DateTimeFormat {
  let formatter = formatters.get(timeZone);
  if (!formatter) {
    try {
      formatter = new Intl.DateTimeFormat("en-US", {
        timeZone,
        year: "numeric",
        month: "numeric",
        day: "numeric",
      });
    } catch {
      formatter = formatterFor(DEFAULT_SCHEDULE_TIMEZONE);
    }
    formatters.set(timeZone, formatter);
  }
  return formatter;
}

/** The calendar date of `time` in `timeZone`. */
export function localDate(
  time: Date,
  timeZone: string,
): { year: number; month: number; day: number } {
  const parts = formatterFor(timeZone).formatToParts(time);
  const value = (type: string) => Number(parts.find((part) => part.type === type)?.value ?? 0);
  return { year: value("year"), month: value("month"), day: value("day") };
}

const DAY_MS = 24 * 60 * 60 * 1000;

/** The ISO 8601 week of a calendar date (as Go's `Time.ISOWeek`, which restic uses). */
export function isoWeek(year: number, month: number, day: number): { year: number; week: number } {
  const date = Date.UTC(year, month - 1, day);
  const weekday = (new Date(date).getUTCDay() + 6) % 7; // Monday = 0
  const thursday = date + (3 - weekday) * DAY_MS;
  const weekYear = new Date(thursday).getUTCFullYear();
  const week = Math.floor((thursday - Date.UTC(weekYear, 0, 1)) / DAY_MS / 7) + 1;
  return { year: weekYear, week };
}

type CalendarDate = { year: number; month: number; day: number };

/**
 * restic's `ApplyPolicy` for the daily, weekly and monthly rules: newest
 * first, a snapshot is kept when it opens a new day (week, month) for a rule
 * with counts left, and the oldest snapshot is kept while a rule has counts
 * left. A policy that keeps nothing at all keeps everything (restic refuses to
 * forget without a rule, and so does this).
 */
export function applyRetentionPolicy(
  snapshots: readonly DatedSnapshot[],
  rules: RetentionRules,
  timeZone: string = DEFAULT_SCHEDULE_TIMEZONE,
): RetentionDecision {
  const sorted = [...snapshots].sort(
    (a, b) => b.time.getTime() - a.time.getTime() || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0),
  );
  if (rules.keepDaily <= 0 && rules.keepWeekly <= 0 && rules.keepMonthly <= 0) {
    return { keep: sorted.map((snapshot) => snapshot.id), remove: [] };
  }
  const buckets = [
    {
      count: rules.keepDaily,
      last: null as number | null,
      of: (d: CalendarDate) => d.year * 10_000 + d.month * 100 + d.day,
    },
    {
      count: rules.keepWeekly,
      last: null as number | null,
      of: (d: CalendarDate) => {
        const week = isoWeek(d.year, d.month, d.day);
        return week.year * 100 + week.week;
      },
    },
    {
      count: rules.keepMonthly,
      last: null as number | null,
      of: (d: CalendarDate) => d.year * 100 + d.month,
    },
  ];
  const keep: string[] = [];
  const remove: string[] = [];
  sorted.forEach((snapshot, index) => {
    const date = localDate(snapshot.time, timeZone);
    let kept = false;
    for (const bucket of buckets) {
      if (bucket.count <= 0) {
        continue;
      }
      const value = bucket.of(date);
      if (value !== bucket.last || index === sorted.length - 1) {
        kept = true;
        bucket.last = value;
        bucket.count -= 1;
      }
    }
    (kept ? keep : remove).push(snapshot.id);
  });
  return { keep, remove };
}

// ---------------------------------------------------------------------------
// Which snapshots the decision may touch
// ---------------------------------------------------------------------------

/** A snapshot's time may run this far ahead of the server before it counts as dated in the future. */
export const SNAPSHOT_CLOCK_TOLERANCE_MS = 60 * 60 * 1000;

/**
 * A snapshot stored this recently without a run that reported it is not
 * suspicious yet: its backup may still be reporting (restic stores the
 * snapshot file before the agent finishes the run).
 */
export const UNRECORDED_GRACE_MS = 60 * 60 * 1000;

export type SnapshotFlagReason = "unrecorded" | "future_time";

/** A file under `snapshots/` and when the storage received it. */
export interface StoredSnapshot {
  readonly id: string;
  readonly storedAt: Date | null;
}

/** A snapshot id a backup run reported (full or a prefix of at least 8 digits) and when the run ended. */
export interface RecordedSnapshot {
  readonly snapshotId: string;
  readonly finishedAt: Date | null;
}

/** What restic says about a snapshot: its id and the time written into it (by the agent). */
export interface ClaimedSnapshot {
  readonly id: string;
  readonly time: string;
}

export interface SnapshotFlag {
  readonly id: string;
  readonly reasons: SnapshotFlagReason[];
  readonly snapshotTime: Date | null;
  readonly storedAt: Date | null;
}

export interface SnapshotAudit {
  /** The recorded snapshots, dated by the server: what the retention policy decides on. */
  readonly dated: DatedSnapshot[];
  /** Snapshots no run reported: never deleted by retention. */
  readonly unrecorded: string[];
  /** Snapshots to tell the admin about. */
  readonly flags: SnapshotFlag[];
}

function earliest(a: Date | null, b: Date | null): Date | null {
  if (a === null) {
    return b;
  }
  return b !== null && b.getTime() < a.getTime() ? b : a;
}

/**
 * Sort the snapshots of a repository into the ones retention may decide on
 * and the ones it must leave alone, and flag the suspicious ones.
 *
 * A recorded id that is only a prefix counts only when exactly one stored
 * snapshot starts with it (anything else would let a forged snapshot pass as
 * a recorded one). A recorded snapshot is dated by the earlier of the moment
 * its file was stored and the end of the run that reported it (the earliest,
 * if several did). An unrecorded snapshot stored within the last hour is left
 * out of the decision but not flagged yet (see {@link UNRECORDED_GRACE_MS}).
 */
export function auditSnapshots(input: {
  stored: readonly StoredSnapshot[];
  recorded: readonly RecordedSnapshot[];
  claimed: readonly ClaimedSnapshot[];
  now: Date;
}): SnapshotAudit {
  const { now } = input;
  const recordedFull = new Map<string, Date | null>();
  const prefixes: RecordedSnapshot[] = [];
  for (const run of input.recorded) {
    const id = run.snapshotId.toLowerCase();
    if (id.length === 64) {
      recordedFull.set(id, earliest(recordedFull.get(id) ?? null, run.finishedAt));
    } else if (id.length >= 8) {
      prefixes.push({ snapshotId: id, finishedAt: run.finishedAt });
    }
  }
  const stored = input.stored.map((snapshot) => ({ ...snapshot, id: snapshot.id.toLowerCase() }));
  const byPrefix = new Map<string, { count: number; finishedAt: Date | null }>();
  for (const prefix of prefixes) {
    const matches = stored.filter((snapshot) => snapshot.id.startsWith(prefix.snapshotId));
    byPrefix.set(prefix.snapshotId, { count: matches.length, finishedAt: prefix.finishedAt });
  }
  const recordedRun = (id: string): { finishedAt: Date | null } | null => {
    if (recordedFull.has(id)) {
      return { finishedAt: recordedFull.get(id) ?? null };
    }
    for (const [prefix, match] of byPrefix) {
      if (match.count === 1 && id.startsWith(prefix)) {
        return { finishedAt: match.finishedAt };
      }
    }
    return null;
  };
  const claimedTime = new Map(
    input.claimed.map((snapshot) => [snapshot.id.toLowerCase(), new Date(snapshot.time)]),
  );

  const dated: DatedSnapshot[] = [];
  const unrecorded: string[] = [];
  const flags: SnapshotFlag[] = [];
  for (const snapshot of stored) {
    const reasons: SnapshotFlagReason[] = [];
    const run = recordedRun(snapshot.id);
    if (run) {
      dated.push({ id: snapshot.id, time: earliest(snapshot.storedAt, run.finishedAt) ?? now });
    } else {
      unrecorded.push(snapshot.id);
      const fresh =
        snapshot.storedAt !== null &&
        now.getTime() - snapshot.storedAt.getTime() < UNRECORDED_GRACE_MS;
      if (!fresh) {
        reasons.push("unrecorded");
      }
    }
    const claimed = claimedTime.get(snapshot.id);
    const time = claimed && !Number.isNaN(claimed.getTime()) ? claimed : null;
    if (
      time &&
      (time.getTime() > now.getTime() + SNAPSHOT_CLOCK_TOLERANCE_MS ||
        (snapshot.storedAt !== null &&
          time.getTime() > snapshot.storedAt.getTime() + SNAPSHOT_CLOCK_TOLERANCE_MS))
    ) {
      reasons.push("future_time");
    }
    if (reasons.length > 0) {
      flags.push({ id: snapshot.id, reasons, snapshotTime: time, storedAt: snapshot.storedAt });
    }
  }
  return { dated, unrecorded, flags };
}
