import { z } from "zod";

/**
 * The contract between the updater process (ROLE=updater, this directory), the
 * api (features/updates) and the edge (Caddy proxies the read-only public
 * status). docs/ARCHITECTURE.md, Updates, explains the design.
 *
 * Nothing here imports the database, the configuration or the secret store:
 * the updater holds the Docker socket, so it is kept free of every credential
 * the application processes hold (updater/boundary.test.ts enforces that).
 *
 * The state is a document in the updater's volume (`status.json`). The api,
 * the web UI and the static maintenance page all read views of it; a view
 * never carries a secret, a token, a path outside the project or a log line
 * that was not redacted.
 */

/** The steps of an update, in the order they run. The UI shows them as a list. */
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

/**
 * Share of the whole update each step accounts for, in percent (sums to 100).
 * `fetch` (pull or build) and `start` (migrations and the new api) take the
 * longest.
 */
export const STEP_WEIGHTS: Readonly<Record<UpdateStepId, number>> = {
  prepare: 5,
  fetch: 35,
  backup: 10,
  stop: 5,
  start: 25,
  health: 15,
  finish: 5,
};

/**
 * idle       nothing announced (the last run stays readable in `history`)
 * scheduled  announced, counting down to `startsAt`; can be cancelled
 * running    the update is running; cannot be cancelled any more
 * succeeded  finished, the new version answers
 * failed     finished without success; `outcome` says what state the installation is in
 */
export const UPDATER_PHASES = ["idle", "scheduled", "running", "succeeded", "failed"] as const;
export type UpdaterPhase = (typeof UPDATER_PHASES)[number];

/**
 * How a finished run left the installation:
 *
 *   succeeded        the new version runs
 *   unchanged        it failed before anything was stopped or replaced; the old version never stopped
 *   rolled_back      it failed before database migrations ran; the previous images run again
 *   needs_attention  the new api failed after migrations ran: the updater stopped the application
 *                    and kept the database dump; the operator restores it (`recovery` says how)
 */
export const RUN_OUTCOMES = ["succeeded", "unchanged", "rolled_back", "needs_attention"] as const;
export type RunOutcome = (typeof RUN_OUTCOMES)[number];

/** `image`: pull the published release image. `source`: fetch the repository at the tag and build. */
export const UPDATE_MODES = ["image", "source"] as const;
export type UpdateMode = (typeof UPDATE_MODES)[number];

/** Lead times an administrator can announce a maintenance with, in seconds. */
export const LEAD_TIME_PRESETS = [0, 60, 300, 900, 1800, 3600] as const;

/**
 * Machine-readable reasons a run fails, `<step>.<reason>`. The UI and the
 * maintenance page translate them (packages/i18n, namespace `updates`); the
 * updater never sends prose.
 */
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

/** Why the updater cannot start an update right now (`capabilities.blockers`). */
export const BLOCKER_CODES = [
  "docker_unreachable",
  "compose_missing",
  "project_dir_mismatch",
  "env_unwritable",
  "disk_space",
  "docker_cli_missing",
  /** The `updater` service takes its image from RESTOW_IMAGE / RESTOW_WEB_IMAGE instead of RESTOW_UPDATER_IMAGE. */
  "updater_image_unpinned",
] as const;
export type BlockerCode = (typeof BLOCKER_CODES)[number];

const iso = z.string().datetime({ offset: true });

/** Text for the client: a code and parameters, translated there (never prose). */
export const messageSchema = z.object({
  code: z.string(),
  params: z.record(z.union([z.string(), z.number()])).default({}),
});
export type UpdateMessage = z.infer<typeof messageSchema>;

export const stepStateSchema = z.object({
  id: z.enum(UPDATE_STEPS),
  status: z.enum(STEP_STATUSES),
  startedAt: iso.nullable().default(null),
  finishedAt: iso.nullable().default(null),
  /** Short, non-sensitive facts of the step (`{ image: "...", digest: "sha256:..." }`). */
  detail: z.record(z.union([z.string(), z.number(), z.boolean(), z.null()])).default({}),
});
export type StepState = z.infer<typeof stepStateSchema>;

