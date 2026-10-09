import {
  enrollmentTokenExpiry,
  generateEnrollmentToken,
  pveGuestBackable,
  pveJobOfGuest,
  pveNextRunAt,
} from "@restow/core";
import {
  type Database,
  type PveGuest,
  type PveJob,
  type PveJobSchedule,
  type PveJobSettings,
  type PveNode,
  pveClusters,
  pveEnrollmentTokens,
  pveGuests,
  pveJobs,
  pveNodes,
  pveRuns,
  pveSnapshots,
  pveTasks,
} from "@restow/db";
import { and, asc, desc, eq, inArray, isNull, sql } from "drizzle-orm";
import { storeSecret } from "../../lib/secrets.js";
import { withTenantTx } from "../../lib/tenant-context.js";
import { ProblemError } from "../../problem.js";
import { isSafeOrigin } from "../endpoints/distribution.js";
import { PVE_AUDIT_ACTIONS, type PveActor, auditPve } from "./audit.js";
import { NODE_ONLINE_MS } from "./node-service.js";

/**
 * The session side of the Proxmox VE feature (docs/PVE.md): clusters, nodes
 * and guests for the inventory, the onboarding token with the commands per
 * cluster and per node, restore points and runs of a guest, back up now,
 * restore as a new guest into the restore pool, verify, jobs.
 */

export const PVE_PROBLEMS = {
  noNode: "urn:restow:problem:pve-node-unavailable",
  privilegedRestore: "urn:restow:problem:pve-privileged-ct-restore",
  template: "urn:restow:problem:pve-template-unsupported",
  restoresOff: "urn:restow:problem:pve-restores-off",
} as const;

/** The pool restores go into; the API token may create (and delete) guests only there. */
export const RESTORE_POOL = "restow-restore";
const TASK_TTL_MS = 12 * 60 * 60 * 1000;

function nodeDto(n: PveNode, now: Date) {
  return {
    id: n.id,
    name: n.name,
    helperVersion: n.helperVersion,
    pveVersion: n.pveVersion,
    fleecingStorage: n.fleecingStorage,
    lastSeenAt: n.lastSeenAt?.toISOString() ?? null,
    online: n.lastSeenAt !== null && now.getTime() - n.lastSeenAt.getTime() < NODE_ONLINE_MS,
    problems: n.facts.problems ?? [],
    pluginLoaded: n.facts.pluginLoaded ?? null,
    restoresAllowed: n.facts.restoresAllowed ?? null,
    state: n.facts.state ?? null,
  };
}

/** What the inventory says about the bitmap of a guest's disks after its last backup. */
export function bitmapState(
  guest: Pick<PveGuest, "kind" | "diskState">,
): "incremental" | "full_read" | null {
  if (guest.kind !== "vm") {
    return null;
  }
  const modes = Object.values(guest.diskState).map((d) => d.bitmapMode);
  if (modes.length === 0) {
    return null;
  }
  return modes.every((m) => m === "reuse") ? "incremental" : "full_read";
}

function guestDto(
  g: PveGuest,
  jobs: Map<string, PveJob>,
  lastRun: { status: string; error: string | null } | undefined,
) {
  const attention: string[] = [];
  if (g.template && g.kind === "vm") {
    attention.push("template_unsupported");
  }
  // Not backed up: in no enabled job, the job for all guests included (the overviews' rule,
  // pveJobOfGuest in @restow/core).
  if (pveGuestBackable(g) && !pveJobOfGuest(g, [...jobs.values()])) {
    attention.push("no_job");
  }
  if (lastRun?.status === "failed") {
    attention.push("last_backup_failed");
  }
  if (!g.present) {
    attention.push("absent");
  }
  return {
    id: g.id,
    clusterId: g.clusterId,
    vmid: g.vmid,
    kind: g.kind,
    name: g.name,
    node: g.node,
    status: g.status,
    template: g.template,
    privileged: g.privileged,
    agent: g.agent,
    present: g.present,
    tags: g.tags,
    pool: g.pool,
    diskBytes: g.disks.reduce((s, d) => s + d.size, 0),
    disks: g.disks,
    jobId: g.jobId,
    jobName: g.jobId ? (jobs.get(g.jobId)?.name ?? null) : null,
    lastBackupAt: g.lastBackupAt?.toISOString() ?? null,
    lastSuccessAt: g.lastSuccessAt?.toISOString() ?? null,
    lastSnapshotId: g.lastSnapshotId,
    lastRunStatus: lastRun?.status ?? null,
    lastRunError: lastRun?.error ?? null,
    bitmapState: bitmapState(g),
    attention,
  };
}

