import type { AuditEvent } from "@restow/core";
import {
  MOUNT_ROOT,
  type MountSpec,
  type MounterState,
  type TestResult,
  mountPathOf,
} from "../../mounter/protocol.js";
import { ProblemError } from "../../problem.js";
import {
  type MounterClient,
  type MounterFailure,
  MounterRejectedError,
  MounterUnavailableError,
} from "./mounter-client.js";

/**
 * Installation > Mounts (docs/MOUNTS.md): NFS shares the opt-in mounter adds to the
 * compose project. The api checks what only it can know before it asks the mounter:
 *
 *   - nothing that writes to or reads from storage is running (adding or removing a
 *     share recreates the api and the worker, which would cut it off);
 *   - no storage target, and not the installation default, uses a share that is to be
 *     removed (its data would vanish from under the tenants).
 *
 * Every change and every test is written to the installation's audit chain. The
 * outcome of an operation is the mounter's to report (the operation log in the view).
 */

export const MOUNT_AUDIT_ACTIONS = {
  addRequested: "mount.add_requested",
  /** An add that waits until no job runs ("apply when idle"). */
  addQueued: "mount.add_queued",
  /** The owner withdrew an add that waited. */
  addQueueCancelled: "mount.add_queue_cancelled",
  removeRequested: "mount.remove_requested",
  tested: "mount.tested",
} as const;

export const MOUNT_PROBLEMS = {
  unavailable: "urn:restow:problem:mounter-unavailable",
  rejected: "urn:restow:problem:mounter-rejected",
  jobsRunning: "urn:restow:problem:mounts-jobs-running",
  inUse: "urn:restow:problem:mount-in-use",
  demo: "urn:restow:problem:mounts-demo",
  /** Another share already waits for the running jobs to finish. */
  pendingExists: "urn:restow:problem:mount-pending-exists",
  /** No waiting request of that name. */
  pendingNotFound: "urn:restow:problem:mount-pending-not-found",
} as const;

/** What the Mounts section shows how to start the mounter with. */
export const ENABLE_MOUNTER_COMMAND = "docker compose --profile mounts up -d mounter";

export interface MountsActor {
  id: string | null;
  email: string;
  ip: string | null;
}

/** A storage location that lies on a share. */
export interface MountUser {
  kind: "target" | "installation_default";
  tenantId: string | null;
  tenantName: string | null;
  name: string | null;
  path: string;
}

export interface ActiveWork {
  /** Jobs that are running (backup, restore, verify, archive, ...). */
  jobs: number;
  /** Endpoint backups and restores reporting as running. */
  endpointRuns: number;
}

/**
 * An add that waits until no job runs ("apply when idle", docs/MOUNTS.md): the owner asked
 * for it while backups or restores ran, so instead of refusing, the api keeps the request
 * and starts it as soon as nothing runs ({@link MountsService.applyPending}). At most one
 * waits at a time. `failure` is set when the mounter refused it once it was its turn; the
 * request then waits for nothing more and stays only so the owner sees why (and dismisses it).
 */
export interface PendingMount {
  mount: MountSpec;
  requestedBy: { userId: string | null; label: string; ip: string | null };
  requestedAt: string;
  failure: { code: string | null; detail: string | null } | null;
}

/** Where the waiting request is kept, so an api restart does not lose it (pending.ts). */
export interface PendingMountStore {
  load(): Promise<PendingMount | null>;
  save(pending: PendingMount): Promise<void>;
  clear(): Promise<void>;
}

/** What one pass of {@link MountsService.applyPending} did. */
export type PendingOutcome = "none" | "waiting" | "applied" | "failed";

export interface MountsServiceDeps {
  client: MounterClient;
  /** Keeps an add that waits for running jobs; without it such an add is refused. */
  pending?: PendingMountStore;
  now?: () => Date;
  /** What runs right now that the recreate would cut off. */
  activeWork: () => Promise<ActiveWork>;
  /** Storage locations at or below `path`. */
  usersOf: (path: string) => Promise<MountUser[]>;
  audit: (event: AuditEvent) => Promise<void>;
  demo?: boolean;
}

