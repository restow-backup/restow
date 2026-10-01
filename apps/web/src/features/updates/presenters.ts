import type { StatusTone } from "@/components/kit/status-badge";
import { ApiError, errorMessageKey } from "@/lib/api";
import {
  BLOCKER_CODES,
  type BlockerCode,
  CHECK_ERROR_CODES,
  type CheckErrorCode,
  FAILURE_CODES,
  type FailureCode,
  INVALID_UPDATE_SOURCE_PROBLEM,
  LEAD_TIME_PRESETS,
  MAX_SOURCE_URL_LENGTH,
  RECENT_SIGN_IN_PROBLEM,
  type Recovery,
  type RunOutcome,
  type RunView,
  type StepStatus,
  UPDATER_BLOCKED_PROBLEM,
  UPDATER_UNAVAILABLE_PROBLEM,
  UPDATE_BUSY_PROBLEM,
  UPDATE_NOT_VERIFIABLE_PROBLEM,
  UPDATE_RUNNING_UNKNOWN_PROBLEM,
  UPDATE_SOURCE_NOT_ALLOWED_PROBLEM,
  UPDATE_VERSION_UNKNOWN_PROBLEM,
  type UpdateChannel,
  type UpdateMode,
  type UpdateSettingsInput,
  type UpdateStepId,
  type UpdaterPhase,
  type UpdatesView,
} from "./api";

/**
 * Pure mapping from the updates documents to what the tab and the maintenance
 * shell show: i18n keys (namespace `updates` unless a namespace is spelled
 * out), tones, countdown arithmetic, the exact commands an operator copies and
 * the settings form's diff. No visible text lives here.
 */

/** The public repository Restow checks for releases when nothing else is set. */
export const DEFAULT_SOURCE_URL = "https://github.com/restow-backup/restow";

// --- API errors --------------------------------------------------------------------------------

const PROBLEM_KEYS: Record<string, string> = {
  [UPDATER_UNAVAILABLE_PROBLEM]: "updates:errors.updaterUnavailable",
  [UPDATER_BLOCKED_PROBLEM]: "updates:errors.updaterBlocked",
  [UPDATE_BUSY_PROBLEM]: "updates:errors.busy",
  [UPDATE_VERSION_UNKNOWN_PROBLEM]: "updates:errors.versionUnknown",
  [UPDATE_RUNNING_UNKNOWN_PROBLEM]: "updates:errors.runningUnknown",
  [UPDATE_SOURCE_NOT_ALLOWED_PROBLEM]: "updates:errors.sourceNotAllowed",
  [RECENT_SIGN_IN_PROBLEM]: "updates:errors.recentSignIn",
  [UPDATE_NOT_VERIFIABLE_PROBLEM]: "updates:errors.notVerifiable",
  [INVALID_UPDATE_SOURCE_PROBLEM]: "updates:errors.invalidSource",
};

/** The i18n key (with namespace) that explains a failed updates request. */
export function updatesErrorKey(error: unknown): string {
  if (error instanceof ApiError && error.problem) {
    const key = PROBLEM_KEYS[error.problem.type];
    if (key) {
      return key;
    }
  }
  return `common:${errorMessageKey(error)}`;
}

// --- The update check ----------------------------------------------------------------------------

export type CheckStatusKind =
  | "off"
  | "pending"
  | "upToDate"
  | "available"
  | "comparisonUnavailable"
  | "failed";

export interface CheckStatus {
  kind: CheckStatusKind;
  tone: StatusTone;
}

/** Errors that fix themselves (a limit lifts, a server comes back) are warnings; the rest needs a change. */
const TRANSIENT_CHECK_ERRORS: ReadonlySet<CheckErrorCode> = new Set([
  "rate_limited",
  "server_error",
  "network",
  "timeout",
]);

export function isCheckErrorCode(value: unknown): value is CheckErrorCode {
  return typeof value === "string" && (CHECK_ERROR_CODES as readonly string[]).includes(value);
}

