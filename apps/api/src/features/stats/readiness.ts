import {
  type ObjectState,
  type RatedObject,
  isOverdue,
  overallReadiness,
} from "../verify/summary.js";
import { isStorageFinding, objectVerificationOf } from "../verify/verification-state.js";
import type {
  ProtectedObjectStatus,
  ReadinessObject,
  ReadinessRating,
  ReadinessReport,
  ReadinessSnapshot,
} from "./facts.js";

/**
 * Recovery readiness at any moment of the period (pure, no I/O), rated by
 * the one rule every view shares (features/verify/verification-state.ts),
 * applied to what was known at that moment:
 *
 *   - an object's state is the rating of its newest backup at the moment: the
 *     newest check of exactly that snapshot, or a storage finding newer than
 *     it. A backup taken after a green check is unverified until a check of
 *     that backup ran, whatever the older snapshot scored;
 *   - an object with a backup that no check rates is unverified, an object
 *     without any backup yet has no backup. The statistics count both as
 *     unverified: a backup without a verified restore counts as failed
 *     (docs/TESTING.md), so neither is ever shown as fine.
 *
 * Which objects count follows the recovery-readiness page as well: excluded
 * objects are not protected, orphaned ones count while they have a backup.
 * Only an object's current status is stored, not its history, so an object
 * excluded today is left out of earlier moments as well.
 */

export interface ReadinessCounts {
  green: number;
  yellow: number;
  red: number;
  unverified: number;
}

export interface ReadinessAt {
  readonly counts: ReadinessCounts;
  /** Objects counted at the moment: the protected objects. */
  readonly total: number;
  /** Worst state of the counted objects; null when none is counted. */
  readonly overall: ReadinessRating | null;
  /** State of every object that existed at the moment, counted or not. */
  readonly states: ReadonlyMap<string, ObjectState>;
  /** The counted objects as the overview rates them: what `overall` is derived from. */
  readonly rated: readonly RatedObject[];
}

export function emptyReadinessCounts(): ReadinessCounts {
  return { green: 0, yellow: 0, red: 0, unverified: 0 };
}

/** Proven restorable by the check of its newest backup: green, or yellow (restorable, needs attention). */
export function provenCount(counts: ReadinessCounts): number {
  return counts.green + counts.yellow;
}

export function countedTotal(counts: ReadinessCounts): number {
  return counts.green + counts.yellow + counts.red + counts.unverified;
}

/**
 * Whether an object counts as protected: excluded objects do not, orphaned
 * ones (gone from the source) while they still have a backup to restore.
 */
export function isProtected(status: ProtectedObjectStatus, hasBackup: boolean): boolean {
  return status === "active" || (status === "orphaned" && hasBackup);
}

/** Reports oldest first; reports of the same instant by insertion, as the verify page orders them. */
function byCheckTime(a: ReadinessReport, b: ReadinessReport): number {
  return (
    a.checkedAt.getTime() - b.checkedAt.getTime() || a.createdAt.getTime() - b.createdAt.getTime()
  );
}

/** The last entry of a list sorted by `timeOf` whose time is strictly before `moment`, by index. */
export function lastIndexBefore<T>(
  list: readonly T[],
  moment: Date,
  timeOf: (entry: T) => Date,
): number {
  let low = 0;
  let high = list.length;
  while (low < high) {
    const middle = (low + high) >>> 1;
    if (timeOf(list[middle] as T).getTime() < moment.getTime()) {
      low = middle + 1;
    } else {
      high = middle;
    }
  }
  return low - 1;
}

/** The newest report of a sorted list checked strictly before `moment`. */
function latestReportBefore(
  list: readonly ReadinessReport[] | undefined,
  moment: Date,
): ReadinessReport | null {
  if (!list) {
    return null;
  }
  const index = lastIndexBefore(list, moment, (report) => report.checkedAt);
  return index >= 0 ? (list[index] as ReadinessReport) : null;
}

export function pushTo<K, V>(map: Map<K, V[]>, key: K, value: V): void {
  const list = map.get(key);
  if (list) {
    list.push(value);
  } else {
    map.set(key, [value]);
  }
}

/** An object's backups in completion order, with the newest (highest sequence) so far at each. */
interface SnapshotHistory {
  readonly byCompletion: readonly ReadinessSnapshot[];
  /** `newestSoFar[i]`: the highest-sequence snapshot among `byCompletion[0..i]`. */
  readonly newestSoFar: readonly ReadinessSnapshot[];
}

function snapshotHistory(list: ReadinessSnapshot[]): SnapshotHistory {
  list.sort((a, b) => a.completedAt.getTime() - b.completedAt.getTime() || a.sequence - b.sequence);
  const newestSoFar: ReadinessSnapshot[] = [];
  for (const snapshot of list) {
    const previous = newestSoFar.at(-1);
    newestSoFar.push(previous && previous.sequence > snapshot.sequence ? previous : snapshot);
  }
  return { byCompletion: list, newestSoFar };
}

const prunedBefore = (snapshot: ReadinessSnapshot, moment: Date): boolean =>
  snapshot.prunedAt !== null && snapshot.prunedAt.getTime() < moment.getTime();

