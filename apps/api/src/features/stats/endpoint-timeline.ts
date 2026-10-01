import {
  type EndpointState,
  type ReadinessReportFact,
  endpointReadiness,
  endpointVerifyOverdue,
} from "@restow/core";
import type { RatedObject } from "../verify/summary.js";
import type { EndpointBackup, EndpointReportRow, EndpointRow } from "./endpoint-facts.js";
import { type RatedSet, emptyReadinessCounts, lastIndexBefore, pushTo } from "./readiness.js";

/**
 * Recovery readiness of the endpoints at any moment of the period (pure, no
 * I/O), by the rule the verify page and the endpoint lists use
 * (`endpointReadiness`, @restow/core), applied to what was known at that moment:
 *
 *   - the newest good backup run that finished before the moment decides which
 *     snapshot counts (succeeded or partial, with a snapshot);
 *   - the restore tests of exactly that snapshot checked before the moment, and
 *     the newest repository check before the moment, are the evidence. A backup
 *     taken after a green test is unverified until a test of it ran;
 *   - an endpoint without a backup, and one whose newest backup no test rates,
 *     count as unverified (the statistics do the same for protected objects).
 *
 * An endpoint is protected at a moment when it existed (created before it) and
 * was not revoked yet (not revoked before it). A revoked endpoint keeps its
 * backups but is no longer protected, like an excluded object.
 */

export interface EndpointReadinessAt extends RatedSet {
  /** State of every endpoint protected at the moment. */
  readonly states: ReadonlyMap<string, EndpointState>;
}

/** Oldest first; reports of the same instant keep their order. */
function byCheckTime(a: EndpointReportRow, b: EndpointReportRow): number {
  return a.checkedAt.getTime() - b.checkedAt.getTime();
}

const snapshotKey = (endpointId: string, snapshotId: string): string =>
  `${endpointId}/${snapshotId}`;

function toFact(report: EndpointReportRow): ReadinessReportFact {
  return {
    kind: report.kind,
    origin: report.origin,
    snapshotId: report.snapshotId,
    readiness: report.readiness,
    checkedAt: report.checkedAt,
  };
}

/** The entries of a list sorted by `checkedAt` that were checked strictly before `moment`. */
function checkedBefore(list: readonly EndpointReportRow[] | undefined, moment: Date) {
  if (!list) {
    return [];
  }
  return list.slice(0, lastIndexBefore(list, moment, (report) => report.checkedAt) + 1);
}

/** Readiness of a set of endpoints at any moment; backups and reports are indexed once up front. */
export class EndpointTimeline {
  /** Good backups per endpoint, oldest first. */
  private readonly backupsByEndpoint = new Map<string, EndpointBackup[]>();
  /** Restore tests per (endpoint, snapshot), oldest first. */
  private readonly testsBySnapshot = new Map<string, EndpointReportRow[]>();
  /** Repository checks per endpoint, oldest first. */
  private readonly checksByEndpoint = new Map<string, EndpointReportRow[]>();

  constructor(
    private readonly endpoints: readonly EndpointRow[],
    backups: readonly EndpointBackup[],
    reports: readonly EndpointReportRow[],
  ) {
    for (const backup of backups) {
      pushTo(this.backupsByEndpoint, backup.endpointId, backup);
    }
    for (const list of this.backupsByEndpoint.values()) {
      list.sort((a, b) => a.finishedAt.getTime() - b.finishedAt.getTime());
    }
    for (const report of reports) {
      if (report.kind === "restore_test") {
        if (report.snapshotId !== null) {
          pushTo(this.testsBySnapshot, snapshotKey(report.endpointId, report.snapshotId), report);
        }
      } else {
        pushTo(this.checksByEndpoint, report.endpointId, report);
      }
    }
    for (const index of [this.testsBySnapshot, this.checksByEndpoint]) {
      for (const list of index.values()) {
        list.sort(byCheckTime);
      }
    }
  }

  /** The newest good backup of an endpoint that finished strictly before `moment`. */
  latestBackupAt(endpointId: string, moment: Date): EndpointBackup | null {
    const list = this.backupsByEndpoint.get(endpointId);
    if (!list) {
      return null;
    }
    const index = lastIndexBefore(list, moment, (backup) => backup.finishedAt);
    return index >= 0 ? (list[index] as EndpointBackup) : null;
  }

  /** Readiness at `moment` (exclusive: what happened at `moment` itself is not included). */
  at(moment: Date): EndpointReadinessAt {
    const counts = emptyReadinessCounts();
    const states = new Map<string, EndpointState>();
    const rated: RatedObject[] = [];
    for (const endpoint of this.endpoints) {
      if (endpoint.createdAt.getTime() >= moment.getTime()) {
        continue;
      }
      if (endpoint.revokedAt !== null && endpoint.revokedAt.getTime() < moment.getTime()) {
        continue;
      }
      const backup = this.latestBackupAt(endpoint.id, moment);
      const tests = backup
        ? checkedBefore(
            this.testsBySnapshot.get(snapshotKey(endpoint.id, backup.snapshotId)),
            moment,
          )
        : [];
      const check = checkedBefore(this.checksByEndpoint.get(endpoint.id), moment).at(-1);
      const result = endpointReadiness({
        latestSnapshotId: backup?.snapshotId ?? null,
        latestBackupPartial: backup?.partial ?? false,
        reports: [...tests, ...(check ? [check] : [])].map(toFact),
      });
      states.set(endpoint.id, result.state);
      if (result.state === "no_backup" || result.state === "unverified") {
        counts.unverified += 1;
      } else {
        counts[result.state] += 1;
      }
      rated.push({
        state: result.state,
        overdue: endpointVerifyOverdue(result.checkedAt, moment),
        checkedAt: result.checkedAt,
      });
    }
    return { counts, total: rated.length, rated, states };
  }
}