export function checkErrorKey(code: CheckErrorCode): string {
  return isCheckErrorCode(code) ? `check.errors.${code}` : "check.errors.unknown";
}

export function checkErrorTone(code: CheckErrorCode): StatusTone {
  return TRANSIENT_CHECK_ERRORS.has(code) ? "warning" : "destructive";
}

/** What the version card says about the update check, in one word and one tone. */
export function checkStatusOf(view: Pick<UpdatesView, "check" | "updateAvailable">): CheckStatus {
  switch (view.check.state) {
    case "disabled":
      return { kind: "off", tone: "muted" };
    case "pending":
      return { kind: "pending", tone: "muted" };
    case "failed":
      return {
        kind: "failed",
        tone: view.check.error ? checkErrorTone(view.check.error.code) : "warning",
      };
    case "ok":
      if (view.updateAvailable === true) {
        return { kind: "available", tone: "info" };
      }
      if (view.updateAvailable === false) {
        // Up to date is a state, not a proof: neutral, never green.
        return { kind: "upToDate", tone: "neutral" };
      }
      return { kind: "comparisonUnavailable", tone: "muted" };
  }
}

/** A day, in the UI language ("Sep 30, 2026"); `null` when missing or invalid. */
export function formatReleaseDate(
  value: string | null | undefined,
  language: string,
): string | null {
  if (!value) {
    return null;
  }
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) {
    return null;
  }
  return new Intl.DateTimeFormat(language, { dateStyle: "medium" }).format(date);
}

/** The release page, only when it is a plain https or http link. */
export function safeReleaseUrl(url: string | null | undefined): string | null {
  if (!url) {
    return null;
  }
  try {
    const parsed = new URL(url);
    return parsed.protocol === "https:" || parsed.protocol === "http:" ? parsed.href : null;
  } catch {
    return null;
  }
}

// --- Source and channel form ---------------------------------------------------------------------

export type TokenIntent =
  | { kind: "keep" }
  | { kind: "replace"; value: string }
  | { kind: "remove" };

export interface SettingsForm {
  enabled: boolean;
  /** Empty means the default source. */
  sourceUrl: string;
  channel: UpdateChannel;
  token: TokenIntent;
}

export function settingsFormOf(view: Pick<UpdatesView, "settings">): SettingsForm {
  return {
    enabled: view.settings.enabled,
    sourceUrl: view.settings.sourceUrl ?? "",
    channel: view.settings.channel,
    token: { kind: "keep" },
  };
}

export type SourceUrlIssue = "tooLong" | "invalid" | "protocol";

/** An empty field is valid (the default source); otherwise an http(s) URL of bounded length. */
export function validateSourceUrl(value: string): SourceUrlIssue | null {
  const trimmed = value.trim();
  if (trimmed.length === 0) {
    return null;
  }
  if (trimmed.length > MAX_SOURCE_URL_LENGTH) {
    return "tooLong";
  }
  let parsed: URL;
  try {
    parsed = new URL(trimmed);
  } catch {
    return "invalid";
  }
  return parsed.protocol === "https:" || parsed.protocol === "http:" ? null : "protocol";
}

export function sourceUrlIssueKey(issue: SourceUrlIssue): string {
  return `source.url.issues.${issue}`;
}

/** Whether the token intent is complete (a replacement needs a value). */
export function tokenIntentReady(token: TokenIntent): boolean {
  return token.kind !== "replace" || token.value.trim().length > 0;
}

/**
 * The PATCH body for the fields that differ from what is stored; `null` when
 * nothing changed. With the environment override set, the switch, the source
 * and the token are the environment's and never sent; the channel stays.
 */
