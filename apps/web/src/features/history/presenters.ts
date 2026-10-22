import type { StatusTone } from "@/components/kit/status-badge";
import { throttleRemainingMs } from "@/features/jobs/presenters";

import type {
  HistoryFilters,
  Run,
  RunCategory,
  RunEvent,
  RunRestoreCheck,
  RunState,
  RunSubject,
} from "./api";
import { RUN_CATEGORIES } from "./api";

/**
 * What the History pages decide, in pure functions: how a run's state reads and which tone it
 * wears, what its numbers say (percent, time left, savings), what its restore check shows, and
 * how the address names a tab, a job and an open run. The components stay declarative and
 * this file is unit tested.
 */

// --- State ---------------------------------------------------------------------------------------

export interface StateView {
  /** i18n key below `state.` in the `history` namespace. */
  key:
    | "queued"
    | "running"
    | "succeeded"
    | "restored"
    | "partial"
    | "failed"
    | "cancelled"
    | "incomplete";
  tone: StatusTone;
  /** A pulsing dot instead of an icon: something is running right now. */
  live: boolean;
}

/**
 * How a run's state reads. Brand rules: Lapis is "running"; green is only for proof, so a
 * backup that completed is neutral (no restore check has read it back) and only a restore that
 * completed, which brought the data back, is green. A restore check that could not complete is
 * neutral information (it is repeated), never "failed".
 */
export function stateView(run: Pick<Run, "state" | "kind" | "checkIncomplete">): StateView {
  if (run.checkIncomplete && run.state !== "running" && run.state !== "queued") {
    return { key: "incomplete", tone: "info", live: false };
  }
  switch (run.state) {
    case "running":
      return { key: "running", tone: "info", live: true };
    case "queued":
      return { key: "queued", tone: "muted", live: false };
    case "succeeded":
      return run.kind === "restore"
        ? { key: "restored", tone: "success", live: false }
        : { key: "succeeded", tone: "neutral", live: false };
    case "partial":
      return { key: "partial", tone: "warning", live: false };
    case "failed":
      return { key: "failed", tone: "destructive", live: false };
    default:
      return { key: "cancelled", tone: "muted", live: false };
  }
}

export function isRunning(state: RunState): boolean {
  return state === "running";
}

export function isLiveState(state: RunState): boolean {
  return state === "running" || state === "queued";
}

// --- Restore check ---------------------------------------------------------------------------------

export interface CheckView {
  key: RunRestoreCheck["state"];
  tone: StatusTone;
}

/** Green only for a check that read the backup back and found it whole (brand guide, section 4). */
export function checkView(check: Pick<RunRestoreCheck, "state">): CheckView {
  switch (check.state) {
    case "passed":
      return { key: "passed", tone: "success" };
    case "warning":
      return { key: "warning", tone: "warning" };
    case "failed":
      return { key: "failed", tone: "destructive" };
    case "running":
      return { key: "running", tone: "info" };
    case "queued":
      return { key: "queued", tone: "muted" };
    case "unverified":
      return { key: "unverified", tone: "muted" };
    default:
      return { key: "none", tone: "muted" };
  }
}

// --- Numbers -----------------------------------------------------------------------------------------

function timeOf(value: string | null): number | null {
  if (!value) {
    return null;
  }
  const parsed = Date.parse(value);
  return Number.isNaN(parsed) ? null : parsed;
}

/** How long a run ran, or has been running, in seconds; null before it started. */
export function runDurationSeconds(
  run: Pick<Run, "startedAt" | "finishedAt">,
  now: number,
): number | null {
  const started = timeOf(run.startedAt);
  if (started === null) {
    return null;
  }
  const ended = timeOf(run.finishedAt) ?? now;
  return Math.max(0, (ended - started) / 1000);
}

// --- Liveness ----------------------------------------------------------------------------------

/**
 * A running run that reported nothing for this long says so. The worker reports every 50 items
 * or two seconds while items complete; a large item or a pause Microsoft asked for keeps it quiet.
 */
export const QUIET_AFTER_MS = 30_000;

/** When the run last reported: its progress, else the run itself. */
export function lastReportAt(run: Pick<Run, "progress" | "updatedAt">): number | null {
  return timeOf(run.progress?.updatedAt ?? null) ?? timeOf(run.updatedAt);
}