function jobDto(j: PveJob) {
  return {
    id: j.id,
    name: j.name,
    scopeAll: j.scopeAll,
    schedule: j.schedule,
    settings: j.settings,
    enabled: j.enabled,
    nextRunAt: j.nextRunAt?.toISOString() ?? null,
    lastRunAt: j.lastRunAt?.toISOString() ?? null,
  };
}

/** Clusters with their nodes, the guests and the jobs of a tenant. */
export async function overview(database: Database, tenantId: string, now: Date = new Date()) {
  return withTenantTx(database, tenantId, async (tx) => {
    const clusters = await tx.select().from(pveClusters).orderBy(asc(pveClusters.name));
    const nodes = await tx
      .select()
      .from(pveNodes)
      .where(isNull(pveNodes.revokedAt))
      .orderBy(asc(pveNodes.name));
    const guests = await tx.select().from(pveGuests).orderBy(asc(pveGuests.vmid));
    const jobs = await tx.select().from(pveJobs).orderBy(asc(pveJobs.name));
    const lastRuns = await tx.execute<{
      guest_id: string;
      status: string;
      error_message: string | null;
    }>(sql`
      SELECT DISTINCT ON (guest_id) guest_id, status, error_message
        FROM pve_runs WHERE kind = 'backup' AND status <> 'running'
       ORDER BY guest_id, started_at DESC`);
    const runByGuest = new Map(
      lastRuns.rows.map((r) => [r.guest_id, { status: r.status, error: r.error_message }]),
    );
    const jobMap = new Map(jobs.map((j) => [j.id, j]));
    return {
      clusters: clusters.map((c) => ({
        id: c.id,
        name: c.name,
        storageId: c.storageId,
        nodes: nodes.filter((n) => n.clusterId === c.id).map((n) => nodeDto(n, now)),
      })),
      guests: guests.map((g) => guestDto(g, jobMap, runByGuest.get(g.id))),
      jobs: jobs.map(jobDto),
      restorePool: RESTORE_POOL,
    };
  });
}

/** Secret kind of an existing PVE API token handed to one enrollment (sealed JSON {id, secret}). */
export const PVE_API_TOKEN_SECRET_KIND = "pve_api_token";

/** The environment variable the node installer reads the enrollment token from. */
export const ENROLL_TOKEN_ENV = "RESTOW_ENROLL_TOKEN";

/** The one command to run as root on a node (docs/PVE.md, onboarding). */
export function nodeCommand(instanceUrl: string, token: string): string {
  // The token goes to the installer through its environment, not its arguments.
  return `curl -fsSL '${instanceUrl}/install/pve.sh' | ${ENROLL_TOKEN_ENV}='${token}' sh`;
}

/**
 * A one-time enrollment token (24 hours, one node) and the one command to run
 * as root on that node. The installer sets up the PVE side itself (user, roles,
 * restore pool, an API token of its own for the node) unless the admin gives an
 * existing PVE API token here: that one is sealed with the tenant key, bound to
 * this enrollment token, handed to the node once before it enrolls and deleted
 * when the node enrolled (or by the worker when the token expired).
 */
