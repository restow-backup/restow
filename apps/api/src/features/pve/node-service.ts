import {
  enrollmentTokenState,
  generateAgentSecret,
  hashSecret,
  PVE_BOOT_TEST_CAPABILITY,
  parseArchiveName,
  pveNodeDeclares,
} from "@restow/core";
import {
  type JobStartPauseState,
  NOT_PAUSED,
  type PveGuest,
  type PveInventoryDisk,
  pveClusters,
  pveEnrollmentTokens,
  pveGuests,
  pveNodes,
  pveRuns,
  pveSnapshots,
  pveTasks,
  readJobStartPause,
  secrets,
  tenants,
} from "@restow/db";
import { and, asc, desc, eq, gt, inArray, isNull, lt, ne, notInArray, or, sql } from "drizzle-orm";
import { db, providerDb } from "../../db.js";
import { readSecret } from "../../lib/secrets.js";
import { type Transaction, withTenantTx } from "../../lib/tenant-context.js";
import { ProblemError } from "../../problem.js";
import { FailureTracker } from "../endpoints/agent-auth.js";
import {
  announcedAgentVersion,
  compareAgentVersions,
  distributionFile,
  readReleaseFile,
} from "../endpoints/distribution.js";
import { auditPve, nodeActor, PVE_AUDIT_ACTIONS } from "./audit.js";
import { recordBootTestResult } from "./boot-tests.js";
import { cancelOrders, taskCancelledOrFailed } from "./cancel.js";
import type { NodeContext } from "./node-auth.js";
import { endedStatus, finishFailedTaskRun } from "./runs.js";

/**
 * The server side of restow-pve's service calls (docs/PVE-PROTOCOL.md):
 * enrollment, heartbeat with tasks, inventory, task results, the listing
 * the storage plugin shows and the update offer.
 */

export const PVE_ENROLLMENT_INVALID = "urn:restow:problem:pve-enrollment-token-invalid";
export const PVE_CLUSTER_TAKEN = "urn:restow:problem:pve-cluster-taken";

/** Failed enrollments per address. */
export const pveEnrollFailures = new FailureTracker(20);

/** The PVE storage id a cluster gets for its Restow storage. */
export const DEFAULT_STORAGE_ID = "restow";

const REDELIVER_AFTER_MS = 30 * 60 * 1000;
const BOOT_TEST_UNSUPPORTED =
  "The node does not run boot tests (restow-pve too old, or boot tests switched off on the node).";
const MAX_TASKS = 5;
/** A node that has not called for this long is offline. */
export const NODE_ONLINE_MS = 3 * 60 * 1000;

export interface EnrollInput {
  token: string;
  clusterName: string;
  clusterFingerprint: string;
  nodeName: string;
  pveVersion: string;
  helperVersion: string;
  fleecingStorage: string;
}