export type Liveness =
  | { kind: "reporting"; silentSeconds: number }
  | { kind: "throttled"; silentSeconds: number; waitSeconds: number }
  | { kind: "quiet"; silentSeconds: number };

/**
 * Whether a running run is still reporting, and if not, what is known about why: Microsoft Graph
 * asked it to wait (until the moment it reported), or nothing, only how long it has been quiet.
 * Null for a run that is not running or has no time to go by.
 */
export function livenessOf(
  run: Pick<Run, "state" | "progress" | "updatedAt" | "throttle">,
  now: number,
): Liveness | null {
  if (run.state !== "running") {
    return null;
  }
  const at = lastReportAt(run);
  if (at === null) {
    return null;
  }
  const silentMs = Math.max(0, now - at);
  const silentSeconds = Math.floor(silentMs / 1000);
  const waitMs = throttleRemainingMs(run.throttle, now);
  if (waitMs > 0) {
    return { kind: "throttled", silentSeconds, waitSeconds: Math.ceil(waitMs / 1000) };
  }
  return silentMs > QUIET_AFTER_MS
    ? { kind: "quiet", silentSeconds }
    : { kind: "reporting", silentSeconds };
}

/**
 * The time left, going down every second between two reports: the estimate of the last report
 * less the time since. Never below zero; null without an estimate.
 */
export function remainingSeconds(
  etaSeconds: number | null | undefined,
  run: Pick<Run, "progress" | "updatedAt">,
  now: number,
): number | null {
  if (etaSeconds === null || etaSeconds === undefined || !Number.isFinite(etaSeconds)) {
    return null;
  }
  const at = lastReportAt(run);
  const elapsed = at === null ? 0 : Math.max(0, (now - at) / 1000);
  return Math.max(0, etaSeconds - elapsed);
}

/** The width of a progress bar: the run's percent, 100 once it completed, 0 for what has not begun. */
export function barPercent(run: Pick<Run, "state" | "progress">): number | null {
  const percent = run.progress?.percent;
  if (percent !== null && percent !== undefined) {
    return Math.min(100, Math.max(0, percent));
  }
  if (run.state === "succeeded" || run.state === "partial") {
    return 100;
  }
  return run.state === "running" ? null : 0;
}

export type EstimateUnit = "underMinute" | "minutes" | "hours" | "hoursMinutes" | "days";

/**
 * A time left worded as the estimate it is (#47): the further out, the coarser,
 * so a rate measured over a few minutes does not pose as exact to the second.
 * Under a minute; whole minutes up to 10; then 5 minutes; 15 minutes up to
 * 10 hours; whole hours beyond, with days from 48 hours.
 */
export function estimateParts(totalSeconds: number): {
  key: `firstBackup.estimate.${EstimateUnit}`;
  values: { days: number; hours: number; minutes: number };
} {
  const seconds = Number.isFinite(totalSeconds) ? Math.max(0, totalSeconds) : 0;
  const parts = (unit: EstimateUnit, days: number, hours: number, minutes: number) => ({
    key: `firstBackup.estimate.${unit}` as const,
    values: { days, hours, minutes },
  });
  if (seconds < 60) {
    return parts("underMinute", 0, 0, 0);
  }
  const minutes = seconds / 60;
  if (minutes < 10) {
    return parts("minutes", 0, 0, Math.round(minutes));
  }
  const byFive = Math.round(minutes / 5) * 5;
  if (byFive < 60) {
    return parts("minutes", 0, 0, byFive);
  }
  if (minutes < 600) {
    const byQuarter = Math.round(minutes / 15) * 15;
    const hours = Math.floor(byQuarter / 60);
    const rest = byQuarter % 60;
    return rest === 0 ? parts("hours", 0, hours, 0) : parts("hoursMinutes", 0, hours, rest);
  }
  const hours = Math.round(minutes / 60);
  return hours >= 48
    ? parts("days", Math.floor(hours / 24), hours % 24, 0)
    : parts("hours", 0, hours, 0);
}

/** The share of what was read that did not have to be written: deduplication and compression. */
export function savingsPercent(processed: number, transferred: number): number | null {
  if (!(processed > 0) || !(transferred >= 0)) {
    return null;
  }
  return Math.max(0, Math.min(99.9, (1 - transferred / processed) * 100));
}

/**
 * How many of a wave have finished ("3 of 4 mailboxes backed up"): everything that is no longer
 * queued or running. Null for a run that is not part of a wave.
 */
