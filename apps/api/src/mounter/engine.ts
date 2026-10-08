import { randomBytes } from "node:crypto";
import type { Logger } from "../updater/logger.js";
import { type Clock, OpsError, type ServiceState } from "../updater/ops.js";
import type { UpdateActor } from "../updater/protocol.js";
import type { Redactor } from "../updater/redact.js";
import type { MountOps } from "./ops.js";
import {
  OverrideError,
  conflictsOf,
  managedMountsOf,
  renderOverride,
  volumeKeyOf,
} from "./override.js";
import {
  MAX_MOUNTS,
  MOUNT_PROTOCOLS,
  MOUNT_SERVICES,
  MOUNT_STEPS,
  type MountFailureCode,
  type MountSpec,
  type MountStepId,
  type MountStepStatus,
  type MountView,
  type MounterBlocker,
  type MounterCapabilities,
  type MounterErrorCode,
  type Operation,
  type OperationKind,
  type OperationStatus,
  type TestResult,
  mountPathOf,
} from "./protocol.js";
import type { OperationStore } from "./store.js";

/**
 * Adds and removes network shares (docs/MOUNTS.md). One operation at a time, in these
 * steps:
 *
 *   validate  the request is well-formed, the name is free (or exists, for a removal),
 *             nothing of the operator's own override clashes with it (synchronous: a
 *             request that fails here is refused and no operation is recorded)
 *   probe     (add) a temporary volume with the share's settings, a short-lived
 *             container mounts it and writes and removes a file: the share is
 *             reachable, exported to this host and writable for the api's user
 *   write     the new override is written and `docker compose config -q` accepts it
 *   apply     `docker compose up -d --no-deps --no-build --pull never api worker`
 *   health    the api reports healthy and the worker runs
 *   cleanup   managed volumes no service references any more are removed (a failure
 *             here is only a warning: nothing that runs depends on them)
 *
 * A failure after the override was written puts the previous override back and, when
 * the services were already recreated, recreates them again and waits for them. A
 * rollback that fails as well leaves the operation `needs_attention`.
 */

export class MountEngineError extends Error {
  constructor(
    readonly code: MounterErrorCode,
    message: string,
  ) {
    super(message);
    this.name = "MountEngineError";
  }
}

export interface MountEngineDeps {
  ops: MountOps;
  store: OperationStore;
  clock: Clock;
  logger: Logger;
  redactor: Redactor;
  healthTimeoutMs: number;
  probeTimeoutMs: number;
  /** Between two looks at the service states (default 3 s). */
  pollIntervalMs?: number;
  /** How long a capabilities answer is reused (default 30 s). */
  capabilitiesTtlMs?: number;
  newId?: () => string;
}

class StepFailure extends Error {
  constructor(
    readonly code: MountFailureCode,
    readonly step: MountStepId,
    readonly detail: string,
  ) {
    super(`${code}: ${detail}`);
    this.name = "StepFailure";
  }
}

function defaultId(): string {
  return `${Date.now().toString(36)}-${randomBytes(4).toString("hex")}`;
}

function detailOf(error: unknown): string {
  if (error instanceof OpsError) {
    return error.detail ? `${error.message} ${error.detail}` : error.message;
  }
  return error instanceof Error ? error.message : String(error);
}

export class MountEngine {
  private busy = false;
  private task: Promise<void> | null = null;
  private capabilitiesCache: { at: number; value: MounterCapabilities } | null = null;
  private readonly pollIntervalMs: number;
  private readonly capabilitiesTtlMs: number;
  private readonly newId: () => string;

  constructor(private readonly deps: MountEngineDeps) {
    this.pollIntervalMs = deps.pollIntervalMs ?? 3000;
    this.capabilitiesTtlMs = deps.capabilitiesTtlMs ?? 30_000;
    this.newId = deps.newId ?? defaultId;
  }