export const actorSchema = z.object({
  userId: z.string().nullable(),
  /** E-mail address or `system`. */
  label: z.string(),
  ip: z.string().nullable(),
});
export type UpdateActor = z.infer<typeof actorSchema>;

const digestSchema = z.string().regex(/^sha256:[0-9a-f]{64}$/);

/** What the api tells the updater about the release to install. Nothing secret. */
export const releaseRefSchema = z.object({
  version: z.string().min(1).max(64),
  tag: z.string().min(1).max(128),
  url: z.string().url().nullable(),
  prerelease: z.boolean().default(false),
  /** Digests the release published for its images, when it did. */
  digests: z.object({ app: digestSchema.optional(), web: digestSchema.optional() }).default({}),
});
export type ReleaseRef = z.infer<typeof releaseRefSchema>;

/** Where `source` mode fetches the tagged repository archive from. */
export const sourceRefSchema = z.object({
  /** `https://` archive URL of the tag (a tarball). */
  archiveUrl: z.string().url(),
  /** `owner/repo`, for display and the audit log. */
  repository: z.string().max(200),
  /** Ask the api for the stored access token before fetching (sent as an HTTP header, never in a URL). */
  useToken: z.boolean().default(false),
});
export type SourceRef = z.infer<typeof sourceRefSchema>;

/**
 * The one build switch an update can make: a Community installation moves to the
 * full build of the same version (`ghcr.io/restow-backup/restow` and `restow-web`).
 * Never the other way: the full build's data (licensed features, several tenants)
 * may need modules the Community build does not have.
 */
export const BUILD_SWITCH_TARGETS = ["full"] as const;
export type BuildSwitchTarget = (typeof BUILD_SWITCH_TARGETS)[number];

export const scheduleRequestSchema = z.object({
  release: releaseRefSchema,
  mode: z.enum(UPDATE_MODES),
  /**
   * Switch the build instead of the version: `release` is the running version, its
   * digests are those of the full images, `mode` is `image`. null: a normal update.
   */
  switchTo: z.enum(BUILD_SWITCH_TARGETS).nullable().default(null),
  source: sourceRefSchema.nullable().default(null),
  /** Seconds until the update starts; one of {@link LEAD_TIME_PRESETS}. */
  leadSeconds: z
    .number()
    .int()
    .refine(
      (value) => (LEAD_TIME_PRESETS as readonly number[]).includes(value),
      "unknown lead time",
    ),
  requestedBy: actorSchema,
});
export type ScheduleRequest = z.infer<typeof scheduleRequestSchema>;

/** How the operator gets out of `needs_attention` (exact commands are built by the UI from these facts). */
export const recoverySchema = z.object({
  /** File name of the pre-update dump inside the updater volume (`/state/dumps/<file>`). */
  dumpFile: z.string(),
  dumpBytes: z.number().int().nullable(),
  /** Version the dump was taken at. */
  fromVersion: z.string().nullable(),
  /** Image references that ran before the update (put them back into `.env`). */
  previousImages: z.object({ app: z.string().nullable(), web: z.string().nullable() }),
});
export type Recovery = z.infer<typeof recoverySchema>;

export const failureSchema = z.object({
  code: z.enum(FAILURE_CODES),
  step: z.enum(UPDATE_STEPS),
  /** Redacted, single-line excerpt of what failed (command output tail). May be empty. */
  detail: z.string().max(2000).default(""),
  migrationsRan: z.boolean().nullable().default(null),
});
export type Failure = z.infer<typeof failureSchema>;

