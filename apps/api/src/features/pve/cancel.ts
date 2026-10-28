import type { Database } from "@restow/db";
import { pveGuests, pveJobs, pveNodes, pveRuns, pveTasks } from "@restow/db";
import { and, eq, inArray, isNull, or, type SQL, sql } from "drizzle-orm";
import { type Transaction, withTenantTx } from "../../lib/tenant-context.js";
import { ProblemError } from "../../problem.js";
import { auditPve, PVE_AUDIT_ACTIONS, type PveActor } from "./audit.js";

/**
 * Stopping backups of Proxmox VE guests from the UI (0.4.2, docs/PVE.md "Stopping a backup"):
 *
 *   queued   a `pending` backup task is withdrawn at once (`cancelled`, the node never sees it);
 *            a `delivered` one the node has not started gets a cancel request: the node drops
 *            it (restow-pve from 0.4.2), and opening a run for it is refused in any case.
 *   running  the run gets a cancel request ("Cancelling" in the UI). The node learns it with its
 *            next heartbeat (`cancel.runs`) and stops the vzdump task through the PVE API; the
 *            server refuses the run's uploads from now on, so a node without cancel orders ends
 *            the backup at its next call. The run then ends `cancelled`, not `failed`.
 *
 * A node's queue can also be paused (no backup task is handed out until it is resumed), and every
 * queued backup of a node or of the tenant withdrawn at once. Everything is audited; who asked is
 * kept with the task and the run ("Cancelled by ...").
 */

export const PVE_CANCEL_PROBLEM = "urn:restow:problem:pve-nothing-to-cancel";

/** Cancel orders handed to a node with one heartbeat at most. */
const MAX_ORDERS = 64;

export interface CancelOrders {
  /** Delivered tasks the node is not to start (or to stop, when it runs one). */
  tasks: string[];
  /** Running backup runs the node is to stop, with the VMID it backs up. */
  runs: { id: string; vmid: number; taskId: string | null }[];
}

/** What the node is to stop: delivered tasks and running backups with a cancel request. */
export async function cancelOrders(tx: Transaction, nodeId: string): Promise<CancelOrders> {
  const tasks = await tx
    .select({ id: pveTasks.id })
    .from(pveTasks)
    .where(
      and(
        eq(pveTasks.nodeId, nodeId),
        eq(pveTasks.status, "delivered"),
        sql`${pveTasks.cancelRequestedAt} IS NOT NULL`,
      ),
    )
    .limit(MAX_ORDERS);
  const runs = await tx
    .select({ id: pveRuns.id, vmid: pveGuests.vmid, taskId: pveRuns.taskId })
    .from(pveRuns)
    .innerJoin(pveGuests, eq(pveGuests.id, pveRuns.guestId))
    .where(
      and(
        eq(pveRuns.nodeId, nodeId),
        eq(pveRuns.status, "running"),
        sql`${pveRuns.cancelRequestedAt} IS NOT NULL`,
      ),
    )
    .limit(MAX_ORDERS);
  return { tasks: tasks.map((t) => t.id), runs };
}

/** The end status of a task closed by SQL: `cancelled` after a cancel request, else `failed`. */
export function taskCancelledOrFailed(): SQL<"failed" | "cancelled"> {
  return sql<
    "failed" | "cancelled"
  >`CASE WHEN ${pveTasks.cancelRequestedAt} IS NOT NULL THEN 'cancelled' ELSE 'failed' END`;
}

export interface CancelResult {
  /** Queued backups withdrawn (they will not start). */
  withdrawn: number;
  /** Running backups (or delivered ones the node may be starting) asked to stop. */
  stopping: number;
}

type Scope = { guestId: string } | { guestIds: string[] } | { nodeId: string } | { tenant: true };

function scopeOfTasks(scope: Scope): SQL | undefined {
  if ("guestId" in scope) {
    return eq(pveTasks.guestId, scope.guestId);
  }
  if ("guestIds" in scope) {
    return inArray(pveTasks.guestId, scope.guestIds);
  }
  if ("nodeId" in scope) {
    return eq(pveTasks.nodeId, scope.nodeId);
  }
  return undefined;
}

/**
 * Withdraw the queued backups in `scope`: `pending` ones end `cancelled` with a cancelled run in
 * History, `delivered` ones without a running run get a cancel request. Set-based: one statement
 * each, whatever the number of guests.
 */