export function waveProgress(
  batch: { total: number; queued: number; running: number } | null,
): { done: number; total: number } | null {
  if (!batch || batch.total <= 1) {
    return null;
  }
  return { done: batch.total - batch.queued - batch.running, total: batch.total };
}

// --- Words ---------------------------------------------------------------------------------------------

/** The i18n key (below `kind.`) of a run's kind. */
export function kindKey(kind: RunCategory): string {
  return `kind.${kind}`;
}

/** The i18n key of what a subject is: a mailbox, a OneDrive, a server... */
export function subjectKindKey(kind: RunSubject["kind"]): string {
  return `subject.${kind}`;
}

export function isMailSubject(kind: RunSubject["kind"]): boolean {
  return (
    kind === "mailbox" ||
    kind === "onedrive" ||
    kind === "imap" ||
    kind === "site" ||
    kind === "group"
  );
}

/** The name of a run for lists and headings: what it did to what, in the viewer's words. */
export function runLabelParts(run: Pick<Run, "kind" | "subject">): {
  kindKey: string;
  subject: string | null;
} {
  return { kindKey: kindKey(run.kind), subject: run.subject?.name ?? null };
}

export interface EventView {
  /** i18n key below `events.` in the `history` namespace. */
  key: string;
  values: Record<string, string | number>;
}

/** The key and values to word a line of a run's timeline; unknown types read as their name. */
export function eventView(event: Pick<RunEvent, "type" | "params">): EventView {
  const text = (value: unknown): string => (typeof value === "string" ? value : "");
  const count = (value: unknown): number => (typeof value === "number" ? value : 0);
  const { params } = event;
  switch (event.type) {
    case "started":
      return { key: params.full === true ? "startedFull" : "started", values: {} };
    case "phase":
      return { key: "phase", values: { phase: text(params.phase) } };
    case "throttled":
      return {
        key: "throttled",
        values: { status: count(params.status), seconds: Math.round(count(params.waitMs) / 1000) },
      };
    case "item_failed":
      return {
        key: "itemFailed",
        values: { item: text(params.item), reason: text(params.reason) },
      };
    case "completed": {
      const written = params.itemsWritten;
      const failed = count(params.failed);
      if (typeof written === "number") {
        return {
          key: failed > 0 ? "completedWithFailures" : "completedItems",
          values: { written, total: count(params.itemsTotal), failed },
        };
      }
      return { key: failed > 0 ? "completedWithFailuresPlain" : "completed", values: { failed } };
    }
    case "failed":
      return {
        key: params.message ? "failedWithReason" : "failed",
        values: { reason: text(params.message) },
      };
    case "agent_error":
      return {
        key: params.path ? "agentErrorPath" : "agentError",
        values: { path: text(params.path), message: text(params.message) },
      };
    case "finished": {
      const files = count(params.filesNew) + count(params.filesChanged);
      return {
        key: files > 0 ? "finishedFiles" : "finished",
        values: { files, state: text(params.state) },
      };
    }
    default:
      return { key: event.type, values: {} };
  }
}

// --- The address -----------------------------------------------------------------------------------------

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function isRunCategory(value: unknown): value is RunCategory {
  return typeof value === "string" && (RUN_CATEGORIES as readonly string[]).includes(value);
}

export interface HistorySearch extends HistoryFilters {
  /** The run whose drawer is open. */
  run: string | null;
}

function id(value: unknown): string | null {
  return typeof value === "string" && UUID.test(value) ? value : null;
}

/** `?type=`, `?job=` and `?run=` of an address; anything else is ignored, a bad value reads as absent. */
export function parseHistorySearch(search: Record<string, unknown>): HistorySearch {
  return {
    type: isRunCategory(search.type) ? search.type : null,
    job: id(search.job),
    run: id(search.run),
  };
}

/** The search of an address for these filters (and an open run); absent values stay out. */
export function historySearchOf(search: Partial<HistorySearch>): Record<string, string> {
  return {
    ...(search.type ? { type: search.type } : {}),
    ...(search.job ? { job: search.job } : {}),
    ...(search.run ? { run: search.run } : {}),
  };
}

/** The search of the address the current one becomes with the drawer open on `runId` (null closes it). */
export function withRun(
  search: Record<string, unknown>,
  runId: string | null,
): Record<string, unknown> {
  const { run: _closed, ...rest } = search;
  return runId ? { ...rest, run: runId } : rest;
}
