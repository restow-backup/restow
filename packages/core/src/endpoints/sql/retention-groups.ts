/**
 * Retention groups of an endpoint's repository (W2a, docs/BAREMETAL-WINDOWS.md 5.1.5). The server
 * decides what to forget (retention-policy.ts); the job's keep rules apply to each group on its
 * own, so the snapshots of the native SQL backup (one per instance and run) never push file
 * backups out, nor the other way round. `files` holds the snapshots of backup runs, `sql:<instance>`
 * those of the `sql` runs of one instance.
 */
import {
  applyRetentionPolicy,
  type DatedSnapshot,
  type RetentionDecision,
  type RetentionRules,
} from "../retention-policy.js";

export const FILES_RETENTION_GROUP = "files";

export function sqlRetentionGroup(instance: string): string {
  return `sql:${instance.toUpperCase()}`;
}

/** A snapshot id a run reported (a prefix from an old agent, or the whole id) and its group. */
export interface GroupedSnapshot {
  snapshotId: string;
  group: string;
}

/**
 * The group of each dated snapshot: the group of the run that reported it (by the whole id, or by
 * a prefix that matches exactly one stored snapshot); `files` when none says otherwise.
 */
export function retentionGroupsOf(
  dated: readonly DatedSnapshot[],
  reported: readonly GroupedSnapshot[],
): Map<string, DatedSnapshot[]> {
  const full = new Map<string, string>();
  const prefixes: GroupedSnapshot[] = [];
  for (const entry of reported) {
    const id = entry.snapshotId.toLowerCase();
    if (id.length === 64) {
      // A SQL group wins over `files`: a SQL snapshot is never counted with the file backups.
      if (!full.has(id) || full.get(id) === FILES_RETENTION_GROUP) {
        full.set(id, entry.group);
      }
    } else if (id.length >= 8) {
      prefixes.push({ snapshotId: id, group: entry.group });
    }
  }
  const groups = new Map<string, DatedSnapshot[]>();
  for (const snapshot of dated) {
    const id = snapshot.id.toLowerCase();
    let group = full.get(id);
    if (group === undefined) {
      const matches = prefixes.filter((prefix) => id.startsWith(prefix.snapshotId));
      const unique = matches.filter(
        (prefix) =>
          dated.filter((other) => other.id.toLowerCase().startsWith(prefix.snapshotId)).length ===
          1,
      );
      group = unique[0]?.group ?? FILES_RETENTION_GROUP;
    }
    groups.set(group, [...(groups.get(group) ?? []), snapshot]);
  }
  return groups;
}

/** The keep rules applied per group; `keep` and `remove` of all groups, newest first. */
export function applyGroupedRetention(
  dated: readonly DatedSnapshot[],
  reported: readonly GroupedSnapshot[],
  rules: RetentionRules,
  timeZone?: string,
): RetentionDecision & { groups: Record<string, { keep: number; remove: number }> } {
  const time = new Map(dated.map((snapshot) => [snapshot.id, snapshot.time.getTime()]));
  const keep: string[] = [];
  const remove: string[] = [];
  const groups: Record<string, { keep: number; remove: number }> = {};
  for (const [group, snapshots] of retentionGroupsOf(dated, reported)) {
    const decision = applyRetentionPolicy(snapshots, rules, timeZone);
    keep.push(...decision.keep);
    remove.push(...decision.remove);
    groups[group] = { keep: decision.keep.length, remove: decision.remove.length };
  }
  const newestFirst = (a: string, b: string) => (time.get(b) ?? 0) - (time.get(a) ?? 0);
  return { keep: keep.sort(newestFirst), remove: remove.sort(newestFirst), groups };
}