export function buildSettingsPatch(
  form: SettingsForm,
  view: Pick<UpdatesView, "settings" | "environmentOverride">,
): UpdateSettingsInput | null {
  const patch: UpdateSettingsInput = {};
  const locked = view.environmentOverride !== null;
  if (!locked && form.enabled !== view.settings.enabled) {
    patch.enabled = form.enabled;
  }
  if (form.channel !== view.settings.channel) {
    patch.channel = form.channel;
  }
  if (!locked) {
    const url = form.sourceUrl.trim();
    if (url !== (view.settings.sourceUrl ?? "")) {
      patch.sourceUrl = url.length > 0 ? url : null;
    }
    if (form.token.kind === "replace" && form.token.value.trim().length > 0) {
      patch.token = form.token.value.trim();
    } else if (form.token.kind === "remove" && view.settings.tokenSet) {
      patch.token = null;
    }
  }
  return Object.keys(patch).length > 0 ? patch : null;
}

/** The source the form shows as its placeholder: the default source of this installation. */
export function defaultSourceUrl(view: Pick<UpdatesView, "source">): string {
  return view.source.isDefault ? view.source.url : DEFAULT_SOURCE_URL;
}

// --- Updater ------------------------------------------------------------------------------------------

export function blockerKey(code: BlockerCode): string {
  return (BLOCKER_CODES as readonly string[]).includes(code)
    ? `updater.blockers.${code}`
    : "updater.blockers.unknown";
}

/** How a lead time reads: the message key and its parameters. */
export function leadTimeLabel(seconds: number): { key: string; params: { minutes?: number } } {
  switch (seconds) {
    case 0:
      return { key: "lead.now", params: {} };
    case 60:
      return { key: "lead.minute1", params: {} };
    case 300:
      return { key: "lead.minutes5", params: {} };
    case 900:
      return { key: "lead.minutes15", params: {} };
    case 1800:
      return { key: "lead.minutes30", params: {} };
    case 3600:
      return { key: "lead.hour1", params: {} };
    default:
      return { key: "lead.custom", params: { minutes: Math.max(1, Math.round(seconds / 60)) } };
  }
}

/** The lead times the api offers, falling back to the protocol's presets. */
export function offeredLeadTimes(view: Pick<UpdatesView, "leadTimes">): number[] {
  const offered = view.leadTimes.filter((value) => Number.isInteger(value) && value >= 0);
  return offered.length > 0 ? [...offered] : [...LEAD_TIME_PRESETS];
}

// --- Steps, outcomes and failures ---------------------------------------------------------------

export function stepLabelKey(id: UpdateStepId, mode: UpdateMode | null = null): string {
  if (id === "fetch" && mode === "image") {
    return "steps.fetchImage";
  }
  if (id === "fetch" && mode === "source") {
    return "steps.fetchSource";
  }
  return `steps.${id}`;
}

export function stepStatusKey(status: StepStatus): string {
  return `steps.status.${status}`;
}

export function isFailureCode(value: unknown): value is FailureCode {
  return typeof value === "string" && (FAILURE_CODES as readonly string[]).includes(value);
}

/** Failure codes contain a dot (`fetch.pull_failed`); the key nests accordingly. */
export function failureKey(code: FailureCode | string): string {
  return isFailureCode(code) ? `failure.${code}` : "failure.unknown";
}

export function outcomeKey(outcome: RunOutcome): string {
  return `run.outcomes.${outcome}`;
}

export function outcomeTone(outcome: RunOutcome): StatusTone {
  switch (outcome) {
    case "succeeded":
      // The update went through; nothing about it is a passed restore check.
      return "neutral";
    case "unchanged":
      return "info";
    case "rolled_back":
      return "warning";
    case "needs_attention":
      return "destructive";
  }
}

export type RunStatusKind = "scheduled" | "running" | "cancelled" | "failed" | RunOutcome;

