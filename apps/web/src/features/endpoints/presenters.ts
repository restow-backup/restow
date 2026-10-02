import type { StatusTone } from "@/components/kit";
import { ApiError, errorMessageKey } from "@/lib/api";
import { RECENT_SIGN_IN_PROBLEM } from "@/lib/recent-sign-in";

import type {
  Attention,
  BrowseEntry,
  EffectiveSettings,
  EndpointReport,
  EndpointSummary,
  EndpointTask,
  RunKind,
  RunProgress,
  RunStatus,
  RunSummary,
} from "./api.js";

/**
 * Pure logic of the endpoint pages: which label, tone and translation key a
 * state gets, how progress and durations read, how problems map to messages.
 * Nothing here renders or fetches, so it is tested on its own.
 */

/** An i18n key with its values; the caller translates it in the `endpoints` namespace. */
export interface Message {
  key: string;
  values?: Record<string, string | number>;
}

export interface Formatters {
  bytes: (value: number) => string;
  integer: (value: number) => string;
}

// --- Names ------------------------------------------------------------------------

/** The name shown for a machine: the label an admin gave it, else its host name. */
export function endpointName(endpoint: Pick<EndpointSummary, "displayName" | "hostname">): string {
  return endpoint.displayName?.trim() || endpoint.hostname;
}

/** The host name as second line, when a label replaced it as the name. */
export function endpointHostLine(
  endpoint: Pick<EndpointSummary, "displayName" | "hostname">,
): string | null {
  const label = endpoint.displayName?.trim();
  return label && label !== endpoint.hostname ? endpoint.hostname : null;
}

// --- Connection and activity ----------------------------------------------------------

export interface StatusView {
  tone: StatusTone;
  key: string;
}

/**
 * The connection state of a machine. A server is expected to be always on, so
 * being offline is a warning; a client is often off (a laptop at night), so it
 * is neutral. A revoked machine is shown as such whatever it last did.
 */
export function statusView(
  endpoint: Pick<EndpointSummary, "status" | "connection" | "profile">,
): StatusView {
  if (endpoint.status === "revoked") {
    return { tone: "muted", key: "status.revoked" };
  }
  switch (endpoint.connection) {
    case "online":
      // Online is a state, not a proof: neutral. Green is for a restore test that passed.
      return { tone: "neutral", key: "status.online" };
    case "offline":
      return { tone: endpoint.profile === "server" ? "warning" : "muted", key: "status.offline" };
    default:
      return { tone: "muted", key: "status.never" };
  }
}

/** What the agent is doing right now, if anything; the label names the run when it is known. */
export function activityKey(
  endpoint: Pick<EndpointSummary, "status" | "agentState" | "latestRun">,
): string | null {
  if (endpoint.status !== "active") {
    return null;
  }
  if (endpoint.latestRun?.status === "running") {
    return `activity.${endpoint.latestRun.kind}`;
  }
  return endpoint.agentState === "running" ? "activity.busy" : null;
}

/** Whether something is running on the machine, so the page polls faster. */
export function isBusy(
  endpoint: Pick<EndpointSummary, "status" | "agentState" | "latestRun">,
): boolean {
  return activityKey(endpoint) !== null;
}

// --- Backup outcome ------------------------------------------------------------------

export type LastBackup =
  | { state: "never" }
  | { state: "running" }
  | { state: "done"; at: string; outcome: "ok" | "partial" | "failed" | "interrupted" };

/**
 * The last backup as the list shows it: when it finished and how it ended.
 * `lastBackupAt` is the last finished backup whatever its outcome, so a failed
 * one is marked as failed instead of passing as a success. Whether a failed
 * run counts as a failure is the server's call (`interruptedOnly`): a run that
 * was only interrupted by an agent restart resumes by itself and is shown
 * neutrally.
 */