export interface MountsView {
  /** The mounter answered. */
  available: boolean;
  /** Why it did not; null when it did. */
  unavailableReason: MounterFailure | null;
  demo: boolean;
  enableCommand: string;
  mountRoot: string;
  state: MounterState | null;
  /** An add that waits until no job runs, or one that failed when it was its turn. */
  pending: PendingMount | null;
}

export interface AddMountInput {
  mount: MountSpec;
  /** While jobs run: keep the request and apply it once they have finished, instead of refusing. */
  whenIdle?: boolean;
}

export class MountsService {
  constructor(private readonly deps: MountsServiceDeps) {}

  async view(options: { refresh?: boolean } = {}): Promise<MountsView> {
    const state = this.deps.demo ? null : await this.deps.client.state(options);
    return {
      available: state !== null,
      unavailableReason: state ? null : this.deps.demo ? "disabled" : this.deps.client.failure(),
      demo: this.deps.demo === true,
      enableCommand: ENABLE_MOUNTER_COMMAND,
      mountRoot: MOUNT_ROOT,
      state,
      pending: await this.loadPending(),
    };
  }

  /** The paths of the shares, for the storage form; empty when the mounter is not there. */
  async paths(): Promise<string[]> {
    const view = await this.view();
    return (view.state?.mounts ?? []).map((entry) => entry.path);
  }

  async add(input: AddMountInput, actor: MountsActor): Promise<MountsView> {
    this.refuseDemo();
    const work = await this.deps.activeWork();
    if (isBusy(work)) {
      if (input.whenIdle && this.deps.pending) {
        return await this.queue(input.mount, actor);
      }
      throw jobsRunningProblem(work);
    }
    await this.ask(() =>
      this.deps.client.add({ mount: input.mount, requestedBy: requestedByOf(actor) }),
    );
    // A request of the same share that waited is now moot.
    const waiting = await this.loadPending();
    if (waiting && waiting.mount.name === input.mount.name) {
      await this.deps.pending?.clear();
    }
    await this.auditAdd(input.mount, requestedByOf(actor), false);
    return await this.view();
  }

  /** Withdraw the waiting add of `name` (or dismiss its failure). */
  async cancelPending(name: string, actor: MountsActor): Promise<MountsView> {
    this.refuseDemo();
    const waiting = await this.loadPending();
    if (!waiting || waiting.mount.name !== name) {
      throw new ProblemError(404, "No waiting request for this share", {
        type: MOUNT_PROBLEMS.pendingNotFound,
      });
    }
    await this.deps.pending?.clear();
    await this.deps.audit({
      tenantId: null,
      actor: actor.email,
      actorUserId: actor.id,
      action: MOUNT_AUDIT_ACTIONS.addQueueCancelled,
      target: name,
      targetType: "mount",
      ip: actor.ip,
      details: { path: mountPathOf(name), failed: waiting.failure !== null },
    });
    return await this.view();
  }