export const runSchema = z.object({
  /** `r-<epoch ms>`; identifies the run in the UI, the journal and the audit log. */
  id: z.string(),
  mode: z.enum(UPDATE_MODES),
  /** The run switches a Community installation to the full build of the same version. */
  switchTo: z.enum(BUILD_SWITCH_TARGETS).nullable().default(null),
  fromVersion: z.string().nullable(),
  targetVersion: z.string(),
  targetTag: z.string(),
  releaseUrl: z.string().nullable(),
  requestedBy: actorSchema,
  scheduledAt: iso,
  leadSeconds: z.number().int(),
  startsAt: iso,
  startedAt: iso.nullable().default(null),
  finishedAt: iso.nullable().default(null),
  cancelledAt: iso.nullable().default(null),
  outcome: z.enum(RUN_OUTCOMES).nullable().default(null),
  step: z.enum(UPDATE_STEPS).nullable().default(null),
  steps: z.array(stepStateSchema),
  progress: z.number().min(0).max(100).default(0),
  message: messageSchema.nullable().default(null),
  failure: failureSchema.nullable().default(null),
  recovery: recoverySchema.nullable().default(null),
  /** Image references the run installs (image mode: registry references; source mode: local tags). */
  images: z.object({ app: z.string().nullable(), web: z.string().nullable() }),
  /** Whether the pulled image matched a digest the release published; null when none was checked. */
  digestVerified: z.boolean().nullable().default(null),
  /**
   * Whether the images carry the release workflow's signature (signature.ts): true when
   * verified, false when the check failed or the operator switched it off, null for
   * `source` mode and before the check.
   */
  signatureVerified: z.boolean().nullable().default(null),
  /** Redacted tail of the run's log (operator-facing, English). */
  log: z.array(z.string()).default([]),
  /** The run was cancelled before it started. */
  cancelled: z.boolean().default(false),
});
export type Run = z.infer<typeof runSchema>;

/** What history keeps of a finished run (without the log tail). */
export const runSummarySchema = runSchema.omit({ log: true });
export type RunSummary = z.infer<typeof runSummarySchema>;

/** Actions that reach the audit log. Scheduling and cancelling are audited by the api itself. */
export const JOURNAL_ACTIONS = ["update.started", "update.succeeded", "update.failed"] as const;

/**
 * An event the updater cannot audit itself (it has no database access). The
 * api writes it to the audit log after the fact and remembers the last `id` it
 * wrote, so nothing is lost while the api restarts. `id` sorts chronologically.
 */
export const journalEventSchema = z.object({
  id: z.string(),
  at: iso,
  action: z.enum(JOURNAL_ACTIONS),
  runId: z.string(),
  actor: actorSchema,
  /** The target version. */
  target: z.string(),
  details: z.record(z.unknown()).default({}),
});
export type JournalEvent = z.infer<typeof journalEventSchema>;

export const blockerSchema = z.object({
  code: z.enum(BLOCKER_CODES),
  /** Non-sensitive specifics, e.g. the free space or the path that must match. */
  detail: z.string().max(500).nullable().default(null),
});
export type Blocker = z.infer<typeof blockerSchema>;

export const dumpInfoSchema = z.object({
  file: z.string(),
  bytes: z.number().int(),
  createdAt: iso,
});
export type DumpInfo = z.infer<typeof dumpInfoSchema>;

export const capabilitiesSchema = z.object({
  /** An update can be scheduled now (no blockers). */
  ready: z.boolean(),
  blockers: z.array(blockerSchema),
  /** How the updater reaches Docker: the `docker` binary in its own image, or helper containers. */
  runner: z.enum(["cli", "helper"]),
  composeFile: z.string().nullable(),
  imageRepository: z.string(),
  webImageRepository: z.string(),
  dumps: z.array(dumpInfoSchema),
  /**
   * What `source` mode may build from, as the operator wrote it in
   * RESTOW_UPDATER_SOURCE_HOSTS (host or host/owner/repo, source-policy.ts). Empty:
   * `source` mode is off. (Defaults to empty for an updater that predates the field.)
   */
  sourceAllowlist: z.array(z.string().max(300)).max(100).default([]),
  /**
   * Whether the updater checks the release signature of the images it installs. false when the
   * operator switched it off (RESTOW_UPDATER_VERIFY_SIGNATURES=false): the tab then warns that
   * an installed image is identified by its published digest only. (true for an older updater.)
   */
  signatureChecks: z.boolean().default(true),
  /** When the preflight ran. */
  checkedAt: iso,
});
export type Capabilities = z.infer<typeof capabilitiesSchema>;