export function lastBackupOf(
  endpoint: Pick<EndpointSummary, "lastBackupAt" | "latestRun">,
): LastBackup {
  const run = endpoint.latestRun;
  if (run?.kind === "backup" && run.status === "running") {
    return { state: "running" };
  }
  if (!endpoint.lastBackupAt) {
    return { state: "never" };
  }
  let outcome: "ok" | "partial" | "failed" | "interrupted" = "ok";
  if (run?.kind === "backup" && run.status === "failed") {
    outcome = run.interruptedOnly ? "interrupted" : "failed";
  } else if (run?.kind === "backup" && run.status === "partial") {
    outcome = "partial";
  }
  return { state: "done", at: endpoint.lastBackupAt, outcome };
}

// --- Attention -------------------------------------------------------------------------

const ATTENTION_ORDER: readonly Attention[] = [
  "repository_damaged",
  "restore_test_failed",
  "last_backup_failed",
  "silent",
  "backup_overdue",
  "never_seen",
];

const ATTENTION_TONE: Record<Attention, StatusTone> = {
  repository_damaged: "destructive",
  restore_test_failed: "destructive",
  last_backup_failed: "destructive",
  silent: "destructive",
  backup_overdue: "warning",
  never_seen: "warning",
};

export function attentionTone(attention: Attention): StatusTone {
  return ATTENTION_TONE[attention];
}

/** Heaviest first, without repeats; unknown values from a newer API are kept last. */
export function sortAttention(list: readonly Attention[]): Attention[] {
  const unique = [...new Set(list)];
  const rank = (item: Attention) => {
    const index = ATTENTION_ORDER.indexOf(item);
    return index === -1 ? ATTENTION_ORDER.length : index;
  };
  return unique.sort((a, b) => rank(a) - rank(b));
}

/** Whether the attention code is one this app can word (a newer API may add more). */
export function isKnownAttention(value: string): value is Attention {
  return (ATTENTION_ORDER as readonly string[]).includes(value);
}

/**
 * The sentence for an attention code on the detail page. The thresholds come
 * from the effective settings, so the text names the limit that applies.
 */
export function attentionMessage(
  attention: Attention,
  settings: Pick<EffectiveSettings, "staleAfterHours" | "staleAfterDays"> | null,
): Message {
  switch (attention) {
    case "silent":
      return { key: "attention.silent.message", values: { hours: settings?.staleAfterHours ?? 2 } };
    case "backup_overdue":
      return {
        key: "attention.backup_overdue.message",
        values: { days: settings?.staleAfterDays ?? 7 },
      };
    default:
      return { key: `attention.${attention}.message` };
  }
}

// --- Runs -----------------------------------------------------------------------------

export interface RunStatusView {
  tone: StatusTone;
  key: string;
  live: boolean;
}

/**
 * How a run looks. A backup run that succeeded is neutral: it stowed the data
 * and nothing has read it back yet. A restore that succeeded and a restore test
 * (`verify_sample`) that succeeded are the proof green is kept for.
 */
export function runStatusView(status: RunStatus, kind?: RunKind): RunStatusView {
  switch (status) {
    case "running":
      return { tone: "info", key: "runStatus.running", live: true };
    case "succeeded":
      return {
        tone: kind === "restore" || kind === "verify_sample" ? "success" : "neutral",
        key: "runStatus.succeeded",
        live: false,
      };
    case "partial":
      return { tone: "warning", key: "runStatus.partial", live: false };
    default:
      return { tone: "destructive", key: "runStatus.failed", live: false };
  }
}

/** Which special case a run badge shows, so the badge can pick its icon. */
export type RunBadgeMark = "incomplete" | "interrupted" | null;

export interface RunBadgeView extends RunStatusView {
  mark: RunBadgeMark;
}

/**
 * The words of a restore test that could not complete. It proves nothing about
 * the backup (`checkIncomplete` from the server), so it is neither green nor
 * red but a neutral note that the test is repeated: while the backup is the
 * machine's newest, else with the next backup. A revoked machine runs no more
 * tests, so its note promises none.
 */
export function incompleteCheckKey(willRetry: boolean): string {
  return willRetry ? "runStatus.incomplete" : "runStatus.incompleteFinal";
}

