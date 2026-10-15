import { RESTORE_TEST_RETRY_DELAYS_MS, isInterruptedOnly } from "@restow/core";
import type {
  EndpointRun,
  EndpointRunProgress,
  EndpointRunStats,
  FileShareRun,
  RunSamplePoint,
} from "@restow/db";
import { currentThroughput, latestSamples } from "@restow/db";
import { type FailureDto, failureDto } from "../failures/dto.js";
import type {
  JobDto,
  JobPhaseDto,
  JobQueueName,
  JobStatusName,
  JobThrottleDto,
  JobViewRow,
} from "../jobs/dto.js";

/**
 * One shape for every run, whoever did the work: a mail run (a row of `jobs`, done by the
 * worker), a run an agent reported (`endpoint_runs`) and a run of a file share
 * (`file_share_runs`, a runner container; docs/FILESHARES.md 13). History lists them together, the live
 * channel streams them, and the run drawer opens one. Nothing here reads the database: the
 * mapping from rows to these shapes is pure and tested without one (the queries are in
 * ./read.ts, the stream in ./live.ts).
 *
 * The categories are what the History tabs filter by; the state is one vocabulary over the two
 * sources (a mail run `completed` with failed items is `partial`, like an agent's).
 */

export const RUN_CATEGORIES = [
  "backup",
  "restore",
  "restore_check",
  "export",
  "import",
  "maintenance",
] as const;
export type RunCategory = (typeof RUN_CATEGORIES)[number];

export type RunSource = "mail" | "endpoint" | "file_share";

/** `succeeded` is a run that completed; whether the backup is restorable is the restore check's word. */
export type RunState = "queued" | "running" | "succeeded" | "partial" | "failed" | "cancelled";

export type SubjectKind = "mailbox" | "onedrive" | "imap" | "server" | "client" | "file_share";

/** The object or machine a run works on. */
export interface RunSubjectDto {
  kind: SubjectKind;
  id: string;
  name: string;
  /** The address of a mailbox, the operating system of a machine, the location of a file share. */
  detail: string | null;
}

export interface RunProgressDto {
  /** 0 to 100; null while the run does not know its size (discovery still running). */
  percent: number | null;
  itemsDone: number;
  itemsTotal: number | null;
  itemsFailed: number;
  /** Bytes read and handled. */
  bytesProcessed: number;
  /** Bytes written to the repository (compressed, sealed). */
  bytesTransferred: number;
  /** New data stored by the run (mail: after deduplication; machines: once the run finished). */
  bytesNew: number | null;
  /** What a machine run expects to read in all; null when unknown. */
  bytesTotal: number | null;
  etaSeconds: number | null;
  /** The file an agent is reading right now. */
  currentPath: string | null;
  updatedAt: string | null;
}

export interface RunAttemptDto {
  /** The attempt this row shows (1 = first). */
  number: number;
  /** How many attempts the check gets in all. */
  of: number;
}

/** The backup job (definition) a run belongs to. */
export interface RunJobDto {
  id: string;
  name: string;
}

export interface RunDto {
  id: string;
  source: RunSource;
  kind: RunCategory;
  /** The job queue (mail) or the agent's run kind (machines): `verify`, `backup`, `verify_sample`... */
  type: string;
  state: RunState;
  /**
   * A restore check that could not complete: it rated nothing and is repeated. Shown neutrally,
   * never as failed.
   */
  checkIncomplete: boolean;
  /** Restore checks that are tried again: which attempt this is. Null for everything else. */
  attempt: RunAttemptDto | null;
  subject: RunSubjectDto | null;
  job: RunJobDto | null;
  trigger: "scheduled" | "manual" | "after_backup";
  /** A backup that re-reads everything instead of continuing from the last state. */
  full: boolean;
  createdAt: string;
  startedAt: string | null;
  finishedAt: string | null;
  /** The last time anything about the run changed (the stream's change marker). */
  updatedAt: string;
  progress: RunProgressDto | null;
  /** The current speed over the last seconds; null before a second measurement or for a finished run. */
  throughput: { processedBps: number; transferredBps: number } | null;
  /**
   * The newest measurements, cumulative bytes as `[epoch ms, processed, transferred]`: the
   * sparkline of a row and the charts of the drawer. Null when the run has none.
   */
  samples: RunSamplePoint[] | null;
  phase: JobPhaseDto | null;
  throttle: JobThrottleDto | null;
  errorMessage: string | null;
  failure: FailureDto | null;
  /** A queued or running mail run can be cancelled; a run on a machine cannot (the agent owns it). */
  cancellable: boolean;
}

