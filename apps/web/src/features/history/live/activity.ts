import type { BackupJob } from "@/features/backup-jobs/api";
import type { NavActivity, NavActivityItem } from "@/lib/navigation";

import type { Run, RunSource } from "../api";
import type { LiveDefinitions, LiveRuns } from "./apply";

/**
 * What runs behind a menu entry, in pure functions: the backups of an area that run or wait, from
 * the live channel (its runs and its job definitions) or, while the channel is not connected, from
 * the list of backup jobs (their "last run" counts). The sidebar (features/history/live/activity-
 * badges.ts) words and draws it; this file is unit tested.
 */

/** The two areas with a "Jobs" entry: Mail & SaaS, and Servers & clients. */
export type ActivityArea = "mail" | "endpoint";

const SOURCE_OF: Readonly<Record<ActivityArea, RunSource>> = {
  mail: "mail",
  endpoint: "endpoint",
};

/** The address that opens a run in the drawer of the area's job list. */
export function runLink(area: ActivityArea, runId: string): Pick<NavActivityItem, "to" | "search"> {
  return { to: "/jobs", search: { type: area, run: runId } };
}

function startedAt(run: Run): number {
  const at = Date.parse(run.startedAt ?? run.createdAt);
  return Number.isNaN(at) ? 0 : at;
}

/**
 * From the channel: the backups of the area that run (each one an item, labelled by `label`),
 * those that wait as runs (a mail backup in the queue) and those a job says wait for their machine
 * (a requested backup that starts at the machine's next check-in).
 */
export function activityFromLive(
  runs: LiveRuns,
  definitions: LiveDefinitions,
  area: ActivityArea,
  label: (run: Run) => string,
): NavActivity {
  const source = SOURCE_OF[area];
  const ours = Object.values(runs).filter((run) => run.source === source && run.kind === "backup");
  const running = ours
    .filter((run) => run.state === "running")
    .sort((a, b) => startedAt(a) - startedAt(b));
  const queuedRuns = ours.filter((run) => run.state === "queued").length;
  const waitingMachines = Object.values(definitions)
    .filter((job) => job.kind === area)
    .reduce((sum, job) => sum + Math.max(0, job.lastRun.queued), 0);
  return {
    running: running.length,
    queued: queuedRuns + waitingMachines,
    items: running.map((run) => ({
      id: run.id,
      label: label(run),
      percent: run.progress?.percent ?? null,
      ...runLink(area, run.id),
    })),
  };
}

/**
 * From the list of backup jobs, while the channel is not connected: the counts each job carries,
 * and an item per job with something running, which opens the run the job names as its current
 * one.
 */
export function activityFromJobs(
  jobs: readonly Pick<BackupJob, "id" | "kind" | "name" | "lastRun">[],
  area: ActivityArea,
): NavActivity {
  const ours = jobs.filter((job) => job.kind === area);
  const items: NavActivityItem[] = ours.flatMap((job) =>
    job.lastRun.running > 0 && job.lastRun.runId
      ? [{ id: job.id, label: job.name, percent: null, ...runLink(area, job.lastRun.runId) }]
      : [],
  );
  return {
    running: ours.reduce((sum, job) => sum + Math.max(0, job.lastRun.running), 0),
    queued: ours.reduce((sum, job) => sum + Math.max(0, job.lastRun.queued), 0),
    items,
  };
}

/** A guest of Proxmox VE as far as its activity goes (features/pve/api.ts `PveGuest`). */
export interface GuestActivity {
  id: string;
  vmid: number;
  name: string | null;
  jobName: string | null;
  activity?: "queued" | "running" | null;
}

/** The guests of Proxmox VE that back up now or wait for their node; each running one opens its page. */
export function activityFromGuests(
  guests: readonly GuestActivity[],
  guestPath: (id: string) => string,
): NavActivity {
  const running = guests.filter((guest) => guest.activity === "running");
  return {
    running: running.length,
    queued: guests.filter((guest) => guest.activity === "queued").length,
    items: running.map((guest) => {
      const name = guest.name ?? String(guest.vmid);
      return {
        id: guest.id,
        label: guest.jobName ? `${guest.jobName} · ${name}` : name,
        percent: null,
        to: guestPath(guest.id),
      };
    }),
  };
}

/** Whether there is anything to show. */
export function isBusy(activity: NavActivity | null | undefined): activity is NavActivity {
  return Boolean(activity && (activity.running > 0 || activity.queued > 0));
}
