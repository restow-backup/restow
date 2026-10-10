import { randomBytes } from "node:crypto";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { z } from "zod";
import type {
  ContainerInspect,
  ContainerLogs,
  ContainerSummary,
  CreateContainerBody,
  CreateVolumeBody,
  LogLimits,
  VolumeSummary,
} from "../updater/engine-api.js";
import type { Logger } from "../updater/logger.js";
import type { Clock } from "../updater/ops.js";
import type { Redactor } from "../updater/redact.js";
import { writeAtomic } from "../updater/store.js";
import { PROBE_LABEL } from "./protocol.js";
import {
  RunnerRedactor,
  cacheVolumeLabels,
  classifyMountError,
  execContainerSpec,
  runContainerSpec,
  runNames,
  runVolumeLabels,
  shareVolumeOptions,
} from "./runner-ops.js";
import {
  RUNNER_DEADLINE_LABEL,
  RUNNER_KIND_LABEL,
  RUNNER_LABEL,
  RUNNER_PROTOCOLS,
  RUNNER_RUN_KINDS,
  RUNNER_SHARE_LABEL,
  RUNNER_VOLUME_LABEL,
  type RunnerCapabilities,
  type RunnerExecRequest,
  type RunnerExecResult,
  type RunnerFailureCode,
  type RunnerRunDetail,
  type RunnerRunKind,
  type RunnerRunRequest,
  type RunnerRunView,
  type RunnerStarted,
  isUuid,
} from "./runner-protocol.js";

/**
 * The runner (docs/FILESHARES.md 3.4-3.5): one temporary volume and one short-lived
 * container per run, from the image of the project's api container. Runs survive a
 * restart of the mounter: on start it adopts the runner containers that still run
 * and removes everything else it finds by label. The share's password exists only
 * in the request body and, while the container runs, in the volume's options; the
 * run token only in the container's environment. Neither is logged, persisted or
 * put into the operation history.
 */

/** The Docker calls the runner makes (EngineClient implements them; tests fake them). */
export interface RunnerDocker {
  ping(): Promise<void>;
  listContainers(labels: readonly string[]): Promise<ContainerSummary[]>;
  inspectContainer(idOrName: string): Promise<ContainerInspect | null>;
  networkExists(name: string): Promise<boolean>;
  createVolume(spec: CreateVolumeBody): Promise<string>;
  removeVolume(name: string): Promise<void>;
  listVolumes(labels: readonly string[]): Promise<VolumeSummary[]>;
  createContainer(body: CreateContainerBody, name: string): Promise<string>;
  startContainer(id: string): Promise<void>;
  waitContainer(id: string, signal?: AbortSignal): Promise<number>;
  killContainer(id: string): Promise<void>;
  stopContainer(id: string, timeoutSeconds: number): Promise<void>;
  removeContainer(id: string): Promise<void>;
  containerLogs(id: string, limits: LogLimits): Promise<ContainerLogs>;
}

export interface RunnerConfig {
  /** RESTOW_MOUNTER_MAX_RUNNERS: hard cap of concurrent runner containers. */
  maxRunners: number;
  /** RESTOW_MOUNTER_RUNNER_API_URL. */
  apiUrl: string;
  /** RESTOW_MOUNTER_RUNNER_NETWORK: the compose network key (`runners`). */
  networkKey: string;
  /** RESTOW_MOUNTER_RUNNER_EXEC_TIMEOUT_SECONDS, in ms. */
  execTimeoutMs: number;
  /** RESTOW_MOUNTER_RUNNER_MAX_MEMORY_MIB. */
  maxMemoryMiB: number;
  /** RESTOW_MOUNTER_SELINUX_CONTEXT. */
  selinux: boolean;
}

