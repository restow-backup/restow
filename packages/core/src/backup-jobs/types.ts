// The JSON shapes of a backup job. @restow/core has no dependency on @restow/db, so the shapes
// are written here as well as next to the columns they live in (packages/db schema/backup-jobs.ts);
// the two are structurally identical and the API assigns one to the other without a cast.

import type { BandwidthWindow } from "./bandwidth.js";

/**
 * When a job (or one member) runs. Mail jobs: `interval` or `cron` (`daily` is stored as the
 * equivalent cron expression); endpoint jobs: `interval`, `daily` or `on_connect`, exactly what
 * the agent contract knows. `timeZone` is the IANA zone cron and `timeOfDay` are read in.
 */
export interface JobSchedule {
  kind: "interval" | "cron" | "daily" | "on_connect";
  /** `interval`: minutes between runs; `on_connect`: the least minutes between two backups. */
  intervalMinutes?: number;
  /** `cron`: five fields. */
  cron?: string;
  /** `daily`: local time `HH:MM`. */
  timeOfDay?: string;
  timeZone: string;
}

/** Server-side retention of a machine's repository (`restic forget --keep-*`). */
export interface JobRetention {
  keepDaily: number;
  keepWeekly: number;
  keepMonthly: number;
}

/** What an endpoint job tells the agent to back up and how; a field left out keeps what the machine has. */
export interface JobEndpointSettings {
  paths?: string[];
  /** Exclude patterns (restic `--exclude-file` lines), exactly as sent to the agent. */
  excludes?: string[];
  /** Skip files larger than this many GiB (restic `--exclude-larger-than`); null or absent = no limit. */
  excludeLargerThanGib?: number | null;
  hooks?: { pre?: string; post?: string };
  /** Upload limit in kbit/s, the default outside every time window; null or absent = unlimited. */
  bandwidthKbps?: number | null;
  /**
   * Time windows with a limit of their own (days, local from and to, kbit/s, 0 = unlimited). Read
   * in the time zone of the job's schedule; the limit that applies when a run starts is the active
   * window's, else `bandwidthKbps`. Absent or empty = no windows.
   */
  bandwidthWindows?: BandwidthWindow[];
  retention?: JobRetention;
}

/** What one member does differently from the job; a field set here replaces the job's value. */
export type JobMemberOverrides = JobEndpointSettings & {
  /** Its own backup schedule. */
  schedule?: JobSchedule;
  /** Mail: its own restore-check schedule. */
  verifySchedule?: JobSchedule;
};
