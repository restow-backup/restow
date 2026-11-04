import type { PveRunning } from "@/features/history/api";
import type { PveJob, PveJobRound } from "@/features/pve/api";

/**
 * What of a Proxmox VE job runs now, from the live channel's Proxmox VE runs (the ones the start
 * page's "Running now" shows): the guests its round backs up, and how far the round is with them.
 * Pure, so the job list's row and the job's detail panel read it the same way.
 */

/**
 * Whether a live Proxmox VE run is a backup of the job's round. The server names the job that
 * started the run (`jobId`, from 0.5.0); an older one names only a job, the one of the guest,
 * so its runs are matched by that name.
 */
export function isRunOfPveJob(run: PveRunning, job: Pick<PveJob, "id" | "name">): boolean {
  if (run.kind !== "backup") {
    return false;
  }
  return run.jobId !== undefined ? run.jobId === job.id : run.jobName === job.name;
}

/** The job's backups that run now, the one started first first. */
export function runsOfPveJob(
  runs: Readonly<Record<string, PveRunning>> | null,
  job: Pick<PveJob, "id" | "name">,
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
 * How far a job's round is in percent: its guests that are done, and the share of those that run
 * now as far as their nodes report it (so the figure moves while a guest is backed up, as a mail
 * job's does). Null for a round without guests.
 */
export function pveRoundPercent(
  round: Pick<PveJobRound, "total" | "done" | "running">,
  running: readonly Pick<PveRunning, "progress">[] = [],
): number | null {
  if (round.total <= 0) {
    return null;
  }
  const share = running.reduce((sum, run) => sum + (runShare(run) ?? 0), 0);
  const done = round.done + Math.min(share, round.running);
  // Times 100 first: 57 of 100 is 57, not 56.99….
  return Math.min(100, Math.max(0, Math.floor((done * 100) / round.total)));
}