export async function enrollNode(
  input: EnrollInput,
  ip: string | null,
  now: Date = new Date(),
): Promise<{
  nodeId: string;
  nodeSecret: string;
  clusterId: string;
  storageId: string;
  createdCluster: boolean;
}> {
  const tokenHash = hashSecret(input.token);
  const [claimed] = await providerDb
    .update(pveEnrollmentTokens)
    .set({ usedAt: now })
    .where(
      and(
        eq(pveEnrollmentTokens.tokenHash, tokenHash),
        isNull(pveEnrollmentTokens.usedAt),
        isNull(pveEnrollmentTokens.revokedAt),
        gt(pveEnrollmentTokens.expiresAt, now),
      ),
    )
    .returning();
  if (!claimed) {
    const [known] = await providerDb
      .select()
      .from(pveEnrollmentTokens)
      .where(eq(pveEnrollmentTokens.tokenHash, tokenHash))
      .limit(1);
    throw new ProblemError(401, "Enrollment token not valid", {
      type: PVE_ENROLLMENT_INVALID,
      detail: "The enrollment token is unknown, expired, revoked or already used.",
      extensions: { reason: known ? enrollmentTokenState(known, now) : "unknown" },
    });
  }
  const release = () =>
    providerDb
      .update(pveEnrollmentTokens)
      .set({ usedAt: null })
      .where(eq(pveEnrollmentTokens.id, claimed.id));
  const tenantId = claimed.tenantId;
  try {
    const [tenant] = await providerDb
      .select({ status: tenants.status })
      .from(tenants)
      .where(eq(tenants.id, tenantId))
      .limit(1);
    if (tenant?.status !== "active") {
      throw new ProblemError(403, "Tenant suspended", {
        detail: "The tenant of this enrollment token is currently suspended.",
      });
    }
    // One tenant per cluster: the cluster CA fingerprint is unique installation-wide.
    const [existing] = await providerDb
      .select()
      .from(pveClusters)
      .where(eq(pveClusters.fingerprint, input.clusterFingerprint))
      .limit(1);
    if (existing && existing.tenantId !== tenantId) {
      throw new ProblemError(409, "Cluster belongs to another tenant", {
        type: PVE_CLUSTER_TAKEN,
        detail:
          "This Proxmox VE cluster is already connected to another tenant. A cluster serves one tenant in this release.",
      });
    }
    const secret = generateAgentSecret();
    const result = await withTenantTx(db, tenantId, async (tx) => {
      let cluster = existing;
      let createdCluster = false;
      if (!cluster) {
        [cluster] = await tx
          .insert(pveClusters)
          .values({
            tenantId,
            name: input.clusterName,
            fingerprint: input.clusterFingerprint,
            storageId: DEFAULT_STORAGE_ID,
          })
          .returning();
        createdCluster = true;
      }
      if (!cluster) {
        throw new Error("cluster insert returned no row");
      }
      // Enrolling a node again (a reinstall) replaces its earlier enrollment.
      await tx
        .update(pveNodes)
        .set({ revokedAt: now })
        .where(
          and(
            eq(pveNodes.clusterId, cluster.id),
            eq(pveNodes.name, input.nodeName),
            isNull(pveNodes.revokedAt),
          ),
        );
      const [node] = await tx
        .insert(pveNodes)
        .values({
          tenantId,
          clusterId: cluster.id,
          name: input.nodeName,
          helperVersion: input.helperVersion,
          pveVersion: input.pveVersion,
          secretHash: secret.hash,
          fleecingStorage: input.fleecingStorage || null,
          lastSeenAt: now,
        })
        .returning();
      if (!node) {
        throw new Error("node insert returned no row");
      }
      await tx
        .update(pveEnrollmentTokens)
        .set({ usedByNodeId: node.id })
        .where(eq(pveEnrollmentTokens.id, claimed.id));
      // An existing PVE API token handed over for this enrollment has served its
      // purpose: the node keeps it, Restow does not (the reference goes null).
      if (claimed.pveTokenSecretId) {
        await tx.delete(secrets).where(eq(secrets.id, claimed.pveTokenSecretId));
      }
      await auditPve(tx, {
        tenantId,
        actor: nodeActor(input.nodeName, ip),
        action: PVE_AUDIT_ACTIONS.nodeEnrolled,
        target: node.id,
        targetType: "pve_node",
        details: {
          cluster: input.clusterName,
          node: input.nodeName,
          pveVersion: input.pveVersion,
          helperVersion: input.helperVersion,
          tokenId: claimed.id,
        },
      });
      return { node, cluster, createdCluster };
    });
    return {
      nodeId: result.node.id,
      nodeSecret: secret.value,
      clusterId: result.cluster.id,
      storageId: result.cluster.storageId,
      createdCluster: result.createdCluster,
    };
  } catch (error) {
    await release().catch(() => undefined);
    throw error;
  }
}

/**
 * Before a node enrolls (docs/PVE-PROTOCOL.md): is the enrollment token still
 * good, and did the admin give an existing PVE API token with it? The installer
 * asks this first, so it fails early on a used or expired token and uses the
 * admin's PVE token instead of creating one. It does not use the enrollment
 * token up; the PVE token is deleted when the node enrolled with it.
 */