/** A refusal of a runner request: HTTP 409 (limit, exists, blocked) or 422 (mount). */
export class RunnerError extends Error {
  constructor(
    readonly code: RunnerFailureCode | "exists" | "not_found" | "busy" | "invalid_request",
    message: string,
    readonly status: 404 | 409 | 422,
  ) {
    super(message);
    this.name = "RunnerError";
  }
}

const COMPOSE_PROJECT_LABEL = "com.docker.compose.project";
const COMPOSE_SERVICE_LABEL = "com.docker.compose.service";

/** Finished runs stay visible this long (3.5 step 4). */
export const FINISHED_RETENTION_MS = 24 * 3600_000;
/** How often the deadlines are checked (3.5 step 5). */
export const SWEEP_INTERVAL_MS = 60_000;
/** A run never gets a deadline further away than this (7.4 maxRunHours: 336). */
export const MAX_RUN_MS = 336 * 3600_000;
/** stdout of a test or list (3.1). */
export const EXEC_MAX_OUTPUT = 1024 * 1024;
/** Concurrent tests and lists. */
export const MAX_EXECS = 4;
const STDERR_TAIL = 4096;
const STOP_GRACE_SECONDS = 30;

// ---------------------------------------------------------------------------
// The persisted record (runner-runs.json): no spec, no option string, no secret.
// ---------------------------------------------------------------------------

const iso = z.string().datetime({ offset: true });
const persistedRunSchema = z.object({
  runId: z.string(),
  kind: z.enum(RUNNER_RUN_KINDS),
  shareId: z.string(),
  containerId: z.string(),
  volumes: z.array(z.string()),
  state: z.enum(["running", "exited"]),
  startedAt: iso,
  deadline: iso,
  exitCode: z.number().int().nullable(),
  finishedAt: iso.nullable(),
  stopReason: z.enum(["deadline", "stopped"]).nullable(),
  stderrTail: z.string().nullable(),
});
export type PersistedRun = z.infer<typeof persistedRunSchema>;

/** The fields runner-runs.json holds (boundary.test.ts checks that none is a secret). */
export const PERSISTED_RUN_FIELDS: readonly string[] = Object.keys(persistedRunSchema.shape);

const runsFileSchema = z.object({ schemaVersion: z.literal(1), runs: z.array(persistedRunSchema) });

export const RUNNER_STATE_FILE = "runner-runs.json";

export interface RunnerRunStore {
  load(): Promise<PersistedRun[]>;
  save(runs: readonly PersistedRun[]): Promise<void>;
}

export class FileRunnerRunStore implements RunnerRunStore {
  private chain: Promise<void> = Promise.resolve();
  constructor(private readonly stateDir: string) {}

  async load(): Promise<PersistedRun[]> {
    try {
      const raw = await fs.readFile(path.join(this.stateDir, RUNNER_STATE_FILE), "utf8");
      const parsed = runsFileSchema.safeParse(JSON.parse(raw));
      return parsed.success ? parsed.data.runs : [];
    } catch {
      return [];
    }
  }

  save(runs: readonly PersistedRun[]): Promise<void> {
    const payload = `${JSON.stringify({ schemaVersion: 1, runs }, null, 2)}\n`;
    const write = this.chain.then(() =>
      writeAtomic(path.join(this.stateDir, RUNNER_STATE_FILE), payload),
    );
    this.chain = write.catch(() => undefined);
    return write;
  }
}

export class MemoryRunnerRunStore implements RunnerRunStore {
  runs: PersistedRun[] = [];
  saves = 0;
  async load(): Promise<PersistedRun[]> {
    return this.runs.map((run) => ({ ...run }));
  }
  async save(runs: readonly PersistedRun[]): Promise<void> {
    this.runs = runs.map((run) => ({ ...run }));
    this.saves += 1;
  }
}

export interface RunnerEngineDeps {
  docker: RunnerDocker;
  config: RunnerConfig;
  projectName: string;
  store: RunnerRunStore;
  clock: Clock;
  logger: Logger;
  /** The mounter's own redactor (its shared secret and patterns). */
  redactor: Redactor;
  /** How long a capabilities answer is reused (default 30 s). */
  capabilitiesTtlMs?: number;
  newSuffix?: () => string;
}

