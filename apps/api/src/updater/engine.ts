import { type DumpStore, KEEP_DUMPS, dumpFileName } from "./dumps.js";
import { type CapturedEnv, type EnvFile, EnvFileError, postgresSettings } from "./env-file.js";
import type { ImageVariant } from "./image-variant.js";
import type { Logger } from "./logger.js";
import { type ApiClient, type Clock, type DockerOps, OpsError, type TimerHandle } from "./ops.js";
import type { Preflight } from "./preflight.js";
import {
  type Blocker,
  type BlockerCode,
  type FailureCode,
  type JournalEvent,
  type Recovery,
  type Run,
  type RunOutcome,
  type RunSummary,
  type ScheduleRequest,
  type StepState,
  type UpdateMessage,
  type UpdateMessageCode,
  type UpdateStepId,
  type UpdaterPhase,
  pendingSteps,
  progressOf,
} from "./protocol.js";
import { type Redactor, clip, sensitiveEnvValues } from "./redact.js";
import { isNewerVersion, sameVersion, targetVersionOf } from "./semver.js";
import { RELEASE_SIGNATURE_ISSUER, releaseSignerIdentity } from "./signature.js";
import { SourceError, type SourceProvider, buildImages, sourceImageTags } from "./source.js";
import { type RunContext, type StatusStore, emptyRunContext } from "./store.js";

/**
 * The update state machine. It is driven only through interfaces (DockerOps,
 * ApiClient, SourceProvider, Clock, StatusStore), so every scenario can be scripted
 * with fakes.
 *
 * Rules the code below keeps everywhere:
 *
 *   - The state is written to the store before the side effect that follows it.
 *   - Every message is a code with parameters; the English log line for it comes
 *     from one table (LOG_TEXT) and passes through the redactor.
 *   - Failure handling never guesses: an installation is rolled back only when it
 *     is certain that the database was not migrated; when migrations ran, or that
 *     cannot be established, the application is stopped, the dump is kept and the
 *     operator decides.
 */

const APP_SERVICES = ["api", "worker", "scheduler", "caddy"] as const;
const WORKER_SERVICES = ["worker", "scheduler"] as const;

export const HEALTH_POLL_MS = 2000;
/** A scheduled run that is found this long after its start time is not started any more. */
export const LATE_START_LIMIT_MS = 10 * 60_000;
const STOP_TIMEOUT_SECONDS = 60;
const SERVICES_GRACE_SECONDS = 30;
const LOG_LINES = 200;
const LOG_LINE_CHARS = 400;
/** Consecutive `ready` answers with the wrong version before the run fails. */
const VERSION_MISMATCH_LIMIT = 3;
/** Observations of the api container crashing before the run fails. */
const CRASH_LIMIT = 2;

export type EngineErrorCode =
  | "busy"
  | "blocked"
  | "running"
  | "not_scheduled"
  | "not_finished"
  | "invalid_request"
  | "not_newer"
  | "source_not_allowed";

/** A request the engine refuses; the server turns it into a 409 or 422. */
export class EngineError extends Error {
  constructor(
    readonly code: EngineErrorCode,
    message: string,
    readonly blockers: Blocker[] = [],
  ) {
    super(message);
    this.name = "EngineError";
  }
}

/** A step failed. `code` is the machine-readable reason; `detail` is redacted before it is stored. */
export class StepFailure extends Error {
  constructor(
    readonly code: FailureCode,
    readonly step: UpdateStepId,
    readonly detail: string = "",
  ) {
    super(`${code}: ${detail}`);
    this.name = "StepFailure";
  }
}

/** The process is shutting down; the run is left as it is and recovered at the next start. */
class ShutdownSignal extends Error {}

type Params = Record<string, string | number>;

interface Msg {
  code: UpdateMessageCode;
  /** Parameters the client receives (also anonymous visitors, through the public status): no images, files or paths. */
  params?: Params;
  /** Facts for the operator's log line only (images, file names); never part of the message. */
  details?: Params;
}

/** The English operator log line for every message code. */
const LOG_TEXT: Record<UpdateMessageCode, (p: Params) => string> = {
  "run.scheduled": (p) => `Update to ${p.version} scheduled for ${p.startsAt}.`,
  "run.starting": (p) => `Starting the update to ${p.version}.`,
  "run.succeeded": (p) => `Update to ${p.version} finished; the new version answers.`,
  "run.unchanged": (p) =>
    `The update failed (${p.code}) before anything was replaced; nothing changed.`,
  "run.rolled_back": (p) =>
    `The update failed (${p.code}) before database migrations ran; the previous version runs again.`,
  "run.needs_attention": (p) =>
    `The update failed (${p.code}) and needs attention: the application was stopped, the dump was kept.`,
  "run.interrupted": () => "The updater restarted while the update was running.",
  "step.prepare.checking": () => "Checking Docker, the compose project and the running version.",
  "step.prepare.verifying_compose": () =>
    "Checking that the compose file uses the image variables.",
  "step.fetch.pulling": (p) => `Pulling ${p.image} (version ${p.version}).`,
  "step.fetch.pulling_web": (p) => `Pulling ${p.image} (version ${p.version}).`,
  "step.fetch.web_not_published": (p) =>
    `The release publishes no web image digest (${p.image}); the current web image stays.`,
  "step.fetch.verifying_signatures": (p) =>
    `Verifying the release signature of ${p.image} (signer ${p.signer}).`,
  "step.fetch.verifying_digests": () => "Verifying the image digests.",
  "step.fetch.requesting_token": () => "Requesting the repository access token from the api.",
  "step.fetch.downloading": (p) => `Downloading the source archive of ${p.version}.`,
  "step.fetch.extracting": (p) => `Unpacking the source archive of ${p.version}.`,
  "step.fetch.building": (p) => `Building ${p.image} (version ${p.version}).`,
  "step.fetch.building_web": (p) => `Building ${p.image} (version ${p.version}).`,
  "step.backup.baseline": () => "Reading the number of applied database migrations.",
  "step.backup.dumping": (p) => `Dumping the database to ${p.file}.`,
  "step.backup.verifying": (p) => `Verifying ${p.file}.`,
  "step.stop.stopping": () => "Stopping worker and scheduler.",
  "step.start.writing_env": () => "Writing the new image references to .env.",
  "step.start.starting_api": (p) =>
    `Starting the api with ${p.image}; it applies migrations on start.`,
  "step.health.waiting_for_api": (p) => `Waiting for the api to report version ${p.version}.`,
  "step.health.starting_workers": () => "Starting worker and scheduler.",
  "step.health.starting_edge": () => "Starting the web edge.",
  "step.health.verifying_services": () => "Verifying that api, worker, scheduler and edge run.",
  "step.finish.cleaning": () => "Removing old dumps and downloaded sources.",
  "rollback.checking_migrations": () => "Checking whether database migrations ran.",
  "rollback.restoring_env": () => "Restoring the previous image references in .env.",
  "rollback.restarting": (p) => `Starting the previous version (${p.version}).`,
  "rollback.waiting_for_api": () => "Waiting for the previous version to answer.",
  "rollback.done": () => "Rolled back; the previous version answers.",
  "rollback.failed": () => "The rollback did not succeed.",
  "recovery.stopping_application": () => "Stopping api, worker and scheduler; the edge stays up.",
  "recovery.dump_kept": (p) => `The database dump ${p.file} was kept for the operator.`,
};