  /** After a restart: an operation that was running when the process stopped is closed as interrupted. */
  async init(): Promise<void> {
    const operation = this.deps.store.current();
    if (operation && operation.status === "running") {
      const step = operation.steps.find((entry) => entry.status === "running")?.id ?? "validate";
      for (const entry of operation.steps) {
        if (entry.status === "running") {
          entry.status = "failed";
          entry.finishedAt = this.now();
        }
      }
      operation.status = "needs_attention";
      operation.failure = {
        code: "interrupted",
        step,
        detail:
          "The mounter stopped while the operation ran. Check the shares listed here against the compose override.",
      };
      operation.finishedAt = this.now();
      await this.deps.store.save();
      this.deps.logger.warn(`Operation ${operation.id} was interrupted by a restart.`);
    }
  }

  /** Resolves when the operation that runs (if any) has finished. */
  async whenIdle(): Promise<void> {
    await this.task;
  }

  get isBusy(): boolean {
    return this.busy;
  }

  current(): Operation | null {
    return this.deps.store.current();
  }

  history(): Operation[] {
    return this.deps.store.history();
  }

  /** The shares the override lists; empty when it cannot be read (the capabilities say why). */
  async mounts(): Promise<MountView[]> {
    try {
      const mounts = managedMountsOf(await this.deps.ops.readOverride());
      return mounts.map((mount) => ({
        mount,
        path: mountPathOf(mount.name),
        volume: volumeKeyOf(mount),
      }));
    } catch {
      return [];
    }
  }

  async capabilities(refresh = false): Promise<MounterCapabilities> {
    const nowMs = this.deps.clock.now().getTime();
    if (
      !refresh &&
      this.capabilitiesCache &&
      nowMs - this.capabilitiesCache.at < this.capabilitiesTtlMs
    ) {
      return this.capabilitiesCache.value;
    }
    const { ops, redactor } = this.deps;
    const blockers: MounterBlocker[] = [];
    const block = (code: MounterBlocker["code"], detail: string) =>
      blockers.push({ code, detail: redactor.oneLine(detail, 500) });
    try {
      await ops.ping();
      const readiness = await ops.readiness();
      if (!readiness.ready) {
        block("docker_cli_missing", readiness.detail ?? "Docker commands cannot run yet.");
      }
    } catch (error) {
      block("docker_unreachable", detailOf(error));
    }
    const composeFile = await ops.composeFile().catch(() => null);
    if (composeFile === null) {
      block("compose_missing", "No docker-compose.yml or compose.yaml in the project directory.");
    }
    if (await ops.composeFileVariableSet().catch(() => false)) {
      block(
        "compose_file_variable",
        "COMPOSE_FILE is set in .env; Compose would not read the override file on its own.",
      );
    }
    const overrideFile = await ops.overrideFile().catch(() => "docker-compose.override.yml");
    try {
      managedMountsOf(await ops.readOverride());
    } catch (error) {
      block("override_invalid", detailOf(error));
    }
    const value: MounterCapabilities = {
      ready: blockers.length === 0,
      blockers,
      runner: ops.runnerKind,
      composeFile,
      overrideFile,
      protocols: [...MOUNT_PROTOCOLS],
      checkedAt: this.now(),
    };
    this.capabilitiesCache = { at: nowMs, value };
    return value;
  }

  /** Add a share. Resolves with the operation once it has started; it runs in the background. */
  async add(mount: MountSpec, actor: UpdateActor): Promise<Operation> {
    return await this.start("add", mount.name, actor, (current, text) => {
      if (current.some((entry) => entry.name === mount.name)) {
        throw new MountEngineError("exists", `A share named ${mount.name} exists already.`);
      }
      if (current.length >= MAX_MOUNTS) {
        throw new MountEngineError("limit", `At most ${MAX_MOUNTS} shares can be added.`);
      }
      const conflicts = conflictsOf(text, mount);
      if (conflicts.length > 0) {
        throw new MountEngineError(
          "conflict",
          `The compose override already mounts something at ${mountPathOf(mount.name)} (${conflicts.join(", ")}).`,
        );
      }
      return { next: [...current, mount], mount };
    });
  }