export async function withdrawQueued(
  tx: Transaction,
  tenantId: string,
  scope: Scope,
  actor: PveActor,
  now: Date,
): Promise<CancelResult> {
  const message = `Cancelled by ${actor.label} before it started.`;
  const withdrawn = await tx
    .update(pveTasks)
    .set({
      status: "cancelled",
      finishedAt: now,
      cancelRequestedAt: now,
      cancelledBy: actor.label,
      errorMessage: message,
    })
    .where(
      and(
        eq(pveTasks.tenantId, tenantId),
        eq(pveTasks.kind, "backup"),
        eq(pveTasks.status, "pending"),
        scopeOfTasks(scope),
      ),
    )
    .returning({ id: pveTasks.id });
  if (withdrawn.length > 0) {
    // History shows the withdrawn backup: one cancelled run per task, in one statement.
    await tx.execute(sql`
      INSERT INTO pve_runs (tenant_id, cluster_id, node_id, guest_id, kind, origin, status,
        task_id, error_message, started_at, finished_at, cancel_requested_at, cancelled_by)
      SELECT t.tenant_id, g.cluster_id, t.node_id, g.id, 'backup', 'restow', 'cancelled',
        t.id, ${message}, t.created_at, ${now}, ${now}, ${actor.label}
      FROM pve_tasks t JOIN pve_guests g ON g.id = t.guest_id
      WHERE t.id IN (${sql.join(
        withdrawn.map((t) => sql`${t.id}::uuid`),
        sql`, `,
      )})`);
  }
  const requested = await tx
    .update(pveTasks)
    .set({ cancelRequestedAt: now, cancelledBy: actor.label })
    .where(
      and(
        eq(pveTasks.tenantId, tenantId),
        eq(pveTasks.kind, "backup"),
        eq(pveTasks.status, "delivered"),
        isNull(pveTasks.cancelRequestedAt),
        scopeOfTasks(scope),
        sql`NOT EXISTS (SELECT 1 FROM pve_runs r WHERE r.task_id = ${pveTasks.id} AND r.status = 'running')`,
      ),
    )
    .returning({ id: pveTasks.id });
  return { withdrawn: withdrawn.length, stopping: requested.length };
}

/** Ask the running backups of guests to stop (and their tasks with them). */
async function stopRunning(
  tx: Transaction,
  guestIds: readonly string[],
  actor: PveActor,
  now: Date,
): Promise<number> {
  if (guestIds.length === 0) {
    return 0;
  }
  // Asking again keeps the first request (and who made it).
  const runs = await tx
    .update(pveRuns)
    .set({
      cancelRequestedAt: sql`coalesce(${pveRuns.cancelRequestedAt}, ${now})`,
      cancelledBy: sql`coalesce(${pveRuns.cancelledBy}, ${actor.label})`,
    })
    .where(
      and(
        inArray(pveRuns.guestId, [...guestIds]),
        eq(pveRuns.kind, "backup"),
        eq(pveRuns.status, "running"),
      ),
    )
    .returning({ id: pveRuns.id, taskId: pveRuns.taskId });
  const taskIds = runs.flatMap((r) => (r.taskId ? [r.taskId] : []));
  if (taskIds.length > 0) {
    await tx
      .update(pveTasks)
      .set({ cancelRequestedAt: now, cancelledBy: actor.label })
      .where(
        and(
          inArray(pveTasks.id, taskIds),
          inArray(pveTasks.status, ["pending", "delivered"]),
          isNull(pveTasks.cancelRequestedAt),
        ),
      );
  }
  return runs.length;
}

function nothingToCancel(detail: string): ProblemError {
  return new ProblemError(409, "Nothing to cancel", { type: PVE_CANCEL_PROBLEM, detail });
}

/** POST /pve/guests/:id/cancel: stop the guest's running backup and withdraw its queued ones. */
export async function cancelGuestBackup(
  database: Database,
  tenantId: string,
  guestId: string,
  actor: PveActor,
  now: Date = new Date(),
): Promise<CancelResult> {
  return withTenantTx(database, tenantId, async (tx) => {
    const [guest] = await tx.select().from(pveGuests).where(eq(pveGuests.id, guestId)).limit(1);
    if (!guest) {
      throw new ProblemError(404, "Guest not found");
    }
    const queued = await withdrawQueued(tx, tenantId, { guestId }, actor, now);
    const running = await stopRunning(tx, [guestId], actor, now);
    const result = { withdrawn: queued.withdrawn, stopping: queued.stopping + running };
    if (result.withdrawn + result.stopping === 0) {
      throw nothingToCancel("No backup of this guest is queued or running.");
    }
    await auditPve(tx, {
      tenantId,
      actor,
      action: PVE_AUDIT_ACTIONS.backupCancelled,
      target: guestId,
      targetType: "pve_guest",
      details: { vmid: guest.vmid, node: guest.node, ...result },
    });
    return result;
  });
}

/**
 * POST /pve/jobs/:id/cancel (0.4.5): "Stop" of a job, every queued and running backup of the
 * guests it covers (its members; for an "all" job also every guest in no job). Set-based like
 * the rest: a handful of statements whatever the number of guests.
 */
