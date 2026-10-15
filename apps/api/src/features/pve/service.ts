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
  type PveRunProgress,
  type PveRunStats,
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
import { type DbExecutor, withTenantTx } from "../../lib/tenant-context.js";
import { ProblemError } from "../../problem.js";
import { isSafeOrigin } from "../endpoints/distribution.js";
import { auditPve, PVE_AUDIT_ACTIONS, type PveActor } from "./audit.js";
import { guestBootTestFacts } from "./boot-tests.js";
import { containerBackupPaths } from "./files.js";
import { NODE_ONLINE_MS } from "./node-service.js";
import { browsableDisks } from "./vm-files.js";

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
    // What the node runs beyond backups and restores (an older node announces nothing).
    capabilities: n.facts.capabilities ?? [],
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

/** What is happening with a guest's backup right now: handed to its node, or running. */
export type GuestActivity = "queued" | "running" | null;

/**
 * Since when a guest waits for its node (the oldest open task) or its backup
 * runs, and how far the running backup is, when its node reports it (#51).
 */
export interface GuestActivityDetail {
  since: string | null;
  progress: PveRunProgress | null;
  /**
   * The job whose scheduled round the backup belongs to; null for a backup an administrator
   * asked for ("Back up now") or one started in PVE: the jobs list shows those as a row of
   * their own while they run (#53).
   */
  jobId?: string | null;
  /** The running backup's run. */
  runId?: string | null;
}

/**
 * Where a job's scheduled round stands while it goes (#53): how many of the guests it handed
 * to their nodes are done (succeeded or failed), how many run and how many wait.
 */
export interface JobRound {
  since: string;
  total: number;
  done: number;
  failed: number;
  running: number;
  queued: number;
}

/**
 * The open rounds of the jobs from their tasks: the scheduler hands every guest of a due job
 * to its node with the job's id at `last_run_at`. A round no longer shows once nothing of it
 * waits or runs.
 */
export function jobRounds(
  tasks: readonly {
    job_id: string;
    guest_id: string | null;
    status: string;
    created_at: Date | string;
  }[],
  activity: ReadonlyMap<string, GuestActivity>,
): Map<string, JobRound> {
  const rounds = new Map<string, JobRound>();
  for (const task of tasks) {
    const round = rounds.get(task.job_id) ?? {
      since: new Date(task.created_at).toISOString(),
      total: 0,
      done: 0,
      failed: 0,
      running: 0,
      queued: 0,
    };
    const at = new Date(task.created_at).toISOString();
    if (at < round.since) {
      round.since = at;
    }
    round.total += 1;
    if (task.status === "pending" || task.status === "delivered") {
      if (task.guest_id && activity.get(task.guest_id) === "running") {
        round.running += 1;
      } else {
        round.queued += 1;
      }
    } else {
      round.done += 1;
      if (task.status === "failed") {
        round.failed += 1;
      }
    }
    rounds.set(task.job_id, round);
  }
  for (const [jobId, round] of rounds) {
    if (round.running + round.queued === 0) {
      rounds.delete(jobId);
    }
  }
  return rounds;
}

/**
 * What a restore point added to the repository: a container's new data after
 * restic's deduplication, a VM's uploaded blocks. Null when the point recorded
 * neither (restore points from before 0.3.5 may lack the counter).
 */