/**
 * The updater's own update (self-update.ts, docs/UPDATING.md "The updater updates
 * itself"). After an image-mode update succeeded with verified signatures, the updater
 * pins RESTOW_UPDATER_IMAGE to the application image it just verified, by digest, and
 * recreates its own container through a helper container.
 *
 *   pending    RESTOW_UPDATER_IMAGE was written and the helper was started; the new
 *              updater confirms it when it starts with the target version
 *   succeeded  the updater now runs the target version
 *   failed     it did not happen (`reason`); the application update stays successful
 *   skipped    it was not attempted (`reason`): switched off, `source` mode, or the
 *              signatures were not verified; the operator moves the updater by hand
 */
export const SELF_UPDATE_STATUSES = ["pending", "succeeded", "failed", "skipped"] as const;
export type SelfUpdateStatus = (typeof SELF_UPDATE_STATUSES)[number];

export const SELF_UPDATE_REASONS = [
  /** RESTOW_UPDATER_SELF_UPDATE=false. */
  "disabled",
  /** The run built from source: nothing is signed, so the updater never runs it. */
  "source_mode",
  /** Signature verification is switched off (RESTOW_UPDATER_VERIFY_SIGNATURES=false) or did not pass. */
  "signature_unverified",
  /** The compose file does not take the updater's image from RESTOW_UPDATER_IMAGE. */
  "compose_unsupported",
  /** RESTOW_UPDATER_IMAGE could not be written to `.env`. */
  "env_write_failed",
  /** The helper container that recreates the updater could not be started. */
  "launch_failed",
  /** `docker compose up` in the helper container failed. */
  "helper_failed",
  /** The helper finished, but the updater still runs the old version. */
  "not_replaced",
] as const;
export type SelfUpdateReason = (typeof SELF_UPDATE_REASONS)[number];

export const selfUpdateRecordSchema = z.object({
  status: z.enum(SELF_UPDATE_STATUSES),
  reason: z.enum(SELF_UPDATE_REASONS).nullable().default(null),
  /** The updater's version before (null for an unversioned local build). */
  fromVersion: z.string().nullable(),
  targetVersion: z.string(),
  /** The image written to RESTOW_UPDATER_IMAGE (`name:tag@sha256:...`); null when nothing was written. */
  image: z.string().nullable().default(null),
  startedAt: iso,
  finishedAt: iso.nullable().default(null),
  /** Redacted, single-line detail of a failure. */
  detail: z.string().max(1000).default(""),
});
export type SelfUpdateRecord = z.infer<typeof selfUpdateRecordSchema>;

export const selfUpdateViewSchema = z.object({
  /** RESTOW_UPDATER_SELF_UPDATE is not false. */
  enabled: z.boolean(),
  /** Signatures are verified (a self-update needs them). */
  verifiesSignatures: z.boolean(),
  last: selfUpdateRecordSchema.nullable(),
});
export type SelfUpdateView = z.infer<typeof selfUpdateViewSchema>;

/** `GET /v1/state` (authenticated): everything the api needs. */
export const stateViewSchema = z.object({
  updaterVersion: z.string().nullable(),
  phase: z.enum(UPDATER_PHASES),
  run: runSchema.nullable(),
  history: z.array(runSummarySchema),
  events: z.array(journalEventSchema),
  capabilities: capabilitiesSchema,
  /** null: an updater that predates its self-update (0.2.0), which never updates itself. */
  selfUpdate: selfUpdateViewSchema.nullable().default(null),
  serverTime: iso,
});
export type StateView = z.infer<typeof stateViewSchema>;

/**
 * `GET /public/status` (unauthenticated, read by the browser through the edge at
 * `/_maintenance/status`, and by the static maintenance page). Only what a
 * visitor who is not signed in may see: no user, no images, no log, no paths,
 * and no versions (neither the running nor the target version: which release an
 * installation runs is for its signed-in users, see {@link maintenanceStatusOf}).
 * Message parameters that name a version are left out for the same reason.
 */
export const publicStatusSchema = z.object({
  phase: z.enum(UPDATER_PHASES),
  runId: z.string().nullable(),
  outcome: z.enum(RUN_OUTCOMES).nullable(),
  startsAt: iso.nullable(),
  startedAt: iso.nullable(),
  finishedAt: iso.nullable(),
  step: z.enum(UPDATE_STEPS).nullable(),
  steps: z.array(z.object({ id: z.enum(UPDATE_STEPS), status: z.enum(STEP_STATUSES) })),
  progress: z.number().min(0).max(100),
  message: messageSchema.nullable(),
  failureCode: z.enum(FAILURE_CODES).nullable(),
  serverTime: iso,
});
export type PublicStatus = z.infer<typeof publicStatusSchema>;

