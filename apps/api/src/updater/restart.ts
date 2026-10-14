import type { Logger } from "./logger.js";
import { type Clock, type DockerOps, OpsError } from "./ops.js";
import { RESTARTABLE_SERVICES, type RestartableService, type ServiceRestart } from "./protocol.js";

/**
 * Restarting one service when an administrator asks for it (`POST /v1/restart`,
 * docs/UPDATING.md "Restart required"): `docker compose restart <service>` in
 * the project, for one of {@link RESTARTABLE_SERVICES} and nothing else. The
 * application records why a service needs a restart; this only runs the
 * command an administrator would otherwise type, after they clicked for it.
 *
 * The restart runs in the background and the request answers at once: the api
 * that asked may be the service being restarted, and its request would never
 * see the answer. The outcome is kept in memory ({@link ServiceRestarter.view})
 * and the service clears its restart notice itself when it starts again.
 * Refused while an update is announced or running, and while another restart
 * runs, so it never interferes with an update's own stop and start.
 */

/** Refused before anything ran. */
export class RestartRefusedError extends Error {
  constructor(
    readonly code: "busy" | "invalid_request",
    message: string,
  ) {
    super(message);
    this.name = "RestartRefusedError";
  }
}

export interface ServiceRestarterDeps {
  ops: Pick<DockerOps, "composeRestart">;
  /** An update is announced or running: no restart then. */
  updateActive: () => boolean;
  clock: Pick<Clock, "now">;
  logger: Logger;
}

export class ServiceRestarter {
  private last: ServiceRestart | null = null;
  private execution: Promise<void> | null = null;

  constructor(private readonly deps: ServiceRestarterDeps) {}

  /** The services it accepts, as the state view reports them. */
  get services(): readonly RestartableService[] {
    return RESTARTABLE_SERVICES;
  }

  /** The last restart since the updater started; null when there was none. */
  view(): ServiceRestart | null {
    return this.last ? { ...this.last } : null;
  }

  /** Resolves when the restart that runs (if any) has ended. */
  settled(): Promise<void> {
    return this.execution ?? Promise.resolve();
  }

  /**
   * Start restarting `service`; returns the restart as it now stands
   * (`running`). Throws {@link RestartRefusedError} when it does not start.
   */
  start(service: string): ServiceRestart {
    if (!(RESTARTABLE_SERVICES as readonly string[]).includes(service)) {
      throw new RestartRefusedError("invalid_request", "This service cannot be restarted.");
    }
    if (this.execution) {
      throw new RestartRefusedError("busy", "A restart is already running.");
    }
    if (this.deps.updateActive()) {
      throw new RestartRefusedError("busy", "An update is announced or running.");
    }
    const restart: ServiceRestart = {
      service,
      status: "running",
      startedAt: this.deps.clock.now().toISOString(),
      finishedAt: null,
    };
    this.last = restart;
    this.deps.logger.info(`Restarting the ${service} service, as an administrator asked.`);
    this.execution = this.run(restart).finally(() => {
      this.execution = null;
    });
    return { ...restart };
  }

  private async run(restart: ServiceRestart): Promise<void> {
    try {
      await this.deps.ops.composeRestart([restart.service]);
      this.last = {
        ...restart,
        status: "succeeded",
        finishedAt: this.deps.clock.now().toISOString(),
      };
      this.deps.logger.info(`The ${restart.service} service was restarted.`);
    } catch (error) {
      this.last = { ...restart, status: "failed", finishedAt: this.deps.clock.now().toISOString() };
      const detail = error instanceof OpsError && error.detail ? ` ${error.detail}` : "";
      this.deps.logger.error(
        `Restarting the ${restart.service} service failed: ${error instanceof Error ? error.message : String(error)}${detail}`,
      );
    }
  }
}
