import {
  enrollmentTokenState,
  generateAgentSecret,
  hashSecret,
  parseArchiveName,
} from "@restow/core";
import {
  type PveGuest,
  type PveInventoryDisk,
  pveClusters,
  pveEnrollmentTokens,
  pveGuests,
  pveNodes,
  pveRuns,
  pveSnapshots,
  pveTasks,
  tenants,
} from "@restow/db";
import { and, asc, desc, eq, gt, inArray, isNull, lt, notInArray, or, sql } from "drizzle-orm";
import { db, providerDb } from "../../db.js";
import { withTenantTx } from "../../lib/tenant-context.js";
import { ProblemError } from "../../problem.js";
import { FailureTracker } from "../endpoints/agent-auth.js";
import {
  announcedAgentVersion,
  compareAgentVersions,
  distributionFile,
  readReleaseFile,
} from "../endpoints/distribution.js";
import { PVE_AUDIT_ACTIONS, auditPve, nodeActor } from "./audit.js";
import type { NodeContext } from "./node-auth.js";
import { finishFailedTaskRun } from "./runs.js";

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
    if (!tenant || tenant.status !== "active") {
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

export interface HeartbeatInput {
  helperVersion: string;
  pveVersion: string;
  fleecingStorage: string;
  pluginLoaded: boolean;
  state: "idle" | "running";
  problems: string[];
  restoresAllowed: boolean;
}

/** Tasks for the node, its usage figures and the update offer. */
export async function nodeHeartbeat(
  node: NodeContext,
  input: HeartbeatInput,
  now: Date = new Date(),
) {
  const tasks = await withTenantTx(db, node.tenantId, async (tx) => {
    await tx
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
        },
        lastSeenAt: now,
      })
      .where(eq(pveNodes.id, node.nodeId));
    // Tasks nobody picked up in time fail.
    const expired = await tx
      .update(pveTasks)
      .set({
        status: "failed",
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
    // A node that was busy did not take new work; the state tells.
    if (input.state === "running") {
      return [];
    }
    const due = await tx
      .select()
      .from(pveTasks)
      .where(
        and(
          eq(pveTasks.nodeId, node.nodeId),
          or(
            eq(pveTasks.status, "pending"),
            and(
              eq(pveTasks.status, "delivered"),
              lt(pveTasks.deliveredAt, new Date(now.getTime() - REDELIVER_AFTER_MS)),
            ),
          ),
        ),
      )
      .orderBy(asc(pveTasks.createdAt))
      .limit(MAX_TASKS);
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
  });
  const usage = await withTenantTx(db, node.tenantId, async (tx) => {
    const [row] = await tx
      .select({ bytes: sql<string | null>`sum(${pveSnapshots.byteSize})` })
      .from(pveSnapshots)
      .where(and(eq(pveSnapshots.clusterId, node.clusterId), eq(pveSnapshots.status, "active")));
    return Number(row?.bytes ?? 0);
  });
  return {
    tasks,
    storageId: node.storageId,
    usage: { usedBytes: usage, budgetBytes: 0 },
    update: await updateOffer(input.helperVersion),
  };
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
        status: input.status,
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
    if (input.status === "failed") {
      await finishFailedTaskRun(tx, task, task.errorMessage ?? "failed", now);
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
