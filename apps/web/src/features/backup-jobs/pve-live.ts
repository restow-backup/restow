import type { PveRunning } from "@/features/history/api";
import type { PveJob, PveJobRound } from "@/features/pve/api";

/**
 * What of a Proxmox VE job runs now, from the live channel's Proxmox VE runs (the ones the start
 * page's "Running now" shows): the guests its round backs up, and how far the round is with them.
 * Pure, so the job list's row and the job's detail panel read it the same way.
 */

/** The job a live run is matched against: its id, its name and how many guests its round runs. */
export type PveJobRef = Pick<PveJob, "id" | "name"> & {
  round?: Pick<PveJobRound, "running"> | null;
};

/**
 * Whether a live Proxmox VE run is the job's: a backup of its round or a boot test it started.
 * The server names the job whose task started the run (`jobId`, from 0.5.0). Restores and restore
 * checks name no job and are nobody's here.
 *
 * An older server names only a job, the one the guest is in, so its runs are matched by that name
 * (unique in a tenant, and the list and the live channel are the same tenant's). That cannot tell
 * a guest's "Back up now" from the round's backup, so it takes backups only while the round runs
 * guests at all; a boot test is left out, and a job over all guests, whose guests are in no job
 * of their own there, shows none. The fallback lasts only until the server is updated.
 */
export function isRunOfPveJob(run: PveRunning, job: PveJobRef): boolean {
  if (run.jobId !== undefined) {
    return run.jobId === job.id && (run.kind === "backup" || run.kind === "boot_test");
  }
  return run.kind === "backup" && (job.round?.running ?? 0) > 0 && run.jobName === job.name;
}

/** The job's runs that go on now (its backups, its boot tests), the one started first first. */
export function runsOfPveJob(
  runs: Readonly<Record<string, PveRunning>> | null,
  job: PveJobRef,
): PveRunning[] {
  if (!runs) {
    return [];
  }
  return Object.values(runs)
    .filter((run) => isRunOfPveJob(run, job))
    .sort((a, b) => Date.parse(a.startedAt) - Date.parse(b.startedAt) || (a.id < b.id ? -1 : 1));
}

/** How much of a running backup is read, 0 to 1; null while its node gave no total. */
export function runShare(run: Pick<PveRunning, "progress">): number | null {
  const progress = run.progress;
  if (!progress || progress.bytesTotal === null || progress.bytesTotal <= 0) {
    return null;
  }
  return Math.min(1, Math.max(0, progress.bytesDone / progress.bytesTotal));
}

/**
 * How far a job's round is in percent: its guests that are done, and the share of the backups
 * that run now as far as their nodes report it (so the figure moves while a guest is backed up,
 * as a mail job's does; a boot test is not part of the round). Null for a round without guests.
 */
export function pveRoundPercent(
  round: Pick<PveJobRound, "total" | "done" | "running">,
  running: readonly Pick<PveRunning, "kind" | "progress">[] = [],
): number | null {
  if (round.total <= 0) {
    return null;
  }
  const share = running
    .filter((run) => run.kind === "backup")
    .reduce((sum, run) => sum + (runShare(run) ?? 0), 0);
  const done = round.done + Math.min(share, round.running);
  // Times 100 first: 57 of 100 is 57, not 56.99….
  return Math.min(100, Math.max(0, Math.floor((done * 100) / round.total)));
}