export async function enrollmentPreflight(
  token: string,
  now: Date = new Date(),
): Promise<{ expiresAt: string; pveTokenId: string | null; pveTokenSecret: string | null }> {
  const [row] = await providerDb
    .select()
    .from(pveEnrollmentTokens)
    .where(eq(pveEnrollmentTokens.tokenHash, hashSecret(token)))
    .limit(1);
  const state = row ? enrollmentTokenState(row, now) : "unknown";
  if (!row || state !== "valid") {
    throw new ProblemError(401, "Enrollment token not valid", {
      type: PVE_ENROLLMENT_INVALID,
      detail: "The enrollment token is unknown, expired, revoked or already used.",
      extensions: { reason: state },
    });
  }
  let pveToken: { id: string; secret: string } | null = null;
  if (row.pveTokenSecretId) {
    const plaintext = await readSecret(db, { id: row.pveTokenSecretId, tenantId: row.tenantId });
    if (plaintext) {
      pveToken = JSON.parse(plaintext) as { id: string; secret: string };
    }
  }
  return {
    expiresAt: row.expiresAt.toISOString(),
    pveTokenId: pveToken?.id ?? null,
    pveTokenSecret: pveToken?.secret ?? null,
  };
}

export interface HeartbeatInput {
  helperVersion: string;
  pveVersion: string;
  fleecingStorage: string;
  pluginLoaded: boolean;
  state: "idle" | "running";
  problems: string[];
  restoresAllowed: boolean;
  activeRuns?: string[];
  capabilities?: string[];
}

/** Whether an update pauses new job starts (#46); unreadable counts as not paused. */
async function startPause(): Promise<JobStartPauseState> {
  try {
    return await readJobStartPause(providerDb.$client);
  } catch {
    return NOT_PAUSED;
  }
}

/** Tasks for the node, its usage figures and the update offer. */
export async function nodeHeartbeat(
  node: NodeContext,
  input: HeartbeatInput,
  now: Date = new Date(),
) {
  // While an update pauses new job starts (#46) the node gets no backup task; it gets
  // them on the first heartbeat after the pause.
  const pause = await startPause();
  const paused = pause.paused;
  const result = await withTenantTx(db, node.tenantId, async (tx) => {
    const [nodeRow] = await tx
      .update(pveNodes)
      .set({
        helperVersion: input.helperVersion,
        pveVersion: input.pveVersion,
        fleecingStorage: input.fleecingStorage || null,
        facts: {
          pluginLoaded: input.pluginLoaded,
          restoresAllowed: input.restoresAllowed,
          problems: input.problems.slice(0, 20),
          state: input.state,
          ...(input.activeRuns
            ? { activeRuns: input.activeRuns, activeRunsAt: now.toISOString() }
            : {}),
          // An older node sends none: it gets none of the newer task kinds.
          capabilities: (input.capabilities ?? []).slice(0, 32),
        },
        lastSeenAt: now,
      })
      .where(eq(pveNodes.id, node.nodeId))
      .returning({
        queuePausedAt: pveNodes.queuePausedAt,
        updateRequestedAt: pveNodes.updateRequestedAt,
      });
    // Tasks nobody picked up in time fail (one with a cancel request ends cancelled).
    const expired = await tx
      .update(pveTasks)
      .set({
        status: taskCancelledOrFailed(),
        finishedAt: now,
        errorMessage: "The node did not run the task in time.",
      })
      .where(
        and(
          eq(pveTasks.nodeId, node.nodeId),
          inArray(pveTasks.status, ["pending", "delivered"]),
          lt(pveTasks.expiresAt, now),
        ),
      )
      .returning();
    for (const task of expired) {
      await finishFailedTaskRun(tx, task, "The node did not run the task in time.", now);
    }
    // A boot test queued for a node that no longer announces them (an older helper after a
    // reinstall, or boot tests switched off on the node) fails instead of being delivered.
    const capable = pveNodeDeclares(
      { capabilities: input.capabilities ?? [] },
      PVE_BOOT_TEST_CAPABILITY,
    );
    if (!capable) {
      const refused = await tx
        .update(pveTasks)
        .set({ status: "failed", finishedAt: now, errorMessage: BOOT_TEST_UNSUPPORTED })
        .where(
          and(
            eq(pveTasks.nodeId, node.nodeId),
            eq(pveTasks.kind, "boot_test"),
            inArray(pveTasks.status, ["pending", "delivered"]),
          ),
        )
        .returning();
      for (const task of refused) {
        await finishFailedTaskRun(tx, task, BOOT_TEST_UNSUPPORTED, now);
      }
    }
    // What the node is to stop: delivered tasks and running backups with a cancel request.
    const cancel = await cancelOrders(tx, node.nodeId);
    // A node that was busy did not take new work; the state tells. A paused queue hands out
    // no backup (the admin resumes it on the node's page).
    const queuePaused = nodeRow?.queuePausedAt != null;
    const tasks =
      input.state === "running"
        ? []
        : await deliverDueTasks(tx, node, input, paused || queuePaused, now);
    return { tasks, cancel, queuePaused, nodeRow };
  });
  const usage = await withTenantTx(db, node.tenantId, async (tx) => {
    const [row] = await tx
      .select({ bytes: sql<string | null>`sum(${pveSnapshots.byteSize})` })
      .from(pveSnapshots)
      .where(and(eq(pveSnapshots.clusterId, node.clusterId), eq(pveSnapshots.status, "active")));
    return Number(row?.bytes ?? 0);
  });
  const offer = await updateOffer(input.helperVersion);
  // "Update now": asked on the node's page, or the fleet phase after a server update
  // (features/updates/fleet.ts). The node installs it once it is idle.
  const updateNow =
    offer !== null && (result.nodeRow?.updateRequestedAt != null || pause.phase === "fleet");
  if (!offer && result.nodeRow?.updateRequestedAt) {
    await clearUpdateRequest(node);
  }
  return {
    tasks: result.tasks,
    // restow-pve from 0.4.2 stops these (older nodes ignore the field; the server refuses their
    // uploads, so their backup ends at its next call).
    cancel: result.cancel,
    queuePaused: result.queuePaused,
    storageId: node.storageId,
    usage: { usedBytes: usage, budgetBytes: 0 },
    update: offer ? { ...offer, now: updateNow } : null,
  };
}