interface LiveRun extends PersistedRun {
  /** Knows the run's token and, at start, the share's password; memory only. */
  redactor: RunnerRedactor | null;
}

function view(run: PersistedRun): RunnerRunView {
  return {
    runId: run.runId,
    kind: run.kind,
    state: run.state,
    startedAt: run.startedAt,
    deadline: run.deadline,
    exitCode: run.exitCode,
    finishedAt: run.finishedAt,
    stopReason: run.stopReason,
  };
}

function persisted(run: LiveRun): PersistedRun {
  const { redactor: _redactor, ...rest } = run;
  return rest;
}

export class RunnerEngine {
  private readonly runs = new Map<string, LiveRun>();
  private capabilitiesCache: { at: number; value: RunnerCapabilities } | null = null;
  private starting: Promise<unknown> = Promise.resolve();
  private execs = 0;
  private sweepTimer: { cancel(): void } | null = null;
  private readonly newSuffix: () => string;

  constructor(private readonly deps: RunnerEngineDeps) {
    this.newSuffix = deps.newSuffix ?? (() => randomBytes(8).toString("hex"));
  }

  private now(): Date {
    return this.deps.clock.now();
  }

  private get networkName(): string {
    return `${this.deps.projectName}_${this.deps.config.networkKey}`;
  }

  get running(): number {
    let count = 0;
    for (const run of this.runs.values()) {
      if (run.state === "running") {
        count += 1;
      }
    }
    return count;
  }

  // -- Start and garbage collection (3.5 step 6) ------------------------------

  /**
   * Adopt runner containers that still run and whose deadline is ahead; remove
   * exited ones and those past their deadline; then remove every run volume no
   * remaining container uses. Probe containers (tests and lists) are removed by
   * DockerMountOps.removeStaleProbes.
   */
  async init(): Promise<void> {
    const { docker, logger } = this.deps;
    const nowMs = this.now().getTime();
    for (const run of await this.deps.store.load()) {
      if (run.state === "exited" && run.finishedAt) {
        if (nowMs - Date.parse(run.finishedAt) < FINISHED_RETENTION_MS) {
          this.runs.set(run.runId, { ...run, redactor: null });
        }
      } else {
        // Running when the mounter stopped: Docker says below whether it still is.
        this.runs.set(run.runId, { ...run, redactor: null });
      }
    }
    const adopted = new Set<string>();
    let containers: ContainerSummary[] = [];
    try {
      containers = await docker.listContainers([RUNNER_LABEL]);
    } catch (error) {
      logger.warn(`Could not list runner containers: ${(error as Error).message}`);
      return;
    }
    for (const container of containers) {
      const runId = container.Labels[RUNNER_LABEL] ?? "";
      const kind = container.Labels[RUNNER_KIND_LABEL] as RunnerRunKind;
      const deadline = container.Labels[RUNNER_DEADLINE_LABEL] ?? "";
      const shareId = container.Labels[RUNNER_SHARE_LABEL] ?? "";
      const known = this.runs.get(runId);
      const deadlineMs = Date.parse(deadline);
      const valid =
        isUuid(runId) &&
        (RUNNER_RUN_KINDS as readonly string[]).includes(kind) &&
        !Number.isNaN(deadlineMs);
      if (valid && container.State === "running" && deadlineMs > nowMs) {
        const names = runNames(runId, shareId || "x", "source");
        const run: LiveRun = known
          ? { ...known, containerId: container.Id, state: "running", redactor: null }
          : {
              runId,
              kind,
              shareId,
              containerId: container.Id,
              volumes: [
                runNames(runId, shareId || "x", kind === "backup" ? "source" : "target")
                  .shareVolume,
                names.scratchVolume,
              ],
              state: "running",
              startedAt: new Date(container.Created * 1000).toISOString(),
              deadline: new Date(deadlineMs).toISOString(),
              exitCode: null,
              finishedAt: null,
              stopReason: null,
              stderrTail: null,
              redactor: null,
            };
        this.runs.set(runId, run);
        adopted.add(runId);
        this.watch(run);
        logger.info(`Adopted the running runner of run ${runId}.`);
        continue;
      }
      // Exited, past its deadline or not ours to understand: record what it left, remove it.
      let exitCode: number | null = null;
      let stderrTail: string | null = null;
      try {
        const info = await docker.inspectContainer(container.Id);
        exitCode = info?.State?.ExitCode ?? null;
        const logs = await docker.containerLogs(container.Id, {
          maxStdoutBytes: 0,
          stderrTailBytes: STDERR_TAIL,
        });
        stderrTail = this.deps.redactor.tail(logs.stderr, STDERR_TAIL);
      } catch {
        // Only the record suffers.
      }
      if (container.State === "running") {
        await docker.killContainer(container.Id).catch(() => undefined);
      }
      await docker.removeContainer(container.Id).catch((error: Error) => {
        logger.warn(`Could not remove the runner container of ${runId}: ${error.message}`);
      });
      if (valid) {
        const pastDeadline = deadlineMs <= nowMs;
        this.runs.set(runId, {
          ...(known ?? {
            runId,
            kind,
            shareId,
            containerId: container.Id,
            volumes: [],
            startedAt: new Date(container.Created * 1000).toISOString(),
            deadline: new Date(deadlineMs).toISOString(),
          }),
          state: "exited",
          exitCode: pastDeadline && container.State === "running" ? 137 : exitCode,
          finishedAt: this.now().toISOString(),
          stopReason: pastDeadline && container.State === "running" ? "deadline" : null,
          stderrTail,
          redactor: null,
        } as LiveRun);
      }
    }
    // A run the file says was running but Docker no longer has: lost.
    for (const run of this.runs.values()) {
      if (run.state === "running" && !adopted.has(run.runId)) {
        run.state = "exited";
        run.finishedAt = this.now().toISOString();
      }
    }
    await this.removeOrphanVolumes(adopted);
    await this.persist();
  }

