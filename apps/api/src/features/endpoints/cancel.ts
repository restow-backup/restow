import type { Database } from "@restow/db";
import { endpointRuns, endpoints, endpointTasks } from "@restow/db";
import { and, eq, inArray, isNull, sql } from "drizzle-orm";
import { type Transaction, withTenantTx } from "../../lib/tenant-context.js";
import { ProblemError } from "../../problem.js";
import { auditEndpoint, ENDPOINT_AUDIT_ACTIONS, type EndpointActor } from "./audit.js";

/**
 * Stopping a machine's backup from the UI (0.4.2, docs/AGENT.md "Stopping a backup"):
 *
 *   queued   a `pending` "back up now" ends `cancelled` at once; a `delivered` one the agent has
 *            not started gets a cancel request: the agent drops it, and starting a run for it is
 *            refused in any case.
 *   running  the run gets a cancel request ("Cancelling" in the UI). The agent learns it with its
 *            next heartbeat (`cancel.runs`, every minute while it works) and stops restic
 *            gracefully (SIGINT: restic writes no snapshot and leaves no lock behind); the run
 *            then ends `cancelled`, not `failed`, and the machine's last backup stays as it was.
 *
 * Audited; who asked is kept with the run and the task ("Cancelled by ...").
 */

export const ENDPOINT_CANCEL_PROBLEM = "urn:restow:problem:endpoint-nothing-to-cancel";

const MAX_ORDERS = 32;

export interface AgentCancelOrders {
  /** Delivered tasks the agent is not to start (or to stop when it runs one). */
  tasks: string[];
  /** Running runs the agent is to stop. */
  runs: string[];
}

/** What the agent is to stop: delivered tasks and running runs with a cancel request. */
export async function agentCancelOrders(
  tx: Transaction,
  endpointId: string,
): Promise<AgentCancelOrders> {
  const tasks = await tx
    .select({ id: endpointTasks.id })
    .from(endpointTasks)
    .where(
      and(
        eq(endpointTasks.endpointId, endpointId),
        eq(endpointTasks.status, "delivered"),
        sql`${endpointTasks.cancelRequestedAt} IS NOT NULL`,
      ),
    )
    .limit(MAX_ORDERS);
  const runs = await tx
    .select({ id: endpointRuns.id })
    .from(endpointRuns)
    .where(
      and(
        eq(endpointRuns.endpointId, endpointId),
        eq(endpointRuns.status, "running"),
        sql`${endpointRuns.cancelRequestedAt} IS NOT NULL`,
      ),
    )
    .limit(MAX_ORDERS);
  return { tasks: tasks.map((t) => t.id), runs: runs.map((r) => r.id) };
}

export interface EndpointCancelResult {
  withdrawn: number;
  stopping: number;
}

/** POST /endpoints/:id/cancel: stop the machine's running backup, withdraw its queued ones. */
export async function cancelEndpointBackup(
  database: Database,
  tenantId: string,
  endpointId: string,
  actor: EndpointActor,
  now: Date = new Date(),
): Promise<EndpointCancelResult> {
  return withTenantTx(database, tenantId, async (tx) => {
    const [endpoint] = await tx
      .select({ id: endpoints.id, hostname: endpoints.hostname })
      .from(endpoints)
      .where(
        and(
          eq(endpoints.id, endpointId),
          eq(endpoints.tenantId, tenantId),
          isNull(endpoints.removedAt),
        ),
      )
      .limit(1);
    if (!endpoint) {
      throw new ProblemError(404, "Endpoint not found");
    }
    const withdrawn = await tx
      .update(endpointTasks)
      .set({
        status: "cancelled",
        finishedAt: now,
        cancelRequestedAt: now,
        cancelledBy: actor.label,
        errorMessage: `Cancelled by ${actor.label} before it started.`,
      })
      .where(
        and(
          eq(endpointTasks.endpointId, endpointId),
          eq(endpointTasks.kind, "backup_now"),
          eq(endpointTasks.status, "pending"),
        ),
      )
      .returning({ id: endpointTasks.id });
    const delivered = await tx
      .update(endpointTasks)
      .set({ cancelRequestedAt: now, cancelledBy: actor.label })
      .where(
        and(
          eq(endpointTasks.endpointId, endpointId),
          eq(endpointTasks.kind, "backup_now"),
          eq(endpointTasks.status, "delivered"),
          isNull(endpointTasks.cancelRequestedAt),
          sql`NOT EXISTS (SELECT 1 FROM endpoint_runs r WHERE r.task_id = ${endpointTasks.id} AND r.status = 'running')`,
        ),
      )
      .returning({ id: endpointTasks.id });
    // Asking again keeps the first request (and who made it).
    const runs = await tx
      .update(endpointRuns)
      .set({
        cancelRequestedAt: sql`coalesce(${endpointRuns.cancelRequestedAt}, ${now})`,
        cancelledBy: sql`coalesce(${endpointRuns.cancelledBy}, ${actor.label})`,
      })
      .where(
        and(
          eq(endpointRuns.endpointId, endpointId),
          eq(endpointRuns.kind, "backup"),
          eq(endpointRuns.status, "running"),
        ),
      )
      .returning({ id: endpointRuns.id, taskId: endpointRuns.taskId });
    const runTasks = runs.flatMap((r) => (r.taskId ? [r.taskId] : []));
    if (runTasks.length > 0) {
      await tx
        .update(endpointTasks)
        .set({ cancelRequestedAt: now, cancelledBy: actor.label })
        .where(
          and(
            inArray(endpointTasks.id, runTasks),
            inArray(endpointTasks.status, ["pending", "delivered"]),
            isNull(endpointTasks.cancelRequestedAt),
          ),
        );
    }
    const result = { withdrawn: withdrawn.length, stopping: delivered.length + runs.length };
    if (result.withdrawn + result.stopping === 0) {
      throw new ProblemError(409, "Nothing to cancel", {
        type: ENDPOINT_CANCEL_PROBLEM,
        detail: "No backup of this machine is queued or running.",
      });
    }
    await auditEndpoint(tx, {
      tenantId,
      actor,
      action: ENDPOINT_AUDIT_ACTIONS.backupCancelled,
      endpointId,
      details: { hostname: endpoint.hostname, ...result },
    });
    return result;
  });
}

/**
 * POST /endpoints/:id/update: the agent looks for its update with its next heartbeat and installs
 * it once it is idle (docs/AGENT.md "Updates"). An agent with self-update switched off, or with
 * updates paused for the tenant or the machine, is not updated by it.
 */
export async function requestEndpointUpdate(
  database: Database,
  tenantId: string,
  endpointId: string,
  actor: EndpointActor,
  now: Date = new Date(),
): Promise<{ updateRequestedAt: string }> {
  return withTenantTx(database, tenantId, async (tx) => {
    const [endpoint] = await tx
      .update(endpoints)
      .set({ updateRequestedAt: now })
      .where(
        and(
          eq(endpoints.id, endpointId),
          eq(endpoints.tenantId, tenantId),
          eq(endpoints.status, "active"),
        ),
      )
      .returning({ hostname: endpoints.hostname, agentVersion: endpoints.agentVersion });
    if (!endpoint) {
      throw new ProblemError(404, "Endpoint not found");
    }
    await auditEndpoint(tx, {
      tenantId,
      actor,
      action: ENDPOINT_AUDIT_ACTIONS.updateRequested,
      endpointId,
      details: { hostname: endpoint.hostname, agentVersion: endpoint.agentVersion },
    });
    return { updateRequestedAt: now.toISOString() };
  });
}