/** The tasks the idle node gets now, marked delivered. */
async function deliverDueTasks(
  tx: Transaction,
  node: NodeContext,
  input: HeartbeatInput,
  holdBackups: boolean,
  now: Date,
) {
  // Never a boot test beside a backup on the node: it waits for the next heartbeat.
  const holdBootTests = (input.activeRuns?.length ?? 0) > 0;
  const due = await tx
    .select()
    .from(pveTasks)
    .where(
      and(
        eq(pveTasks.nodeId, node.nodeId),
        holdBackups ? ne(pveTasks.kind, "backup") : undefined,
        // A delivered task with a cancel request is not handed out again.
        isNull(pveTasks.cancelRequestedAt),
        holdBootTests ? ne(pveTasks.kind, "boot_test") : undefined,
        or(
          eq(pveTasks.status, "pending"),
          and(
            eq(pveTasks.status, "delivered"),
            lt(pveTasks.deliveredAt, new Date(now.getTime() - REDELIVER_AFTER_MS)),
            // Not while a run of it is still open: a long backup would start a second time.
            sql`NOT EXISTS (SELECT 1 FROM pve_runs r WHERE r.task_id = "pve_tasks"."id" AND r.status = 'running')`,
          ),
        ),
      ),
    )
    .orderBy(asc(pveTasks.createdAt))
    .limit(MAX_TASKS);
  // One boot test per heartbeat: the node runs them one after another anyway.
  const firstBootTest = due.findIndex((t) => t.kind === "boot_test");
  if (firstBootTest >= 0) {
    due.splice(
      0,
      due.length,
      ...due.filter((t, i) => t.kind !== "boot_test" || i === firstBootTest),
    );
  }
  if (due.length > 0) {
    await tx
      .update(pveTasks)
      .set({ status: "delivered", deliveredAt: now })
      .where(
        inArray(
          pveTasks.id,
          due.map((t) => t.id),
        ),
      );
  }
  return due.map((t) => ({ id: t.id, kind: t.kind, params: t.params }));
}