export async function createEnrollmentToken(
  database: Database,
  tenantId: string,
  actor: PveActor,
  instance: { url: string },
  input: { pveToken?: { id: string; secret: string } | undefined } = {},
  now: Date = new Date(),
) {
  if (!instance.url || !isSafeOrigin(instance.url)) {
    throw new ProblemError(503, "Instance address unknown", {
      detail: "The public address of this installation is not configured.",
    });
  }
  const token = generateEnrollmentToken();
  const pveToken = input.pveToken ?? null;
  const row = await withTenantTx(database, tenantId, async (tx) => {
    const sealed = pveToken
      ? await storeSecret(tx, {
          tenantId,
          kind: PVE_API_TOKEN_SECRET_KIND,
          plaintext: JSON.stringify({ id: pveToken.id, secret: pveToken.secret }),
        })
      : null;
    const [created] = await tx
      .insert(pveEnrollmentTokens)
      .values({
        tenantId,
        tokenHash: token.hash,
        expiresAt: enrollmentTokenExpiry(now),
        pveTokenSecretId: sealed?.id ?? null,
        createdBy: actor.userId,
      })
      .returning();
    if (!created) {
      throw new Error("token insert returned no row");
    }
    await auditPve(tx, {
      tenantId,
      actor,
      action: PVE_AUDIT_ACTIONS.tokenCreated,
      target: created.id,
      targetType: "pve_enrollment_token",
      details: {
        expiresAt: created.expiresAt.toISOString(),
        // Only the id of an existing PVE API token, never its secret.
        pveTokenId: pveToken?.id ?? null,
      },
    });
    return created;
  });
  return {
    id: row.id,
    token: token.value,
    expiresAt: row.expiresAt.toISOString(),
    pveTokenId: pveToken?.id ?? null,
    nodeCommand: nodeCommand(instance.url, token.value),
  };
}

async function loadGuest(
  tx: Parameters<Parameters<typeof withTenantTx>[2]>[0],
  id: string,
): Promise<PveGuest> {
  const [guest] = await tx.select().from(pveGuests).where(eq(pveGuests.id, id)).limit(1);
  if (!guest) {
    throw new ProblemError(404, "Guest not found");
  }
  return guest;
}

/** One guest with its restore points, runs and open tasks. */
export async function guestDetail(database: Database, tenantId: string, id: string) {
  return withTenantTx(database, tenantId, async (tx) => {
    const guest = await loadGuest(tx, id);
    const snapshots = await tx
      .select()
      .from(pveSnapshots)
      .where(and(eq(pveSnapshots.guestId, id), eq(pveSnapshots.status, "active")))
      .orderBy(desc(pveSnapshots.backupAt))
      .limit(200);
    const runs = await tx
      .select()
      .from(pveRuns)
      .where(eq(pveRuns.guestId, id))
      .orderBy(desc(pveRuns.startedAt))
      .limit(50);
    const tasks = await tx
      .select()
      .from(pveTasks)
      .where(and(eq(pveTasks.guestId, id), inArray(pveTasks.status, ["pending", "delivered"])))
      .orderBy(desc(pveTasks.createdAt));
    const jobs = await tx.select().from(pveJobs);
    const [cluster] = await tx
      .select()
      .from(pveClusters)
      .where(eq(pveClusters.id, guest.clusterId))
      .limit(1);
    return {
      guest: guestDto(guest, new Map(jobs.map((j) => [j.id, j])), undefined),
      cluster: cluster
        ? { id: cluster.id, name: cluster.name, storageId: cluster.storageId }
        : null,
      diskState: guest.diskState,
      snapshots: snapshots.map((s) => ({
        id: s.id,
        sequence: s.sequence,
        kind: s.kind,
        archiveName: s.archiveName,
        origin: s.origin,
        backupAt: s.backupAt.toISOString(),
        byteSize: s.byteSize,
        stats: s.stats,
        disks: s.disks.map((d) => ({
          device: d.device,
          size: d.size,
          changedBlocks: d.changedBlocks,
          zeroBlocks: d.zeroBlocks,
          dataBlocks: d.dataBlocks,
          bitmapMode: d.bitmapMode,
        })),
        verify: s.verify,
      })),
      runs: runs.map((r) => ({
        id: r.id,
        kind: r.kind,
        origin: r.origin,
        status: r.status,
        archiveName: r.archiveName,
        snapshotId: r.snapshotId,
        startedAt: r.startedAt.toISOString(),
        finishedAt: r.finishedAt?.toISOString() ?? null,
        stats: r.stats,
        error: r.errorMessage,
        logTail: r.logTail,
      })),
      tasks: tasks.map((t) => ({
        id: t.id,
        kind: t.kind,
        status: t.status,
        createdAt: t.createdAt.toISOString(),
      })),
    };
  });
}