const BLOCKER_TO_FAILURE: Record<BlockerCode, FailureCode> = {
  docker_unreachable: "prepare.docker_unreachable",
  docker_cli_missing: "prepare.docker_unreachable",
  updater_image_unpinned: "prepare.updater_image_unpinned",
  compose_missing: "prepare.compose_missing",
  project_dir_mismatch: "prepare.project_dir_mismatch",
  env_unwritable: "prepare.env_unwritable",
  disk_space: "prepare.disk_space",
};

/** The failure code for an unexpected error, per step. */
const FALLBACK_CODE: Record<UpdateStepId, FailureCode> = {
  prepare: "prepare.compose_unsupported",
  fetch: "fetch.pull_failed",
  backup: "backup.failed",
  stop: "stop.failed",
  start: "start.failed",
  health: "health.crashed",
  finish: "finish.failed",
};

export interface EngineConfig {
  projectDir: string;
  /** The build this installation runs (image-variant.ts); `source` mode builds its targets. Default full. */
  imageVariant?: ImageVariant;
  imageRepository: string;
  webImageRepository: string;
  healthTimeoutSeconds: number;
  /** Image mode installs only images the release workflow signed (signature.ts). Default true. */
  verifySignatures?: boolean;
  /** The cosign image, pinned by digest. */
  cosignImage?: string;
}

export interface EngineDeps {
  config: EngineConfig;
  store: StatusStore;
  ops: DockerOps;
  api: ApiClient;
  source: SourceProvider;
  clock: Clock;
  redactor: Redactor;
  logger: Logger;
  envFile: EnvFile;
  dumps: DumpStore;
  preflight: Preflight;
}

export interface EngineView {
  phase: UpdaterPhase;
  run: Run | null;
  history: RunSummary[];
  events: JournalEvent[];
}

/** Everything a running run keeps in memory (what must survive a restart lives in the store). */
interface Exec {
  target: string;
  images: { app: string; web: string };
  /** The release ships a web image (false: the current one stays). */
  webChanges: boolean;
  /** `docker compose up` for the api was attempted: the new api may have started and migrated. */
  apiUpAttempted: boolean;
}

export class UpdateEngine {
  private timer: TimerHandle | null = null;
  private execution: Promise<void> | null = null;
  private shuttingDown = false;
  /** Access tokens registered for redaction by the current run. */
  private readonly runTokens: string[] = [];

  constructor(private readonly deps: EngineDeps) {}

  // ---------------------------------------------------------------------------
  // Public API
  // ---------------------------------------------------------------------------

  /** Load-time recovery. Call once, before the server accepts requests. */
  async init(): Promise<void> {
    const { store, clock } = this.deps;
    await this.deps.source.purge().catch((error: Error) => {
      this.deps.logger.warn(`Could not remove leftover sources: ${error.message}`);
    });
    const state = store.state;
    if (state.phase === "scheduled" && state.run) {
      const late = clock.now().getTime() - Date.parse(state.run.startsAt);
      if (late <= 0) {
        this.armTimer(Date.parse(state.run.startsAt));
      } else if (late <= LATE_START_LIMIT_MS) {
        this.deps.logger.info(
          `Starting the scheduled update ${state.run.id} now (it was due earlier).`,
        );
        await this.begin();
      } else {
        this.deps.logger.warn(
          `The scheduled update ${state.run.id} is ${Math.round(late / 60_000)} minutes overdue; marking it interrupted.`,
        );
        await this.failInterrupted("unchanged");
      }
    } else if (state.phase === "running" && state.run) {
      this.deps.logger.warn(`The update ${state.run.id} was running when the updater stopped.`);
      await this.recoverRunning();
    }
  }

  /** A snapshot of the state for the api, the UI and the public status. */
  view(): EngineView {
    const { phase, run, history, events } = this.deps.store.snapshot();
    return { phase, run, history, events };
  }

  /** Resolves when the current run (if any) has ended. */
  settled(): Promise<void> {
    return this.execution ?? Promise.resolve();
  }

  /** The version the api reports, or the api container's RESTOW_VERSION; null when neither is known. */
  async detectRunningVersion(): Promise<string | null> {
    const readiness = await this.deps.api.readiness();
    if (readiness.version) {
      return readiness.version;
    }
    try {
      return await this.deps.ops.apiRunningVersion();
    } catch {
      return null;
    }
  }

