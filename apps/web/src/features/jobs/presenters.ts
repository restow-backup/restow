import type { BadgeProps } from "@/components/ui/badge";
import type {
  BackupTarget,
  Job,
  JobFilters,
  JobPage,
  JobProgress,
  JobQueue,
  JobStatus,
  JobThrottle,
  RecoveryReadiness,
  SnapshotState,
} from "@/features/jobs/api";
import type { ServerEvent } from "@/features/jobs/sse";

/**
 * Pure presentation logic for jobs: status tones, progress ratios, durations,
 * throttling waits and cache merging. Components stay declarative; this file
 * is where the decisions live, and it is unit tested.
 */

type BadgeVariant = NonNullable<BadgeProps["variant"]>;

/**
 * A job that completed is neutral, not green: green means proof (brand guide,
 * section 4), and a backup that merely completed has not been read back. Only a
 * restore that completed is a success (see `jobStatusDisplay`).
 */
export const STATUS_VARIANT: Record<JobStatus, BadgeVariant> = {
  queued: "muted",
  active: "default",
  completed: "outline",
  failed: "destructive",
  cancelled: "secondary",
};

/** A backup that completed is stowed, not checked: neutral until a restore check reads it back. */
export const SNAPSHOT_STATE_VARIANT: Record<SnapshotState, BadgeVariant> = {
  running: "default",
  completed: "outline",
  incomplete: "warning",
  pruned: "muted",
};

export const READINESS_VARIANT: Record<RecoveryReadiness, BadgeVariant> = {
  green: "success",
  yellow: "warning",
  red: "destructive",
};

/** What a job status badge says and how it looks. */
export interface JobStatusDisplay {
  /** i18n key in the `backup` namespace. */
  key: string;
  values: Record<string, number>;
  variant: BadgeVariant;
}

/**
 * The badge for a job. A run that completed but left items it could not
 * process is not a plain success: it reads "completed, N items failed" in the
 * warning tone, so a "Completed" never hides failed items. A completed run is
 * neutral; only a restore that completed is green (the data is back), which is
 * why the queue is passed when it is known.
 */
export function jobStatusDisplay(
  status: JobStatus,
  failedItems = 0,
  queue?: JobQueue,
  checkIncomplete = false,
): JobStatusDisplay {
  // A restore check that could not complete proves nothing: neutral, never "Failed" or "Completed".
  if (checkIncomplete && status !== "active") {
    return { key: "jobStatus.checkIncomplete", values: {}, variant: "info" };
  }
  if (status === "completed" && failedItems > 0) {
    return {
      key: "jobStatus.completedWithFailures",
      values: { count: failedItems },
      variant: "warning",
    };
  }
  if (status === "completed" && queue === "restore") {
    return { key: "jobStatus.completed", values: {}, variant: "success" };
  }
  return { key: `jobStatus.${status}`, values: {}, variant: STATUS_VARIANT[status] };
}

export function isTerminal(status: JobStatus): boolean {
  return status === "completed" || status === "failed" || status === "cancelled";
}

export function isLive(status: JobStatus): boolean {
  return status === "queued" || status === "active";
}

/**
 * Share of processed items (done or failed) in [0, 1], or null while the
 * total is still unknown (discovery has not finished).
 */
export function progressRatio(progress: JobProgress | null): number | null {
  if (!progress || progress.total <= 0) {
    return null;
  }
  return Math.min(1, Math.max(0, (progress.done + progress.failed) / progress.total));
}

/** The count lines a job can show (`progress.<key>` in the `backup` namespace). */
export type ProgressCountKey = "items" | "itemsOpen" | "itemsDone" | "noChanges" | "noItems";

/**
 * Which count line a job shows. "N of M items" once the total is known. A run
 * that is still going reads "N items so far"; a finished one never does, since
 * "so far" suggests more to come: a completed run that found nothing to do says
 * "No changes" (a restore check always reads something, so it never does), and
 * any other finished run (completed, failed or cancelled) says "N items
 * processed", or "No items processed" when it got nowhere.
 */
export function progressCountKey(
  job: Pick<Job, "queue" | "status" | "progress">,
): ProgressCountKey {
  const progress = job.progress;
  if (progress && progress.total > 0) {
    return "items";
  }
  if (!isTerminal(job.status)) {
    return "itemsOpen";
  }
  const nothingProcessed = !progress || (progress.done === 0 && progress.failed === 0);
  if (nothingProcessed) {
    return job.status === "completed" && job.queue !== "verify" ? "noChanges" : "noItems";
  }
  return "itemsDone";
}

/**
 * The byte line of a job. A restore check reads data back; a backup writes new
 * data, unless it stopped before its snapshot was completed (failed or
 * cancelled), when what it stored is only what it had stored by then.
 */
export function progressBytesKey(
  job: Pick<Job, "queue" | "status">,
): "bytes" | "bytesRead" | "bytesPartial" {
  if (job.queue === "verify") {
    return "bytesRead";
  }
  return job.status === "failed" || job.status === "cancelled" ? "bytesPartial" : "bytes";
}

/** The translation key of what started a job. */
export function jobTriggerKey(job: Pick<Job, "trigger" | "scheduleId">): string {
  if (job.trigger === "after_backup") {
    return "jobs.afterBackup";
  }
  return job.trigger === "scheduled" || (job.trigger === undefined && job.scheduleId)
    ? "jobs.scheduled"
    : "jobs.manual";
}