/** The node that hosts a guest (vzdump and restores run on the guest's node). */
async function nodeFor(
  tx: Parameters<Parameters<typeof withTenantTx>[2]>[0],
  clusterId: string,
  name: string | null,
): Promise<PveNode> {
  const nodes = await tx
    .select()
    .from(pveNodes)
    .where(and(eq(pveNodes.clusterId, clusterId), isNull(pveNodes.revokedAt)));
  const node = nodes.find((n) => n.name === name);
  if (!node) {
    throw new ProblemError(409, "No helper on that node", {
      type: PVE_PROBLEMS.noNode,
      detail: `restow-pve is not enrolled on node ${name ?? "?"}. Install it there first.`,
    });
  }
  return node;
}

/** Queue a backup of a guest on its node. */
export async function backupNow(
  database: Database,
  tenantId: string,
  guestId: string,
  input: { verifyRead: boolean },
  actor: PveActor | null,
  now: Date = new Date(),
) {
  return withTenantTx(database, tenantId, async (tx) => {
    const guest = await loadGuest(tx, guestId);
    if (guest.kind === "vm" && guest.template) {
      throw new ProblemError(409, "Templates cannot be backed up", {
        type: PVE_PROBLEMS.template,
        detail:
          "PVE does not back up VM templates through a backup provider (fleecing is off for templates).",
      });
    }
    const node = await nodeFor(tx, guest.clusterId, guest.node);
    const [open] = await tx
      .select({ id: pveTasks.id })
      .from(pveTasks)
      .where(
        and(
          eq(pveTasks.guestId, guestId),
          eq(pveTasks.kind, "backup"),
          inArray(pveTasks.status, ["pending", "delivered"]),
        ),
      )
      .limit(1);
    if (open) {
      return { taskId: open.id, alreadyQueued: true };
    }
    const job = guest.jobId
      ? (await tx.select().from(pveJobs).where(eq(pveJobs.id, guest.jobId)).limit(1))[0]
      : undefined;
    const [task] = await tx
      .insert(pveTasks)
      .values({
        tenantId,
        nodeId: node.id,
        guestId,
        kind: "backup",
        params: {
          vmid: guest.vmid,
          mode: job?.settings.mode ?? "snapshot",
          verifyRead: input.verifyRead,
        },
        createdBy: actor?.userId ?? null,
        expiresAt: new Date(now.getTime() + TASK_TTL_MS),
      })
      .returning();
    if (actor) {
      await auditPve(tx, {
        tenantId,
        actor,
        action: PVE_AUDIT_ACTIONS.backupRequested,
        target: guestId,
        targetType: "pve_guest",
        details: { vmid: guest.vmid, node: node.name, verifyRead: input.verifyRead },
      });
    }
    return { taskId: (task as { id: string }).id, alreadyQueued: false };
  });
}

/**
 * Restore a restore point as a new guest, on the guest's node (or another
 * node of the cluster), into the restore pool. The original is never touched.
 */