  async schedule(request: ScheduleRequest): Promise<void> {
    const { store } = this.deps;
    const target = targetVersionOf(request.release.version);
    if (!target) {
      throw new EngineError("invalid_request", "The release version is not a plain version.");
    }
    if (request.mode === "image") {
      // Nothing unverifiable is announced: the run would refuse it anyway.
      if (!request.release.digests.app) {
        throw new EngineError(
          "invalid_request",
          "The release publishes no image digest; it cannot be verified and is not installed.",
        );
      }
      if (this.verifySignatures && !releaseSignerIdentity(request.release.tag, target)) {
        throw new EngineError(
          "invalid_request",
          `The release tag ${request.release.tag} is not a tag the release workflow signs for version ${target}.`,
        );
      }
    }
    if (request.mode === "source") {
      if (!request.source) {
        throw new EngineError("invalid_request", "Source mode needs a source.");
      }
      try {
        this.deps.source.validate(request.source.archiveUrl);
      } catch (error) {
        if (error instanceof SourceError && error.notAllowed) {
          throw new EngineError("source_not_allowed", error.message);
        }
        throw new EngineError(
          "invalid_request",
          error instanceof SourceError ? error.message : "The archive URL is not acceptable.",
        );
      }
    }
    this.assertFree();

    const capabilities = await this.deps.preflight.get(true);
    if (!capabilities.ready) {
      throw new EngineError(
        "blocked",
        "The updater cannot start an update now.",
        capabilities.blockers,
      );
    }
    const running = await this.detectRunningVersion();
    if (running !== null && isNewerVersion(running, target) === false) {
      throw new EngineError(
        "not_newer",
        `Version ${target} is not newer than the running version ${running}.`,
      );
    }

    // From here on nothing awaits until the state is changed: two requests cannot both pass.
    this.assertFree();
    const now = this.deps.clock.now();
    const startsAt = new Date(now.getTime() + request.leadSeconds * 1000);
    const run: Run = {
      id: `r-${now.getTime()}`,
      mode: request.mode,
      fromVersion: running,
      targetVersion: target,
      targetTag: request.release.tag,
      releaseUrl: request.release.url,
      requestedBy: request.requestedBy,
      scheduledAt: now.toISOString(),
      leadSeconds: request.leadSeconds,
      startsAt: startsAt.toISOString(),
      startedAt: null,
      finishedAt: null,
      cancelledAt: null,
      outcome: null,
      step: null,
      steps: pendingSteps(),
      progress: 0,
      message: null,
      failure: null,
      recovery: null,
      images: { app: null, web: null },
      digestVerified: null,
      signatureVerified: null,
      log: [],
      cancelled: false,
    };
    store.state.run = run;
    store.state.runContext = {
      ...emptyRunContext(),
      digests: request.release.digests,
      source: request.mode === "source" ? request.source : null,
    };
    store.state.phase = "scheduled";
    this.setMessage({
      code: "run.scheduled",
      params: { version: target, startsAt: run.startsAt },
    });
    await store.save();
    this.deps.preflight.invalidate();

    if (request.leadSeconds === 0) {
      await this.begin();
    } else {
      this.armTimer(startsAt.getTime());
    }
  }

  async cancel(): Promise<void> {
    const { store, clock } = this.deps;
    const state = store.state;
    if (state.phase === "running") {
      throw new EngineError("running", "The update has started and cannot be cancelled.");
    }
    if (state.phase !== "scheduled" || !state.run) {
      throw new EngineError("not_scheduled", "No update is scheduled.");
    }
    this.clearTimer();
    const run = state.run;
    run.cancelled = true;
    run.cancelledAt = clock.now().toISOString();
    run.outcome = null;
    run.finishedAt = run.cancelledAt;
    this.log(run, "The scheduled update was cancelled.");
    store.recordHistory(run);
    state.run = null;
    state.runContext = null;
    state.phase = "idle";
    await store.save();
    this.deps.preflight.invalidate();
  }

  async acknowledge(): Promise<void> {
    const { store } = this.deps;
    const state = store.state;
    if (state.phase === "scheduled" || state.phase === "running") {
      throw new EngineError("not_finished", "The update has not finished.");
    }
    if (state.phase === "idle") {
      return;
    }
    state.run = null;
    state.runContext = null;
    state.phase = "idle";
    await store.save();
    this.deps.preflight.invalidate();
  }

  /** Stop timers and refuse to begin further steps; the store is flushed. */
  async shutdown(): Promise<void> {
    this.shuttingDown = true;
    this.clearTimer();
    await this.deps.store.flush();
  }

  // ---------------------------------------------------------------------------
  // Scheduling
  // ---------------------------------------------------------------------------

  private assertFree(): void {
    const phase = this.deps.store.state.phase;
    if (phase === "scheduled" || phase === "running") {
      throw new EngineError("busy", "An update is already scheduled or running.");
    }
  }

  private armTimer(startsAtMs: number): void {
    this.clearTimer();
    const delay = Math.max(0, startsAtMs - this.deps.clock.now().getTime());
    this.timer = this.deps.clock.setTimer(() => {
      this.timer = null;
      this.begin().catch((error: Error) => {
        this.deps.logger.error(`The update could not be started: ${error.message}`);
      });
    }, delay);
  }

  private clearTimer(): void {
    this.timer?.cancel();
    this.timer = null;
  }

  /** scheduled -> running, then execute in the background. */
  private async begin(): Promise<void> {
    const { store, clock } = this.deps;
    const state = store.state;
    if (state.phase !== "scheduled" || !state.run || this.shuttingDown) {
      return;
    }
    this.clearTimer();
    const run = state.run;
    run.startedAt = clock.now().toISOString();
    state.phase = "running";
    this.setMessage({ code: "run.starting", params: { version: run.targetVersion } });
    this.journal("update.started", run, {
      mode: run.mode,
      fromVersion: run.fromVersion,
      targetVersion: run.targetVersion,
    });
    await store.save();
    this.deps.preflight.invalidate();

    const target = run.targetVersion;
    const exec: Exec = {
      target,
      images: { app: "", web: "" },
      webChanges: true,
      apiUpAttempted: false,
    };
    this.execution = this.execute(exec).finally(() => {
      this.execution = null;
    });
  }

  // ---------------------------------------------------------------------------
  // The run
  // ---------------------------------------------------------------------------

  private async execute(exec: Exec): Promise<void> {
    try {
      await this.executeSteps(exec);
    } finally {
      // Tokens the run held stop being redacted only after the last state was written.
      for (const token of this.runTokens.splice(0)) {
        this.deps.redactor.forget(token);
      }
    }
  }

  private async executeSteps(exec: Exec): Promise<void> {
    try {
      await this.stepPrepare(exec);
      await this.stepFetch(exec);
      await this.stepBackup(exec);
      await this.stepStop(exec);
      await this.stepStart(exec);
      await this.stepHealth(exec);
      await this.stepFinish(exec);
    } catch (error) {
      if (error instanceof ShutdownSignal) {
        return;
      }
      try {
        await this.handleFailure(this.asFailure(error), exec);
      } catch (inner) {
        this.deps.logger.error(
          `The failure of the update could not be recorded: ${(inner as Error).message}`,
        );
      }
    }
  }

  private asFailure(error: unknown): StepFailure {
    if (error instanceof StepFailure) {
      return error;
    }
    const run = this.run();
    const step = run.step ?? "prepare";
    return new StepFailure(FALLBACK_CODE[step], step, this.detail(error));
  }