export function addedBytes(kind: string, stats: PveRunStats | null | undefined): number | null {
  const value = kind === "ct" ? stats?.resticBytesAdded : stats?.uploadedBytes;
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

/** Items restic could not read into a container restore point (0 when complete). */
export function unreadableItems(stats: PveRunStats | null | undefined): number {
  const value = stats?.resticUnreadable;
  return typeof value === "number" && value > 0 ? value : 0;
}

/**
 * The sizes of one restore point as the interface shows them: what it contains
 * (every file or block it restores) and what it added to the repository.
 */
export interface BackupSize {
  at: string;
  contains: number;
  added: number | null;
  unreadable: number;
}

type SnapshotSizeRow = {
  guest_id: string;
  kind: string;
  backup_at: Date | string;
  byte_size: number | string;
  stats: PveRunStats | null;
};

function backupSize(row: SnapshotSizeRow): BackupSize {
  return {
    at: new Date(row.backup_at).toISOString(),
    contains: Number(row.byte_size),
    added: addedBytes(row.kind, row.stats),
    unreadable: unreadableItems(row.stats),
  };
}

/** How many of the newest follow-up backups the average covers. */
export const FOLLOW_UP_POINTS = 10;

/** What a follow-up backup adds on average, over how many restore points. */
export interface FollowUpAverage {
  added: number;
  points: number;
}

/**
 * The average a follow-up backup added, over the newest {@link FOLLOW_UP_POINTS}
 * restore points after the first backup (newest first, or in any order: the
 * highest sequences count). Points that did not record what they added are left
 * out; null when no follow-up point recorded it.
 */
export function followUpAverage(
  points: readonly { sequence: number; added: number | null }[],
  firstSequence: number | null,
  limit = FOLLOW_UP_POINTS,
): FollowUpAverage | null {
  const recent = points
    .filter((p) => firstSequence !== null && p.sequence > firstSequence)
    .sort((a, b) => b.sequence - a.sequence)
    .slice(0, limit)
    .flatMap((p) => (p.added === null ? [] : [p.added]));
  if (recent.length === 0) {
    return null;
  }
  const total = recent.reduce((sum, value) => sum + value, 0);
  return { added: Math.round(total / recent.length), points: recent.length };
}

/**
 * The first backup a guest ever had (also when retention removed it since), its
 * newest restore point, and what its follow-up backups added on average.
 */
export interface GuestBackupSizes {
  first: BackupSize | null;
  last: BackupSize | null;
  followUp?: FollowUpAverage | null;
}

function guestDto(
  g: PveGuest,
  jobs: Map<string, PveJob>,
  lastRun: { status: string; error: string | null } | undefined,
  activity: GuestActivity = null,
  sizes: GuestBackupSizes = { first: null, last: null },
  detail: GuestActivityDetail = { since: null, progress: null },
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
  if ((sizes.last?.unreadable ?? 0) > 0) {
    attention.push("last_backup_incomplete");
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
    activity,
    activitySince: detail.since,
    activityJobId: activity ? (detail.jobId ?? null) : null,
    activityRunId: activity === "running" ? (detail.runId ?? null) : null,
    progress: activity === "running" ? detail.progress : null,
    bitmapState: bitmapState(g),
    backups: sizes,
    attention,
  };
}

export function jobDto(j: PveJob, facts: { guests?: number; round?: JobRound | null } = {}) {
  return {
    id: j.id,
    name: j.name,
    scopeAll: j.scopeAll,
    schedule: j.schedule,
    settings: j.settings,
    enabled: j.enabled,
    recommended: j.recommended,
    nextRunAt: j.nextRunAt?.toISOString() ?? null,
    lastRunAt: j.lastRunAt?.toISOString() ?? null,
    /** The guests the job backs up (its own, and for a job over all guests those in no job). */
    guestCount: facts.guests ?? 0,
    round: facts.round ?? null,
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
    // A run Restow asked for names its task; a scheduled task names its job (#53).
    const running = await tx.execute<{
      id: string;
      guest_id: string;
      started_at: Date | string;
      progress: PveRunProgress | null;
      job_id: string | null;
    }>(sql`
      SELECT DISTINCT ON (r.guest_id) r.id, r.guest_id, r.started_at, r.progress,
             t.params->>'jobId' AS job_id
        FROM pve_runs r LEFT JOIN pve_tasks t ON t.id = r.task_id
       WHERE r.kind = 'backup' AND r.status = 'running' ORDER BY r.guest_id, r.started_at DESC`);
    const queued = await tx.execute<{
      guest_id: string;
      since: Date | string;
      job_id: string | null;
    }>(sql`
      SELECT guest_id, min(created_at) AS since, max(params->>'jobId') AS job_id FROM pve_tasks
       WHERE kind = 'backup' AND status IN ('pending', 'delivered') AND guest_id IS NOT NULL
       GROUP BY guest_id`);
    const activity = new Map<string, GuestActivity>(
      queued.rows.map((r) => [r.guest_id, "queued" as const]),
    );
    const activityDetail = new Map<string, GuestActivityDetail>(
      queued.rows.map((r) => [
        r.guest_id,
        { since: new Date(r.since).toISOString(), progress: null, jobId: r.job_id ?? null },
      ]),
    );
    for (const r of running.rows) {
      activity.set(r.guest_id, "running");
      activityDetail.set(r.guest_id, {
        since: new Date(r.started_at).toISOString(),
        progress: r.progress ?? null,
        // A run started in PVE has no task; a delivered task of a round still names its job.
        jobId: r.job_id ?? activityDetail.get(r.guest_id)?.jobId ?? null,
        runId: r.id,
      });
    }
    // The tasks of each job's newest scheduled round (the scheduler writes them right after it
    // sets `last_run_at`; a minute of slack for the two clocks).
    const roundTasks = await tx.execute<{
      job_id: string;
      guest_id: string | null;
      status: string;
      created_at: Date | string;
    }>(sql`
      SELECT j.id AS job_id, t.guest_id, t.status, t.created_at
        FROM pve_tasks t JOIN pve_jobs j ON j.id::text = t.params->>'jobId'
       WHERE t.kind = 'backup' AND j.last_run_at IS NOT NULL
         AND t.created_at >= j.last_run_at - interval '1 minute'`);
    const rounds = jobRounds(roundTasks.rows, activity);
    // The first backup ever (pruned ones included: it is the full one) and the newest
    // restore point, per guest.
    const firsts = await tx.execute<SnapshotSizeRow>(sql`
      SELECT DISTINCT ON (guest_id) guest_id, kind, backup_at, byte_size, stats
        FROM pve_snapshots ORDER BY guest_id, sequence ASC`);
    const lasts = await tx.execute<SnapshotSizeRow>(sql`
      SELECT DISTINCT ON (guest_id) guest_id, kind, backup_at, byte_size, stats
        FROM pve_snapshots WHERE status = 'active' ORDER BY guest_id, sequence DESC`);
    // The newest kept follow-up points per guest (after the first backup ever), for the
    // average a follow-up backup adds.
    const followUps = await tx.execute<{
      guest_id: string;
      kind: string;
      sequence: number;
      first_sequence: number;
      stats: PveRunStats | null;
    }>(sql`
      SELECT guest_id, kind, sequence, first_sequence, stats FROM (
        SELECT guest_id, kind, sequence, first_sequence, stats,
               row_number() OVER (PARTITION BY guest_id ORDER BY sequence DESC) AS rn
          FROM (SELECT guest_id, kind, sequence, status, stats,
                       min(sequence) OVER (PARTITION BY guest_id) AS first_sequence
                  FROM pve_snapshots) all_points
         WHERE status = 'active' AND sequence > first_sequence) follow_ups
       WHERE rn <= ${FOLLOW_UP_POINTS}`);
    const sizes = new Map<string, GuestBackupSizes>();
    for (const row of firsts.rows) {
      sizes.set(row.guest_id, { first: backupSize(row), last: null, followUp: null });
    }
    for (const row of lasts.rows) {
      const entry = sizes.get(row.guest_id) ?? { first: null, last: null, followUp: null };
      entry.last = backupSize(row);
      sizes.set(row.guest_id, entry);
    }
    const followUpRows = new Map<string, { sequence: number; added: number | null }[]>();
    const firstSequences = new Map<string, number>();
    for (const row of followUps.rows) {
      const list = followUpRows.get(row.guest_id) ?? [];
      list.push({ sequence: Number(row.sequence), added: addedBytes(row.kind, row.stats) });
      followUpRows.set(row.guest_id, list);
      firstSequences.set(row.guest_id, Number(row.first_sequence));
    }
    for (const [guestId, points] of followUpRows) {
      const entry = sizes.get(guestId);
      if (entry) {
        entry.followUp = followUpAverage(points, firstSequences.get(guestId) ?? null);
      }
    }
    const jobMap = new Map(jobs.map((j) => [j.id, j]));
    const guestCounts = new Map<string, number>();
    // Paused jobs count their guests too (the worker's `coveredBy`).
    const allJob = jobs.find((j) => j.scopeAll);
    for (const g of guests) {
      const jobId = pveGuestBackable(g) ? (g.jobId ?? allJob?.id) : undefined;
      if (jobId) {
        guestCounts.set(jobId, (guestCounts.get(jobId) ?? 0) + 1);
      }
    }
    return {
      clusters: clusters.map((c) => ({
        id: c.id,
        name: c.name,
        storageId: c.storageId,
        nodes: nodes.filter((n) => n.clusterId === c.id).map((n) => nodeDto(n, now)),
      })),
      guests: guests.map((g) =>
        guestDto(
          g,
          jobMap,
          runByGuest.get(g.id),
          activity.get(g.id) ?? null,
          sizes.get(g.id),
          activityDetail.get(g.id),
        ),
      ),
      jobs: jobs.map((j) =>
        jobDto(j, { guests: guestCounts.get(j.id) ?? 0, round: rounds.get(j.id) ?? null }),
      ),
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

/**
 * How a restore point came about: the guest's first backup, an incremental one
 * (a container's restic run reuses every unchanged file, a VM read only the
 * changed blocks), or a VM that had to read whole disks again.
 */
export function backupType(
  point: { kind: string; sequence: number; disks: { bitmapMode: string }[] },
  firstSequence: number | null,
): "first" | "incremental" | "full_read" {
  if (firstSequence === null || point.sequence <= firstSequence) {
    return "first";
  }
  if (point.kind === "vm" && point.disks.some((d) => d.bitmapMode !== "reuse")) {
    return "full_read";
  }
  return "incremental";
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
    // The guest's first backup ever, also when retention pruned it since: a later
    // point is never "the first one" just because the older ones are gone.
    const [first] = await tx
      .select({ sequence: sql<number>`min(${pveSnapshots.sequence})` })
      .from(pveSnapshots)
      .where(eq(pveSnapshots.guestId, id));
    const firstSequence =
      first?.sequence === null || first?.sequence === undefined ? null : Number(first.sequence);
    const [cluster] = await tx
      .select()
      .from(pveClusters)
      .where(eq(pveClusters.id, guest.clusterId))
      .limit(1);
    return {
      guest: guestDto(guest, new Map(jobs.map((j) => [j.id, j])), undefined),
      bootTest: await guestBootTestFacts(tx, guest),
      followUp: followUpAverage(
        snapshots.map((s) => ({ sequence: s.sequence, added: addedBytes(s.kind, s.stats) })),
        firstSequence,
      ),
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
        added: addedBytes(s.kind, s.stats),
        backupType: backupType(s, firstSequence),
        unreadable: unreadableItems(s.stats),
        consistency: typeof s.stats.consistency === "string" ? s.stats.consistency : null,
        stats: s.stats,
        // What a container restore point holds, as paths in the container (#59, #62).
        contents: s.kind === "ct" ? containerBackupPaths(s.guestConfig) : null,
        // Whether its files can be browsed and downloaded: a container's restic snapshot (#62),
        // a VM's disks through the sandboxed file system reader (vm-files.ts).
        browsable: s.kind === "ct" ? s.resticSnapshotId !== null : browsableDisks(s).length > 0,
        disks: s.disks.map((d) => ({
          device: d.device,
          size: d.size,
          changedBlocks: d.changedBlocks,
          zeroBlocks: d.zeroBlocks,
          dataBlocks: d.dataBlocks,
          bitmapMode: d.bitmapMode,
        })),
        verify: s.verify,
        // The newest rated boot test of the restore point (docs/PVE.md, "Boot test").
        bootTest: s.bootTest ?? null,
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
        progress: r.status === "running" ? (r.progress ?? null) : null,
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
    if (snap?.status !== "active") {
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
  database: DbExecutor,
  tenantId: string,
  id: string | null,
  input: JobInput,
  actor: PveActor,
  now: Date = new Date(),
  options: { recommended?: boolean } = {},
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
            recommended: options.recommended ?? false,
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
      details: {
        name: job.name,
        enabled: job.enabled,
        scopeAll: job.scopeAll,
        created: !id,
        ...(job.recommended && !id
          ? { recommended: true, schedule: job.schedule, settings: job.settings }
          : {}),
      },
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
  database: DbExecutor,
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