  /** Remove a share (the data on the server stays where it is). */
  async remove(name: string, actor: UpdateActor): Promise<Operation> {
    return await this.start("remove", name, actor, (current) => {
      if (!current.some((entry) => entry.name === name)) {
        throw new MountEngineError("not_found", `There is no share named ${name}.`);
      }
      return { next: current.filter((entry) => entry.name !== name), mount: null };
    });
  }

  /** Test a share's settings without changing anything. */
  async test(target: { mount: MountSpec } | { name: string }): Promise<TestResult> {
    let spec: MountSpec;
    if ("mount" in target) {
      spec = target.mount;
    } else {
      const found = (await this.mounts()).find((entry) => entry.mount.name === target.name);
      if (!found) {
        throw new MountEngineError("not_found", `There is no share named ${target.name}.`);
      }
      spec = found.mount;
    }
    const started = this.deps.clock.now().getTime();
    const outcome = await this.deps.ops.probe(spec, this.deps.probeTimeoutMs);
    return {
      ok: outcome.ok,
      code: outcome.code,
      detail: outcome.detail,
      wrote: outcome.ok && outcome.wrote,
      durationMs: Math.max(0, this.deps.clock.now().getTime() - started),
    };
  }

  // -- Running an operation --------------------------------------------------

  private async start(
    kind: OperationKind,
    name: string,
    actor: UpdateActor,
    plan: (
      current: MountSpec[],
      text: string | null,
    ) => { next: MountSpec[]; mount: MountSpec | null },
  ): Promise<Operation> {
    if (this.busy) {
      throw new MountEngineError("busy", "Another change to the shares is running.");
    }
    this.busy = true;
    let started = false;
    try {
      const capabilities = await this.capabilities(true);
      if (!capabilities.ready) {
        throw new MountEngineError(
          "blocked",
          capabilities.blockers.map((blocker) => blocker.detail).join(" "),
        );
      }
      const text = await this.deps.ops.readOverride();
      let current: MountSpec[];
      try {
        current = managedMountsOf(text);
      } catch (error) {
        throw new MountEngineError("blocked", detailOf(error));
      }
      let planned: { next: MountSpec[]; mount: MountSpec | null };
      try {
        planned = plan(current, text);
      } catch (error) {
        if (error instanceof OverrideError) {
          throw new MountEngineError("blocked", error.message);
        }
        throw error;
      }

      const now = this.now();
      const operation: Operation = {
        id: this.newId(),
        kind,
        name,
        mount: planned.mount,
        status: "running",
        steps: MOUNT_STEPS.map((id) => ({
          id,
          status: id === "validate" ? "done" : "pending",
          startedAt: id === "validate" ? now : null,
          finishedAt: id === "validate" ? now : null,
        })),
        failure: null,
        warnings: [],
        requestedBy: actor,
        startedAt: now,
        finishedAt: null,
      };
      await this.deps.store.begin(operation);
      this.deps.logger.info(
        `Operation ${operation.id}: ${kind} share ${name}, requested by ${actor.label}.`,
      );
      started = true;
      this.task = this.execute(operation, text, current, planned.next)
        .catch((error: Error) => {
          this.deps.logger.error(`Operation ${operation.id} ended unexpectedly: ${error.message}`);
        })
        .finally(() => {
          this.busy = false;
          this.capabilitiesCache = null;
        });
      return structuredClone(operation);
    } finally {
      if (!started) {
        this.busy = false;
      }
    }
  }