// ---------------------------------------------------------------------------
// Detail
// ---------------------------------------------------------------------------

export type RestoreCheckState =
  | "passed"
  | "warning"
  | "failed"
  | "queued"
  | "running"
  | "unverified"
  | "none";

/** The restore check of the backup a run made. Green (`passed`) only for a check that read it back. */
export interface RunRestoreCheckDto {
  state: RestoreCheckState;
  checkedAt: string | null;
  /** The run of the check, when there is one to open. */
  runId: string | null;
}

export interface RunObjectDto {
  /** The run that backed this object up in the same wave; null for an object with no run in it. */
  runId: string | null;
  subject: RunSubjectDto;
  state: RunState;
  restoreCheck: RunRestoreCheckDto;
  /** The object of the run that was opened. */
  current: boolean;
}

/** How the runs of the same job and wave stand: "3 of 4 mailboxes backed up". */
export interface RunBatchDto {
  total: number;
  queued: number;
  running: number;
  succeeded: number;
  partial: number;
  failed: number;
  cancelled: number;
  /** More objects than the list shows. */
  truncated: boolean;
}

export type RunEventType =
  | "queued"
  | "started"
  | "phase"
  | "throttled"
  | "item_failed"
  | "completed"
  | "failed"
  | "cancelled"
  | "agent_error"
  | "finished"
  | "restore_check_queued"
  | "restore_check_running"
  | "restore_check_passed"
  | "restore_check_warning"
  | "restore_check_failed";

/** One line of the timeline; the web app words it from `type` and `params`. */
export interface RunEventDto {
  at: string;
  type: RunEventType;
  params: Record<string, string | number | boolean | null>;
  /** Time since the previous line, in milliseconds; null for the first. */
  durationMs: number | null;
}

export interface RunSummaryDto {
  itemsWritten: number | null;
  itemsTotal: number | null;
  filesNew: number | null;
  filesChanged: number | null;
  bytesNew: number | null;
  /** The sequence number of a mail snapshot, or the restic snapshot of a machine run. */
  snapshot: { id: string; sequence: number | null } | null;
  throttleWaits: number;
  throttleWaitMs: number;
}

export interface RunErrorDto {
  path: string | null;
  message: string;
  /** Mail: the classified cause; machines: the agent's own error code. */
  code: string | null;
  /** The classified cause (packages/core/src/failures) for both: what the UI explains. */
  cause: string | null;
}

export interface RunDetailDto extends RunDto {
  summary: RunSummaryDto | null;
  restoreCheck: RunRestoreCheckDto;
  batch: RunBatchDto | null;
  objects: RunObjectDto[];
  events: RunEventDto[];
  /** Mail: failed items (the first few); machines: the errors the agent reported. */
  errors: RunErrorDto[];
  errorCount: number;
  /** The tail of the agent's log (machine runs), redacted by the server. */
  logTail: string | null;
  docsUrl: string;
}

// ---------------------------------------------------------------------------
// Pure mapping
// ---------------------------------------------------------------------------

/** The newest points a list row or an event carries: a sparkline needs about a minute. */
export const LIST_SAMPLE_COUNT = 40;

export function categoryOfQueue(queue: JobQueueName): RunCategory {
  switch (queue) {
    case "backup":
      return "backup";
    case "restore":
      return "restore";
    case "verify":
      return "restore_check";
    case "export":
      return "export";
    case "import":
      return "import";
    default:
      // archive, directory, retention, scrub, storage_migration
      return "maintenance";
  }
}