/** What the run panel's badge says: the outcome once finished, the live phase before. */
export function runStatusOf(
  run: Pick<RunView, "outcome" | "cancelled" | "finishedAt" | "startedAt">,
  phase: UpdaterPhase,
): { kind: RunStatusKind; tone: StatusTone } {
  if (run.cancelled) {
    return { kind: "cancelled", tone: "muted" };
  }
  if (run.outcome) {
    return { kind: run.outcome, tone: outcomeTone(run.outcome) };
  }
  if (phase === "scheduled") {
    return { kind: "scheduled", tone: "info" };
  }
  if (phase === "running" || (run.startedAt && !run.finishedAt)) {
    return { kind: "running", tone: "info" };
  }
  return { kind: "failed", tone: "destructive" };
}

/** A finished run can be cleared from the tab. */
export function canDismissRun(phase: UpdaterPhase): boolean {
  return phase === "succeeded" || phase === "failed";
}

/** An announced or running maintenance: nothing else can be scheduled. */
export function isMaintenanceActive(phase: UpdaterPhase): boolean {
  return phase === "scheduled" || phase === "running";
}

// --- Clock ------------------------------------------------------------------------------------------------

/** Server clock minus client clock at the moment an answer arrived (add it to `Date.now()`). */
export function clockOffset(serverTime: string, receivedAtMs: number): number {
  const server = Date.parse(serverTime);
  return Number.isFinite(server) ? server - receivedAtMs : 0;
}

/** Whole seconds until `startsAt`, never below zero; `null` when there is no start time. */
export function remainingSeconds(
  startsAt: string | null | undefined,
  nowMs: number,
  offsetMs = 0,
): number | null {
  if (!startsAt) {
    return null;
  }
  const target = Date.parse(startsAt);
  if (!Number.isFinite(target)) {
    return null;
  }
  return Math.max(0, Math.ceil((target - (nowMs + offsetMs)) / 1000));
}

/** `04:32`, or `1:04:32` from one hour on. */
export function formatClock(totalSeconds: number): string {
  const safe = Math.max(0, Math.floor(Number.isFinite(totalSeconds) ? totalSeconds : 0));
  const hours = Math.floor(safe / 3600);
  const minutes = Math.floor((safe % 3600) / 60);
  const seconds = safe % 60;
  const pair = (value: number) => String(value).padStart(2, "0");
  return hours > 0
    ? `${hours}:${pair(minutes)}:${pair(seconds)}`
    : `${pair(minutes)}:${pair(seconds)}`;
}

/** A span rounded to its largest unit, as a message key with a count ("15 minutes"). */
export function spanLabel(totalSeconds: number): { key: string; count: number } {
  const safe = Math.max(0, Math.round(totalSeconds));
  if (safe >= 3600) {
    return { key: "span.hours", count: Math.round(safe / 3600) };
  }
  if (safe >= 60) {
    return { key: "span.minutes", count: Math.round(safe / 60) };
  }
  return { key: "span.seconds", count: safe };
}

// --- Commands the operator copies ---------------------------------------------------------------

/** Quote a value for a POSIX shell only when it needs it. */
export function shellQuote(value: string): string {
  return /^[A-Za-z0-9_@%+=:,./-]+$/.test(value) ? value : `'${value.replace(/'/g, "'\\''")}'`;
}

export const ENABLE_UPDATER_COMMAND = "docker compose --profile updater up -d";

/** Bring the updater to the version of the installation (it is not restarted by an update). */
export const RECREATE_UPDATER_COMMAND = "docker compose --profile updater up -d updater";

/**
 * A release the updater cannot install as an image: it publishes no digest for the
 * application image, so there is nothing to verify the pulled image against.
 */
export function isUnverifiableRelease(
  view: Pick<UpdatesView, "mode">,
  release: { digests: { app?: string } } | undefined,
): boolean {
  return view.mode === "image" && release !== undefined && !release.digests.app;
}

/** The variable in `.env` that names the repositories the updater may build from. */
export const SOURCE_ALLOWLIST_VARIABLE = "RESTOW_UPDATER_SOURCE_HOSTS";

