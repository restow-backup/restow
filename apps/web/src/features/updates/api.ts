import { apiFetch } from "@/lib/api";

/**
 * Client for the Updates feature (`apps/api/src/features/updates`) and the
 * maintenance state every signed-in user reads. The types mirror the api's
 * `schemas.ts` and the updater protocol by hand: the web never imports from
 * apps/api. Requests never carry a tenant header (installation level).
 */

// --- Updater protocol (apps/api/src/updater/protocol.ts) ---------------------------------

/** The steps of an update, in the order they run. */
export const UPDATE_STEPS = [
  "prepare",
  "fetch",
  "backup",
  "stop",
  "start",
  "health",
  "finish",
] as const;
export type UpdateStepId = (typeof UPDATE_STEPS)[number];

export const STEP_STATUSES = ["pending", "running", "done", "failed", "skipped"] as const;
export type StepStatus = (typeof STEP_STATUSES)[number];

export const UPDATER_PHASES = ["idle", "scheduled", "running", "succeeded", "failed"] as const;
export type UpdaterPhase = (typeof UPDATER_PHASES)[number];

export const RUN_OUTCOMES = ["succeeded", "unchanged", "rolled_back", "needs_attention"] as const;
export type RunOutcome = (typeof RUN_OUTCOMES)[number];

export type UpdateMode = "image" | "source";

/** Lead times an administrator can announce a maintenance with, in seconds. */
export const LEAD_TIME_PRESETS = [0, 60, 300, 900, 1800, 3600] as const;

/** `<step>.<reason>`; translated under `updates:failure.*`. */
export const FAILURE_CODES = [
  "prepare.docker_unreachable",
  "prepare.compose_missing",
  "prepare.project_dir_mismatch",
  "prepare.env_unwritable",
  "prepare.disk_space",
  "prepare.not_newer",
  "prepare.switch_refused",
  "prepare.compose_unsupported",
  "prepare.updater_image_unpinned",
  "fetch.pull_failed",
  "fetch.digest_missing",
  "fetch.signature_invalid",
  "fetch.digest_mismatch",
  "fetch.download_failed",
  "fetch.token_unavailable",
  "fetch.build_failed",
  "backup.failed",
  "stop.failed",
  "start.failed",
  "health.timeout",
  "health.crashed",
  "health.version_mismatch",
  "finish.failed",
  "interrupted",
] as const;
export type FailureCode = (typeof FAILURE_CODES)[number];

export const BLOCKER_CODES = [
  "docker_unreachable",
  "compose_missing",
  "project_dir_mismatch",
  "env_unwritable",
  "disk_space",
  "docker_cli_missing",
  "updater_image_unpinned",
] as const;
export type BlockerCode = (typeof BLOCKER_CODES)[number];

export interface Blocker {
  code: BlockerCode;
  detail: string | null;
}

export interface DumpInfo {
  file: string;
  bytes: number;
  createdAt: string;
}

/**
 * Every message code the updater writes into `run.message` and the public
 * status (apps/api/src/updater/protocol.ts `UPDATE_MESSAGE_CODES`); each is
 * translated under `updates:maintenance.messages.<code>` (the dots nest).
 * A code that is not listed is never shown.
 */
export const UPDATE_MESSAGE_CODES = [
  "run.scheduled",
  "run.starting",
  "run.succeeded",
  "run.unchanged",
  "run.rolled_back",
  "run.needs_attention",
  "run.interrupted",
  "step.prepare.checking",
  "step.prepare.verifying_compose",
  "step.fetch.pulling",
  "step.fetch.pulling_web",
  "step.fetch.web_not_published",
  "step.fetch.verifying_signatures",
  "step.fetch.verifying_digests",
  "step.fetch.requesting_token",
  "step.fetch.downloading",
  "step.fetch.extracting",
  "step.fetch.building",
  "step.fetch.building_web",
  "step.backup.baseline",
  "step.backup.dumping",
  "step.backup.verifying",
  "step.stop.stopping",
  "step.start.writing_env",
  "step.start.starting_api",
  "step.health.waiting_for_api",
  "step.health.starting_workers",
  "step.health.starting_edge",
  "step.health.verifying_services",
  "step.finish.cleaning",
  "rollback.checking_migrations",
  "rollback.restoring_env",
  "rollback.restarting",
  "rollback.waiting_for_api",
  "rollback.done",
  "rollback.failed",
  "recovery.stopping_application",
  "recovery.dump_kept",
] as const;
export type UpdateMessageCode = (typeof UPDATE_MESSAGE_CODES)[number];