export const QUEUES_OF_CATEGORY: Readonly<Record<RunCategory, readonly JobQueueName[]>> = {
  backup: ["backup"],
  restore: ["restore"],
  restore_check: ["verify"],
  export: ["export"],
  import: ["import"],
  maintenance: ["archive", "directory", "retention", "scrub", "storage_migration"],
};

export function categoryOfEndpointKind(kind: EndpointRun["kind"]): RunCategory {
  switch (kind) {
    case "backup":
      return "backup";
    case "restore":
      return "restore";
    default:
      return "restore_check";
  }
}

export const ENDPOINT_KINDS_OF_CATEGORY: Readonly<
  Record<RunCategory, readonly EndpointRun["kind"][]>
> = {
  backup: ["backup"],
  restore: ["restore"],
  restore_check: ["verify_sample"],
  export: [],
  import: [],
  maintenance: [],
};

/**
 * The runs of file shares per category: backups, and restores (a copy run is a restore run).
 * Their restore checks are the server's reports, not runs.
 */
export const SHARE_KINDS_OF_CATEGORY: Readonly<
  Record<RunCategory, readonly FileShareRun["kind"][]>
> = {
  backup: ["backup"],
  restore: ["restore"],
  restore_check: [],
  export: [],
  import: [],
  maintenance: [],
};

export function stateOfShareRun(status: FileShareRun["status"]): RunState {
  switch (status) {
    case "queued":
      return "queued";
    case "starting":
    case "running":
      return "running";
    case "warning":
      return "partial";
    case "succeeded":
    case "failed":
    case "cancelled":
      return status;
    default:
      return "failed";
  }
}

export function stateOfJob(status: JobStatusName, failedItems: number): RunState {
  switch (status) {
    case "queued":
      return "queued";
    case "active":
      return "running";
    case "completed":
      return failedItems > 0 ? "partial" : "succeeded";
    case "failed":
      return "failed";
    default:
      return "cancelled";
  }
}

export function stateOfEndpointRun(status: EndpointRun["status"]): RunState {
  return status === "running" ? "running" : status;
}

export function isFinished(state: RunState): boolean {
  return state !== "queued" && state !== "running";
}

/** Attempts a mail restore check gets: the first plus the queue's retries (worker queues.ts, `verify`). */
export const MAIL_CHECK_ATTEMPTS = 6;
/** Attempts a restore test on a machine gets: the first plus the six retries of restoreTestRetry. */
export const ENDPOINT_CHECK_ATTEMPTS = RESTORE_TEST_RETRY_DELAYS_MS.length + 1;

/**
 * Which attempt a restore check of the mail queue is on, from the failure it carries. A check
 * that failed an attempt and waits for its retry is queued with `failure.retry` naming the attempt
 * that failed; the one that runs next is the one after. Null for a check on its first attempt.
 */
export function mailCheckAttempt(
  queue: JobQueueName,
  status: JobStatusName,
  failure: Pick<FailureDto, "retry"> | null,
): RunAttemptDto | null {
  if (queue !== "verify" || !failure?.retry) {
    return null;
  }
  const failed = failure.retry.attempt;
  const of = Math.max(failure.retry.limit, failed);
  const number = status === "active" ? failed + 1 : failed;
  return { number: Math.min(Math.max(1, number), of), of };
}

/** Which attempt a restore test on a machine is: the retry number its task carries, plus one. */
export function endpointCheckAttempt(
  kind: EndpointRun["kind"],
  taskParams: Record<string, unknown> | null,
): RunAttemptDto | null {
  if (kind !== "verify_sample" || !taskParams) {
    return null;
  }
  const retry =
    typeof taskParams.retry === "number" &&
    Number.isInteger(taskParams.retry) &&
    taskParams.retry > 0
      ? taskParams.retry
      : 0;
  // A test that was never offered again is on its first attempt: no number to show.
  return retry === 0
    ? null
    : { number: Math.min(retry + 1, ENDPOINT_CHECK_ATTEMPTS), of: ENDPOINT_CHECK_ATTEMPTS };
}

function iso(value: Date | null | undefined): string | null {
  return value ? value.toISOString() : null;
}