/**
 * The badge of a run in the runs list and the run sheet. A restore test that
 * could not complete comes first: neutral, never "Failed" (brand guide,
 * section 4: red only when the backup is proven broken), also when the agent
 * lost it to a restart. Then a run the agent lost to a restart, which carries
 * on by itself, and else {@link runStatusView}.
 */
export function runBadgeView(
  run: {
    status: RunStatus;
    kind?: RunKind;
    interrupted?: boolean;
    checkIncomplete?: boolean;
  },
  options: { willRetry: boolean } = { willRetry: true },
): RunBadgeView {
  if (run.status !== "running" && run.checkIncomplete === true) {
    return {
      tone: "info",
      key: incompleteCheckKey(options.willRetry),
      live: false,
      mark: "incomplete",
    };
  }
  if (run.interrupted === true && run.status !== "running" && run.status !== "succeeded") {
    return { tone: "info", key: "runStatus.interrupted", live: false, mark: "interrupted" };
  }
  return { ...runStatusView(run.status, run.kind), mark: null };
}

export function runKindKey(kind: RunKind): string {
  return `runKind.${kind}`;
}

/** How long a run took (or has taken so far); `null` when the times are unusable. */
export function runDurationMs(
  run: Pick<RunSummary, "startedAt" | "finishedAt">,
  now: number = Date.now(),
): number | null {
  const start = Date.parse(run.startedAt);
  if (Number.isNaN(start)) {
    return null;
  }
  const end = run.finishedAt ? Date.parse(run.finishedAt) : now;
  if (Number.isNaN(end)) {
    return null;
  }
  return Math.max(0, end - start);
}

/** "1 h 5 min", "3 min 12 s", "45 s": the two largest units. */
export function formatDuration(ms: number, language: string): string {
  const total = Math.max(0, Math.round(ms / 1000));
  const hours = Math.floor(total / 3600);
  const minutes = Math.floor((total % 3600) / 60);
  const seconds = total % 60;
  const unit = (value: number, name: "hour" | "minute" | "second") =>
    new Intl.NumberFormat(language, {
      style: "unit",
      unit: name,
      unitDisplay: "short",
      maximumFractionDigits: 0,
    }).format(value);
  if (hours > 0) {
    return minutes > 0 ? `${unit(hours, "hour")} ${unit(minutes, "minute")}` : unit(hours, "hour");
  }
  if (minutes > 0) {
    return seconds > 0
      ? `${unit(minutes, "minute")} ${unit(seconds, "second")}`
      : unit(minutes, "minute");
  }
  return unit(seconds, "second");
}

/** Share done (0..1) by bytes when the total is known, else by files, else `null` (unknown). */
export function progressRatio(progress: RunProgress | null | undefined): number | null {
  if (!progress) {
    return null;
  }
  const clamp = (value: number) => Math.max(0, Math.min(1, value));
  if (progress.totalBytes && progress.totalBytes > 0) {
    return clamp(progress.bytesDone / progress.totalBytes);
  }
  if (progress.totalFiles && progress.totalFiles > 0) {
    return clamp(progress.filesDone / progress.totalFiles);
  }
  return null;
}

/** The error codes the agent reports (agent/ of the repository); others are shown as they are. */
const RUN_ERROR_CODES = [
  "interrupted",
  "agent_stopped",
  "no_paths",
  "pre_hook_failed",
  "post_hook_failed",
  "hooks_not_allowed",
  "timeout",
  "target_not_empty",
  "invalid_task",
  "hash_mismatch",
  "missing",
  "not_regular",
  "read_error",
] as const;

export interface RunErrorView {
  /** The meaning of the code; `null` for an error without a code. */
  headline: Message | null;
  /** The agent stopped by itself and resumes: no failure. */
  neutral: boolean;
}

/**
 * Words the code of a run error. `restic_exit_<N>` names the exit code of
 * restic; a code this app does not know is shown raw, next to the agent's own
 * message, which the sheet always keeps visible as the detail.
 */
