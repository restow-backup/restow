import {
  PVE_BOOT_TEST_CAPABILITY,
  pveBootTestPlan,
  pveBootTestTaskParams,
  pveJobOfGuest,
  pveNodeDeclares,
} from "@restow/core";
import {
  type Database,
  type PveBootTestOutcome,
  type PveBootTestResult,
  type PveGuest,
  type PveNode,
  type PveRunStats,
  type PveSnapshot,
  type PveTask,
  pveGuests,
  pveJobs,
  pveNodes,
  pveRuns,
  pveSnapshots,
  pveTasks,
} from "@restow/db";
import { and, eq, inArray, isNull, sql } from "drizzle-orm";
import { z } from "zod";
import { type Transaction, withTenantTx } from "../../lib/tenant-context.js";
import { ProblemError } from "../../problem.js";
import { auditPve, PVE_AUDIT_ACTIONS, type PveActor } from "./audit.js";

/**
 * Boot tests of Proxmox VE restore points (docs/PVE.md, "Boot test"): the guest's node restores
 * a restore point to a temporary guest with its network cut, starts it, waits for the QEMU guest
 * agent and destroys it again (agent/internal/pve/boottest.go). Here: asking for one ("Boot test
 * now"), whether a guest's node can run one, and what the node's result means for the run and
 * the restore point. The worker plans the scheduled ones (apps/worker pve/maintenance.ts) and
 * raises the alerts.
 *
 * A node gets a boot test only when its last heartbeat announced the capability `boot_test`;
 * an older node never sees the task kind.
 */

export const PVE_BOOT_TEST_PROBLEMS = {
  unsupported: "urn:restow:problem:pve-boot-test-unsupported",
} as const;

/** A boot test waits this long for its node (a restore can take a while to come round). */
const BOOT_TEST_TASK_TTL_MS = 24 * 60 * 60 * 1000;

/** Why a guest's restore points cannot be boot-tested now; null: they can. */
export type BootTestBlocker =
  | "no_node"
  | "node_unsupported"
  | "restores_off"
  | "privileged"
  | "template"
  | null;

export function bootTestBlocker(
  guest: Pick<PveGuest, "kind" | "privileged" | "template">,
  node: Pick<PveNode, "facts"> | null,
): BootTestBlocker {
  if (guest.kind === "vm" && guest.template) {
    return "template";
  }
  if (guest.kind === "ct" && guest.privileged) {
    return "privileged";
  }
  if (!node) {
    return "no_node";
  }
  if (!pveNodeDeclares(node.facts, PVE_BOOT_TEST_CAPABILITY)) {
    return "node_unsupported";
  }
  if (node.facts.restoresAllowed === false) {
    return "restores_off";
  }
  return null;
}

/** The node a guest lives on (boot tests run there), or null. */
export async function guestNode(tx: Transaction, guest: PveGuest): Promise<PveNode | null> {
  const [node] = await tx
    .select()
    .from(pveNodes)
    .where(
      and(
        eq(pveNodes.clusterId, guest.clusterId),
        eq(pveNodes.name, guest.node ?? ""),
        isNull(pveNodes.revokedAt),
      ),
    )
    .limit(1);
  return node ?? null;
}

const BLOCKER_DETAIL: Record<Exclude<BootTestBlocker, null>, string> = {
  no_node: "restow-pve is not enrolled on the guest's node.",
  node_unsupported:
    "restow-pve on the guest's node does not run boot tests (update it, or it switched them off with restow-pve config --boot-tests=false).",
  restores_off:
    "Restores are switched off on the guest's node (restow-pve config --allow-restores).",
  privileged: "PVE refuses to restore privileged containers from a backup provider.",
  template: "VM templates are not backed up.",
};

/**
 * Queue a boot test of one restore point on its guest's node. A boot test of the same restore
 * point that still waits or runs is returned instead of a second one.
 */