/** The node runs the offered version (or none is offered): its "update now" is done. */
async function clearUpdateRequest(node: NodeContext): Promise<void> {
  await withTenantTx(db, node.tenantId, (tx) =>
    tx.update(pveNodes).set({ updateRequestedAt: null }).where(eq(pveNodes.id, node.nodeId)),
  );
}

/** A newer signed release that carries restow-pve, or null. */
export async function updateOffer(current: string): Promise<{ version: string } | null> {
  if (!current || current.includes("-dev")) {
    return null;
  }
  const version = await announcedAgentVersion();
  if (compareAgentVersions(version, current) <= 0) {
    return null;
  }
  if (!(await readReleaseFile(version, "SHA256SUMS.sig"))) {
    return null;
  }
  return (await distributionFile(version, "linux-amd64", "restow-pve")) ? { version } : null;
}

export interface InventoryGuestInput {
  vmid: number;
  kind: "vm" | "ct";
  name: string;
  node: string;
  status: string;
  template: boolean;
  privileged: boolean;
  tags: string[];
  pool: string;
  disks: PveInventoryDisk[];
  agent: boolean;
}

/**
 * Replace what this node reports: every guest it lists is upserted (it may
 * have migrated here), every guest last seen on this node that it no longer
 * lists is marked absent.
 */
export async function reportInventory(
  node: NodeContext,
  guests: InventoryGuestInput[],
  now: Date = new Date(),
): Promise<{ guests: number }> {
  await withTenantTx(db, node.tenantId, async (tx) => {
    for (const g of guests) {
      const values = {
        kind: g.kind,
        name: g.name || null,
        node: g.node || node.name,
        status: g.status || null,
        template: g.template,
        privileged: g.privileged,
        agent: g.agent,
        tags: g.tags.slice(0, 50),
        pool: g.pool || null,
        disks: g.disks.slice(0, 64),
        present: true,
        reportedAt: now,
      };
      await tx
        .insert(pveGuests)
        .values({ tenantId: node.tenantId, clusterId: node.clusterId, vmid: g.vmid, ...values })
        .onConflictDoUpdate({ target: [pveGuests.clusterId, pveGuests.vmid], set: values });
    }
    const listed = guests.map((g) => g.vmid);
    await tx
      .update(pveGuests)
      .set({ present: false })
      .where(
        and(
          eq(pveGuests.clusterId, node.clusterId),
          eq(pveGuests.node, node.name),
          listed.length > 0 ? notInArray(pveGuests.vmid, listed) : sql`true`,
        ),
      );
  });
  return { guests: guests.length };
}

/** Record how a task ended. Only the node it was given to may report it. */
export async function taskResult(
  node: NodeContext,
  taskId: string,
  input: { status: "done" | "failed"; error?: string; result?: Record<string, unknown> },
  now: Date = new Date(),
): Promise<void> {
  await withTenantTx(db, node.tenantId, async (tx) => {
    const [task] = await tx
      .update(pveTasks)
      .set({
        // A task that failed after a cancel request was stopped as asked.
        status: input.status === "failed" ? taskCancelledOrFailed() : input.status,
        finishedAt: now,
        result: input.result ?? null,
        errorMessage:
          input.status === "failed" ? (input.error ?? "").slice(0, 2000) || "failed" : null,
      })
      .where(
        and(
          eq(pveTasks.id, taskId),
          eq(pveTasks.nodeId, node.nodeId),
          inArray(pveTasks.status, ["pending", "delivered"]),
        ),
      )
      .returning();
    if (!task) {
      throw new ProblemError(404, "Task not found", {
        detail: "No open task with this id for this node.",
      });
    }
    if (task.kind === "boot_test") {
      await recordBootTestResult(tx, task, input, now);
      return;
    }
    if (input.status === "failed") {
      await finishFailedTaskRun(tx, task, task.errorMessage ?? "failed", now);
      return;
    }
    // A backup whose own end was never reported (the node could not send it)
    // ends with its task: done with a restore point, failed without one.
    if (task.kind === "backup") {
      const open = await tx
        .select()
        .from(pveRuns)
        .where(
          and(
            eq(pveRuns.taskId, task.id),
            eq(pveRuns.status, "running"),
            eq(pveRuns.kind, "backup"),
          ),
        );
      for (const run of open) {
        const status = endedStatus(run, run.snapshotId !== null ? "succeeded" : "failed");
        await tx
          .update(pveRuns)
          .set({
            status,
            finishedAt: now,
            errorMessage:
              status === "failed" ? "The backup ended without reporting a restore point." : null,
          })
          .where(eq(pveRuns.id, run.id));
        if (status !== "cancelled") {
          await tx
            .update(pveGuests)
            .set({ lastBackupAt: now })
            .where(eq(pveGuests.id, run.guestId));
        }
      }
      return;
    }
    // A restore task's run ends here: the node reports the new VMID.
    const [run] = await tx
      .select()
      .from(pveRuns)
      .where(and(eq(pveRuns.taskId, task.id), eq(pveRuns.status, "running")))
      .limit(1);
    if (run && (run.kind === "restore" || run.kind === "restore_test")) {
      await tx
        .update(pveRuns)
        .set({
          status: "succeeded",
          finishedAt: now,
          stats: { ...run.stats, ...(input.result ?? {}) },
        })
        .where(eq(pveRuns.id, run.id));
      if (run.kind === "restore_test") {
        await tx
          .update(pveGuests)
          .set({ lastRestoreTestAt: now })
          .where(eq(pveGuests.id, run.guestId));
      }
    }
  });
}