/** Text from the updater: a code and parameters, translated here (never prose). */
export interface UpdateMessage {
  code: string;
  params: Record<string, string | number>;
}

export interface StepState {
  id: UpdateStepId;
  status: StepStatus;
  startedAt: string | null;
  finishedAt: string | null;
  detail: Record<string, string | number | boolean | null>;
}

export interface Recovery {
  dumpFile: string;
  dumpBytes: number | null;
  fromVersion: string | null;
  previousImages: { app: string | null; web: string | null };
}

export interface Failure {
  code: FailureCode;
  step: UpdateStepId;
  detail: string;
  migrationsRan: boolean | null;
}

/** The current or last run as an administrator sees it. */
export interface RunView {
  id: string;
  mode: UpdateMode;
  /** The run switches the build (Community to full) instead of the version. */
  switchTo: BuildSwitchTarget | null;
  fromVersion: string | null;
  targetVersion: string;
  targetTag: string;
  releaseUrl: string | null;
  requestedBy: { userId: string | null; label: string };
  scheduledAt: string;
  leadSeconds: number;
  startsAt: string;
  startedAt: string | null;
  finishedAt: string | null;
  cancelledAt: string | null;
  outcome: RunOutcome | null;
  step: UpdateStepId | null;
  steps: StepState[];
  progress: number;
  message: UpdateMessage | null;
  failure: Failure | null;
  recovery: Recovery | null;
  images: { app: string | null; web: string | null };
  digestVerified: boolean | null;
  /** The images carry the release workflow's signature (null for a build from source). */
  signatureVerified: boolean | null;
  log: string[];
  cancelled: boolean;
}

/**
 * What a visitor may see of a maintenance (`GET /_maintenance/status`, no sign-in).
 * The edge's answer names no version (both are null there); the api's
 * `/maintenance` for signed-in users carries them.
 */
export const BUILD_SWITCH_TARGETS = ["full"] as const;
export type BuildSwitchTarget = (typeof BUILD_SWITCH_TARGETS)[number];

export interface PublicStatus {
  phase: UpdaterPhase;
  runId: string | null;
  outcome: RunOutcome | null;
  targetVersion: string | null;
  fromVersion: string | null;
  /** Only the api's `/maintenance` names it; the edge's answer has null. */
  switchTo: BuildSwitchTarget | null;
  startsAt: string | null;
  startedAt: string | null;
  finishedAt: string | null;
  step: UpdateStepId | null;
  steps: { id: UpdateStepId; status: StepStatus }[];
  progress: number;
  message: UpdateMessage | null;
  failureCode: FailureCode | null;
  serverTime: string;
}

/** `GET /api/v1/maintenance`: the public status plus the version the api answering runs. */
export type MaintenanceView = PublicStatus & {
  runningVersion: string | null;
};

// --- Updates view (apps/api/src/features/updates/schemas.ts) -----------------------------

export const UPDATE_CHANNELS = ["stable", "beta"] as const;
export type UpdateChannel = (typeof UPDATE_CHANNELS)[number];

/** Longest source URL and token the api accepts. */
export const MAX_SOURCE_URL_LENGTH = 300;
export const MAX_TOKEN_LENGTH = 500;

export const CHECK_ERROR_CODES = [
  "rate_limited",
  "unauthorized",
  "not_found",
  "forbidden",
  "server_error",
  "network",
  "timeout",
  "invalid_response",
  "no_release",
  "redirect",
] as const;
export type CheckErrorCode = (typeof CHECK_ERROR_CODES)[number];

export interface CheckError {
  code: CheckErrorCode;
  status: number | null;
  retryAt: string | null;
  detail: string | null;
}