export function runErrorView(error: { code?: string }): RunErrorView {
  const code = error.code?.trim();
  if (!code) {
    return { headline: null, neutral: false };
  }
  if ((RUN_ERROR_CODES as readonly string[]).includes(code)) {
    return { headline: { key: `runErrors.${code}` }, neutral: code === "interrupted" };
  }
  const exit = /^restic_exit_(\d+)$/.exec(code);
  if (exit) {
    return {
      headline: { key: "runErrors.restic_exit", values: { code: Number(exit[1]) } },
      neutral: false,
    };
  }
  return { headline: { key: "runErrors.unknown", values: { code } }, neutral: false };
}

/** A run whose every error is an interruption: the agent was restarted and carries on by itself. */
export function onlyInterrupted(errors: readonly { code?: string }[]): boolean {
  return errors.length > 0 && errors.every((error) => error.code === "interrupted");
}

/** How many errors the run sheet lists before it says how many more there are. */
export const RUN_ERRORS_SHOWN = 100;

// --- Reports --------------------------------------------------------------------------

export interface ReportView {
  tone: StatusTone;
  /** The result in one line. */
  headline: Message;
  /** Extra facts, one per line. */
  details: Message[];
}

/**
 * What a server-side report says, in words. A restore test reads how many of
 * the sampled files matched; a failed step carries its own message.
 */
export function reportView(report: EndpointReport, format: Formatters): ReportView {
  const tone: StatusTone =
    report.readiness === "red"
      ? "destructive"
      : report.readiness === "yellow"
        ? "warning"
        : report.readiness === "green"
          ? "success"
          : "muted";
  const data = report.summary;
  const details: Message[] = [];
  if (data.errorMessage) {
    details.push({ key: "reports.errorMessage", values: { message: data.errorMessage } });
  }
  switch (report.kind) {
    case "restore_test": {
      if (typeof data.files === "number" && typeof data.matched === "number") {
        return {
          tone,
          headline: {
            key: "reports.restoreTest.matched",
            values: { matched: format.integer(data.matched), files: format.integer(data.files) },
          },
          details,
        };
      }
      return { tone, headline: { key: "reports.restoreTest.noResult" }, details };
    }
    case "repository_check": {
      const percent = typeof data.subsetPercent === "number" ? data.subsetPercent : null;
      return {
        tone,
        headline:
          percent === null
            ? { key: "reports.check.headline" }
            : { key: "reports.check.subset", values: { percent: Math.round(percent) } },
        details,
      };
    }
    default: {
      if (typeof data.removedSnapshots === "number" && typeof data.keptSnapshots === "number") {
        details.push({
          key: "reports.retention.kept",
          values: { kept: format.integer(data.keptSnapshots) },
        });
      }
      if (typeof data.repositoryBytes === "number") {
        details.push({
          key: "reports.retention.size",
          values: { size: format.bytes(data.repositoryBytes) },
        });
      }
      if (typeof data.unrecordedSnapshots === "number" && data.unrecordedSnapshots > 0) {
        details.push({
          key: "reports.retention.unrecorded",
          values: { count: data.unrecordedSnapshots },
        });
      }
      return {
        tone,
        headline:
          typeof data.removedSnapshots === "number"
            ? {
                key: "reports.retention.removed",
                values: { count: data.removedSnapshots },
              }
            : { key: "reports.retention.headline" },
        details,
      };
    }
  }
}

export function reportKindKey(kind: EndpointReport["kind"]): string {
  return `reports.kind.${kind}`;
}

// --- Tasks ----------------------------------------------------------------------------

/** Tasks that still wait for the machine (queued, or handed over and not finished). */
export function waitingTasks(tasks: readonly EndpointTask[]): EndpointTask[] {
  return tasks.filter((task) => task.status === "pending" || task.status === "delivered");
}

/**
 * How a finished request ended, worded. The server records a short reason on a
 * failed one; the ones it writes itself have a text here (`tasks.reason.*`),
 * anything else (an error the agent reported) is shown as it came.
 */