  private async removeOrphanVolumes(keep: ReadonlySet<string>): Promise<void> {
    const { docker, logger } = this.deps;
    try {
      for (const volume of await docker.listVolumes([RUNNER_VOLUME_LABEL])) {
        const runId = volume.Labels?.[RUNNER_LABEL] ?? "";
        if (keep.has(runId)) {
          continue;
        }
        await docker.removeVolume(volume.Name).catch((error: Error) => {
          logger.warn(`Could not remove the runner volume ${volume.Name}: ${error.message}`);
        });
      }
    } catch (error) {
      logger.warn(`Could not list runner volumes: ${(error as Error).message}`);
    }
  }

  /** Start the deadline sweep (every minute). */
  startSweeping(): void {
    const tick = (): void => {
      void this.sweep()
        .catch((error: Error) => this.deps.logger.warn(`Runner sweep failed: ${error.message}`))
        .finally(() => {
          this.sweepTimer = this.deps.clock.setTimer(tick, SWEEP_INTERVAL_MS);
        });
    };
    this.sweepTimer = this.deps.clock.setTimer(tick, SWEEP_INTERVAL_MS);
  }

  stopSweeping(): void {
    this.sweepTimer?.cancel();
    this.sweepTimer = null;
  }

  /** Kill runs past their deadline; drop finished runs older than a day. */
  async sweep(): Promise<void> {
    const nowMs = this.now().getTime();
    let changed = false;
    for (const run of [...this.runs.values()]) {
      if (run.state === "running" && Date.parse(run.deadline) <= nowMs) {
        run.stopReason = "deadline";
        changed = true;
        this.deps.logger.warn(`Run ${run.runId} passed its deadline; stopping it.`);
        await this.deps.docker.killContainer(run.containerId).catch(() => undefined);
      }
      if (
        run.state === "exited" &&
        run.finishedAt &&
        nowMs - Date.parse(run.finishedAt) >= FINISHED_RETENTION_MS
      ) {
        this.runs.delete(run.runId);
        changed = true;
      }
    }
    if (changed) {
      await this.persist();
    }
  }