  /**
   * One pass of "apply when idle": start the waiting add once no job runs, the mounter
   * answers, is ready and runs no other change. Called on a timer (pending.ts); it never
   * throws. The request is removed before the mounter is asked, so that the restart the
   * add causes cannot start it twice; it is put back when the mounter could not be reached.
   */
  async applyPending(): Promise<PendingOutcome> {
    const store = this.deps.pending;
    if (!store || this.deps.demo) {
      return "none";
    }
    const waiting = await store.load();
    if (!waiting || waiting.failure) {
      return "none";
    }
    if (isBusy(await this.deps.activeWork())) {
      return "waiting";
    }
    const state = await this.deps.client.state({ refresh: true });
    if (!state || state.operation?.status === "running" || !state.capabilities.ready) {
      return "waiting";
    }
    const existing = state.mounts.find((entry) => entry.mount.name === waiting.mount.name);
    if (existing) {
      if (
        existing.mount.server === waiting.mount.server &&
        existing.mount.export === waiting.mount.export
      ) {
        // Applied already (the api restarted before it could note that).
        await store.clear();
        return "applied";
      }
      await store.save({
        ...waiting,
        failure: { code: "exists", detail: `${mountPathOf(waiting.mount.name)} is in use` },
      });
      return "failed";
    }
    await store.clear();
    try {
      await this.deps.client.add({ mount: waiting.mount, requestedBy: waiting.requestedBy });
    } catch (error) {
      if (
        error instanceof MounterUnavailableError ||
        (error instanceof MounterRejectedError &&
          (error.code === "busy" || error.code === "blocked"))
      ) {
        await store.save(waiting);
        return "waiting";
      }
      const rejected = error instanceof MounterRejectedError ? error : null;
      await store.save({
        ...waiting,
        failure: {
          code: rejected?.code ?? null,
          detail: rejected?.detail ?? (error instanceof Error ? error.message.slice(0, 600) : null),
        },
      });
      return "failed";
    }
    await this.auditAdd(waiting.mount, waiting.requestedBy, true);
    return "applied";
  }

  async remove(name: string, actor: MountsActor): Promise<MountsView> {
    this.refuseDemo();
    await this.refuseWhileBusy();
    const users = await this.deps.usersOf(mountPathOf(name));
    if (users.length > 0) {
      throw new ProblemError(409, "The share is in use", {
        type: MOUNT_PROBLEMS.inUse,
        detail: `${users.length} storage location(s) lie on ${mountPathOf(name)}. Move or remove them first.`,
        extensions: { users },
      });
    }
    await this.ask(() => this.deps.client.remove(name, { requestedBy: requestedByOf(actor) }));
    await this.deps.audit({
      tenantId: null,
      actor: actor.email,
      actorUserId: actor.id,
      action: MOUNT_AUDIT_ACTIONS.removeRequested,
      target: name,
      targetType: "mount",
      ip: actor.ip,
      details: { path: mountPathOf(name) },
    });
    return await this.view();
  }

  async test(
    target: { mount: MountSpec } | { name: string },
    actor: MountsActor,
  ): Promise<TestResult> {
    this.refuseDemo();
    const result = await this.ask(() => this.deps.client.test(target));
    const name = "mount" in target ? target.mount.name : target.name;
    await this.deps.audit({
      tenantId: null,
      actor: actor.email,
      actorUserId: actor.id,
      action: MOUNT_AUDIT_ACTIONS.tested,
      target: name,
      targetType: "mount",
      ip: actor.ip,
      details: {
        ok: result.ok,
        code: result.code,
        ...("mount" in target
          ? { server: target.mount.server, export: target.mount.export }
          : { configured: true }),
      },
    });
    return result;
  }

  private refuseDemo(): void {
    if (this.deps.demo) {
      throw new ProblemError(403, "Not available in the demo", { type: MOUNT_PROBLEMS.demo });
    }
  }

  private async refuseWhileBusy(): Promise<void> {
    const work = await this.deps.activeWork();
    if (isBusy(work)) {
      throw jobsRunningProblem(work);
    }
  }

  private async loadPending(): Promise<PendingMount | null> {
    if (!this.deps.pending || this.deps.demo) {
      return null;
    }
    return await this.deps.pending.load();
  }

