import {
  type Database,
  type OpenRestartRequest,
  RESTARTABLE_ROLES,
  type ServiceRole,
  listRestartRequests,
} from "@restow/db";
import { audit } from "../../lib/audit.js";
import { ProblemError } from "../../problem.js";
import {
  RESTARTABLE_SERVICES,
  type RestartableService,
  type ServiceRestart,
  type StateView,
} from "../../updater/protocol.js";
import { type Actor, mapUpdaterError } from "./service.js";
import { type UpdaterClient, UpdaterUnavailableError } from "./updater-client.js";

/**
 * "Restart required" (docs/UPDATING.md): the services the application asked
 * to be restarted (packages/db restart-requests.ts), what the Updates tab and
 * the provider admins' notice show of them, and the "Restart now" button,
 * which asks the opt-in updater to restart exactly that one service. Nothing
 * here restarts anything on its own; without the updater, or when it cannot,
 * the tab shows the command to run instead.
 *
 *   GET  /api/v1/updates/restarts            the open requests and what can be done about them
 *   POST /api/v1/updates/restarts/:service   "Restart now" (owner role)
 */

export const RESTART_AUDIT_ACTIONS = {
  /** An administrator asked the updater to restart a service (`target` names it). */
  requested: "update.restart.requested",
} as const;

export const RESTART_PROBLEMS = {
  /** The service has no open restart request: nothing to restart it for. */
  notRequested: "urn:restow:problem:restart-not-requested",
  /** The updater answers but cannot restart services (it predates the feature). */
  unsupported: "urn:restow:problem:restart-unsupported",
} as const;

/**
 * What the "Restart now" button can do right now:
 *
 *   ready        the updater restarts the service on a click
 *   busy         an update is announced or running, or a restart runs
 *   unsupported  the updater answers but predates restarts: recreate it, or run the command
 *   unavailable  no updater answers: run the command
 *   demo         the demo installation changes nothing
 */
export type RestartAvailability = "ready" | "busy" | "unsupported" | "unavailable" | "demo";

export interface RestartRequestView {
  service: ServiceRole;
  /** A translation key: `updates:restart.reasons.<reason>`. */
  reason: string;
  requestedAt: string;
}

export interface RestartsView {
  requests: RestartRequestView[];
  updater: RestartAvailability;
  /** The last restart the updater ran since it started; null when none (or no updater). */
  lastRestart: ServiceRestart | null;
  /**
   * The project directory on the host, as the updater knows it, for the command to copy;
   * null when no updater tells (the tab then names the usual directory, to be adapted).
   */
  projectDir: string | null;
}

export interface RestartServiceDeps {
  /** The installation pool: `restart_requests` and the installation audit chain. */
  db: Database;
  updater: UpdaterClient;
  demo?: boolean;
}

function availabilityOf(state: StateView | null, demo: boolean): RestartAvailability {
  if (demo) {
    return "demo";
  }
  if (!state) {
    return "unavailable";
  }
  if (!RESTARTABLE_SERVICES.every((service) => state.restartableServices.includes(service))) {
    return "unsupported";
  }
  if (
    state.phase === "scheduled" ||
    state.phase === "running" ||
    state.restart?.status === "running"
  ) {
    return "busy";
  }
  return "ready";
}

function toRequestView(request: OpenRestartRequest): RestartRequestView {
  return {
    service: request.service,
    reason: request.reason,
    requestedAt: request.requestedAt.toISOString(),
  };
}

export class RestartService {
  constructor(private readonly deps: RestartServiceDeps) {}

  private get demo(): boolean {
    return this.deps.demo === true;
  }

  private async updaterState(fresh = false): Promise<StateView | null> {
    if (this.demo || !this.deps.updater.enabled) {
      return null;
    }
    try {
      return await this.deps.updater.state({ fresh });
    } catch {
      // An updater that speaks another protocol cannot be asked either: the command remains.
      return null;
    }
  }

  async view(): Promise<RestartsView> {
    const requests = await listRestartRequests(this.deps.db);
    // Without an open request nobody needs the updater's answer: the notice is not shown.
    const state = requests.length > 0 ? await this.updaterState() : null;
    return {
      requests: requests.map(toRequestView),
      updater: availabilityOf(state, this.demo),
      lastRestart: state?.restart ?? null,
      projectDir: state?.projectDir ?? null,
    };
  }

  /** "Restart now": ask the updater to restart `service`, which must have an open request. */
  async restart(service: string, actor: Actor): Promise<RestartsView> {
    if (!(RESTARTABLE_ROLES as readonly string[]).includes(service)) {
      throw new ProblemError(404, "Unknown service", {
        detail: "Only the api, the worker and the scheduler can be restarted here.",
      });
    }
    const target = service as RestartableService;
    const requests = await listRestartRequests(this.deps.db);
    const open = requests.filter((request) => request.service === target);
    if (open.length === 0) {
      throw new ProblemError(409, "No restart is needed", {
        type: RESTART_PROBLEMS.notRequested,
        detail: "This service has no open restart request.",
      });
    }
    if (this.demo || !this.deps.updater.enabled) {
      throw mapUpdaterError(new UpdaterUnavailableError("disabled"));
    }
    const state = await this.updaterState(true);
    if (!state) {
      throw mapUpdaterError(new UpdaterUnavailableError("unreachable"));
    }
    if (availabilityOf(state, false) === "unsupported") {
      throw new ProblemError(409, "The updater cannot restart services", {
        type: RESTART_PROBLEMS.unsupported,
        detail:
          "This updater predates restarts. Recreate it (`docker compose --profile updater up -d updater`), or run the command shown.",
      });
    }
    try {
      await this.deps.updater.restart(target);
    } catch (error) {
      throw mapUpdaterError(error);
    }
    await audit(this.deps.db, {
      tenantId: null,
      actor: actor.email,
      actorUserId: actor.id,
      action: RESTART_AUDIT_ACTIONS.requested,
      target,
      targetType: "service",
      ip: actor.ip,
      details: { service: target, reasons: open.map((request) => request.reason) },
    });
    return this.view();
  }
}