/** What a signed-in user sees of a maintenance: the public status plus the versions. */
export type MaintenanceStatus = PublicStatus & {
  targetVersion: string | null;
  fromVersion: string | null;
  /** The run switches the build instead of the version (null: a normal update, or none). */
  switchTo: BuildSwitchTarget | null;
};

/** Message parameters a visitor may not see. */
const PRIVATE_MESSAGE_PARAMS: ReadonlySet<string> = new Set(["version"]);

function publicMessage(message: UpdateMessage | null): UpdateMessage | null {
  if (!message) {
    return null;
  }
  const params: UpdateMessage["params"] = {};
  for (const [key, value] of Object.entries(message.params)) {
    if (!PRIVATE_MESSAGE_PARAMS.has(key)) {
      params[key] = value;
    }
  }
  return { code: message.code, params };
}

/** The status while nothing is announced (also what the edge answers when no updater runs). */
export function idlePublicStatus(now: Date): PublicStatus {
  return {
    phase: "idle",
    runId: null,
    outcome: null,
    startsAt: null,
    startedAt: null,
    finishedAt: null,
    step: null,
    steps: [],
    progress: 0,
    message: null,
    failureCode: null,
    serverTime: now.toISOString(),
  };
}

/** The public view of a run. */
export function publicStatusOf(run: Run | null, phase: UpdaterPhase, now: Date): PublicStatus {
  if (!run) {
    return { ...idlePublicStatus(now), phase };
  }
  return {
    phase,
    runId: run.id,
    outcome: run.outcome,
    startsAt: run.startsAt,
    startedAt: run.startedAt,
    finishedAt: run.finishedAt,
    step: run.step,
    steps: run.steps.map((step) => ({ id: step.id, status: step.status })),
    progress: run.progress,
    message: publicMessage(run.message),
    failureCode: run.failure?.code ?? null,
    serverTime: now.toISOString(),
  };
}

/** The view of a run for signed-in users (the api's `/maintenance`): with the versions. */
export function maintenanceStatusOf(
  run: Run | null,
  phase: UpdaterPhase,
  now: Date,
): MaintenanceStatus {
  return {
    ...publicStatusOf(run, phase, now),
    message: run?.message ?? null,
    targetVersion: run?.targetVersion ?? null,
    fromVersion: run?.fromVersion ?? null,
    switchTo: run?.switchTo ?? null,
  };
}

/** Percent done, from the steps' states (a running step counts as half done). */
export function progressOf(steps: readonly Pick<StepState, "id" | "status">[]): number {
  let done = 0;
  for (const step of steps) {
    const weight = STEP_WEIGHTS[step.id];
    if (step.status === "done" || step.status === "skipped") {
      done += weight;
    } else if (step.status === "running") {
      done += weight / 2;
    }
  }
  return Math.min(100, Math.round(done));
}

/** A fresh list of steps, all pending. */
export function pendingSteps(): StepState[] {
  return UPDATE_STEPS.map((id) => ({
    id,
    status: "pending" as const,
    startedAt: null,
    finishedAt: null,
    detail: {},
  }));
}

/** Header the api sends the shared secret in: `Authorization: Bearer <secret>`. */
export const UPDATER_AUTH_SCHEME = "Bearer";

/** Where the updater listens inside the compose network. */
export const UPDATER_DEFAULT_PORT = 8090;

/** File name of the shared secret inside the shared volume. */
export const UPDATER_SECRET_FILE = "secret";

// ---------------------------------------------------------------------------
// Additions made by the updater process (engine, server, api client)
// ---------------------------------------------------------------------------

