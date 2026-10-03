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
  removeRequested: "mount.remove_requested",
  tested: "mount.tested",
} as const;

export const MOUNT_PROBLEMS = {
  unavailable: "urn:restow:problem:mounter-unavailable",
  rejected: "urn:restow:problem:mounter-rejected",
  jobsRunning: "urn:restow:problem:mounts-jobs-running",
  inUse: "urn:restow:problem:mount-in-use",
  demo: "urn:restow:problem:mounts-demo",
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

export interface MountsServiceDeps {
  client: MounterClient;
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
}

export interface AddMountInput {
  mount: MountSpec;
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
    };
  }

  /** The paths of the shares, for the storage form; empty when the mounter is not there. */
  async paths(): Promise<string[]> {
    const view = await this.view();
    return (view.state?.mounts ?? []).map((entry) => entry.path);
  }

  async add(input: AddMountInput, actor: MountsActor): Promise<MountsView> {
    this.refuseDemo();
    await this.refuseWhileBusy();
    await this.ask(() =>
      this.deps.client.add({ mount: input.mount, requestedBy: requestedByOf(actor) }),
    );
    await this.deps.audit({
      tenantId: null,
      actor: actor.email,
      actorUserId: actor.id,
      action: MOUNT_AUDIT_ACTIONS.addRequested,
      target: input.mount.name,
      targetType: "mount",
      ip: actor.ip,
      details: {
        protocol: input.mount.protocol,
        server: input.mount.server,
        export: input.mount.export,
        nfsVersion: input.mount.nfsVersion,
        readOnly: input.mount.readOnly,
        path: mountPathOf(input.mount.name),
      },
    });
    return await this.view();
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
    if (work.jobs > 0 || work.endpointRuns > 0) {
      throw new ProblemError(409, "Backups or restores are running", {
        type: MOUNT_PROBLEMS.jobsRunning,
        detail:
          "Adding or removing a share restarts the api and the worker. Wait until the running jobs have finished.",
        extensions: { jobs: work.jobs, endpointRuns: work.endpointRuns },
      });
    }
  }

  /** Call the mounter, turning its refusals into problem responses. */
  private async ask<T>(call: () => Promise<T>): Promise<T> {
    try {
      return await call();
    } catch (error) {
      if (error instanceof MounterUnavailableError) {
        throw new ProblemError(503, "The mounter is not running", {
          type: MOUNT_PROBLEMS.unavailable,
          detail: `Start it with: ${ENABLE_MOUNTER_COMMAND}`,
          extensions: { reason: error.reason, command: ENABLE_MOUNTER_COMMAND },
        });
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

/** Whether `path` is the share's path or lies below it (segment-wise). */
export function liesOn(path: string, mountPath: string): boolean {
  const normalized = path.replace(/\/+$/, "");
  return normalized === mountPath || normalized.startsWith(`${mountPath}/`);
}