export type TaskOutcome =
  | { state: "done" }
  | {
      /** `incomplete`: a restore test that rated nothing (`checkIncomplete`); it proves nothing. */
      state: "failed" | "incomplete";
      reason: { key: string } | { text: string } | null;
    };

const TASK_REASON_KEYS: Readonly<Record<string, string>> = {
  expired: "tasks.reason.expired",
  "endpoint revoked": "tasks.reason.revoked",
  "agent stopped reporting": "tasks.reason.agentStopped",
};

export function taskOutcomeOf(
  task: Pick<EndpointTask, "status" | "errorMessage" | "checkIncomplete">,
): TaskOutcome {
  if (task.status !== "failed") {
    return { state: "done" };
  }
  const state = task.checkIncomplete === true ? "incomplete" : "failed";
  const message = task.errorMessage?.trim() ?? "";
  if (message === "") {
    return { state, reason: null };
  }
  const key = TASK_REASON_KEYS[message];
  return { state, reason: key ? { key } : { text: message } };
}

export interface TaskStatusView {
  tone: StatusTone;
  key: string;
  mark: "incomplete" | null;
}

/**
 * The badge of a finished request. Only a restore that went through is green:
 * the data is back. A restore test that could not complete is neutral like
 * its run ({@link incompleteCheckKey}); any other failed request is a failure.
 */
export function taskStatusView(
  task: Pick<EndpointTask, "kind" | "status">,
  outcome: TaskOutcome,
  options: { willRetry: boolean } = { willRetry: true },
): TaskStatusView {
  switch (outcome.state) {
    case "done":
      return {
        tone: task.kind === "restore" ? "success" : "neutral",
        key: `tasks.status.${task.status}`,
        mark: null,
      };
    case "incomplete":
      return { tone: "info", key: incompleteCheckKey(options.willRetry), mark: "incomplete" };
    default:
      return { tone: "destructive", key: "tasks.status.failed", mark: null };
  }
}

/**
 * When a restore test offered again (it could not complete before) may be
 * picked up: `params.notBefore` of the task while it lies ahead, else `null`.
 */
export function retryNotBefore(
  task: Pick<EndpointTask, "kind" | "params">,
  now: number = Date.now(),
): string | null {
  const value = task.params.notBefore;
  if (task.kind !== "verify_sample" || typeof value !== "string") {
    return null;
  }
  const at = Date.parse(value);
  return Number.isNaN(at) || at <= now ? null : value;
}

// --- Configuration ------------------------------------------------------------------------

/**
 * Whether the machine already runs the configuration the server holds. Until
 * it fetched the change (next heartbeat), the two versions differ.
 */
export function configPending(detail: {
  configVersion: number;
  agentConfigVersion: number | null;
}): boolean {
  return detail.agentConfigVersion === null || detail.agentConfigVersion < detail.configVersion;
}

// --- File browser ------------------------------------------------------------------------

export interface PathSegment {
  name: string;
  path: string;
}

/** "/home/ada/docs" -> home, ada, docs, each with the path up to it. */
export function pathSegments(path: string): PathSegment[] {
  const parts = path.split("/").filter(Boolean);
  return parts.map((name, index) => ({ name, path: `/${parts.slice(0, index + 1).join("/")}` }));
}

/** Whether `path` lies below `ancestor` (not equal to it). */
export function isBelow(path: string, ancestor: string): boolean {
  const base = ancestor.endsWith("/") ? ancestor : `${ancestor}/`;
  return path !== ancestor && path.startsWith(base);
}

/** A file or folder the user ticked in the browser. */
export interface SelectedItem {
  path: string;
  name: string;
  type: BrowseEntry["type"];
}

export type Selection = ReadonlyMap<string, SelectedItem>;

/** Whether a folder the user ticked already includes this path. */
export function coveredByFolder(selection: Selection, path: string): boolean {
  for (const item of selection.values()) {
    if (item.type === "dir" && isBelow(path, item.path)) {
      return true;
    }
  }
  return false;
}