  private async persist(): Promise<void> {
    try {
      await this.deps.store.save([...this.runs.values()].map(persisted));
    } catch (error) {
      this.deps.logger.warn(`Could not save ${RUNNER_STATE_FILE}: ${(error as Error).message}`);
    }
  }

  // -- Capabilities -----------------------------------------------------------

  async capabilities(refresh = false): Promise<RunnerCapabilities> {
    const nowMs = this.now().getTime();
    const ttl = this.deps.capabilitiesTtlMs ?? 30_000;
    if (!refresh && this.capabilitiesCache && nowMs - this.capabilitiesCache.at < ttl) {
      return { ...this.capabilitiesCache.value, running: this.running };
    }
    const blockers: RunnerCapabilities["blockers"] = [];
    let image: string | null = null;
    try {
      await this.deps.docker.ping();
      image = await this.apiImage();
      if (!image) {
        blockers.push({
          code: "runner_image_unknown",
          detail: `No api container of the compose project ${this.deps.projectName} was found to take the image from.`,
        });
      }
      if (!(await this.deps.docker.networkExists(this.networkName))) {
        blockers.push({
          code: "runner_network_missing",
          detail: `The compose project has no network ${this.networkName}: its docker-compose.yml predates file share backup. Update the compose file.`,
        });
      }
    } catch (error) {
      blockers.push({
        code: "docker_unreachable",
        detail: this.deps.redactor.oneLine((error as Error).message, 500),
      });
    }
    const value: RunnerCapabilities = {
      ready: blockers.length === 0,
      blockers,
      protocols: [...RUNNER_PROTOCOLS],
      running: this.running,
      limit: this.deps.config.maxRunners,
      image,
    };
    this.capabilitiesCache = { at: nowMs, value };
    return value;
  }

  /** The image id of the project's api container (a running one first). */
  private async apiImage(): Promise<string | null> {
    const containers = await this.deps.docker.listContainers([
      `${COMPOSE_PROJECT_LABEL}=${this.deps.projectName}`,
      `${COMPOSE_SERVICE_LABEL}=api`,
    ]);
    const running = containers.find((container) => container.State === "running");
    const chosen = running ?? containers[0];
    return chosen?.ImageID || null;
  }

  // -- Synchronous operations: test and list ------------------------------------