/**
 * Every message code the updater writes into `run.message` (with the parameters
 * noted here). The UI translates them (packages/i18n, namespace `updates`); a
 * code that is not listed never reaches a client. Parameters are versions and
 * failure codes only: images, file names and paths appear in `run.log` and the
 * run's own fields, never in a message. The public status drops `version` too.
 *
 *   run.scheduled {version, startsAt}     announced, counting down
 *   run.starting {version}                the run began
 *   run.succeeded {version}               the new version answers
 *   run.unchanged {code}                  failed before anything was stopped; `code` is the failure code
 *   run.rolled_back {code}                failed before migrations ran; the previous images run again
 *   run.needs_attention {code}            failed after migrations ran (or the state is unknown)
 *   run.interrupted {}                    the updater itself restarted during the run
 *   step.prepare.checking {}
 *   step.prepare.verifying_compose {}
 *   step.fetch.pulling {version}
 *   step.fetch.pulling_web {version}
 *   step.fetch.web_not_published {version}  the release has no web image; the current one stays
 *   step.fetch.verifying_signatures {}     checking the release workflow's signature of the images
 *   step.fetch.verifying_digests {}
 *   step.fetch.requesting_token {}
 *   step.fetch.downloading {version}
 *   step.fetch.extracting {version}
 *   step.fetch.building {version}
 *   step.fetch.building_web {version}
 *   step.backup.baseline {}
 *   step.backup.dumping {}
 *   step.backup.verifying {}
 *   step.stop.stopping {}
 *   step.start.writing_env {}
 *   step.start.starting_api {version}
 *   step.health.waiting_for_api {version}
 *   step.health.starting_workers {}
 *   step.health.starting_edge {}
 *   step.health.verifying_services {}
 *   step.finish.cleaning {}
 *   rollback.checking_migrations {}
 *   rollback.restoring_env {}
 *   rollback.restarting {version}         `version` is "unknown" when the previous version was not known
 *   rollback.waiting_for_api {}
 *   rollback.done {}
 *   rollback.failed {}
 *   recovery.stopping_application {}
 *   recovery.dump_kept {}                  the file name is `run.recovery.dumpFile`
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

/**
 * Codes of an error response of the updater's HTTP API:
 *   unauthorized   missing or wrong bearer secret
 *   invalid_request  the body is not a valid request (422)
 *   not_newer      the target version is not newer than the running one (422)
 *   source_not_allowed  `source` mode for a repository the operator did not allow (409)
 *   busy           a run is scheduled or running (409)
 *   blocked        `capabilities.ready` is false (409, `blockers` lists why)
 *   running        cancel refused, the run already started (409)
 *   not_scheduled  cancel refused, nothing is scheduled (409)
 *   not_finished   acknowledge refused, the run is still scheduled or running (409)
 *   not_found      unknown route
 *   internal       unexpected error (details only in the updater's log)
 */
export const UPDATER_ERROR_CODES = [
  "unauthorized",
  "invalid_request",
  "not_newer",
  "source_not_allowed",
  "busy",
  "blocked",
  "running",
  "not_scheduled",
  "not_finished",
  "not_found",
  "internal",
] as const;
export type UpdaterErrorCode = (typeof UPDATER_ERROR_CODES)[number];

/** Error body of every non-2xx response of the updater. */
export const updaterErrorSchema = z.object({
  code: z.enum(UPDATER_ERROR_CODES),
  message: z.string(),
  /** Present with `blocked`. */
  blockers: z.array(blockerSchema).optional(),
});
export type UpdaterError = z.infer<typeof updaterErrorSchema>;

/**
 * What the updater reads from the api's `GET /readyz` when it sends the shared
 * secret: the readiness, the version the running build reports and the named
 * checks (the api may add fields; they are ignored).
 */
export const apiReadinessSchema = z
  .object({
    status: z.string(),
    version: z.string().nullable().optional(),
    checks: z.record(z.string(), z.unknown()).optional(),
  })
  .passthrough();
export type ApiReadiness = z.infer<typeof apiReadinessSchema>;

/** Where the updater asks the api for the access token of a private source repository (`source` mode). */
export const UPDATER_SOURCE_TOKEN_PATH = "/internal/updater/source-token";

/** Response of {@link UPDATER_SOURCE_TOKEN_PATH}: the token, or null when none is stored. */
export const sourceTokenResponseSchema = z.object({ token: z.string().min(1).nullable() });
export type SourceTokenResponse = z.infer<typeof sourceTokenResponseSchema>;