export function toggleItem(selection: Selection, entry: BrowseEntry): Selection {
  const next = new Map(selection);
  if (next.has(entry.path)) {
    next.delete(entry.path);
  } else {
    next.set(entry.path, { path: entry.path, name: entry.name, type: entry.type });
  }
  return next;
}

/** Entries that can be ticked at all; devices and other special files cannot be restored. */
export function isSelectable(entry: BrowseEntry): boolean {
  return entry.type !== "other";
}

/** Tick every selectable entry of the folder, or clear them when all are ticked already. */
export function toggleAll(selection: Selection, entries: readonly BrowseEntry[]): Selection {
  const selectable = entries.filter(isSelectable);
  const allTicked = selectable.length > 0 && selectable.every((e) => selection.has(e.path));
  const next = new Map(selection);
  for (const entry of selectable) {
    if (allTicked) {
      next.delete(entry.path);
    } else {
      next.set(entry.path, { path: entry.path, name: entry.name, type: entry.type });
    }
  }
  return next;
}

/** "checked", "indeterminate" or "unchecked" for the header box of a folder listing. */
export function allState(
  selection: Selection,
  entries: readonly BrowseEntry[],
): boolean | "indeterminate" {
  const selectable = entries.filter(isSelectable);
  if (selectable.length === 0) {
    return false;
  }
  const ticked = selectable.filter(
    (e) => selection.has(e.path) || coveredByFolder(selection, e.path),
  );
  if (ticked.length === 0) {
    return false;
  }
  return ticked.length === selectable.length ? true : "indeterminate";
}

/**
 * The paths a download or restore names: a folder includes everything inside,
 * so anything below a ticked folder is left out (it would only repeat it).
 */
export function effectivePaths(selection: Selection): string[] {
  const items = [...selection.values()];
  return items
    .filter((item) => !coveredByFolder(selection, item.path))
    .map((item) => item.path)
    .sort();
}

/** How many single files (not folders) the download names; each one is read on its own. */
export function effectiveFileCount(selection: Selection): number {
  return [...selection.values()].filter(
    (item) => item.type !== "dir" && !coveredByFolder(selection, item.path),
  ).length;
}

export interface SelectionLimits {
  paths: string[];
  /** The download cannot be started as it is, and why. */
  downloadBlocked: "too_many" | null;
  restoreBlocked: "too_many" | null;
}

export function selectionLimits(
  selection: Selection,
  limits: { downloadPaths: number; restorePaths: number },
): SelectionLimits {
  const paths = effectivePaths(selection);
  return {
    paths,
    downloadBlocked: paths.length > limits.downloadPaths ? "too_many" : null,
    restoreBlocked: paths.length > limits.restorePaths ? "too_many" : null,
  };
}

/**
 * Past this many single items the download is slow: the server reads every
 * file on its own, so the page points at the parent folder instead.
 */
export const MANY_ITEMS_NOTE_AT = 50;

// --- Restore target ---------------------------------------------------------------------------

/** An absolute path of a POSIX or Windows machine (schemas.ts `absolutePath`). */
export function isAbsolutePath(value: string): boolean {
  return /^(\/|[A-Za-z]:[\\/])/.test(value);
}

// biome-ignore lint/suspicious/noControlCharactersInRegex: control characters are what is refused
const CONTROL_CHARACTERS = /[\u0000-\u001f]/;

export function hasControlCharacters(value: string): boolean {
  return CONTROL_CHARACTERS.test(value);
}

// --- Problems ----------------------------------------------------------------------------------

/**
 * The problem types the endpoint API raises (apps/api features/endpoints
 * problems.ts) and the texts that word them. A request is worded by its type,
 * never by its title.
 */