/** The restore points of the node's cluster, for the storage plugin's listing. */
export async function listing(node: NodeContext) {
  const rows = await withTenantTx(db, node.tenantId, (tx) =>
    tx
      .select({
        archiveName: pveSnapshots.archiveName,
        kind: pveSnapshots.kind,
        backupAt: pveSnapshots.backupAt,
        byteSize: pveSnapshots.byteSize,
        id: pveSnapshots.id,
        vmid: pveGuests.vmid,
      })
      .from(pveSnapshots)
      .innerJoin(pveGuests, eq(pveGuests.id, pveSnapshots.guestId))
      .where(and(eq(pveSnapshots.clusterId, node.clusterId), eq(pveSnapshots.status, "active")))
      .orderBy(desc(pveSnapshots.backupAt))
      .limit(10_000),
  );
  return {
    volumes: rows.map((r) => ({
      volname: r.archiveName,
      vmid: r.vmid,
      kind: r.kind,
      ctime: Math.floor(r.backupAt.getTime() / 1000),
      size: r.byteSize,
      snapshotId: r.id,
    })),
  };
}

/** The guest of the node's cluster with this VMID, created when the inventory has not shown it yet. */
export async function guestForBackup(
  node: NodeContext,
  vmid: number,
  kind: "vm" | "ct",
): Promise<PveGuest> {
  return withTenantTx(db, node.tenantId, async (tx) => {
    const [found] = await tx
      .select()
      .from(pveGuests)
      .where(and(eq(pveGuests.clusterId, node.clusterId), eq(pveGuests.vmid, vmid)))
      .limit(1);
    if (found) {
      return found;
    }
    const [created] = await tx
      .insert(pveGuests)
      .values({ tenantId: node.tenantId, clusterId: node.clusterId, vmid, kind, node: node.name })
      .onConflictDoNothing()
      .returning();
    if (created) {
      return created;
    }
    const [again] = await tx
      .select()
      .from(pveGuests)
      .where(and(eq(pveGuests.clusterId, node.clusterId), eq(pveGuests.vmid, vmid)))
      .limit(1);
    if (!again) {
      throw new Error("guest vanished");
    }
    return again;
  });
}

/** Validate an archive name a node sends against the guest it names. */
export function checkArchiveName(name: string, vmid: number, kind: "vm" | "ct"): string {
  const parsed = parseArchiveName(name);
  if (!parsed || parsed.vmid !== vmid || parsed.kind !== kind) {
    throw new ProblemError(422, "Invalid archive name", {
      detail: "The archive name must be <vm|ct>/<vmid>/<UTC time> and name the guest of the run.",
    });
  }
  return parsed.archiveName;
}