/** Phases the engines report and the UI translates; anything else shows its raw name. */
export const KNOWN_PHASES = [
  "starting",
  "connect",
  "enumerate",
  "changes",
  "download",
  "folders",
  "mail",
  "calendar",
  "contacts",
  "files",
  "resync",
  "retry",
  "commit",
  "manifest",
  "resolve",
  "archive",
  "evaluate",
  "prune",
  // Directory sync (packages/core directory/sync.ts)
  "load",
  "complete",
  "probe",
  "plan",
  "persist",
] as const;

const KNOWN_PHASE_SET: ReadonlySet<string> = new Set(KNOWN_PHASES);

/** The i18n key (namespace `backup`) and values for an engine phase. */
export function phaseLabel(name: string): { key: string; values: Record<string, string> } {
  return KNOWN_PHASE_SET.has(name)
    ? { key: `phase.${name}`, values: {} }
    : { key: "phase.unknown", values: { name } };
}

export type DurationUnit = "hours" | "minutes" | "seconds";

/** A duration split for the `duration.*` messages (largest two units). */
export function durationParts(totalSeconds: number): {
  key: `duration.${DurationUnit}`;
  values: { hours: number; minutes: number; seconds: number };
} {
  const safe = Number.isFinite(totalSeconds) ? Math.max(0, Math.round(totalSeconds)) : 0;
  const hours = Math.floor(safe / 3600);
  const minutes = Math.floor((safe % 3600) / 60);
  const seconds = safe % 60;
  const values = { hours, minutes, seconds };
  if (hours > 0) {
    return { key: "duration.hours", values };
  }
  if (minutes > 0) {
    return { key: "duration.minutes", values };
  }
  return { key: "duration.seconds", values };
}

function timeOf(value: string | null): number | null {
  if (!value) {
    return null;
  }
  const parsed = Date.parse(value);
  return Number.isNaN(parsed) ? null : parsed;
}

/** How long a job ran (or has been running), in seconds; null before it started. */
export function jobDurationSeconds(
  job: Pick<Job, "startedAt" | "completedAt">,
  now: number,
): number | null {
  const started = timeOf(job.startedAt);
  if (started === null) {
    return null;
  }
  const ended = timeOf(job.completedAt) ?? now;
  return Math.max(0, (ended - started) / 1000);
}

/** Milliseconds left in the current throttling wait (0 once it is over). */
export function throttleRemainingMs(throttle: JobThrottle | null, now: number): number {
  const until = timeOf(throttle?.until ?? null);
  return until === null ? 0 : Math.max(0, until - now);
}

/** Anything Microsoft Graph can hold back: a job, a restore, a directory sync. */
export interface ThrottledRun {
  status: string;
  throttle: JobThrottle | null;
}

/** Whether Microsoft is making this run wait right now. */
export function isWaitingForThrottle(run: ThrottledRun, now: number): boolean {
  return run.status === "active" && throttleRemainingMs(run.throttle, now) > 0;
}

/** The label of the object a job works on. */
export function objectLabel(object: { displayName: string | null; externalId: string }): string {
  return object.displayName?.trim() || object.externalId;
}

export function matchesFilters(job: Pick<Job, "queue" | "status">, filters: JobFilters): boolean {
  return (
    (filters.queue === null || job.queue === filters.queue) &&
    (filters.status === null || job.status === filters.status)
  );
}

/**
 * Put a job's new state into loaded pages. Returns null when the job is not
 * loaded (the caller refetches so a new job appears in its place in the order).
 */
export function replaceJobInPages(pages: readonly JobPage[], job: Job): JobPage[] | null {
  let found = false;
  const next = pages.map((page) => ({
    ...page,
    items: page.items.map((item) => {
      if (item.id !== job.id) {
        return item;
      }
      found = true;
      return job;
    }),
  }));
  return found ? next : null;
}

/** Case-insensitive match of a protected object on name, address and source. */
export function matchesTargetSearch(
  target: Pick<BackupTarget, "displayName" | "externalId" | "source">,
  query: string,
): boolean {
  const needle = query.trim().toLowerCase();
  if (needle.length === 0) {
    return true;
  }
  return [target.displayName ?? "", target.externalId, target.source.name].some((value) =>
    value.toLowerCase().includes(needle),
  );
}

function parseJson<T>(data: string): T | null {
  try {
    return JSON.parse(data) as T;
  } catch {
    return null;
  }
}

/** Jobs carried by a stream event (`jobs` snapshot or single `job`); nothing for others. */
export function jobsOfEvent(event: ServerEvent): Job[] {
  if (event.event === "jobs") {
    return parseJson<{ items?: Job[] }>(event.data)?.items ?? [];
  }
  if (event.event === "job") {
    const job = parseJson<Job>(event.data);
    return job ? [job] : [];
  }
  return [];
}

/**
 * Put a backup job into the object it belongs to, unless that object already
 * shows a newer job. Returns null when no loaded object changed.
 */
export function withLatestJob(targets: readonly BackupTarget[], job: Job): BackupTarget[] | null {
  let changed = false;
  const next = targets.map((target) => {
    if (target.id !== job.protectedObjectId) {
      return target;
    }
    const current = target.lastJob;
    if (current && current.id !== job.id && current.createdAt > job.createdAt) {
      return target;
    }
    changed = true;
    return { ...target, lastJob: job };
  });
  return changed ? next : null;
}