  private async execute(
    operation: Operation,
    previousText: string | null,
    previousMounts: MountSpec[],
    nextMounts: MountSpec[],
  ): Promise<void> {
    const { ops } = this.deps;
    let written = false;
    let applied = false;
    try {
      // probe
      if (operation.kind === "add" && operation.mount) {
        await this.beginStep(operation, "probe");
        const outcome = await ops.probe(operation.mount, this.deps.probeTimeoutMs);
        if (!outcome.ok) {
          throw new StepFailure(
            outcome.code ?? "probe.failed",
            "probe",
            outcome.detail ?? "The share could not be used.",
          );
        }
        await this.endStep(operation, "probe", "done");
      } else {
        await this.endStep(operation, "probe", "skipped");
      }

      // write
      await this.beginStep(operation, "write");
      let nextText: string | null;
      try {
        nextText = renderOverride(previousText, nextMounts);
      } catch (error) {
        throw new StepFailure("write.invalid_override", "write", detailOf(error));
      }
      try {
        written = true;
        await ops.writeOverride(nextText);
      } catch (error) {
        throw new StepFailure("write.failed", "write", detailOf(error));
      }
      try {
        await ops.validateConfig();
      } catch (error) {
        throw new StepFailure("write.config_invalid", "write", detailOf(error));
      }
      await this.endStep(operation, "write", "done");

      // apply
      await this.beginStep(operation, "apply");
      applied = true;
      try {
        await ops.composeUp(MOUNT_SERVICES);
      } catch (error) {
        throw new StepFailure("apply.failed", "apply", detailOf(error));
      }
      await this.endStep(operation, "apply", "done");

      // health
      await this.beginStep(operation, "health");
      await this.waitHealthy("health");
      await this.endStep(operation, "health", "done");

      // cleanup
      await this.beginStep(operation, "cleanup");
      operation.warnings.push(...(await this.removeUnreferenced(nextMounts)));
      await this.endStep(operation, "cleanup", "done");

      await this.finish(operation, "succeeded");
    } catch (error) {
      const failure =
        error instanceof StepFailure
          ? error
          : new StepFailure(
              "apply.failed",
              operation.steps.find((step) => step.status === "running")?.id ?? "apply",
              detailOf(error),
            );
      await this.fail(operation, failure, {
        written,
        applied,
        previousText,
        previousMounts,
      });
    }
  }

  private async fail(
    operation: Operation,
    failure: StepFailure,
    rollback: {
      written: boolean;
      applied: boolean;
      previousText: string | null;
      previousMounts: MountSpec[];
    },
  ): Promise<void> {
    const { ops, logger, redactor } = this.deps;
    const detail = redactor.oneLine(failure.detail, 500);
    operation.failure = { code: failure.code, step: failure.step, detail };
    for (const step of operation.steps) {
      if (step.id === failure.step || step.status === "running") {
        step.status = "failed";
        step.finishedAt = this.now();
      }
    }
    logger.warn(`Operation ${operation.id} failed at ${failure.step}: ${failure.code} ${detail}`);
    await this.deps.store.save();

    if (!rollback.written) {
      await this.finish(operation, "failed");
      return;
    }
    let status: OperationStatus = "rolled_back";
    try {
      await ops.writeOverride(rollback.previousText);
      if (rollback.applied) {
        await ops.composeUp(MOUNT_SERVICES);
        await this.waitHealthy("health");
      }
      operation.warnings.push(...(await this.removeUnreferenced(rollback.previousMounts)));
      logger.info(`Operation ${operation.id}: the previous override is back.`);
    } catch (error) {
      status = "needs_attention";
      const message = redactor.oneLine(`Rollback failed: ${detailOf(error)}`, 500);
      operation.warnings.push(message);
      logger.error(`Operation ${operation.id}: ${message}`);
    }
    await this.finish(operation, status);
  }