export async function requestBootTest(
  database: Database,
  tenantId: string,
  snapshotId: string,
  actor: PveActor,
  now: Date = new Date(),
): Promise<{ taskId: string; alreadyQueued: boolean }> {
  return withTenantTx(database, tenantId, async (tx) => {
    const [snap] = await tx
      .select()
      .from(pveSnapshots)
      .where(and(eq(pveSnapshots.id, snapshotId), eq(pveSnapshots.status, "active")))
      .limit(1);
    if (!snap) {
      throw new ProblemError(404, "Restore point not found");
    }
    const [guest] = await tx.select().from(pveGuests).where(eq(pveGuests.id, snap.guestId));
    if (!guest) {
      throw new ProblemError(404, "Guest not found");
    }
    const node = await guestNode(tx, guest);
    const blocker = bootTestBlocker(guest, node);
    if (blocker || !node) {
      throw new ProblemError(409, "No boot test possible", {
        type: PVE_BOOT_TEST_PROBLEMS.unsupported,
        detail: BLOCKER_DETAIL[blocker ?? "no_node"],
        extensions: { reason: blocker ?? "no_node" },
      });
    }
    const [open] = await tx
      .select({ id: pveTasks.id })
      .from(pveTasks)
      .where(
        and(
          eq(pveTasks.guestId, guest.id),
          eq(pveTasks.kind, "boot_test"),
          inArray(pveTasks.status, ["pending", "delivered"]),
          sql`${pveTasks.params}->>'snapshotId' = ${snap.id}`,
        ),
      )
      .limit(1);
    if (open) {
      return { taskId: open.id, alreadyQueued: true };
    }
    const jobs = await tx.select().from(pveJobs);
    const job = pveJobOfGuest(guest, jobs);
    // Asked for by hand: the job's limits, or the defaults when the job has boot tests off.
    const plan = pveBootTestPlan(job?.settings.bootTest);
    const taskId = await queueBootTest(tx, { guest, snap, node, plan, userId: actor.userId, now });
    await auditPve(tx, {
      tenantId,
      actor,
      action: PVE_AUDIT_ACTIONS.bootTestRequested,
      target: snap.id,
      targetType: "pve_snapshot",
      details: { vmid: guest.vmid, archiveName: snap.archiveName, node: node.name },
    });
    return { taskId, alreadyQueued: false };
  });
}

/** Insert the task and its run (the worker's planner does the same, pve/maintenance.ts). */
async function queueBootTest(
  tx: Transaction,
  input: {
    guest: PveGuest;
    snap: PveSnapshot;
    node: PveNode;
    plan: ReturnType<typeof pveBootTestPlan>;
    userId: string | null;
    now: Date;
  },
): Promise<string> {
  const { guest, snap, node, plan, now } = input;
  const [task] = await tx
    .insert(pveTasks)
    .values({
      tenantId: guest.tenantId,
      nodeId: node.id,
      guestId: guest.id,
      kind: "boot_test",
      params: { ...pveBootTestTaskParams(snap, guest.vmid, plan) },
      createdBy: input.userId,
      expiresAt: new Date(now.getTime() + BOOT_TEST_TASK_TTL_MS),
    })
    .returning({ id: pveTasks.id });
  if (!task) {
    throw new Error("task insert returned no row");
  }
  await tx.insert(pveRuns).values({
    tenantId: guest.tenantId,
    clusterId: guest.clusterId,
    nodeId: node.id,
    guestId: guest.id,
    kind: "boot_test",
    origin: "restow",
    archiveName: snap.archiveName,
    taskId: task.id,
    snapshotId: snap.id,
    startedAt: now,
  });
  await tx.update(pveGuests).set({ lastBootTestAt: now }).where(eq(pveGuests.id, guest.id));
  return task.id;
}