function percentOf(done: number, total: number): number {
  return Math.min(100, Math.max(0, Math.round((done / total) * 100)));
}

function throughputOf(
  samples: readonly RunSamplePoint[] | null,
  running: boolean,
): RunDto["throughput"] {
  if (!running || !samples) {
    return null;
  }
  return currentThroughput(samples);
}

function samplesOf(
  samples: readonly RunSamplePoint[] | null | undefined,
  count: number,
): RunSamplePoint[] | null {
  return samples && samples.length > 0 ? latestSamples(samples, count) : null;
}

export interface MailRunInput {
  row: JobViewRow;
  dto: JobDto;
  job: RunJobDto | null;
  samples?: readonly RunSamplePoint[] | null;
  /** How many of the newest points to carry (a list row; the detail takes them all). */
  sampleCount?: number;
}

/** A mail run (a `jobs` row with its progress and object). */
export function mailRun(input: MailRunInput): RunDto {
  const { row, dto, job } = input;
  const state = stateOfJob(dto.status, dto.progress?.failed ?? 0);
  const running = state === "running";
  const finished = isFinished(state);
  const progress = row.progress;
  const total = progress?.total ?? 0;
  let percent: number | null = null;
  if (progress && total > 0) {
    percent = percentOf(progress.done + progress.failed, total);
  } else if (state === "succeeded" || state === "partial") {
    percent = 100;
  }
  const samples = input.samples ?? null;
  return {
    id: dto.id,
    source: "mail",
    kind: categoryOfQueue(dto.queue),
    type: dto.queue,
    state,
    checkIncomplete: dto.checkIncomplete,
    attempt: mailCheckAttempt(dto.queue, dto.status, dto.failure),
    subject: dto.object
      ? {
          kind: dto.object.kind,
          id: dto.object.id,
          name: dto.object.displayName?.trim() || dto.object.externalId,
          detail: dto.object.externalId,
        }
      : null,
    job,
    trigger: dto.trigger,
    full: dto.full,
    createdAt: dto.createdAt,
    startedAt: dto.startedAt,
    finishedAt: dto.completedAt,
    updatedAt:
      dto.progress && dto.progress.updatedAt > dto.updatedAt
        ? dto.progress.updatedAt
        : dto.updatedAt,
    progress: progress
      ? {
          percent,
          itemsDone: progress.done,
          itemsTotal: total > 0 ? total : null,
          itemsFailed: progress.failed,
          // Rows written before 0.2.0 carry no processed count: what was stored is what is known.
          bytesProcessed: Math.max(progress.bytesProcessed, progress.bytes),
          bytesTransferred: progress.bytesTransferred,
          bytesNew: progress.bytes,
          bytesTotal: null,
          etaSeconds: running ? progress.etaSeconds : null,
          currentPath: null,
          updatedAt: progress.updatedAt.toISOString(),
        }
      : null,
    throughput: throughputOf(samples, running),
    samples: samplesOf(samples, input.sampleCount ?? LIST_SAMPLE_COUNT),
    phase: dto.phase,
    throttle: dto.throttle,
    errorMessage: dto.errorMessage,
    failure: dto.failure,
    cancellable: dto.cancellable && !finished,
  };
}

/** A machine as a run knows it. */
export interface EndpointFact {
  id: string;
  hostname: string;
  displayName: string | null;
  profile: "server" | "client";
  os: string;
}

export interface EndpointRunInput {
  run: EndpointRun;
  endpoint: EndpointFact;
  /** The `params` of the task that started the run, when one did. */
  taskParams: Record<string, unknown> | null;
  job: RunJobDto | null;
  /** A restore test the server's report rated (see `RatedTests`); false marks it incomplete. */
  rated: boolean;
  samples?: readonly RunSamplePoint[] | null;
  sampleCount?: number;
}

export function endpointName(endpoint: Pick<EndpointFact, "displayName" | "hostname">): string {
  return endpoint.displayName?.trim() || endpoint.hostname;
}