  async exec(request: RunnerExecRequest): Promise<RunnerExecResult> {
    const { docker, logger } = this.deps;
    const redactor = RunnerRedactor.forShare(this.deps.redactor, request.share);
    if (this.execs >= MAX_EXECS) {
      throw new RunnerError("runner.limit", "Too many tests run at the same time; try again.", 409);
    }
    const capabilities = await this.capabilities();
    const image = capabilities.image;
    if (!image) {
      const blocker = capabilities.blockers[0];
      throw new RunnerError(
        blocker?.code === "docker_unreachable" ? "runner.blocked" : "runner.image",
        blocker?.detail ?? "The runner image is unknown.",
        409,
      );
    }
    this.execs += 1;
    const suffix = this.newSuffix();
    const volume = `restow-share-exec-${suffix}`;
    let containerId: string | null = null;
    let volumeCreated = false;
    const fail = (code: RunnerFailureCode, detail: string): RunnerExecResult => ({
      ok: false,
      code,
      detail: redactor.oneLine(detail, 500),
      output: null,
    });
    try {
      const options = shareVolumeOptions(request.share, "ro", this.deps.config.selinux);
      await docker.createVolume({
        Name: volume,
        Driver: "local",
        DriverOpts: { type: options.type, o: options.o, device: options.device },
        Labels: { [PROBE_LABEL]: "1" },
      });
      volumeCreated = true;
      containerId = await docker.createContainer(
        execContainerSpec({ image, request, volume }),
        `restow-runner-exec-${suffix}`,
      );
      try {
        await docker.startContainer(containerId);
      } catch (error) {
        const message = (error as Error).message;
        return fail(classifyMountError(message), message);
      }
      const controller = new AbortController();
      let timedOut = false;
      const timer = setTimeout(() => {
        timedOut = true;
        controller.abort();
        void docker.killContainer(containerId as string).catch(() => undefined);
      }, this.deps.config.execTimeoutMs);
      let exitCode: number;
      try {
        exitCode = await docker.waitContainer(containerId, controller.signal);
      } catch (error) {
        if (!timedOut) {
          throw error;
        }
        exitCode = 124;
      } finally {
        clearTimeout(timer);
      }
      if (timedOut) {
        return fail("runner.timeout", "The share did not answer in time.");
      }
      const logs = await docker.containerLogs(containerId, {
        maxStdoutBytes: EXEC_MAX_OUTPUT,
        stderrTailBytes: 2048,
      });
      const output = parseLastJson(logs.stdout);
      if (!output || typeof output !== "object") {
        return fail(
          "runner.failed",
          logs.stderr.trim() || `The runner ended with exit code ${exitCode} and no answer.`,
        );
      }
      const record = output as { ok?: unknown; code?: unknown; detail?: unknown };
      const ok = exitCode === 0 && record.ok === true;
      // The output is re-serialised from the parsed value, never passed on as text.
      const clean = JSON.parse(redactor.redact(JSON.stringify(output))) as unknown;
      return {
        ok,
        code: ok ? null : typeof record.code === "string" ? record.code : "runner.failed",
        detail:
          ok || typeof record.detail !== "string" ? null : redactor.oneLine(record.detail, 500),
        output: clean,
      };
    } catch (error) {
      const message = (error as Error).message;
      return fail(/timed out/i.test(message) ? "runner.timeout" : "runner.failed", message);
    } finally {
      this.execs -= 1;
      if (containerId) {
        await docker.removeContainer(containerId).catch((error: Error) => {
          logger.warn(`Could not remove a test container: ${redactor.oneLine(error.message)}`);
        });
      }
      if (volumeCreated) {
        await docker.removeVolume(volume).catch((error: Error) => {
          logger.warn(
            `Could not remove the test volume ${volume}: ${redactor.oneLine(error.message)}`,
          );
        });
      }
    }
  }

  // -- Runs ---------------------------------------------------------------------

  /** Start a run (3.5 steps 1-3). Serialised, so two starts never race the limit. */
  start(request: RunnerRunRequest): Promise<RunnerStarted> {
    const next = this.starting.then(() => this.startNow(request));
    this.starting = next.catch(() => undefined);
    return next;
  }