export async function restoreSnapshot(
  database: Database,
  tenantId: string,
  snapshotId: string,
  input: { targetNode?: string; targetStorage: string; targetVmid?: number; start: boolean },
  actor: PveActor,
  options: { restoreTest?: boolean } = {},
  now: Date = new Date(),
) {
  return withTenantTx(database, tenantId, async (tx) => {
    const [snap] = await tx
      .select()
      .from(pveSnapshots)
      .where(eq(pveSnapshots.id, snapshotId))
      .limit(1);
    if (!snap || snap.status !== "active") {
      throw new ProblemError(404, "Restore point not found");
    }
    const guest = await loadGuest(tx, snap.guestId);
    if (snap.kind === "ct" && guest.privileged) {
      throw new ProblemError(409, "Privileged container", {
        type: PVE_PROBLEMS.privilegedRestore,
        detail:
          "PVE refuses to restore privileged containers from a backup provider. Restore it by hand as unprivileged (docs/PVE.md).",
      });
    }
    const node = await nodeFor(tx, guest.clusterId, input.targetNode ?? guest.node);
    if (node.facts.restoresAllowed === false) {
      throw new ProblemError(409, "Restores are off on this node", {
        type: PVE_PROBLEMS.restoresOff,
        detail: `Restores are switched off on node ${node.name} (restow-pve config --allow-restores).`,
      });
    }
    const [task] = await tx
      .insert(pveTasks)
      .values({
        tenantId,
        nodeId: node.id,
        guestId: guest.id,
        kind: "restore",
        params: {
          volname: snap.archiveName,
          kind: snap.kind,
          targetVmid: input.targetVmid ?? 0,
          targetStorage: input.targetStorage,
          pool: RESTORE_POOL,
          start: input.start,
          restoreTest: options.restoreTest ?? false,
        },
        createdBy: actor.userId,
        expiresAt: new Date(now.getTime() + TASK_TTL_MS),
      })
      .returning();
    const taskId = (task as { id: string }).id;
    await tx.insert(pveRuns).values({
      tenantId,
      clusterId: guest.clusterId,
      nodeId: node.id,
      guestId: guest.id,
      kind: options.restoreTest ? "restore_test" : "restore",
      origin: "restow",
      archiveName: snap.archiveName,
      taskId,
      snapshotId: snap.id,
      startedAt: now,
    });
    await auditPve(tx, {
      tenantId,
      actor,
      action: PVE_AUDIT_ACTIONS.restoreRequested,
      target: snap.id,
      targetType: "pve_snapshot",
      details: {
        vmid: guest.vmid,
        archiveName: snap.archiveName,
        node: node.name,
        targetStorage: input.targetStorage,
        targetVmid: input.targetVmid ?? null,
        pool: RESTORE_POOL,
        restoreTest: options.restoreTest ?? false,
      },
    });
    return { taskId };
  });
}

/** Ask the worker to verify a restore point now (read back a sample of its blocks). */
export async function requestVerify(
  database: Database,
  tenantId: string,
  snapshotId: string,
  actor: PveActor,
) {
  await withTenantTx(database, tenantId, async (tx) => {
    const [snap] = await tx
      .update(pveSnapshots)
      .set({ verify: null })
      .where(and(eq(pveSnapshots.id, snapshotId), eq(pveSnapshots.status, "active")))
      .returning();
    if (!snap) {
      throw new ProblemError(404, "Restore point not found");
    }
    await tx.update(pveGuests).set({ lastVerifyAt: null }).where(eq(pveGuests.id, snap.guestId));
    await auditPve(tx, {
      tenantId,
      actor,
      action: PVE_AUDIT_ACTIONS.verifyRequested,
      target: snapshotId,
      targetType: "pve_snapshot",
    });
  });
}

export async function revokeNode(
  database: Database,
  tenantId: string,
  nodeId: string,
  actor: PveActor,
) {
  await withTenantTx(database, tenantId, async (tx) => {
    const [node] = await tx
      .update(pveNodes)
      .set({ revokedAt: new Date() })
      .where(and(eq(pveNodes.id, nodeId), isNull(pveNodes.revokedAt)))
      .returning();
    if (!node) {
      throw new ProblemError(404, "Node not found");
    }
    await auditPve(tx, {
      tenantId,
      actor,
      action: PVE_AUDIT_ACTIONS.nodeRevoked,
      target: nodeId,
      targetType: "pve_node",
      details: { node: node.name },
    });
  });
}