/** Readiness of a set of objects at any moment; snapshots and reports are indexed once up front. */
export class ReadinessTimeline {
  private readonly snapshotsByObject = new Map<string, SnapshotHistory>();
  /** Reports that name a snapshot, per snapshot: the checks of that backup. */
  private readonly checksBySnapshot = new Map<string, ReadinessReport[]>();
  /** Restore checks per object, whatever snapshot they read. */
  private readonly checksByObject = new Map<string, ReadinessReport[]>();
  /** Storage findings per object. */
  private readonly findingsByObject = new Map<string, ReadinessReport[]>();

  constructor(
    private readonly objects: readonly ReadinessObject[],
    snapshots: readonly ReadinessSnapshot[],
    reports: readonly ReadinessReport[],
  ) {
    const snapshotLists = new Map<string, ReadinessSnapshot[]>();
    for (const snapshot of snapshots) {
      pushTo(snapshotLists, snapshot.objectId, snapshot);
    }
    for (const [objectId, list] of snapshotLists) {
      this.snapshotsByObject.set(objectId, snapshotHistory(list));
    }
    for (const report of reports) {
      if (report.snapshotId !== null) {
        pushTo(this.checksBySnapshot, report.snapshotId, report);
      }
      pushTo(
        isStorageFinding(report) ? this.findingsByObject : this.checksByObject,
        report.objectId,
        report,
      );
    }
    for (const index of [this.checksBySnapshot, this.checksByObject, this.findingsByObject]) {
      for (const list of index.values()) {
        list.sort(byCheckTime);
      }
    }
  }

  /**
   * The newest backup of an object at `moment`: the highest sequence among
   * the snapshots completed strictly before it and not pruned yet.
   */
  latestSnapshotAt(objectId: string, moment: Date): ReadinessSnapshot | null {
    const history = this.snapshotsByObject.get(objectId);
    if (!history) {
      return null;
    }
    const last = lastIndexBefore(history.byCompletion, moment, (snapshot) => snapshot.completedAt);
    if (last < 0) {
      return null;
    }
    const newest = history.newestSoFar[last] as ReadinessSnapshot;
    if (!prunedBefore(newest, moment)) {
      return newest;
    }
    // Retention never prunes an object's newest backup; this walk only runs
    // for data that broke that rule, and still answers correctly.
    let best: ReadinessSnapshot | null = null;
    for (let index = last; index >= 0; index -= 1) {
      const snapshot = history.byCompletion[index] as ReadinessSnapshot;
      if (!prunedBefore(snapshot, moment) && (!best || snapshot.sequence > best.sequence)) {
        best = snapshot;
      }
    }
    return best;
  }

  /** Readiness at `moment` (exclusive: what happened at `moment` itself is not included). */
  at(moment: Date): ReadinessAt {
    const counts = emptyReadinessCounts();
    const states = new Map<string, ObjectState>();
    const rated: RatedObject[] = [];
    for (const object of this.objects) {
      if (object.createdAt.getTime() >= moment.getTime()) {
        continue;
      }
      const snapshot = this.latestSnapshotAt(object.id, moment);
      const verification = objectVerificationOf({
        latestSnapshotId: snapshot?.id ?? null,
        latestCheck: snapshot
          ? latestReportBefore(this.checksBySnapshot.get(snapshot.id), moment)
          : null,
        latestFinding: latestReportBefore(this.findingsByObject.get(object.id), moment),
        newestCheck: latestReportBefore(this.checksByObject.get(object.id), moment),
      });
      const state = verification.state;
      states.set(object.id, state);
      if (!isProtected(object.status, snapshot !== null)) {
        continue;
      }
      if (state === "no_backup" || state === "unverified") {
        counts.unverified += 1;
      } else {
        counts[state] += 1;
      }
      // Overdue by the report behind the state, as the verify page rates it.
      const checkedAt = verification.report?.checkedAt ?? null;
      rated.push({ state, overdue: isOverdue(checkedAt, moment), checkedAt });
    }
    return { counts, total: rated.length, overall: overallReadiness(rated), states, rated };
  }
}

/** What the rating of a set of protected things contributes to a moment's readiness. */
export interface RatedSet {
  readonly counts: ReadinessCounts;
  readonly total: number;
  readonly rated: readonly RatedObject[];
}

/**
 * Readiness of protected objects and of another kind of protected thing (the
 * endpoints, endpoint-timeline.ts) as one: the counts and totals add up, and
 * the overall rating is the worst over the union of everything rated. The
 * states stay those of the protected objects (they feed the largest-object
 * table, which lists objects only).
 */
export function mergeReadiness(objects: ReadinessAt, other: RatedSet): ReadinessAt {
  const rated = [...objects.rated, ...other.rated];
  return {
    counts: {
      green: objects.counts.green + other.counts.green,
      yellow: objects.counts.yellow + other.counts.yellow,
      red: objects.counts.red + other.counts.red,
      unverified: objects.counts.unverified + other.counts.unverified,
    },
    total: objects.total + other.total,
    overall: overallReadiness(rated),
    states: objects.states,
    rated,
  };
}