  private async startNow(request: RunnerRunRequest): Promise<RunnerStarted> {
    const { docker, config, logger } = this.deps;
    const mount = request.mounts[0];
    if (!mount) {
      throw new RunnerError("invalid_request", "A run needs one mount.", 409);
    }
    const capabilities = await this.capabilities();
    if (!capabilities.ready || !capabilities.image) {
      const blocker = capabilities.blockers[0];
      const code: RunnerFailureCode =
        blocker?.code === "runner_network_missing"
          ? "runner.network"
          : blocker?.code === "runner_image_unknown"
            ? "runner.image"
            : "runner.blocked";
      throw new RunnerError(code, blocker?.detail ?? "The runner is not ready.", 409);
    }
    if (this.running >= config.maxRunners) {
      throw new RunnerError(
        "runner.limit",
        `${this.running} runs are running; the limit is ${config.maxRunners}.`,
        409,
      );
    }
    if (
      this.runs.has(request.runId) ||
      (await docker.listContainers([`${RUNNER_LABEL}=${request.runId}`])).length > 0
    ) {
      throw new RunnerError("exists", `Run ${request.runId} exists already.`, 409);
    }
    const nowMs = this.now().getTime();
    const deadlineMs = Date.parse(request.limits.deadline);
    if (Number.isNaN(deadlineMs) || deadlineMs <= nowMs) {
      throw new RunnerError("invalid_request", "The deadline has passed.", 409);
    }
    // The mounter's own bounds win over the request (3.2).
    const deadline = new Date(Math.min(deadlineMs, nowMs + MAX_RUN_MS)).toISOString();
    const memoryMiB = Math.min(request.limits.memoryMiB, config.maxMemoryMiB);
    const goMemLimitMiB = Math.min(request.limits.goMemLimitMiB, memoryMiB);
    const shareId = request.limits.cacheKey;
    const names = runNames(request.runId, shareId, mount.role);
    const redactor = RunnerRedactor.forShare(this.deps.redactor, mount.share, [request.token]);
    const access = mount.readOnly ? "ro" : "rw";
    const options = shareVolumeOptions(mount.share, access, config.selinux);
    const labels = runVolumeLabels(request.runId, request.kind, deadline, shareId);
    const created: string[] = [];
    let containerId: string | null = null;
    const cleanup = async (): Promise<void> => {
      if (containerId) {
        await docker.removeContainer(containerId).catch(() => undefined);
      }
      for (const volume of created) {
        await docker.removeVolume(volume).catch(() => undefined);
      }
    };
    try {
      await docker.createVolume({
        Name: names.shareVolume,
        Driver: "local",
        DriverOpts: { type: options.type, o: options.o, device: options.device },
        Labels: labels,
      });
      created.push(names.shareVolume);
      await docker.createVolume({ Name: names.scratchVolume, Driver: "local", Labels: labels });
      created.push(names.scratchVolume);
      // Kept between runs: created when missing (Docker answers the existing one).
      await docker.createVolume({
        Name: names.cacheVolume,
        Driver: "local",
        Labels: cacheVolumeLabels(shareId),
      });
      containerId = await docker.createContainer(
        runContainerSpec({
          image: capabilities.image,
          runId: request.runId,
          kind: request.kind,
          token: request.token,
          apiUrl: config.apiUrl,
          network: this.networkName,
          protocol: mount.share.protocol,
          shareVolume: names.shareVolume,
          scratchVolume: names.scratchVolume,
          cacheVolume: names.cacheVolume,
          readOnly: mount.readOnly,
          memoryMiB,
          goMemLimitMiB,
          deadline,
          shareId,
        }),
        names.container,
      );
    } catch (error) {
      await cleanup();
      throw new RunnerError(
        "runner.failed",
        `The runner could not be prepared: ${redactor.oneLine((error as Error).message)}`,
        422,
      );
    }
    try {
      // Docker mounts the share when the container starts: mount errors come here.
      await docker.startContainer(containerId);
    } catch (error) {
      const message = (error as Error).message;
      await cleanup();
      throw new RunnerError(classifyMountError(message), redactor.oneLine(message, 500), 422);
    }
    const run: LiveRun = {
      runId: request.runId,
      kind: request.kind,
      shareId,
      containerId,
      volumes: [names.shareVolume, names.scratchVolume],
      state: "running",
      startedAt: this.now().toISOString(),
      deadline,
      exitCode: null,
      finishedAt: null,
      stopReason: null,
      stderrTail: null,
      redactor,
    };
    this.runs.set(run.runId, run);
    await this.persist();
    this.watch(run);
    logger.info(`Started the ${run.kind} runner of run ${run.runId}.`);
    return { runId: run.runId, startedAt: run.startedAt };
  }