export interface ReleaseView {
  version: string;
  tag: string;
  name: string | null;
  publishedAt: string | null;
  url: string | null;
  prerelease: boolean;
  /** Markdown source, cut at 20,000 characters. Render it sanitized (markdown.tsx). */
  notes: string | null;
  notesTruncated: boolean;
  digests: { app?: string; web?: string };
}

export type SourceProvider = "github" | "forgejo" | "feed";
export type SourceOrigin = "default" | "settings" | "environment";

export interface SourceView {
  origin: SourceOrigin;
  url: string;
  provider: SourceProvider;
  repository: string | null;
  isDefault: boolean;
  /** The project's alpha repository: unsigned test builds, installed as images. */
  isAlpha: boolean;
}

/** The project's alpha repository (docs/UPDATING.md, "Alpha builds"). */
export const ALPHA_SOURCE_URL = "https://github.com/restow-backup/restow-alpha";

export type UpdaterAvailability = "unavailable" | "ready" | "blocked" | "busy" | "demo";

export const SELF_UPDATE_REASONS = [
  "disabled",
  "source_mode",
  "signature_unverified",
  "compose_unsupported",
  "env_write_failed",
  "launch_failed",
  "helper_failed",
  "not_replaced",
] as const;
export type SelfUpdateReason = (typeof SELF_UPDATE_REASONS)[number];

/** The updater's last update of itself (updater protocol, `selfUpdateRecordSchema`). */
export interface SelfUpdateRecord {
  status: "pending" | "succeeded" | "failed" | "skipped";
  reason: SelfUpdateReason | null;
  fromVersion: string | null;
  targetVersion: string;
  /** What was written to RESTOW_UPDATER_IMAGE (`name:tag@sha256:...`). */
  image: string | null;
  startedAt: string;
  finishedAt: string | null;
  detail: string;
}

export interface SelfUpdateView {
  /** RESTOW_UPDATER_SELF_UPDATE is not false. */
  enabled: boolean;
  /** The updater verifies release signatures (a self-update needs that). */
  verifiesSignatures: boolean;
  last: SelfUpdateRecord | null;
}

export interface UpdaterView {
  state: UpdaterAvailability;
  blockers: Blocker[];
  /**
   * The updater answers but speaks a protocol this version does not understand
   * (it was not recreated after an update); `state` is then `unavailable`.
   */
  incompatible: boolean;
  version: string | null;
  /** null: no updater answers, or one that predates its self-update (0.2.0). */
  selfUpdate: SelfUpdateView | null;
  /** The application image of the running version, by tag: the image the updater runs too. */
  applicationImage: string | null;
  runner: "cli" | "helper" | null;
  /** false: the updater does not verify release signatures (switched off by the operator). null: no updater answers. */
  signatureChecks: boolean | null;
  dumps: DumpInfo[];
  checkedAt: string | null;
}

/** The build this installation runs (Installation, Edition). */
export interface EditionView {
  build: "full" | "community";
  /** A license key entered on the Community build waits for the full build. */
  pendingLicenseKey: boolean;
  /** The full build's images at the running version (Community only): the `.env` lines of a switch by hand. */
  fullImages: { app: string; web: string } | null;
}

export type CheckState = "disabled" | "pending" | "ok" | "failed";

export interface UpdatesView {
  running: string | null;
  demo: boolean;
  settings: {
    enabled: boolean;
    channel: UpdateChannel;
    sourceUrl: string | null;
    /** A token is stored; its value never reaches the browser. */
    tokenSet: boolean;
  };
  environmentOverride: { url: string } | null;
  source: SourceView;
  mode: UpdateMode;
  /**
   * Whether the updater would install from this source: always for image updates;
   * for building from source only when the operator named the repository in
   * RESTOW_UPDATER_SOURCE_HOSTS. null when no updater answers.
   */
  sourceAllowed: boolean | null;
  check: {
    enabled: boolean;
    state: CheckState;
    checkedAt: string | null;
    nextCheckAt: string | null;
    error: CheckError | null;
  };
  latest: ReleaseView | null;
  updateAvailable: boolean | null;
  releases: ReleaseView[];
  updater: UpdaterView;
  leadTimes: readonly number[];
  maintenance: MaintenanceView;
  run: RunView | null;
  /** The build and what a switch to the full build needs (older servers: absent). */
  edition?: EditionView;
}