const PROBLEM_KEYS: Readonly<Record<string, string>> = {
  "urn:restow:problem:restic-busy": "endpoints:errors.resticBusy",
  "urn:restow:problem:endpoint-repository-locked": "endpoints:errors.repositoryLocked",
  "urn:restow:problem:endpoint-repository-unavailable": "endpoints:errors.repositoryUnavailable",
  "urn:restow:problem:restic-failed": "endpoints:errors.resticFailed",
  "urn:restow:problem:restic-unavailable": "endpoints:errors.resticUnavailable",
  "urn:restow:problem:unsupported-os": "endpoints:errors.unsupportedOs",
  "urn:restow:problem:endpoint-revoked": "endpoints:errors.revoked",
  "urn:restow:problem:endpoint-nothing-to-test": "endpoints:errors.nothingToTest",
  "urn:restow:problem:endpoint-instance-unknown": "endpoints:errors.instanceUnknown",
  "urn:restow:problem:endpoint-queue-not-ready": "endpoints:errors.queueNotReady",
  "urn:restow:problem:endpoint-path-not-found": "endpoints:errors.pathNotFound",
  "urn:restow:problem:endpoint-token-settled": "endpoints:errors.tokenSettled",
  "urn:restow:problem:endpoint-download-gone": "endpoints:errors.downloadGone",
  "urn:restow:problem:endpoint-download-too-large": "endpoints:errors.downloadTooLarge",
  "urn:restow:problem:endpoint-invalid-cursor": "endpoints:errors.invalidCursor",
  "urn:restow:problem:endpoint-hooks-not-allowed": "endpoints:errors.hooksNotAllowed",
  "urn:restow:problem:endpoint-hook-not-a-script": "endpoints:errors.hookNotAScript",
  "urn:restow:problem:endpoint-config-managed-by-job": "endpoints:errors.configManagedByJob",
  "urn:restow:problem:endpoint-invalid-bandwidth-windows":
    "endpoints:errors.invalidBandwidthWindows",
  [RECENT_SIGN_IN_PROBLEM]: "endpoints:errors.recentSignIn",
};

/**
 * The fully qualified i18n key that words a failed request: the endpoint
 * specific problems first (a busy or locked repository asks to try again),
 * else the general message of the app.
 */
export function endpointErrorKey(error: unknown): string {
  if (error instanceof ApiError) {
    const byType = error.problem?.type ? PROBLEM_KEYS[error.problem.type] : undefined;
    if (byType) {
      return byType;
    }
  }
  return `common:${errorMessageKey(error)}`;
}

/** The busy and locked answers ask the user to try again in a moment. */
export function isRetryableProblem(error: unknown): boolean {
  if (!(error instanceof ApiError)) {
    return false;
  }
  return (
    error.problem?.type === "urn:restow:problem:restic-busy" ||
    error.problem?.type === "urn:restow:problem:endpoint-repository-locked"
  );
}

// --- Polling ------------------------------------------------------------------------------------

/** Refresh interval while something runs, and while nothing does. */
export const LIVE_REFRESH_MS = 15_000;
export const IDLE_REFRESH_MS = 60_000;
/** The open run sheet follows a running backup more closely (progress arrives every 5 s, every 10 s from an agent older than 0.2.0). */
export const RUN_REFRESH_MS = 5_000;

export function listRefetchInterval(items: readonly EndpointSummary[] | undefined): number {
  return items?.some(isBusy) ? LIVE_REFRESH_MS : IDLE_REFRESH_MS;
}

export function detailRefetchInterval(
  detail:
    | (Pick<EndpointSummary, "status" | "agentState" | "latestRun"> & {
        tasks?: readonly EndpointTask[];
      })
    | undefined,
): number {
  if (!detail) {
    return IDLE_REFRESH_MS;
  }
  return isBusy(detail) || waitingTasks(detail.tasks ?? []).length > 0
    ? LIVE_REFRESH_MS
    : IDLE_REFRESH_MS;
}

// --- Storage budget -------------------------------------------------------------

/** The share of a budget in use, in whole percent; null without a budget or a measurement. */
export function quotaPercent(used: number | null, budget: number | null): number | null {
  if (used === null || budget === null || budget <= 0) {
    return null;
  }
  return Math.floor((used / budget) * 100);
}
