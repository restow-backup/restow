/**
 * How consistent the files of an agent backup are (docs/AGENT.md, "Konsistenz"): the report field
 * `consistency` of `POST /agent/v1/runs/:id/finish`, shared by every file system snapshot method
 * (Windows shadow copies, VSS; LVM and btrfs on Linux; APFS on macOS) and kept with the run's
 * statistics (`endpoint_runs.stats.consistency`).
 *
 *   method           the snapshot method of the machine (`vss`, `lvm`, `btrfs`, `apfs`, `mixed`
 *                    for more than one); absent when the system has none.
 *   state            `used`: requested and no volume failed (volumes the snapshot provider does
 *                    not support do not count); `partial`: at least one volume was read live;
 *                    `unavailable`: no snapshot at all; `off`: none requested.
 *   liveFilesystems  the volumes or file systems read from the live file system although a
 *                    snapshot was requested.
 *
 * A shadow copy makes a backup file consistent, not application consistent: restic asks for a
 * copy backup without writer components, so open databases are crash consistent.
 */

export const SNAPSHOT_METHODS = ["vss", "lvm", "btrfs", "apfs", "mixed"] as const;
export type SnapshotMethod = (typeof SNAPSHOT_METHODS)[number];

export const CONSISTENCY_STATES = ["used", "partial", "unavailable", "off"] as const;
export type ConsistencyState = (typeof CONSISTENCY_STATES)[number];

export const MAX_LIVE_FILESYSTEMS = 32;

export interface RunConsistency {
  method?: SnapshotMethod;
  state: ConsistencyState;
  liveFilesystems?: string[];
}

/**
 * The agent's consistency report, checked and bounded; `null` for none or a malformed one (an
 * agent before 0.5.0 sends none). An unknown method is dropped, an unknown state drops the report.
 */
export function parseRunConsistency(value: unknown): RunConsistency | null {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return null;
  }
  const input = value as Record<string, unknown>;
  if (!(CONSISTENCY_STATES as readonly unknown[]).includes(input.state)) {
    return null;
  }
  const out: RunConsistency = { state: input.state as ConsistencyState };
  if ((SNAPSHOT_METHODS as readonly unknown[]).includes(input.method)) {
    out.method = input.method as SnapshotMethod;
  }
  if (Array.isArray(input.liveFilesystems)) {
    const live = input.liveFilesystems
      .filter((entry): entry is string => typeof entry === "string" && entry.length > 0)
      .slice(0, MAX_LIVE_FILESYSTEMS)
      .map((entry) => entry.slice(0, 300));
    if (live.length > 0) {
      out.liveFilesystems = live;
    }
  }
  return out;
}