export interface UpdateSettingsInput {
  enabled?: boolean;
  channel?: UpdateChannel;
  /** `null` goes back to the default source. */
  sourceUrl?: string | null;
  /** A string sets or replaces the token, `null` removes it. */
  token?: string | null;
}

export interface ScheduleUpdateInput {
  version: string;
  leadSeconds: number;
}

/** Problem types of the updates endpoints (RFC 7807 `type`). */
export const UPDATER_UNAVAILABLE_PROBLEM = "urn:restow:problem:updater-unavailable";
export const UPDATER_BLOCKED_PROBLEM = "urn:restow:problem:updater-blocked";
export const UPDATE_BUSY_PROBLEM = "urn:restow:problem:update-busy";
export const UPDATE_VERSION_UNKNOWN_PROBLEM = "urn:restow:problem:update-version-unknown";
export const UPDATE_RUNNING_UNKNOWN_PROBLEM = "urn:restow:problem:update-running-unknown";
export const UPDATE_SOURCE_NOT_ALLOWED_PROBLEM = "urn:restow:problem:update-source-not-allowed";
export const UPDATE_NOT_VERIFIABLE_PROBLEM = "urn:restow:problem:update-not-verifiable";
export const INVALID_UPDATE_SOURCE_PROBLEM = "urn:restow:problem:invalid-update-source";
export const BUILD_SWITCH_REFUSED_PROBLEM = "urn:restow:problem:build-switch-refused";
export { RECENT_SIGN_IN_PROBLEM } from "@/lib/recent-sign-in";

// --- Endpoints -----------------------------------------------------------------------------

export function fetchUpdates(): Promise<UpdatesView> {
  return apiFetch<UpdatesView>("/updates", { tenantId: null });
}

export function patchUpdateSettings(input: UpdateSettingsInput): Promise<UpdatesView> {
  return apiFetch<UpdatesView>("/updates/settings", {
    method: "PATCH",
    body: input,
    tenantId: null,
  });
}

export function checkForUpdates(): Promise<UpdatesView> {
  return apiFetch<UpdatesView>("/updates/check", { method: "POST", tenantId: null });
}

export function scheduleUpdate(input: ScheduleUpdateInput): Promise<UpdatesView> {
  return apiFetch<UpdatesView>("/updates/maintenance", {
    method: "POST",
    body: input,
    tenantId: null,
  });
}

/** Community only: switch to the full build of the running version (through the updater). */
export function switchToFullBuild(input: { leadSeconds: number }): Promise<UpdatesView> {
  return apiFetch<UpdatesView>("/updates/edition/switch", {
    method: "POST",
    body: input,
    tenantId: null,
  });
}

/** Community only: keep a license key for the full build (not checked before the switch). */
export function storePendingLicenseKey(key: string): Promise<UpdatesView> {
  return apiFetch<UpdatesView>("/updates/edition/license-key", {
    method: "PUT",
    body: { key },
    tenantId: null,
  });
}

export function removePendingLicenseKey(): Promise<UpdatesView> {
  return apiFetch<UpdatesView>("/updates/edition/license-key", {
    method: "DELETE",
    tenantId: null,
  });
}

export function cancelMaintenance(): Promise<UpdatesView> {
  return apiFetch<UpdatesView>("/updates/maintenance", { method: "DELETE", tenantId: null });
}

export function dismissRun(): Promise<UpdatesView> {
  return apiFetch<UpdatesView>("/updates/maintenance/dismiss", {
    method: "POST",
    tenantId: null,
  });
}

/** The maintenance state for every signed-in user; cheap enough to poll. */
export async function fetchMaintenance(): Promise<MaintenanceView> {
  const raw = await apiFetch<unknown>("/maintenance", { tenantId: null });
  const view = parseMaintenance(raw);
  if (!view) {
    throw new Error("The maintenance state has an unexpected shape");
  }
  return view;
}

/** Where the edge serves the updater's public status, without the api. */
export const EDGE_STATUS_PATH = "/_maintenance/status";