  // -- Step 1: prepare --------------------------------------------------------

  private async stepPrepare(exec: Exec): Promise<void> {
    const { ops, envFile, redactor, config } = this.deps;
    await this.beginStep("prepare", { code: "step.prepare.checking" });

    // Deep: the Compose configuration is read again, so a run never starts with an updater
    // whose own image would follow what this run writes into .env.
    const capabilities = await this.deps.preflight.check({ deep: true });
    const blocker = capabilities.blockers[0];
    if (blocker) {
      throw new StepFailure(BLOCKER_TO_FAILURE[blocker.code], "prepare", blocker.detail ?? "");
    }

    let envText: string;
    try {
      envText = await envFile.read();
    } catch (error) {
      throw new StepFailure("prepare.env_unwritable", "prepare", this.detail(error));
    }
    for (const value of sensitiveEnvValues(envText)) {
      redactor.add(value);
    }
    try {
      // POSTGRES_USER / POSTGRES_DB must be plain names: they end up in command lines.
      postgresSettings(envText);
    } catch (error) {
      throw new StepFailure("prepare.compose_unsupported", "prepare", this.detail(error));
    }

    const run = this.run();
    const from = await this.detectRunningVersion();
    run.fromVersion = from ?? run.fromVersion;
    if (run.fromVersion !== null && isNewerVersion(run.fromVersion, exec.target) === false) {
      throw new StepFailure(
        "prepare.not_newer",
        "prepare",
        `Running ${run.fromVersion}, target ${exec.target}.`,
      );
    }

    exec.images =
      run.mode === "source"
        ? sourceImageTags(exec.target, config.imageVariant)
        : {
            app: `${config.imageRepository}:${exec.target}`,
            web: `${config.webImageRepository}:${exec.target}`,
          };

    await this.note({ code: "step.prepare.verifying_compose" });
    let previous: Awaited<ReturnType<DockerOps["configImages"]>>;
    let configured: Awaited<ReturnType<DockerOps["configImages"]>>;
    try {
      previous = await ops.configImages({});
      configured = await ops.configImages({
        RESTOW_IMAGE: exec.images.app,
        RESTOW_WEB_IMAGE: exec.images.web,
      });
    } catch (error) {
      throw new StepFailure("prepare.compose_unsupported", "prepare", this.detail(error));
    }
    const mismatches: string[] = [];
    if (configured.api !== exec.images.app) {
      mismatches.push("api");
    }
    if (configured.caddy !== exec.images.web) {
      mismatches.push("caddy");
    }
    for (const service of ["worker", "scheduler"] as const) {
      if (configured[service] !== null && configured[service] !== exec.images.app) {
        mismatches.push(service);
      }
    }
    if (mismatches.length > 0) {
      throw new StepFailure(
        "prepare.compose_unsupported",
        "prepare",
        `The compose file does not take the image from RESTOW_IMAGE / RESTOW_WEB_IMAGE for: ${mismatches.join(", ")}.`,
      );
    }

    const context = this.context();
    context.previousImages = { app: previous.api, web: previous.caddy };
    run.images = { app: exec.images.app, web: exec.images.web };
    await this.endStep("prepare");
  }

  // -- Step 2: fetch ----------------------------------------------------------

  private async stepFetch(exec: Exec): Promise<void> {
    await this.beginStep("fetch", null);
    const run = this.run();
    const detail =
      run.mode === "source" ? await this.fetchSource(exec) : await this.fetchImages(exec);
    await this.endStep("fetch", detail);
  }

  private get verifySignatures(): boolean {
    return this.deps.config.verifySignatures !== false;
  }

  /**
   * Image mode. Nothing is pulled that is not verified first, and nothing verified
   * is replaced on the way:
   *
   *   1. the release must publish the digest of the application image (a release
   *      without one is refused), and the web image changes only when the release
   *      publishes its digest as well;
   *   2. each image is verified in the registry, by that digest, against the
   *      release workflow's keyless signature for exactly this tag (signature.ts);
   *   3. the tag is pulled and the local image must carry that digest, so what the
   *      services start is the content whose signature was checked.
   */
  private async fetchImages(exec: Exec): Promise<StepState["detail"]> {
    const { ops, config } = this.deps;
    const run = this.run();
    const context = this.context();
    const detail: StepState["detail"] = { app: exec.images.app };

    const appDigest = context.digests.app;
    if (!appDigest) {
      throw new StepFailure(
        "fetch.digest_missing",
        "fetch",
        "The release publishes no digest for the application image, so it cannot be verified. Update by hand after checking the release.",
      );
    }
    const webDigest = context.digests.web;
    if (!webDigest) {
      // The edge keeps the image that runs now; an unverifiable one is never pulled.
      exec.webChanges = false;
      detail.web = "not_published";
      await this.note({
        code: "step.fetch.web_not_published",
        params: { version: exec.target },
        details: { image: exec.images.web },
      });
      exec.images.web = context.previousImages?.web ?? exec.images.web;
      run.images = { app: exec.images.app, web: context.previousImages?.web ?? null };
    }

    const checks: { kind: "app" | "web"; repository: string; image: string; digest: string }[] = [
      {
        kind: "app",
        repository: config.imageRepository,
        image: exec.images.app,
        digest: appDigest,
      },
    ];
    if (webDigest) {
      checks.push({
        kind: "web",
        repository: config.webImageRepository,
        image: exec.images.web,
        digest: webDigest,
      });
    }

    if (this.verifySignatures) {
      const signer = releaseSignerIdentity(run.targetTag, exec.target);
      if (!signer) {
        run.signatureVerified = false;
        throw new StepFailure(
          "fetch.signature_invalid",
          "fetch",
          `The release tag ${run.targetTag} is not a tag the release workflow signs for version ${exec.target}.`,
        );
      }
      for (const check of checks) {
        const byDigest = `${check.repository}@${check.digest}`;
        await this.note({
          code: "step.fetch.verifying_signatures",
          details: { image: byDigest, signer },
        });
        try {
          await ops.verifySignature({
            image: byDigest,
            certificateIdentity: signer,
            certificateOidcIssuer: RELEASE_SIGNATURE_ISSUER,
            verifierImage: config.cosignImage ?? "",
          });
        } catch (error) {
          run.signatureVerified = false;
          throw new StepFailure(
            "fetch.signature_invalid",
            "fetch",
            `The ${check.kind} image ${byDigest} has no valid signature of ${signer}: ${this.detail(error)}`,
          );
        }
      }
      run.signatureVerified = true;
    } else {
      run.signatureVerified = false;
      this.log(
        run,
        "Signature verification is switched off on this updater (RESTOW_UPDATER_VERIFY_SIGNATURES=false); only the digests are checked.",
      );
    }
    detail.signatureVerified = run.signatureVerified;

    for (const check of checks) {
      await this.note({
        code: check.kind === "app" ? "step.fetch.pulling" : "step.fetch.pulling_web",
        params: { version: exec.target },
        details: { image: check.image },
      });
      try {
        await ops.pull(check.image);
      } catch (error) {
        throw new StepFailure("fetch.pull_failed", "fetch", this.detail(error));
      }
      if (check.kind === "web") {
        detail.web = check.image;
      }
    }

    await this.note({ code: "step.fetch.verifying_digests" });
    for (const check of checks) {
      let actual: string[];
      try {
        actual = await ops.imageDigests(check.image);
      } catch (error) {
        throw new StepFailure("fetch.pull_failed", "fetch", this.detail(error));
      }
      if (!actual.includes(check.digest)) {
        run.digestVerified = false;
        throw new StepFailure(
          "fetch.digest_mismatch",
          "fetch",
          `The ${check.kind} image does not have the digest the release published (expected ${check.digest}, found ${actual.join(", ") || "none"}).`,
        );
      }
    }
    run.digestVerified = true;
    detail.digestVerified = true;
    return detail;
  }

