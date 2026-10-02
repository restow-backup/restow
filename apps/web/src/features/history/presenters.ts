import type { StatusTone } from "@/components/kit/status-badge";

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
  return kind === "mailbox" || kind === "onedrive" || kind === "imap";
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