// ---------------------------------------------------------------------------
// Jobs
// ---------------------------------------------------------------------------

export interface JobInput {
  name: string;
  scopeAll: boolean;
  schedule: PveJobSchedule | null;
  enabled: boolean;
  settings: PveJobSettings;
}

function nextRunOf(
  input: Pick<JobInput, "schedule" | "enabled">,
  now: Date,
  lastRunAt: Date | null,
): Date | null {
  if (!input.enabled || !input.schedule) {
    return null;
  }
  try {
    return pveNextRunAt(input.schedule, now, lastRunAt);
  } catch (error) {
    throw new ProblemError(422, "Invalid schedule", {
      detail: error instanceof Error ? error.message : "The schedule cannot be planned.",
    });
  }
}

export async function saveJob(
  database: Database,
  tenantId: string,
  id: string | null,
  input: JobInput,
  actor: PveActor,
  now: Date = new Date(),
) {
  return withTenantTx(database, tenantId, async (tx) => {
    let job: PveJob | undefined;
    try {
      if (id) {
        const [old] = await tx.select().from(pveJobs).where(eq(pveJobs.id, id)).limit(1);
        if (!old) {
          throw new ProblemError(404, "Job not found");
        }
        [job] = await tx
          .update(pveJobs)
          .set({ ...input, nextRunAt: nextRunOf(input, now, old.lastRunAt) })
          .where(eq(pveJobs.id, id))
          .returning();
      } else {
        [job] = await tx
          .insert(pveJobs)
          .values({
            tenantId,
            ...input,
            nextRunAt: nextRunOf(input, now, null),
            createdBy: actor.userId,
          })
          .returning();
      }
    } catch (error) {
      if (
        error instanceof Error &&
        /pve_jobs_tenant_(name|all)_uq/.test(
          String((error as { cause?: unknown }).cause ?? error.message),
        )
      ) {
        throw new ProblemError(409, "Job conflicts", {
          detail: "A job with this name, or a second job for all guests, exists already.",
        });
      }
      throw error;
    }
    if (!job) {
      throw new Error("job write returned no row");
    }
    await auditPve(tx, {
      tenantId,
      actor,
      action: PVE_AUDIT_ACTIONS.jobChanged,
      target: job.id,
      targetType: "pve_job",
      details: { name: job.name, enabled: job.enabled, scopeAll: job.scopeAll, created: !id },
    });
    return jobDto(job);
  });
}

export async function deleteJob(database: Database, tenantId: string, id: string, actor: PveActor) {
  await withTenantTx(database, tenantId, async (tx) => {
    const [job] = await tx.delete(pveJobs).where(eq(pveJobs.id, id)).returning();
    if (!job) {
      throw new ProblemError(404, "Job not found");
    }
    await auditPve(tx, {
      tenantId,
      actor,
      action: PVE_AUDIT_ACTIONS.jobChanged,
      target: id,
      targetType: "pve_job",
      details: { name: job.name, deleted: true },
    });
  });
}

export async function assignJob(
  database: Database,
  tenantId: string,
  guestId: string,
  jobId: string | null,
  actor: PveActor,
) {
  await withTenantTx(database, tenantId, async (tx) => {
    await loadGuest(tx, guestId);
    if (jobId) {
      const [job] = await tx
        .select({ id: pveJobs.id })
        .from(pveJobs)
        .where(eq(pveJobs.id, jobId))
        .limit(1);
      if (!job) {
        throw new ProblemError(404, "Job not found");
      }
    }
    await tx.update(pveGuests).set({ jobId }).where(eq(pveGuests.id, guestId));
    await auditPve(tx, {
      tenantId,
      actor,
      action: PVE_AUDIT_ACTIONS.jobChanged,
      target: guestId,
      targetType: "pve_guest",
      details: { jobId },
    });
  });
}