  private async fetchSource(exec: Exec): Promise<StepState["detail"]> {
    const { ops, api, source, redactor } = this.deps;
    const context = this.context();
    const request = context.source;
    if (!request) {
      throw new StepFailure("fetch.download_failed", "fetch", "The run has no source.");
    }

    let token: string | null = null;
    let fetched: Awaited<ReturnType<SourceProvider["fetch"]>> | null = null;
    try {
      if (request.useToken) {
        await this.note({ code: "step.fetch.requesting_token" });
        try {
          token = await api.sourceToken();
        } catch (error) {
          throw new StepFailure("fetch.token_unavailable", "fetch", this.detail(error));
        }
        if (token === null) {
          throw new StepFailure(
            "fetch.token_unavailable",
            "fetch",
            "The api has no access token stored for the source repository.",
          );
        }
        redactor.add(token);
        this.runTokens.push(token);
      }
      try {
        fetched = await source.fetch({
          version: exec.target,
          archiveUrl: request.archiveUrl,
          token,
          onStage: async (stage) => {
            await this.note(
              stage === "downloading"
                ? { code: "step.fetch.downloading", params: { version: exec.target } }
                : { code: "step.fetch.extracting", params: { version: exec.target } },
            );
          },
        });
      } catch (error) {
        throw new StepFailure("fetch.download_failed", "fetch", this.detail(error));
      }
      // The token is not needed any more (the redactor keeps it until the run ends).
      token = null;

      try {
        await buildImages(
          ops,
          fetched.contextDir,
          exec.target,
          {
            onApp: () =>
              this.note({
                code: "step.fetch.building",
                params: { version: exec.target },
                details: { image: exec.images.app },
              }),
            onWeb: () =>
              this.note({
                code: "step.fetch.building_web",
                params: { version: exec.target },
                details: { image: exec.images.web },
              }),
          },
          this.deps.config.imageVariant,
        );
      } catch (error) {
        throw new StepFailure("fetch.build_failed", "fetch", this.detail(error));
      }
      return { app: exec.images.app, web: exec.images.web };
    } finally {
      if (fetched) {
        await fetched.cleanup().catch((error: Error) => {
          this.deps.logger.warn(`Could not remove the fetched sources: ${error.message}`);
        });
      }
    }
  }

  // -- Step 3: backup ---------------------------------------------------------

  private async stepBackup(exec: Exec): Promise<void> {
    const { ops, dumps, clock } = this.deps;
    await this.beginStep("backup", { code: "step.backup.baseline" });
    const run = this.run();
    const context = this.context();

    try {
      context.baselineMigrations = await ops.migrationCount();
    } catch (error) {
      throw new StepFailure(
        "backup.failed",
        "backup",
        `The migration marker could not be read: ${this.detail(error)}`,
      );
    }
    await this.deps.store.save();

    const file = dumpFileName(clock.now(), run.fromVersion, exec.target);
    await this.note({ code: "step.backup.dumping", details: { file } });
    let verification: Awaited<ReturnType<DockerOps["verifyDump"]>>;
    try {
      await dumps.ensureDirectory();
      await ops.dumpDatabase(dumps.pathOf(file));
      await this.note({ code: "step.backup.verifying", details: { file } });
      verification = await ops.verifyDump(dumps.pathOf(file));
    } catch (error) {
      // A dump that was not completed and verified is worthless: it must not look like a backup.
      await dumps.discard(file).catch(() => undefined);
      if (error instanceof ShutdownSignal) {
        throw error;
      }
      throw new StepFailure("backup.failed", "backup", this.detail(error));
    }
    context.dumpFile = file;
    await this.deps.store.save();
    await dumps.prune(KEEP_DUMPS, this.protectedDumps()).catch((error: Error) => {
      this.deps.logger.warn(`Could not prune old dumps: ${error.message}`);
    });
    await this.endStep("backup", {
      file,
      bytes: verification.bytes,
      entries: verification.entries,
    });
  }

  /**
   * The dump the newest finished run needs the operator to restore (outcome
   * `needs_attention`): pruning must not delete it while no later run has been made.
   * It does not count towards the three dumps that are kept.
   */
  private protectedDumps(): Set<string> {
    const newest = this.deps.store.state.history[0];
    return new Set(newest?.recovery ? [newest.recovery.dumpFile] : []);
  }

  // -- Step 4: stop -----------------------------------------------------------

  private async stepStop(_exec: Exec): Promise<void> {
    await this.beginStep("stop", { code: "step.stop.stopping" });
    try {
      await this.deps.ops.composeStop(WORKER_SERVICES, STOP_TIMEOUT_SECONDS);
    } catch (error) {
      throw new StepFailure("stop.failed", "stop", this.detail(error));
    }
    await this.endStep("stop");
  }

  // -- Step 5: start ----------------------------------------------------------