/**
 * The `.env` line that lets the updater build from this source: the repository
 * as `host/owner/repo` (the operator may widen it to the whole host). Null for a
 * source without a repository.
 */
export function sourceAllowlistLine(
  source: Pick<UpdatesView["source"], "url" | "repository">,
): string | null {
  if (!source.repository) {
    return null;
  }
  try {
    const host = new URL(source.url).hostname.toLowerCase();
    return `${SOURCE_ALLOWLIST_VARIABLE}=${host}/${source.repository.toLowerCase()}`;
  } catch {
    return null;
  }
}

/** Building from the configured source is turned off on the updater (the operator has not allowed it). */
export function isSourceInstallRefused(view: Pick<UpdatesView, "mode" | "sourceAllowed">): boolean {
  return view.mode === "source" && view.sourceAllowed === false;
}

/** The updater answers with another version than the installation runs. */
export function isUpdaterOutdated(view: Pick<UpdatesView, "running" | "updater">): boolean {
  return (
    view.updater.version !== null && view.running !== null && view.updater.version !== view.running
  );
}

export interface ManualUpdate {
  image: string[];
  source: string[];
}

/** The manual update of docs/UPDATING.md, for the release the tab knows about (or a placeholder tag). */
export function manualUpdateCommands(tag: string | null): ManualUpdate {
  return {
    image: ["docker compose pull", "docker compose up -d"],
    source: [
      "git fetch --tags",
      `git checkout ${tag ? shellQuote(tag) : "vX.Y.Z"}`,
      "docker compose up -d --build",
    ],
  };
}

export type RecoveryStepId = "copy" | "stop" | "restore" | "images" | "start";

export interface RecoveryStep {
  id: RecoveryStepId;
  /** Lines to run (or, for `images`, lines to put into `.env`). */
  commands: string[];
  /** Variables `.env` must not define any more (image references that were not set before the update). */
  removeVariables: string[];
}

/**
 * The way out of `needs_attention`, built from the run's recovery facts: copy
 * the pre-update dump out of the updater volume, stop the application, restore
 * the dump, put the previous image references back into `.env`, start again.
 */
export function recoveryPlan(recovery: Recovery): RecoveryStep[] {
  const file = shellQuote(recovery.dumpFile);
  const images: string[] = [];
  const removeVariables: string[] = [];
  for (const [name, value] of [
    ["RESTOW_IMAGE", recovery.previousImages.app],
    ["RESTOW_WEB_IMAGE", recovery.previousImages.web],
  ] as const) {
    if (value) {
      images.push(`${name}=${value}`);
    } else {
      removeVariables.push(name);
    }
  }
  return [
    {
      id: "copy",
      commands: [`docker compose --profile updater cp updater:/state/dumps/${file} ./${file}`],
      removeVariables: [],
    },
    { id: "stop", commands: ["docker compose stop api worker scheduler"], removeVariables: [] },
    {
      id: "restore",
      commands: [
        `docker compose exec -T postgres pg_restore -U restow -d restow --clean --if-exists < ${file}`,
      ],
      removeVariables: [],
    },
    { id: "images", commands: images, removeVariables },
    { id: "start", commands: ["docker compose up -d"], removeVariables: [] },
  ];
}

/** All recovery commands as one script-like block (for one "copy all" button). */
export function recoveryScript(recovery: Recovery): string {
  return recoveryPlan(recovery)
    .flatMap((step) =>
      step.id === "images"
        ? [
            ...step.commands.map((line) => `# .env: ${line}`),
            ...step.removeVariables.map((name) => `# .env: remove the line ${name}`),
          ]
        : step.commands,
    )
    .join("\n");
}

// --- Maintenance messages ---------------------------------------------------------------------------------

/** The key of an updater message code; the caller checks that a translation exists. */
export function maintenanceMessageKey(code: string): string {
  return `maintenance.messages.${code}`;
}