/** The result the node reports for a boot test (agent/internal/pve/boottest.go BootTestResult). */
const nodeResultSchema = z.object({
  outcome: z.enum(["green", "yellow", "red", "skipped"]),
  reason: z.string().max(64).default(""),
  message: z.string().max(4000).default(""),
  durationMs: z.number().int().min(0).default(0),
  bootSeconds: z.number().min(0).nullish(),
  guestAgent: z.boolean().default(false),
  tempVmid: z.number().int().min(0).nullish(),
  storage: z.string().max(64).nullish(),
  cleanedUp: z.boolean().default(false),
  log: z
    .string()
    .max(256 * 1024)
    .default(""),
});

const LOG_TAIL_CHARS = 16 * 1024;

/**
 * The end of a boot test task: its run takes the outcome; a rated outcome (green, yellow, red)
 * becomes the restore point's boot test, which readiness reads. A skipped test, or one the node
 * could not carry out (the task failed), stays with its run and rates nothing.
 */
export async function recordBootTestResult(
  tx: Transaction,
  task: PveTask,
  input: { status: "done" | "failed"; error?: string; result?: Record<string, unknown> },
  now: Date,
): Promise<void> {
  const [run] = await tx
    .select()
    .from(pveRuns)
    .where(and(eq(pveRuns.taskId, task.id), eq(pveRuns.kind, "boot_test")))
    .limit(1);
  const parsed = nodeResultSchema.safeParse(input.result ?? {});
  const failed = input.status === "failed" || !parsed.success;
  const outcome: PveBootTestOutcome = failed ? "error" : parsed.data.outcome;
  const node = parsed.success ? parsed.data : null;
  const message = failed
    ? (input.error ?? "").slice(0, 2000) || "The node could not carry out the boot test."
    : (node?.message ?? "");
  const result: PveBootTestResult = {
    outcome,
    reason: failed ? "node_error" : (node?.reason ?? ""),
    message,
    checkedAt: now.toISOString(),
    durationMs: node?.durationMs ?? 0,
    bootSeconds: node?.bootSeconds ?? null,
    guestAgent: node?.guestAgent ?? false,
    tempVmid: node?.tempVmid ?? null,
    storage: node?.storage ?? null,
    cleanedUp: node?.cleanedUp ?? false,
    runId: run?.id ?? "",
  };
  if (run) {
    const stats: PveRunStats = { ...run.stats, bootTest: result };
    await tx
      .update(pveRuns)
      .set({
        // The run did its job when the test ran to an outcome; red is the backup's failure,
        // shown by the rating. A skipped test or a node error fails the run.
        status: outcome === "skipped" || outcome === "error" ? "failed" : "succeeded",
        finishedAt: now,
        stats,
        errorMessage: outcome === "green" ? null : message || null,
        logTail: node?.log ? node.log.slice(-LOG_TAIL_CHARS) : run.logTail,
      })
      .where(eq(pveRuns.id, run.id));
  }
  const snapshotId =
    run?.snapshotId ?? (typeof task.params.snapshotId === "string" ? task.params.snapshotId : null);
  if (snapshotId && (outcome === "green" || outcome === "yellow" || outcome === "red")) {
    await tx
      .update(pveSnapshots)
      .set({ bootTest: result })
      .where(and(eq(pveSnapshots.id, snapshotId), eq(pveSnapshots.status, "active")));
  }
}

/** The boot test facts of a guest for its page: what its node can do, and the job's plan. */
export async function guestBootTestFacts(
  tx: Transaction,
  guest: PveGuest,
): Promise<{
  blocker: BootTestBlocker;
  schedule: "off" | "weekly" | "after_backup";
  lastBootTestAt: string | null;
}> {
  const node = await guestNode(tx, guest);
  const jobs = await tx.select().from(pveJobs);
  const job = pveJobOfGuest(guest, jobs);
  return {
    blocker: bootTestBlocker(guest, node),
    schedule: pveBootTestPlan(job?.settings.bootTest).schedule,
    lastBootTestAt: guest.lastBootTestAt?.toISOString() ?? null,
  };
}