  private async stepStart(exec: Exec): Promise<void> {
    const { envFile, ops } = this.deps;
    await this.beginStep("start", { code: "step.start.writing_env" });
    const context = this.context();

    // Remember the exact previous lines before touching the file, and persist them.
    let captured: CapturedEnv;
    try {
      captured = await envFile.capture(["RESTOW_IMAGE", "RESTOW_WEB_IMAGE"]);
    } catch (error) {
      throw new StepFailure("start.failed", "start", this.detail(error));
    }
    context.previousEnv = captured;
    await this.deps.store.save();

    const assignments: Record<string, string> = { RESTOW_IMAGE: exec.images.app };
    if (exec.webChanges) {
      assignments.RESTOW_WEB_IMAGE = exec.images.web;
    }
    try {
      await envFile.apply(assignments);
    } catch (error) {
      throw new StepFailure("start.failed", "start", this.detail(error));
    }

    await this.note({
      code: "step.start.starting_api",
      params: { version: exec.target },
      details: { image: exec.images.app },
    });
    exec.apiUpAttempted = true;
    try {
      await ops.composeUp(["api"]);
    } catch (error) {
      throw new StepFailure("start.failed", "start", this.detail(error));
    }
    await this.endStep("start");
  }

  // -- Step 6: health ---------------------------------------------------------

  private async stepHealth(exec: Exec): Promise<void> {
    const { ops } = this.deps;
    await this.beginStep("health", {
      code: "step.health.waiting_for_api",
      params: { version: exec.target },
    });
    await this.waitForApi(exec.target, "health");

    await this.note({ code: "step.health.starting_workers" });
    try {
      await ops.composeUp(WORKER_SERVICES);
    } catch (error) {
      throw new StepFailure("start.failed", "health", this.detail(error));
    }
    // The edge is recreated last: the old one serves the maintenance page while the api is down.
    await this.note({ code: "step.health.starting_edge" });
    try {
      await ops.composeUp(["caddy"]);
    } catch (error) {
      throw new StepFailure("start.failed", "health", this.detail(error));
    }

    await this.note({ code: "step.health.verifying_services" });
    await this.waitForApi(exec.target, "health");
    await this.waitForServices("health");
    await this.endStep("health");
  }

  /**
   * Poll the api until it reports ready with the expected version (any version when
   * `expected` is null). Fails fast when its container crashes or it is ready with a
   * different version, and at the timeout.
   */
  private async waitForApi(expected: string | null, step: UpdateStepId): Promise<void> {
    const { api, ops, clock, config } = this.deps;
    const deadline = clock.now().getTime() + config.healthTimeoutSeconds * 1000;
    let crashes = 0;
    let mismatches = 0;
    let lastReason: string | null = null;

    for (;;) {
      this.assertNotShuttingDown();
      const readiness = await api.readiness();
      if (readiness.ready) {
        if (expected === null || (readiness.version && sameVersion(readiness.version, expected))) {
          return;
        }
        mismatches += 1;
        lastReason = `The api is ready but reports version ${readiness.version ?? "none"}, expected ${expected}.`;
        if (mismatches >= VERSION_MISMATCH_LIMIT) {
          throw new StepFailure("health.version_mismatch", step, await this.withApiLog(lastReason));
        }
      } else {
        mismatches = 0;
        lastReason = readiness.reason;
      }

      try {
        const states = await ops.servicesState();
        const apiState = states.find((entry) => entry.service === "api");
        if (apiState && ["restarting", "exited", "dead"].includes(apiState.state)) {
          crashes += 1;
          if (crashes >= CRASH_LIMIT) {
            throw new StepFailure(
              "health.crashed",
              step,
              await this.withApiLog(
                `The api container is ${apiState.state}${apiState.exitCode !== null ? ` (exit code ${apiState.exitCode})` : ""}.`,
              ),
            );
          }
        }
      } catch (error) {
        if (error instanceof StepFailure) {
          throw error;
        }
        // Service states are advisory here; the readiness poll decides.
      }

      if (clock.now().getTime() >= deadline) {
        throw new StepFailure(
          "health.timeout",
          step,
          await this.withApiLog(
            `The api did not report ready within ${config.healthTimeoutSeconds} seconds${lastReason ? ` (${lastReason})` : ""}.`,
          ),
        );
      }
      await clock.sleep(HEALTH_POLL_MS);
    }
  }

  private async withApiLog(reason: string): Promise<string> {
    let log = "";
    try {
      log = await this.deps.ops.apiLogsTail(40);
    } catch {
      log = "";
    }
    return log ? `${reason} Last api log: ${log}` : reason;
  }

  /** api, worker, scheduler and caddy all run (given a short grace period). */
  private async waitForServices(step: UpdateStepId): Promise<void> {
    const { ops, clock } = this.deps;
    const deadline = clock.now().getTime() + SERVICES_GRACE_SECONDS * 1000;
    for (;;) {
      this.assertNotShuttingDown();
      const states = await ops.servicesState().catch(() => null);
      if (states) {
        const missing = APP_SERVICES.filter(
          (service) =>
            !states.some((entry) => entry.service === service && entry.state === "running"),
        );
        if (missing.length === 0) {
          return;
        }
        if (clock.now().getTime() >= deadline) {
          throw new StepFailure(
            "health.crashed",
            step,
            `Not running: ${missing
              .map((service) => {
                const entry = states.find((candidate) => candidate.service === service);
                return `${service} (${entry?.state ?? "missing"})`;
              })
              .join(", ")}.`,
          );
        }
      } else if (clock.now().getTime() >= deadline) {
        throw new StepFailure("health.crashed", step, "The service states could not be read.");
      }
      await clock.sleep(HEALTH_POLL_MS);
    }
  }

  // -- Step 7: finish ---------------------------------------------------------

  private async stepFinish(exec: Exec): Promise<void> {
    const { dumps, source, logger } = this.deps;
    await this.beginStep("finish", { code: "step.finish.cleaning" });
    // Housekeeping never turns a working update into a failed one.
    await dumps.prune(KEEP_DUMPS, this.protectedDumps()).catch((error: Error) => {
      logger.warn(`Could not prune old dumps: ${error.message}`);
    });
    await source.purge().catch((error: Error) => {
      logger.warn(`Could not remove fetched sources: ${error.message}`);
    });
    await this.endStep("finish");

    const run = this.run();
    const state = this.deps.store.state;
    run.outcome = "succeeded";
    run.finishedAt = this.deps.clock.now().toISOString();
    run.progress = 100;
    state.phase = "succeeded";
    this.setMessage({ code: "run.succeeded", params: { version: exec.target } });
    this.journal("update.succeeded", run, this.finishDetails(run));
    this.deps.store.recordHistory(run);
    await this.deps.store.save();
    this.deps.preflight.invalidate();
  }

