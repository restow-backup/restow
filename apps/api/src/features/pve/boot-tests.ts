import {
  PVE_BOOT_TEST_CAPABILITY,
  pveBootTestOutcomeOf,
  pveBootTestPlan,
  pveBootTestTaskParams,
  pveJobOfGuest,
  pveNodeDeclares,
  pveRestoreCheckBlocker,
  pveRestorePointPrivileged,
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
import { avoidVmids } from "./vmids.js";

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

/**
 * `point` is the restore point to test (for a guest's page: its newest); whether it is of a
 * privileged container is read from its own configuration (pveRestorePointPrivileged).
 */
export function bootTestBlocker(
  guest: Pick<PveGuest, "kind" | "privileged" | "template">,
  node: Pick<PveNode, "facts"> | null,
  point: Pick<PveSnapshot, "kind" | "guestConfig"> | null,
): BootTestBlocker {
  if (guest.kind === "vm" && guest.template) {
    return "template";
  }
  if (
    guest.kind === "ct" &&
    (point ? pveRestorePointPrivileged(point, guest.privileged) : guest.privileged)
  ) {
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

/** Why a restore point of a privileged container is not restored (restore, check, boot test). */
export const PRIVILEGED_CONTAINER_DETAIL =
  "Restow restores containers only as unprivileged; this restore point is of a privileged container (files with ids above 65535 and device nodes would not restore). Restore it by hand (docs/PVE.md).";

/** The newest active restore point of a guest (its configuration decides "privileged"). */
async function newestPoint(
  tx: Transaction,
  guest: PveGuest,
): Promise<Pick<PveSnapshot, "kind" | "guestConfig"> | null> {
  if (!guest.lastSnapshotId) {
    return null;
  }
  const [point] = await tx
    .select({ kind: pveSnapshots.kind, guestConfig: pveSnapshots.guestConfig })
    .from(pveSnapshots)
    .where(and(eq(pveSnapshots.id, guest.lastSnapshotId), eq(pveSnapshots.status, "active")))
    .limit(1);
  return point ?? null;
}

const BLOCKER_DETAIL: Record<Exclude<BootTestBlocker, null>, string> = {
  no_node: "restow-pve is not enrolled on the guest's node.",
  node_unsupported:
    "restow-pve on the guest's node does not run boot tests (update it, or it switched them off with restow-pve config --boot-tests=false).",
  restores_off:
    "Restores are switched off on the guest's node (restow-pve config --allow-restores).",
  privileged: PRIVILEGED_CONTAINER_DETAIL,
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
    const blocker = bootTestBlocker(guest, node, snap);
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
      params: {
        ...pveBootTestTaskParams(snap, guest.vmid, plan),
        // restow-pve from 0.5.0 picks a free VMID outside these (docs/PVE-PROTOCOL.md).
        avoidVmids: await avoidVmids(tx, guest.clusterId),
      },
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

/**
 * The result the node reports for a boot test (agent/internal/pve/boottest.go BootTestResult).
 * Every field is read on its own: a test the node could not carry out (outcome "", the task
 * failed) still says which temporary guest it made and whether that one is gone, and a field
 * this server does not understand never discards the others.
 */
const nodeResultSchema = z.object({
  // "error" from restow-pve 0.5.0: the test could not be carried out (it failed before the
  // restore, or on the boot test storage), with its reason.
  outcome: z.enum(["green", "yellow", "red", "skipped", "error"]).nullable().catch(null),
  // Any reason is taken, also one this server does not know: the run shows the node's message.
  reason: z.string().max(64).catch(""),
  message: z.string().max(4000).catch(""),
  durationMs: z.number().int().min(0).catch(0),
  bootSeconds: z.number().min(0).nullable().catch(null),
  guestAgent: z.boolean().catch(false),
  tempVmid: z.number().int().min(1).nullable().catch(null),
  storage: z.string().max(64).nullable().catch(null),
  cleanedUp: z.boolean().nullable().catch(null),
  log: z
    .string()
    .max(256 * 1024)
    .catch(""),
});

const LOG_TAIL_CHARS = 16 * 1024;

/** A temporary guest the boot test made and could not remove; null: none is left. */
export function bootTestLeftover(
  result: Pick<PveBootTestResult, "tempVmid" | "cleanedUp" | "storage" | "leftoverGoneAt">,
): { vmid: number; storage: string | null } | null {
  return result.tempVmid !== null && !result.cleanedUp && !result.leftoverGoneAt
    ? { vmid: result.tempVmid, storage: result.storage }
    : null;
}

/** The sentence a run's error message carries about a temporary guest that is still there. */
function leftoverSentence(leftover: { vmid: number; storage: string | null }): string {
  return `The temporary guest ${leftover.vmid}${leftover.storage ? ` on ${leftover.storage}` : ""} could not be removed.`;
}

/**
 * The end of a boot test task: its run takes the outcome; a rated outcome (green, yellow, red)
 * becomes the restore point's boot test, which readiness reads. A skipped test, or one the node
 * could not carry out (the task failed), stays with its run and rates nothing. Whatever the
 * outcome, a temporary guest the node could not remove is kept with the run (its VMID, its
 * storage) and named in the run's message.
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
  const raw = input.result;
  const node =
    raw && typeof raw === "object" && !Array.isArray(raw) ? nodeResultSchema.parse(raw) : null;
  const failed = input.status === "failed" || !node?.outcome;
  // The reason decides where it names what the test proved (pveBootTestOutcomeOf): a skipped
  // or unverified reason is never green, a panicked guest never amber.
  const reason = node?.reason || (failed ? "node_error" : "");
  const outcome: PveBootTestOutcome = failed
    ? "error"
    : pveBootTestOutcomeOf(node?.outcome ?? "error", reason);
  const tempVmid = node?.tempVmid ?? null;
  // An older node, or a result without the field: a guest it made counts as removed only when
  // it says so.
  const cleanedUp = tempVmid === null ? true : node?.cleanedUp === true;
  const leftover = bootTestLeftover({
    tempVmid,
    cleanedUp,
    storage: node?.storage ?? null,
  });
  const said = failed
    ? (input.error ?? "").slice(0, 2000) ||
      node?.message ||
      "The node could not carry out the boot test."
    : (node?.message ?? "");
  const message = leftover ? [said, leftoverSentence(leftover)].filter(Boolean).join(" ") : said;
  const result: PveBootTestResult = {
    outcome,
    reason,
    message,
    checkedAt: now.toISOString(),
    durationMs: node?.durationMs ?? 0,
    bootSeconds: node?.bootSeconds ?? null,
    guestAgent: node?.guestAgent ?? false,
    tempVmid,
    storage: node?.storage ?? null,
    cleanedUp,
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
        // Green says nothing more, unless its temporary guest is still there.
        errorMessage: outcome === "green" && !leftover ? null : message || null,
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

/** A temporary guest of a boot test that is still on its node, per guest (newest first). */
export interface BootTestLeftover {
  vmid: number;
  storage: string | null;
  node: string | null;
  runId: string;
  at: string;
}

/** Inventories this soon after a boot test ended may have been taken before it (one minute). */
const LEFTOVER_INVENTORY_SLACK_MS = 60_000;

/**
 * The temporary guests of boot tests that are still on their node, by tested guest: the newest
 * boot test run whose result says it could not remove its temporary guest, as long as no later
 * inventory of that node left the VMID out ({@link markBootTestLeftoversGone}) and no later boot
 * test on the node removed a guest of that VMID.
 */
export async function bootTestLeftovers(
  tx: Transaction,
  guestId?: string,
): Promise<Map<string, BootTestLeftover>> {
  const rows = await tx.execute<{
    guest_id: string;
    id: string;
    vmid: string;
    storage: string | null;
    node: string | null;
    finished_at: Date | string | null;
  }>(sql`
    SELECT DISTINCT ON (r.guest_id) r.guest_id, r.id, r.stats->'bootTest'->>'tempVmid' AS vmid,
           r.stats->'bootTest'->>'storage' AS storage, n.name AS node, r.finished_at
      FROM pve_runs r LEFT JOIN pve_nodes n ON n.id = r.node_id
     WHERE r.kind = 'boot_test' AND r.status <> 'running'
       ${guestId ? sql`AND r.guest_id = ${guestId}` : sql``}
       AND r.stats->'bootTest'->>'cleanedUp' = 'false'
       AND jsonb_typeof(r.stats->'bootTest'->'tempVmid') = 'number'
       AND COALESCE(r.stats->'bootTest'->>'leftoverGoneAt', '') = ''
       AND NOT EXISTS (
         SELECT 1 FROM pve_runs l
          WHERE l.kind = 'boot_test' AND l.node_id = r.node_id AND l.started_at > r.started_at
            AND l.stats->'bootTest'->>'tempVmid' = r.stats->'bootTest'->>'tempVmid'
            AND l.stats->'bootTest'->>'cleanedUp' = 'true')
     ORDER BY r.guest_id, r.started_at DESC`);
  return new Map(
    rows.rows.map((r) => [
      r.guest_id,
      {
        vmid: Number(r.vmid),
        storage: r.storage,
        node: r.node,
        runId: r.id,
        at: r.finished_at ? new Date(r.finished_at).toISOString() : "",
      },
    ]),
  );
}

/**
 * The node's inventory no longer lists a temporary guest a boot test of that node left behind
 * (restow-pve removes leftovers before every boot test and when its service starts): the run
 * and its restore point record when it went, and the guest's amber note ends.
 */
export async function markBootTestLeftoversGone(
  tx: Transaction,
  nodeId: string,
  listed: readonly number[],
  now: Date,
): Promise<void> {
  const before = new Date(now.getTime() - LEFTOVER_INVENTORY_SLACK_MS);
  const gone = await tx.execute<{ id: string; snapshot_id: string | null }>(sql`
    UPDATE pve_runs
       SET stats = jsonb_set(stats, '{bootTest,leftoverGoneAt}', to_jsonb(${now.toISOString()}::text))
     WHERE kind = 'boot_test' AND node_id = ${nodeId} AND status <> 'running'
       AND finished_at < ${before.toISOString()}::timestamptz
       AND stats->'bootTest'->>'cleanedUp' = 'false'
       AND jsonb_typeof(stats->'bootTest'->'tempVmid') = 'number'
       AND COALESCE(stats->'bootTest'->>'leftoverGoneAt', '') = ''
       AND NOT ((stats->'bootTest'->>'tempVmid')::int = ANY(${`{${listed.map((v) => Math.trunc(v)).join(",")}}`}::int[]))
    RETURNING id, snapshot_id`);
  for (const row of gone.rows) {
    if (!row.snapshot_id) {
      continue;
    }
    await tx.execute(sql`
      UPDATE pve_snapshots
         SET boot_test = jsonb_set(boot_test, '{leftoverGoneAt}', to_jsonb(${now.toISOString()}::text))
       WHERE id = ${row.snapshot_id} AND boot_test->>'runId' = ${row.id}`);
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
    blocker: bootTestBlocker(guest, node, await newestPoint(tx, guest)),
    schedule: pveBootTestPlan(job?.settings.bootTest).schedule,
    lastBootTestAt: guest.lastBootTestAt?.toISOString() ?? null,
  };
}

/**
 * The monthly restore check of a guest for its page (docs/PVE.md): whether its job asks for one,
 * why it cannot run now (the planner, apps/worker pve/maintenance.ts `planRestoreTests`, passes
 * such a guest over and does not stamp it): a container whose repository has a problem
 * recorded (`repository_problem`: its check waits until a repair, a reset or a backup that finds
 * the repository clears it), a privileged container's restore point, a node with restores off,
 * offline or not enrolled. Also the node's name and the last check.
 */
export async function guestRestoreCheckFacts(
  tx: Transaction,
  guest: PveGuest,
  now: Date = new Date(),
): Promise<{
  enabled: boolean;
  blocker: "repository_problem" | "privileged" | "no_node" | "restores_off" | "node_offline" | null;
  node: string | null;
  lastRestoreTestAt: string | null;
}> {
  const jobs = await tx.select().from(pveJobs);
  const test = pveJobOfGuest(guest, jobs)?.settings.restoreTest;
  const enabled = Boolean(test?.enabled && test.targetStorage);
  const node = enabled ? await guestNode(tx, guest) : null;
  // The planner passes over a guest whose newest restore point is of a privileged container
  // (apps/worker pve/maintenance.ts): the page says it is not checked, and why.
  const point = enabled && guest.kind === "ct" ? await newestPoint(tx, guest) : null;
  const privileged = point !== null && pveRestorePointPrivileged(point, guest.privileged);
  return {
    enabled,
    blocker: !enabled
      ? null
      : guest.kind === "ct" && guest.repositoryProblem
        ? "repository_problem"
        : privileged
          ? "privileged"
          : pveRestoreCheckBlocker(node, now),
    node: guest.node,
    lastRestoreTestAt: guest.lastRestoreTestAt?.toISOString() ?? null,
  };
}