/** A run an agent reported. */
export function endpointRun(input: EndpointRunInput): RunDto {
  const { run, endpoint, job } = input;
  const state = stateOfEndpointRun(run.status);
  const running = state === "running";
  const progress: EndpointRunProgress | null = running ? run.progress : null;
  const stats: EndpointRunStats | null = run.stats;
  const samples = input.samples ?? null;
  const last =
    samples && samples.length > 0 ? (samples[samples.length - 1] as RunSamplePoint) : null;
  const throughput = throughputOf(samples, running);
  const bytesDone = progress?.bytesDone ?? stats?.totalBytesProcessed ?? last?.[1] ?? 0;
  const bytesTotal = progress?.totalBytes ?? null;
  let percent: number | null = null;
  if (running) {
    if (bytesTotal && bytesTotal > 0) {
      percent = percentOf(bytesDone, bytesTotal);
    } else if (progress?.totalFiles && progress.totalFiles > 0) {
      percent = percentOf(progress.filesDone, progress.totalFiles);
    }
  } else if (state === "succeeded" || state === "partial") {
    percent = 100;
  }
  const remaining = bytesTotal !== null ? Math.max(0, bytesTotal - bytesDone) : null;
  const etaSeconds =
    running && remaining !== null && throughput && throughput.processedBps > 0
      ? Math.round(remaining / throughput.processedBps)
      : null;
  const interruptedOnly = run.status === "failed" && isInterruptedOnly(run.errors);
  const incomplete = run.kind === "verify_sample" && !running && !input.rated;
  const startedAt = run.startedAt.toISOString();
  return {
    id: run.id,
    source: "endpoint",
    kind: categoryOfEndpointKind(run.kind),
    type: run.kind,
    state,
    checkIncomplete: incomplete,
    attempt: endpointCheckAttempt(run.kind, input.taskParams),
    subject: {
      kind: endpoint.profile,
      id: endpoint.id,
      name: endpointName(endpoint),
      detail: endpoint.os,
    },
    job,
    trigger: run.taskId !== null ? "manual" : "scheduled",
    full: false,
    createdAt: run.createdAt.toISOString(),
    startedAt,
    finishedAt: iso(run.finishedAt),
    updatedAt: progress?.updatedAt ?? iso(run.finishedAt) ?? startedAt,
    progress: {
      percent,
      itemsDone: progress?.filesDone ?? (stats?.filesNew ?? 0) + (stats?.filesChanged ?? 0),
      itemsTotal: progress?.totalFiles ?? stats?.totalFilesProcessed ?? null,
      itemsFailed: run.errors.length,
      bytesProcessed: bytesDone,
      bytesTransferred: last?.[2] ?? 0,
      bytesNew: stats?.dataAdded ?? null,
      bytesTotal,
      etaSeconds,
      currentPath: progress?.currentPath ?? null,
      updatedAt: progress?.updatedAt ?? null,
    },
    throughput,
    samples: samplesOf(samples, input.sampleCount ?? LIST_SAMPLE_COUNT),
    phase: null,
    throttle: null,
    errorMessage: interruptedOnly ? null : (run.errors[0]?.message ?? null),
    failure: failureDto(run.failure),
    cancellable: false,
  };
}

/** A file share as a run knows it. */
export interface ShareFact {
  id: string;
  name: string;
  protocol: "smb" | "nfs";
  server: string;
  shareName: string | null;
  exportPath: string | null;
}

/** Where a share is, as people write it: `\\\\server\\share` or `server:/export`. */
export function shareLocation(share: Omit<ShareFact, "id" | "name">): string {
  return share.protocol === "smb"
    ? `\\\\${share.server}\\${share.shareName ?? ""}`
    : `${share.server}:${share.exportPath ?? ""}`;
}

export interface ShareRunInput {
  run: FileShareRun;
  share: ShareFact;
  job: RunJobDto | null;
  samples?: readonly RunSamplePoint[] | null;
  sampleCount?: number;
}

/**
 * A run of a file share: a backup, a restore or a scheduled copy (a restore run of a copy job;
 * `type` says `copy`). The subject is the share backed up, or the source of a restore.
 */