  // ---------------------------------------------------------------------------
  // Failure handling
  // ---------------------------------------------------------------------------

  private async handleFailure(failure: StepFailure, exec: Exec): Promise<void> {
    const { store } = this.deps;
    const run = this.run();
    this.deps.logger.warn(
      `The update ${run.id} failed in step ${failure.step}: ${failure.code} ${this.deps.redactor.oneLine(failure.detail, 300)}`,
    );

    if (failure.step === "finish") {
      // Only housekeeping and the final state write happen here; the update itself worked.
      // There is nothing to undo, and nothing safe to add to a state that could not be written.
      this.deps.logger.error(`The final state of the update ${run.id} could not be recorded.`);
      return;
    }

    const step = this.stepOf(run, failure.step);
    if (step.status === "running" || step.status === "pending") {
      step.status = "failed";
      step.finishedAt = this.deps.clock.now().toISOString();
    }
    this.log(
      run,
      `Step ${failure.step} failed: ${failure.code}. ${this.deps.redactor.oneLine(failure.detail, 300)}`,
    );
    await store.save();

    // Nothing was stopped or replaced yet.
    if (failure.step === "prepare" || failure.step === "fetch" || failure.step === "backup") {
      await this.finalizeFailure(failure, "unchanged", null, false);
      return;
    }
    await this.recoverFromLateFailure(failure, exec);
  }

  /**
   * The failure happened after the point of no return of the stop step. Decide,
   * exactly, whether the database was migrated: only when it certainly was not, the
   * previous images may run again.
   */
  private async recoverFromLateFailure(failure: StepFailure, exec: Exec): Promise<void> {
    const { ops } = this.deps;
    const context = this.context();
    let migrationsRan: boolean | null;

    if (!exec.apiUpAttempted) {
      // The new api never started (the stop step or the .env write failed): no migration can have run.
      migrationsRan = false;
    } else {
      await this.note({ code: "rollback.checking_migrations" });
      // Freeze the api first, so the count cannot change while it is read.
      let frozen = true;
      try {
        await ops.composeStop(["api"], STOP_TIMEOUT_SECONDS);
      } catch (error) {
        frozen = false;
        this.deps.logger.warn(
          `The api could not be stopped before the migration check: ${this.detail(error)}`,
        );
      }
      try {
        const count = await ops.migrationCount();
        migrationsRan =
          context.baselineMigrations === null ? null : count !== context.baselineMigrations;
      } catch (error) {
        migrationsRan = null;
        this.deps.logger.warn(`The migration count could not be read: ${this.detail(error)}`);
      }
      if (migrationsRan === false && !frozen) {
        // The api may still be running and migrating: the count proves nothing.
        migrationsRan = null;
      }
    }

    if (migrationsRan === false) {
      await this.rollBack(failure);
    } else {
      await this.stopForAttention(failure, migrationsRan);
    }
  }

  private async rollBack(failure: StepFailure): Promise<void> {
    const { ops, envFile } = this.deps;
    const context = this.context();
    const run = this.run();
    try {
      if (context.previousEnv) {
        await this.note({ code: "rollback.restoring_env" });
        await envFile.restore(context.previousEnv);
      }
      await this.note({
        code: "rollback.restarting",
        params: { version: run.fromVersion ?? "unknown" },
      });
      await ops.composeUp(APP_SERVICES);
      await this.note({ code: "rollback.waiting_for_api" });
      await this.waitForApi(run.fromVersion, failure.step);
      await this.waitForServices(failure.step);
    } catch (rollbackError) {
      await this.note({ code: "rollback.failed" });
      // Both details stay readable inside the 2000 characters a failure may carry.
      const combined = `${clip(failure.detail, 950)} Rollback failed: ${clip(this.detail(rollbackError), 950)}`;
      await this.finalizeFailure(
        new StepFailure(failure.code, failure.step, combined),
        "needs_attention",
        this.recoveryInfo(),
        false,
      );
      return;
    }
    await this.note({ code: "rollback.done" });
    await this.finalizeFailure(failure, "rolled_back", null, false);
  }

  private async stopForAttention(
    failure: StepFailure,
    migrationsRan: boolean | null,
  ): Promise<void> {
    const { ops } = this.deps;
    await this.note({ code: "recovery.stopping_application" });
    let detail = failure.detail;
    try {
      await ops.composeStop(["api", "worker", "scheduler"], STOP_TIMEOUT_SECONDS);
    } catch (error) {
      detail = `${clip(detail, 950)} The application could not be stopped completely: ${clip(this.detail(error), 950)}`;
    }
    const recovery = this.recoveryInfo();
    if (recovery) {
      await this.note({ code: "recovery.dump_kept", details: { file: recovery.dumpFile } });
    }
    await this.finalizeFailure(
      new StepFailure(failure.code, failure.step, detail),
      "needs_attention",
      recovery,
      migrationsRan,
    );
  }

  private recoveryInfo(): Recovery | null {
    const context = this.context();
    const run = this.run();
    if (!context.dumpFile) {
      return null;
    }
    return {
      dumpFile: context.dumpFile,
      dumpBytes: null,
      fromVersion: run.fromVersion,
      previousImages: context.previousImages ?? { app: null, web: null },
    };
  }

  private async finalizeFailure(
    failure: StepFailure,
    outcome: Exclude<RunOutcome, "succeeded">,
    recovery: Recovery | null,
    migrationsRan: boolean | null,
    message?: Msg,
  ): Promise<void> {
    const { store, clock, redactor } = this.deps;
    const run = this.run();
    if (recovery && recovery.dumpBytes === null) {
      recovery.dumpBytes = (await this.deps.dumps.sizeOf(recovery.dumpFile)) ?? null;
    }
    for (const step of run.steps) {
      if (step.status === "pending") {
        step.status = "skipped";
      }
    }
    run.failure = {
      code: failure.code,
      step: failure.step,
      detail: redactor.oneLine(failure.detail, 2000),
      migrationsRan,
    };
    run.outcome = outcome;
    run.recovery = recovery;
    run.finishedAt = clock.now().toISOString();
    store.state.phase = "failed";
    const code: UpdateMessageCode =
      outcome === "unchanged"
        ? "run.unchanged"
        : outcome === "rolled_back"
          ? "run.rolled_back"
          : "run.needs_attention";
    this.setMessage(message ?? { code, params: { code: failure.code } });
    this.journal("update.failed", run, this.finishDetails(run));
    store.recordHistory(run);
    await store.save();
    this.deps.preflight.invalidate();
  }