  /** Wait for a run's container; on exit record it and remove it with its volumes at once. */
  private watch(run: LiveRun): void {
    const { docker, logger } = this.deps;
    void docker
      .waitContainer(run.containerId)
      .then((exitCode) => this.finished(run, exitCode))
      .catch(async (error: Error) => {
        // Docker went away or the request broke: look again shortly.
        logger.warn(`Lost the wait on run ${run.runId}: ${error.message}; retrying.`);
        await this.deps.clock.sleep(5000);
        const info = await docker.inspectContainer(run.containerId).catch(() => undefined);
        if (info === null) {
          await this.finished(run, null);
        } else if (run.state === "running") {
          this.watch(run);
        }
      });
  }

  private async finished(run: LiveRun, exitCode: number | null): Promise<void> {
    const { docker, logger } = this.deps;
    if (run.state === "exited") {
      return;
    }
    const redact = (text: string): string =>
      run.redactor
        ? run.redactor.tail(text, STDERR_TAIL)
        : this.deps.redactor.tail(text, STDERR_TAIL);
    try {
      const logs = await docker.containerLogs(run.containerId, {
        maxStdoutBytes: 0,
        stderrTailBytes: STDERR_TAIL,
      });
      run.stderrTail = redact(logs.stderr);
    } catch {
      run.stderrTail = null;
    }
    run.state = "exited";
    run.exitCode = exitCode;
    run.finishedAt = this.now().toISOString();
    // The password lives in the volume's options for exactly as long as the container runs.
    await docker.removeContainer(run.containerId).catch((error: Error) => {
      logger.warn(`Could not remove the runner container of ${run.runId}: ${error.message}`);
    });
    for (const volume of run.volumes) {
      await docker.removeVolume(volume).catch((error: Error) => {
        logger.warn(`Could not remove the runner volume ${volume}: ${error.message}`);
      });
    }
    run.redactor = null;
    await this.persist();
    logger.info(
      `The runner of run ${run.runId} ended (exit code ${exitCode ?? "unknown"}${run.stopReason ? `, ${run.stopReason}` : ""}).`,
    );
  }

  list(): RunnerRunView[] {
    return [...this.runs.values()].sort((a, b) => b.startedAt.localeCompare(a.startedAt)).map(view);
  }

  get(runId: string): RunnerRunDetail | null {
    const run = this.runs.get(runId);
    if (!run) {
      return null;
    }
    return { ...view(run), stderrTail: run.state === "exited" ? run.stderrTail : null };
  }

  /** Stop a run (SIGTERM, 30 s, SIGKILL) and clean up. Idempotent. */
  async stop(runId: string): Promise<void> {
    const run = this.runs.get(runId);
    if (run && run.state === "running") {
      run.stopReason = "stopped";
      await this.deps.docker
        .stopContainer(run.containerId, STOP_GRACE_SECONDS)
        .catch(() => undefined);
      return;
    }
    if (!run) {
      // A container the mounter does not know (yet): remove whatever carries the run id.
      for (const container of await this.deps.docker.listContainers([`${RUNNER_LABEL}=${runId}`])) {
        await this.deps.docker.removeContainer(container.Id).catch(() => undefined);
      }
    }
  }

  /** Remove a share's restic cache volume (purge, 8.6). Refused while a run uses it. */
  async removeCache(shareId: string): Promise<void> {
    for (const run of this.runs.values()) {
      if (run.state === "running" && run.shareId === shareId) {
        throw new RunnerError("busy", "A run of this share is running.", 409);
      }
    }
    await this.deps.docker.removeVolume(runNames("00000000", shareId, "source").cacheVolume);
  }
}

/** The last line of stdout that parses as JSON. */
export function parseLastJson(stdout: string): unknown {
  const lines = stdout
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean);
  for (let index = lines.length - 1; index >= 0; index -= 1) {
    try {
      return JSON.parse(lines[index] as string) as unknown;
    } catch {
      // Not JSON: an earlier line may be.
    }
  }
  return null;
}