/**
 * The public status straight from the edge. It answers while the api is down
 * and fails when the edge itself restarts (or in development, where no edge
 * exists and the dev server answers with the app shell): every failure is
 * quiet and simply means "nothing learned".
 */
export async function fetchEdgeStatus(signal?: AbortSignal): Promise<PublicStatus | null> {
  try {
    const response = await fetch(EDGE_STATUS_PATH, {
      cache: "no-store",
      credentials: "omit",
      headers: { accept: "application/json" },
      signal,
    });
    if (!response.ok || !(response.headers.get("content-type") ?? "").includes("json")) {
      return null;
    }
    return parsePublicStatus(await response.json());
  } catch {
    return null;
  }
}

// --- Tolerant decoders -----------------------------------------------------------------------

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function oneOf<T extends string>(values: readonly T[], value: unknown): T | null {
  return typeof value === "string" && (values as readonly string[]).includes(value)
    ? (value as T)
    : null;
}

function stringOrNull(value: unknown): string | null {
  return typeof value === "string" && value.length > 0 ? value : null;
}

function parseMessage(value: unknown): UpdateMessage | null {
  if (!isRecord(value) || typeof value.code !== "string" || value.code.length === 0) {
    return null;
  }
  const params: Record<string, string | number> = {};
  if (isRecord(value.params)) {
    for (const [key, entry] of Object.entries(value.params)) {
      if (typeof entry === "string" || typeof entry === "number") {
        params[key] = entry;
      }
    }
  }
  return { code: value.code, params };
}

/**
 * Read a public status defensively. An answer that is not one (the dev server
 * answering with the app shell, a proxy error page) is `null`, never an error.
 */
export function parsePublicStatus(payload: unknown): PublicStatus | null {
  if (!isRecord(payload)) {
    return null;
  }
  const phase = oneOf(UPDATER_PHASES, payload.phase);
  if (!phase) {
    return null;
  }
  const steps: PublicStatus["steps"] = [];
  if (Array.isArray(payload.steps)) {
    for (const entry of payload.steps) {
      if (!isRecord(entry)) {
        continue;
      }
      const id = oneOf(UPDATE_STEPS, entry.id);
      const status = oneOf(STEP_STATUSES, entry.status);
      if (id && status) {
        steps.push({ id, status });
      }
    }
  }
  const progress =
    typeof payload.progress === "number" && Number.isFinite(payload.progress)
      ? Math.max(0, Math.min(100, payload.progress))
      : 0;
  return {
    phase,
    runId: stringOrNull(payload.runId),
    outcome: oneOf(RUN_OUTCOMES, payload.outcome),
    targetVersion: stringOrNull(payload.targetVersion),
    fromVersion: stringOrNull(payload.fromVersion),
    switchTo: oneOf(BUILD_SWITCH_TARGETS, payload.switchTo),
    startsAt: stringOrNull(payload.startsAt),
    startedAt: stringOrNull(payload.startedAt),
    finishedAt: stringOrNull(payload.finishedAt),
    step: oneOf(UPDATE_STEPS, payload.step),
    steps,
    progress,
    message: parseMessage(payload.message),
    failureCode: oneOf(FAILURE_CODES, payload.failureCode),
    serverTime: stringOrNull(payload.serverTime) ?? new Date().toISOString(),
  };
}

/** `GET /maintenance`; `null` when the answer is not a maintenance view. */
export function parseMaintenance(payload: unknown): MaintenanceView | null {
  const status = parsePublicStatus(payload);
  if (!status || !isRecord(payload)) {
    return null;
  }
  return { ...status, runningVersion: stringOrNull(payload.runningVersion) };
}

/** The view every viewer sees while nothing is announced. */
export function idleMaintenance(now: Date = new Date()): MaintenanceView {
  return {
    phase: "idle",
    runId: null,
    outcome: null,
    targetVersion: null,
    fromVersion: null,
    switchTo: null,
    startsAt: null,
    startedAt: null,
    finishedAt: null,
    step: null,
    steps: [],
    progress: 0,
    message: null,
    failureCode: null,
    serverTime: now.toISOString(),
    runningVersion: null,
  };
}