  private finishDetails(run: Run): Record<string, unknown> {
    const context = this.deps.store.state.runContext;
    return {
      mode: run.mode,
      outcome: run.outcome,
      failureCode: run.failure?.code ?? null,
      fromVersion: run.fromVersion,
      targetVersion: run.targetVersion,
      digestVerified: run.digestVerified,
      signatureVerified: run.signatureVerified,
      dumpFile: context?.dumpFile ?? run.recovery?.dumpFile ?? null,
      steps: run.steps.map((step) => ({
        id: step.id,
        status: step.status,
        durationMs:
          step.startedAt && step.finishedAt
            ? Math.max(0, Date.parse(step.finishedAt) - Date.parse(step.startedAt))
            : null,
      })),
    };
  }

  // ---------------------------------------------------------------------------
  // Load-time recovery
  // ---------------------------------------------------------------------------

  private async recoverRunning(): Promise<void> {
    const run = this.run();
    const stopStep = this.stepOf(run, "stop");
    const reachedStop = stopStep.status !== "pending";
    await this.failInterrupted(reachedStop ? "needs_attention" : "unchanged");
  }

  /** The updater restarted: record the run as interrupted, never let it vanish. */
  private async failInterrupted(outcome: "unchanged" | "needs_attention"): Promise<void> {
    const run = this.run();
    const context = this.context();
    const step: UpdateStepId = run.step ?? "prepare";
    const stepState = this.stepOf(run, step);
    if (stepState.status === "running") {
      stepState.status = "failed";
      stepState.finishedAt = this.deps.clock.now().toISOString();
    }
    let recovery: Recovery | null = null;
    if (outcome === "needs_attention" && context.dumpFile) {
      const bytes = await this.deps.dumps.sizeOf(context.dumpFile);
      if (bytes !== null) {
        recovery = {
          dumpFile: context.dumpFile,
          dumpBytes: bytes,
          fromVersion: run.fromVersion,
          previousImages: context.previousImages ?? { app: null, web: null },
        };
      }
    }
    await this.finalizeFailure(
      new StepFailure("interrupted", step, "The updater restarted while the update was running."),
      outcome,
      recovery,
      // Nothing is known about what happened after the updater went away.
      outcome === "unchanged" ? false : null,
      { code: "run.interrupted" },
    );
  }

  // ---------------------------------------------------------------------------
  // Run document helpers
  // ---------------------------------------------------------------------------

  private run(): Run {
    const run = this.deps.store.state.run;
    if (!run) {
      throw new Error("There is no current run.");
    }
    return run;
  }

  private context(): RunContext {
    const state = this.deps.store.state;
    if (!state.runContext) {
      state.runContext = emptyRunContext();
    }
    return state.runContext;
  }

  private stepOf(run: Run, id: UpdateStepId): StepState {
    const step = run.steps.find((candidate) => candidate.id === id);
    if (!step) {
      throw new Error(`Unknown step ${id}.`);
    }
    return step;
  }

  /** A redacted, single-line description of what went wrong. */
  private detail(error: unknown): string {
    return this.deps.redactor.oneLine(describeError(error), 2000);
  }

  private assertNotShuttingDown(): void {
    if (this.shuttingDown) {
      throw new ShutdownSignal();
    }
  }

  private bumpProgress(run: Run): void {
    run.progress = Math.max(run.progress, progressOf(run.steps));
  }

  private setMessage(message: Msg): void {
    const run = this.run();
    const params = message.params ?? {};
    const safe: Params = {};
    for (const [key, value] of Object.entries(params)) {
      safe[key] = typeof value === "string" ? this.deps.redactor.oneLine(value, 300) : value;
    }
    const update: UpdateMessage = { code: message.code, params: safe };
    run.message = update;
    this.log(run, LOG_TEXT[message.code]({ ...(message.details ?? {}), ...safe }));
  }

  private log(run: Run, line: string): void {
    const text = clip(this.deps.redactor.oneLine(line, LOG_LINE_CHARS), LOG_LINE_CHARS);
    run.log = [...run.log, `${this.deps.clock.now().toISOString()} ${text}`].slice(-LOG_LINES);
  }

  /** Update the message inside a step and persist. */
  private async note(message: Msg): Promise<void> {
    this.assertNotShuttingDown();
    this.setMessage(message);
    await this.deps.store.save();
  }

  private async beginStep(id: UpdateStepId, message: Msg | null): Promise<void> {
    this.assertNotShuttingDown();
    const run = this.run();
    const step = this.stepOf(run, id);
    step.status = "running";
    step.startedAt = this.deps.clock.now().toISOString();
    step.finishedAt = null;
    run.step = id;
    if (message) {
      this.setMessage(message);
    }
    this.bumpProgress(run);
    await this.deps.store.save();
  }

  private async endStep(id: UpdateStepId, detail: StepState["detail"] = {}): Promise<void> {
    const run = this.run();
    const step = this.stepOf(run, id);
    step.status = "done";
    step.finishedAt = this.deps.clock.now().toISOString();
    step.detail = { ...step.detail, ...detail };
    this.bumpProgress(run);
    await this.deps.store.save();
  }

  private journal(
    action: JournalEvent["action"],
    run: Run,
    details: Record<string, unknown>,
  ): void {
    this.deps.store.addEvent(
      {
        at: this.deps.clock.now().toISOString(),
        action,
        runId: run.id,
        actor: run.requestedBy,
        target: run.targetVersion,
        details,
      },
      this.deps.clock.now().getTime(),
    );
  }
}

/** A plain description of what went wrong (redacted by the engine before it is stored). */
function describeError(error: unknown): string {
  if (error instanceof OpsError) {
    return error.detail ? `${error.message} ${error.detail}` : error.message;
  }
  if (error instanceof EnvFileError || error instanceof SourceError || error instanceof Error) {
    return error.message;
  }
  return String(error);
}