export function shareRun(input: ShareRunInput): RunDto {
  const { run, share, job } = input;
  const state = stateOfShareRun(run.status);
  const running = state === "running";
  const progress = running ? run.progress : null;
  const stats = run.stats ?? {};
  const samples = input.samples ?? null;
  const last =
    samples && samples.length > 0 ? (samples[samples.length - 1] as RunSamplePoint) : null;
  const throughput = throughputOf(samples, running);
  const bytesDone = progress?.bytesDone ?? stats.bytes ?? last?.[1] ?? 0;
  const bytesTotal = progress && progress.totalBytes > 0 ? progress.totalBytes : null;
  let percent: number | null = null;
  if (running && progress) {
    if (bytesTotal) {
      percent = percentOf(bytesDone, bytesTotal);
    } else if (progress.totalFiles > 0) {
      percent = percentOf(progress.filesDone, progress.totalFiles);
    }
  } else if (state === "succeeded" || state === "partial") {
    percent = 100;
  }
  const remaining = bytesTotal !== null ? Math.max(0, bytesTotal - bytesDone) : null;
  const etaSeconds =
    running && remaining !== null && throughput && throughput.processedBps > 0
      ? Math.round(remaining / throughput.processedBps)
      : null;
  const queuedAt = run.queuedAt.toISOString();
  const copy = run.trigger === "copy";
  return {
    id: run.id,
    source: "file_share",
    kind: run.kind === "backup" ? "backup" : "restore",
    type: copy ? "copy" : run.kind,
    state,
    checkIncomplete: false,
    attempt: null,
    subject: {
      kind: "file_share",
      id: share.id,
      name: share.name,
      detail: shareLocation(share),
    },
    job,
    trigger: run.trigger === "schedule" || copy ? "scheduled" : "manual",
    full: false,
    createdAt: run.createdAt.toISOString(),
    startedAt: iso(run.startedAt),
    finishedAt: iso(run.finishedAt),
    updatedAt: iso(run.finishedAt) ?? iso(run.lastProgressAt) ?? iso(run.startedAt) ?? queuedAt,
    progress: {
      percent,
      itemsDone: progress?.filesDone ?? stats.files ?? 0,
      itemsTotal: progress && progress.totalFiles > 0 ? progress.totalFiles : (stats.files ?? null),
      itemsFailed: run.itemCount,
      bytesProcessed: bytesDone,
      bytesTransferred: progress?.bytesUploaded ?? last?.[2] ?? 0,
      bytesNew: typeof stats.dataAdded === "number" ? stats.dataAdded : null,
      bytesTotal,
      etaSeconds,
      currentPath: progress?.currentPath || null,
      updatedAt: progress?.at ?? null,
    },
    throughput,
    samples: samplesOf(samples, input.sampleCount ?? LIST_SAMPLE_COUNT),
    phase: null,
    throttle: null,
    errorMessage: run.status === "failed" ? run.errorMessage : null,
    failure: run.status === "failed" ? failureDto(run.failure) : null,
    // Cancelling is on the share's page (it reaches the runner through its progress report).
    cancellable: false,
  };
}

/** The label of a group of runs by the kind of subject: used to word "3 of 4 mailboxes". */
export function batchOf(
  states: readonly RunState[],
  options: { truncated?: boolean } = {},
): RunBatchDto {
  const batch: RunBatchDto = {
    total: states.length,
    queued: 0,
    running: 0,
    succeeded: 0,
    partial: 0,
    failed: 0,
    cancelled: 0,
    truncated: options.truncated ?? false,
  };
  for (const state of states) {
    batch[state]++;
  }
  return batch;
}

/**
 * The timeline of a run: the lines in time order, each with the time since the one before. Lines
 * at the same instant keep the order they were given in.
 */
export function timeline(events: readonly Omit<RunEventDto, "durationMs">[]): RunEventDto[] {
  const ordered = events
    .map((event, index) => ({ event, index, at: Date.parse(event.at) }))
    .sort((a, b) => a.at - b.at || a.index - b.index);
  return ordered.map(({ event, at }, index) => {
    const previous = ordered[index - 1];
    return { ...event, durationMs: previous ? Math.max(0, at - previous.at) : null };
  });
}