  /** Remove the managed volumes that none of `mounts` uses. Returns warnings, never throws. */
  private async removeUnreferenced(mounts: readonly MountSpec[]): Promise<string[]> {
    const keep = new Set(mounts.map((mount) => volumeKeyOf(mount)));
    const warnings: string[] = [];
    let volumes: Awaited<ReturnType<MountOps["managedVolumes"]>>;
    try {
      volumes = await this.deps.ops.managedVolumes();
    } catch (error) {
      return [
        this.deps.redactor.oneLine(`Old volumes could not be listed: ${detailOf(error)}`, 500),
      ];
    }
    for (const volume of volumes) {
      if (keep.has(volume.key)) {
        continue;
      }
      try {
        await this.deps.ops.removeVolume(volume.name);
        this.deps.logger.info(`Removed the volume ${volume.name}, which no share uses any more.`);
      } catch (error) {
        warnings.push(
          this.deps.redactor.oneLine(
            `The volume ${volume.name} could not be removed: ${detailOf(error)}`,
            500,
          ),
        );
      }
    }
    return warnings;
  }

  /** Wait until the api is healthy and the worker runs. Throws StepFailure. */
  private async waitHealthy(step: MountStepId): Promise<void> {
    const { ops, clock } = this.deps;
    const deadline = clock.now().getTime() + this.deps.healthTimeoutMs;
    let last = "No service state was read yet.";
    for (;;) {
      let states: ServiceState[] | null = null;
      try {
        states = await ops.servicesState();
      } catch (error) {
        last = detailOf(error);
      }
      if (states) {
        const verdict = healthOf(states);
        if (verdict.state === "healthy") {
          return;
        }
        if (verdict.state === "crashed") {
          throw new StepFailure("health.crashed", step, verdict.detail);
        }
        last = verdict.detail;
      }
      if (clock.now().getTime() >= deadline) {
        throw new StepFailure("health.timeout", step, last);
      }
      await clock.sleep(this.pollIntervalMs);
    }
  }

  private async beginStep(operation: Operation, id: MountStepId): Promise<void> {
    const step = operation.steps.find((entry) => entry.id === id);
    if (step) {
      step.status = "running";
      step.startedAt = this.now();
    }
    await this.deps.store.save();
  }

  private async endStep(
    operation: Operation,
    id: MountStepId,
    status: MountStepStatus,
  ): Promise<void> {
    const step = operation.steps.find((entry) => entry.id === id);
    if (step) {
      step.status = status;
      step.startedAt ??= this.now();
      step.finishedAt = this.now();
    }
    await this.deps.store.save();
  }

  private async finish(operation: Operation, status: OperationStatus): Promise<void> {
    for (const step of operation.steps) {
      if (step.status === "pending") {
        step.status = "skipped";
      }
    }
    operation.status = status;
    operation.finishedAt = this.now();
    await this.deps.store.save();
    this.deps.logger.info(`Operation ${operation.id} finished: ${status}.`);
  }

  private now(): string {
    return this.deps.clock.now().toISOString();
  }
}

/** Whether the api is healthy and the worker runs, from `docker compose ps`. */
export function healthOf(states: readonly ServiceState[]): {
  state: "healthy" | "waiting" | "crashed";
  detail: string;
} {
  const waiting: string[] = [];
  for (const service of MOUNT_SERVICES) {
    const entries = states.filter((entry) => entry.service === service);
    if (entries.length === 0) {
      waiting.push(`${service} has no container yet`);
      continue;
    }
    for (const entry of entries) {
      if (entry.state === "exited" || entry.state === "dead") {
        return {
          state: "crashed",
          detail: `${service} stopped (${entry.state}${entry.exitCode === null ? "" : `, exit code ${entry.exitCode}`}).`,
        };
      }
      if (entry.health === "unhealthy") {
        return { state: "crashed", detail: `${service} reports unhealthy.` };
      }
      if (entry.state !== "running" || (entry.health !== null && entry.health !== "healthy")) {
        waiting.push(`${service} is ${entry.health ?? entry.state}`);
      }
    }
  }
  return waiting.length === 0
    ? { state: "healthy", detail: "" }
    : { state: "waiting", detail: `${waiting.join("; ")}.` };
}