  /** Keep an add until no job runs (the request was checked by the route already). */
  private async queue(mount: MountSpec, actor: MountsActor): Promise<MountsView> {
    const store = this.deps.pending as PendingMountStore;
    const waiting = await store.load();
    if (waiting && !waiting.failure && waiting.mount.name !== mount.name) {
      throw new ProblemError(409, "Another network share waits already", {
        type: MOUNT_PROBLEMS.pendingExists,
        detail: `The share ${waiting.mount.name} waits for the running jobs. Cancel it first.`,
        extensions: { name: waiting.mount.name },
      });
    }
    // Refuse early what the mounter would refuse once it is its turn.
    const state = await this.deps.client.state();
    if (!state) {
      throw unavailableProblem(this.deps.client.failure() ?? "unreachable");
    }
    if (state.mounts.some((entry) => entry.mount.name === mount.name)) {
      throw new ProblemError(409, "The mounter refused the change", {
        type: MOUNT_PROBLEMS.rejected,
        detail: `A share named ${mount.name} exists already.`,
        extensions: { code: "exists" },
      });
    }
    const requestedBy = requestedByOf(actor);
    await store.save({
      mount,
      requestedBy,
      requestedAt: (this.deps.now?.() ?? new Date()).toISOString(),
      failure: null,
    });
    await this.deps.audit({
      tenantId: null,
      actor: actor.email,
      actorUserId: actor.id,
      action: MOUNT_AUDIT_ACTIONS.addQueued,
      target: mount.name,
      targetType: "mount",
      ip: actor.ip,
      details: { ...mountDetails(mount) },
    });
    return await this.view();
  }

  private async auditAdd(
    mount: MountSpec,
    requestedBy: PendingMount["requestedBy"],
    queued: boolean,
  ): Promise<void> {
    await this.deps.audit({
      tenantId: null,
      actor: requestedBy.label,
      actorUserId: requestedBy.userId,
      action: MOUNT_AUDIT_ACTIONS.addRequested,
      target: mount.name,
      targetType: "mount",
      ip: requestedBy.ip,
      details: { ...mountDetails(mount), ...(queued ? { queued: true } : {}) },
    });
  }

  /** Call the mounter, turning its refusals into problem responses. */
  private async ask<T>(call: () => Promise<T>): Promise<T> {
    try {
      return await call();
    } catch (error) {
      if (error instanceof MounterUnavailableError) {
        throw unavailableProblem(error.reason);
      }
      if (error instanceof MounterRejectedError) {
        const status = error.status === 404 ? 404 : error.status === 422 ? 422 : 409;
        throw new ProblemError(status, "The mounter refused the change", {
          type: MOUNT_PROBLEMS.rejected,
          detail: error.detail ?? undefined,
          extensions: { code: error.code },
        });
      }
      throw error;
    }
  }
}

function requestedByOf(actor: MountsActor) {
  return { userId: actor.id, label: actor.email, ip: actor.ip };
}

function unavailableProblem(reason: MounterFailure): ProblemError {
  return new ProblemError(503, "The mounter is not running", {
    type: MOUNT_PROBLEMS.unavailable,
    detail: `Start it with: ${ENABLE_MOUNTER_COMMAND}`,
    extensions: { reason, command: ENABLE_MOUNTER_COMMAND },
  });
}

function isBusy(work: ActiveWork): boolean {
  return work.jobs > 0 || work.endpointRuns > 0;
}

function jobsRunningProblem(work: ActiveWork): ProblemError {
  return new ProblemError(409, "Backups or restores are running", {
    type: MOUNT_PROBLEMS.jobsRunning,
    detail:
      "Adding or removing a share restarts the api and the worker. Wait until the running jobs have finished.",
    extensions: { jobs: work.jobs, endpointRuns: work.endpointRuns },
  });
}

function mountDetails(mount: MountSpec) {
  return {
    protocol: mount.protocol,
    server: mount.server,
    export: mount.export,
    nfsVersion: mount.nfsVersion,
    readOnly: mount.readOnly,
    path: mountPathOf(mount.name),
  };
}

/** Whether `path` is the share's path or lies below it (segment-wise). */
export function liesOn(path: string, mountPath: string): boolean {
  const normalized = path.replace(/\/+$/, "");
  return normalized === mountPath || normalized.startsWith(`${mountPath}/`);
}