export async function cancelPveJob(
  database: Database,
  tenantId: string,
  jobId: string,
  actor: PveActor,
  now: Date = new Date(),
): Promise<CancelResult> {
  return withTenantTx(database, tenantId, async (tx) => {
    const [job] = await tx.select().from(pveJobs).where(eq(pveJobs.id, jobId)).limit(1);
    if (!job) {
      throw new ProblemError(404, "Job not found");
    }
    const guests = await tx
      .select({ id: pveGuests.id })
      .from(pveGuests)
      .where(
        job.scopeAll
          ? or(eq(pveGuests.jobId, jobId), isNull(pveGuests.jobId))
          : eq(pveGuests.jobId, jobId),
      );
    const guestIds = guests.map((guest) => guest.id);
    const queued =
      guestIds.length > 0
        ? await withdrawQueued(tx, tenantId, { guestIds }, actor, now)
        : { withdrawn: 0, stopping: 0 };
    const running = await stopRunning(tx, guestIds, actor, now);
    const result = { withdrawn: queued.withdrawn, stopping: queued.stopping + running };
    if (result.withdrawn + result.stopping === 0) {
      throw nothingToCancel("No backup of this job is queued or running.");
    }
    await auditPve(tx, {
      tenantId,
      actor,
      action: PVE_AUDIT_ACTIONS.jobCancelled,
      target: jobId,
      targetType: "pve_job",
      details: { name: job.name, ...result },
    });
    return result;
  });
}

/** POST /pve/nodes/:id/queue/cancel (or /pve/queue/cancel): withdraw every queued backup. */
export async function cancelQueuedBackups(
  database: Database,
  tenantId: string,
  nodeId: string | null,
  actor: PveActor,
  now: Date = new Date(),
): Promise<CancelResult> {
  return withTenantTx(database, tenantId, async (tx) => {
    const node = nodeId ? await loadNode(tx, nodeId) : null;
    const result = await withdrawQueued(
      tx,
      tenantId,
      node ? { nodeId: node.id } : { tenant: true },
      actor,
      now,
    );
    await auditPve(tx, {
      tenantId,
      actor,
      action: PVE_AUDIT_ACTIONS.queueCancelled,
      target: node?.id ?? tenantId,
      targetType: node ? "pve_node" : "tenant",
      details: { node: node?.name ?? null, ...result },
    });
    return result;
  });
}

async function loadNode(tx: Transaction, nodeId: string) {
  const [node] = await tx
    .select()
    .from(pveNodes)
    .where(and(eq(pveNodes.id, nodeId), isNull(pveNodes.revokedAt)))
    .limit(1);
  if (!node) {
    throw new ProblemError(404, "Node not found");
  }
  return node;
}

/** POST /pve/nodes/:id/queue/pause and /resume: no backup task is handed out while paused. */
export async function setNodeQueuePaused(
  database: Database,
  tenantId: string,
  nodeId: string,
  paused: boolean,
  actor: PveActor,
  now: Date = new Date(),
): Promise<{ queuePausedAt: string | null; queuePausedBy: string | null }> {
  return withTenantTx(database, tenantId, async (tx) => {
    const node = await loadNode(tx, nodeId);
    const [updated] = await tx
      .update(pveNodes)
      .set(
        paused
          ? { queuePausedAt: node.queuePausedAt ?? now, queuePausedBy: actor.label }
          : { queuePausedAt: null, queuePausedBy: null },
      )
      .where(eq(pveNodes.id, nodeId))
      .returning();
    await auditPve(tx, {
      tenantId,
      actor,
      action: paused ? PVE_AUDIT_ACTIONS.queuePaused : PVE_AUDIT_ACTIONS.queueResumed,
      target: nodeId,
      targetType: "pve_node",
      details: { node: node.name },
    });
    return {
      queuePausedAt: updated?.queuePausedAt?.toISOString() ?? null,
      queuePausedBy: updated?.queuePausedBy ?? null,
    };
  });
}

/**
 * POST /pve/nodes/:id/update: the node installs the offered release with its next heartbeat
 * once it is idle (docs/PVE.md "Updates"). Nothing happens on a node that runs it already.
 */
export async function requestNodeUpdate(
  database: Database,
  tenantId: string,
  nodeId: string,
  actor: PveActor,
  now: Date = new Date(),
): Promise<{ updateRequestedAt: string }> {
  return withTenantTx(database, tenantId, async (tx) => {
    const node = await loadNode(tx, nodeId);
    await tx.update(pveNodes).set({ updateRequestedAt: now }).where(eq(pveNodes.id, nodeId));
    await auditPve(tx, {
      tenantId,
      actor,
      action: PVE_AUDIT_ACTIONS.updateRequested,
      target: nodeId,
      targetType: "pve_node",
      details: { node: node.name, helperVersion: node.helperVersion },
    });
    return { updateRequestedAt: now.toISOString() };
  });
}
