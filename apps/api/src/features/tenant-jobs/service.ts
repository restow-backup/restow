import type { JobSchedule } from "@restow/core";
import { pveGuestBackable } from "@restow/core";
import {
  type Database,
  safeErrorMessage,
  type TenantKind,
  type TenantStatus,
  tenants,
} from "@restow/db";
import { and, asc, eq, ne, sql } from "drizzle-orm";
import { mapBounded } from "../../lib/bounded-map.js";
import { notImportedRaw } from "../../lib/imported-objects.js";
import { type ProviderAccess, providerMayEnterTenant } from "../../lib/provider-access.js";
import { type Transaction, withTenantTx } from "../../lib/tenant-context.js";
import { ProblemError } from "../../problem.js";
import { isOverdue, jobStateOf } from "../backup-jobs/dto.js";
import { listBackupJobs } from "../backup-jobs/read.js";
import {
  outcomeOf,
  type TenantJobItemDto,
  type TenantJobKind,
  type TenantJobKindSummaryDto,
  type TenantJobListDto,
  type TenantJobSummariesDto,
  type TenantJobSummaryDto,
} from "./dto.js";
import type { TenantFiguresCache } from "./figures-cache.js";

/**
 * The jobs of every tenant at a glance (#63), for the provider's "All tenants" view of Jobs.
 *
 * It follows the provider dashboard (ee/api provider-dashboard) and the mailbox usage
 * (features/usage): the tenant list is read on the installation pool (`providerDb`), the one
 * place that may list every tenant; each tenant's figures are then read on the application pool
 * (`db`, the role Row Level Security binds) inside that tenant's own pinned transaction, never
 * with one query across tenants. Per tenant that is a fixed number of aggregate queries (one per
 * kind of job) whatever the number of jobs, objects or runs; nobody's job list is built for it.
 * A few tenants are read at a time ({@link TENANT_READS_AT_ONCE}), and the routes keep each
 * tenant's figures for a short while for every viewer (figures-cache.ts).
 * The list of one tenant's jobs is read on demand, when its row is opened ({@link loadTenantJobs}).
 *
 * Proxmox VE is counted next to mail and machines: its jobs, tasks and runs are tenant data
 * under the same policies (packages/db/sql/rls.sql), which the application role reads like
 * the VMs & containers page does.
 */

export interface TenantJobsDeps {
  /** The application pool (RLS). */
  db: Database;
  /** The installation pool, for the tenant list only. */
  providerDb: Database;
  /** Each tenant's figures, kept for a short while; without it every request reads them. */
  figures?: TenantFiguresCache<TenantJobFigures>;
}

/** The figures of one tenant: one summary per kind of job. */
export type TenantJobFigures = Record<TenantJobKind, TenantJobKindSummaryDto>;

/**
 * How many tenants are read at the same time: each holds a connection of the application pool
 * (10 by default), so most of it stays free for the other requests meanwhile.
 */
export const TENANT_READS_AT_ONCE = 4;

interface TenantRow {
  id: string;
  name: string;
  status: TenantStatus;
  kind: TenantKind;
}

/** The tenants of the overview: all but those being deleted, narrowed to the member's own. */
async function listTenants(
  providerDb: Database,
  access: ProviderAccess | null,
): Promise<TenantRow[]> {
  const rows = await providerDb
    .select({ id: tenants.id, name: tenants.name, status: tenants.status, kind: tenants.kind })
    .from(tenants)
    .where(ne(tenants.status, "deleting"))
    .orderBy(asc(tenants.name));
  return access ? rows.filter((row) => providerMayEnterTenant(access, row.id)) : rows;
}

// ---------------------------------------------------------------------------
// The figures of one tenant
// ---------------------------------------------------------------------------

/** What each aggregate query returns: one row. */
interface KindRow extends Record<string, unknown> {
  jobs: number;
  paused: number;
  running: number;
  queued: number;
  failed: number;
  warning: number;
  succeeded: number;
  last_run_at: Date | string | null;
  next_run_at: Date | string | null;
}

function iso(value: Date | string | null): string | null {
  return value === null ? null : new Date(value).toISOString();
}

function kindSummary(row: KindRow | undefined): TenantJobKindSummaryDto {
  const count = (value: unknown) => Number(value ?? 0);
  const failed = count(row?.failed);
  const warning = count(row?.warning);
  return {
    jobs: count(row?.jobs),
    paused: count(row?.paused),
    running: count(row?.running),
    queued: count(row?.queued),
    outcome: outcomeOf({ failed, warning, succeeded: count(row?.succeeded) }),
    failed,
    warning,
    lastRunAt: iso(row?.last_run_at ?? null),
    nextRunAt: iso(row?.next_run_at ?? null),
  };
}

/**
 * Mail jobs. The objects in a job: active mail objects (no imported mailbox) that are members
 * of a mail job, or of none while the tenant has a mail job for all objects. A run of the mail
 * queue that completed with failed items left something out (`warning`), as History reads it.
 */
async function mailSummary(tx: Transaction, tenantId: string): Promise<KindRow | undefined> {
  const result = await tx.execute<KindRow>(sql`
    WITH mail_jobs AS (
      SELECT id, enabled, scope_mode, next_run_at FROM backup_jobs
       WHERE tenant_id = ${tenantId} AND kind = 'mail'
    ),
    covered AS (
      SELECT o.id FROM protected_objects o
        LEFT JOIN backup_job_members m ON m.protected_object_id = o.id
       WHERE o.tenant_id = ${tenantId} AND o.status = 'active' AND ${notImportedRaw("o.source_id")}
         AND ((m.id IS NOT NULL AND m.job_id IN (SELECT id FROM mail_jobs))
           OR (m.id IS NULL AND EXISTS (SELECT 1 FROM mail_jobs WHERE scope_mode = 'all')))
    ),
    newest AS (
      SELECT n.status, n.completed_at, n.failed_items
        FROM covered c
       CROSS JOIN LATERAL (
         SELECT j.status, j.completed_at,
                coalesce((j.item_failure_summary->>'total')::int, 0) AS failed_items
           FROM jobs j
          WHERE j.protected_object_id = c.id AND j.queue = 'backup'
            AND j.status IN ('completed', 'failed')
          ORDER BY j.created_at DESC LIMIT 1
       ) n
    )
    SELECT
      (SELECT count(*)::int FROM mail_jobs) AS jobs,
      (SELECT count(*)::int FROM mail_jobs WHERE NOT enabled) AS paused,
      (SELECT count(*)::int FROM jobs
        WHERE tenant_id = ${tenantId} AND queue = 'backup' AND status = 'active') AS running,
      (SELECT count(*)::int FROM jobs
        WHERE tenant_id = ${tenantId} AND queue = 'backup' AND status = 'queued') AS queued,
      (SELECT count(*)::int FROM newest WHERE status = 'failed') AS failed,
      (SELECT count(*)::int FROM newest WHERE status = 'completed' AND failed_items > 0) AS warning,
      (SELECT count(*)::int FROM newest WHERE status = 'completed' AND failed_items = 0) AS succeeded,
      (SELECT max(completed_at) FROM newest) AS last_run_at,
      (SELECT min(at) FROM (
         SELECT next_run_at AS at FROM mail_jobs WHERE enabled
         UNION ALL
         SELECT m.next_run_at FROM backup_job_members m
           JOIN mail_jobs j ON j.id = m.job_id
          WHERE j.enabled AND m.overrides->'schedule' IS NOT NULL
       ) planned) AS next_run_at`);
  return result.rows[0];
}

/**
 * Machine jobs. The machines in a job: active machines that are members of one. A backup asked
 * for by hand waits until the agent starts it (`queued`, not while one already runs).
 */
async function endpointSummary(tx: Transaction, tenantId: string): Promise<KindRow | undefined> {
  const result = await tx.execute<KindRow>(sql`
    WITH machine_jobs AS (
      SELECT id, enabled FROM backup_jobs WHERE tenant_id = ${tenantId} AND kind = 'endpoint'
    ),
    covered AS (
      SELECT e.id, e.next_run_at FROM endpoints e
        JOIN backup_job_members m ON m.endpoint_id = e.id
       WHERE e.tenant_id = ${tenantId} AND e.status = 'active'
         AND m.job_id IN (SELECT id FROM machine_jobs)
    ),
    newest AS (
      SELECT n.status, n.finished_at
        FROM covered c
       CROSS JOIN LATERAL (
         SELECT r.status, r.finished_at FROM endpoint_runs r
          WHERE r.endpoint_id = c.id AND r.kind = 'backup' AND r.status <> 'running'
          ORDER BY r.started_at DESC LIMIT 1
       ) n
    ),
    running AS (
      SELECT DISTINCT endpoint_id FROM endpoint_runs
       WHERE tenant_id = ${tenantId} AND kind = 'backup' AND status = 'running'
    )
    SELECT
      (SELECT count(*)::int FROM machine_jobs) AS jobs,
      (SELECT count(*)::int FROM machine_jobs WHERE NOT enabled) AS paused,
      (SELECT count(*)::int FROM endpoint_runs
        WHERE tenant_id = ${tenantId} AND kind = 'backup' AND status = 'running') AS running,
      (SELECT count(DISTINCT endpoint_id)::int FROM endpoint_tasks
        WHERE tenant_id = ${tenantId} AND kind = 'backup_now' AND status IN ('pending', 'delivered')
          AND endpoint_id NOT IN (SELECT endpoint_id FROM running)) AS queued,
      (SELECT count(*)::int FROM newest WHERE status = 'failed') AS failed,
      (SELECT count(*)::int FROM newest WHERE status = 'partial') AS warning,
      (SELECT count(*)::int FROM newest WHERE status = 'succeeded') AS succeeded,
      (SELECT max(finished_at) FROM newest) AS last_run_at,
      (SELECT min(next_run_at) FROM covered) AS next_run_at`);
  return result.rows[0];
}

/**
 * Proxmox VE jobs. The guests in a job: guests PVE can back up (present, no VM template) that
 * name a job, or none while the tenant has a job for all guests (pveJobOfGuest in @restow/core,
 * without the condition that the job is enabled: a paused job still had its outcome). A backup
 * that went through but could not read some items of a container left something out.
 */
async function pveSummary(tx: Transaction, tenantId: string): Promise<KindRow | undefined> {
  const result = await tx.execute<KindRow>(sql`
    WITH pve AS (
      SELECT id, enabled, scope_all, next_run_at FROM pve_jobs WHERE tenant_id = ${tenantId}
    ),
    covered AS (
      SELECT g.id FROM pve_guests g
       WHERE g.tenant_id = ${tenantId} AND g.present AND NOT (g.kind = 'vm' AND g.template)
         AND ((g.job_id IS NOT NULL AND g.job_id IN (SELECT id FROM pve))
           OR (g.job_id IS NULL AND EXISTS (SELECT 1 FROM pve WHERE scope_all)))
    ),
    newest AS (
      SELECT n.status, n.finished_at, n.unreadable
        FROM covered c
       CROSS JOIN LATERAL (
         SELECT r.status, r.finished_at,
                coalesce((r.stats->>'resticUnreadable')::int, 0) AS unreadable
           FROM pve_runs r
          WHERE r.guest_id = c.id AND r.kind = 'backup' AND r.status <> 'running'
          ORDER BY r.started_at DESC LIMIT 1
       ) n
    ),
    running AS (
      SELECT DISTINCT guest_id FROM pve_runs
       WHERE tenant_id = ${tenantId} AND kind = 'backup' AND status = 'running'
    )
    SELECT
      (SELECT count(*)::int FROM pve) AS jobs,
      (SELECT count(*)::int FROM pve WHERE NOT enabled) AS paused,
      (SELECT count(*)::int FROM running) AS running,
      (SELECT count(DISTINCT guest_id)::int FROM pve_tasks
        WHERE tenant_id = ${tenantId} AND kind = 'backup' AND status IN ('pending', 'delivered')
          AND guest_id IS NOT NULL AND guest_id NOT IN (SELECT guest_id FROM running)) AS queued,
      (SELECT count(*)::int FROM newest WHERE status = 'failed') AS failed,
      (SELECT count(*)::int FROM newest WHERE status = 'succeeded' AND unreadable > 0) AS warning,
      (SELECT count(*)::int FROM newest WHERE status = 'succeeded' AND unreadable = 0) AS succeeded,
      (SELECT max(finished_at) FROM newest) AS last_run_at,
      (SELECT min(next_run_at) FROM pve WHERE enabled) AS next_run_at`);
  return result.rows[0];
}

/** One tenant's figures, in its pinned transaction on the application pool. */
export async function loadTenantJobFigures(
  db: Database,
  tenantId: string,
): Promise<TenantJobFigures> {
  return withTenantTx(db, tenantId, async (tx) => ({
    mail: kindSummary(await mailSummary(tx, tenantId)),
    endpoint: kindSummary(await endpointSummary(tx, tenantId)),
    pve: kindSummary(await pveSummary(tx, tenantId)),
  }));
}

function logFailure(tenantId: string, error: unknown): void {
  console.error(
    JSON.stringify({
      level: "error",
      message: "tenant job summary failed",
      tenantId,
      // Never the failed query with its bound parameters.
      errorMessage: safeErrorMessage(error),
    }),
  );
}

function figuresOf(deps: TenantJobsDeps, tenantId: string): Promise<TenantJobFigures> {
  const load = () => loadTenantJobFigures(deps.db, tenantId);
  return deps.figures ? deps.figures.get(tenantId, load) : load();
}

/** One row of the overview; a tenant whose figures cannot be read says so. */
async function summaryOf(deps: TenantJobsDeps, row: TenantRow): Promise<TenantJobSummaryDto> {
  const base = { tenantId: row.id, name: row.name, status: row.status, kind: row.kind };
  try {
    return { ...base, state: "ok", kinds: await figuresOf(deps, row.id) };
  } catch (error) {
    logFailure(row.id, error);
    return { ...base, state: "error", kinds: null };
  }
}

/**
 * GET /api/v1/tenant-jobs: every tenant the provider admin may enter, with its jobs counted. A
 * tenant whose figures cannot be read is listed with `state: "error"`; the others still show.
 */
export async function loadTenantJobSummaries(
  deps: TenantJobsDeps,
  access: ProviderAccess | null,
  now: Date = new Date(),
): Promise<TenantJobSummariesDto> {
  const rows = await listTenants(deps.providerDb, access);
  deps.figures?.prune();
  const summaries = await mapBounded(rows, TENANT_READS_AT_ONCE, (row) => summaryOf(deps, row));
  return { generatedAt: now.toISOString(), tenants: summaries };
}

// ---------------------------------------------------------------------------
// The jobs of one tenant
// ---------------------------------------------------------------------------

interface PveJobRow extends Record<string, unknown> {
  id: string;
  name: string;
  enabled: boolean;
  scope_all: boolean;
  schedule: JobSchedule | null;
  next_run_at: Date | string | null;
  created_at: Date | string;
}

interface PveGuestRow extends Record<string, unknown> {
  id: string;
  kind: string;
  template: boolean;
  present: boolean;
  job_id: string | null;
  status: string | null;
  finished_at: Date | string | null;
  unreadable: number | null;
  running: boolean;
  queued: boolean;
}

/** The Proxmox VE jobs of a tenant, with what their guests' newest backups say. */
async function pveJobItems(db: Database, tenantId: string, now: Date): Promise<TenantJobItemDto[]> {
  return withTenantTx(db, tenantId, async (tx) => {
    const jobs = await tx.execute<PveJobRow>(sql`
      SELECT id, name, enabled, scope_all, schedule, next_run_at, created_at FROM pve_jobs
       WHERE tenant_id = ${tenantId} ORDER BY lower(name)`);
    if (jobs.rows.length === 0) {
      return [];
    }
    const guests = await tx.execute<PveGuestRow>(sql`
      SELECT g.id, g.kind, g.template, g.present, g.job_id,
             newest.status, newest.finished_at, newest.unreadable,
             EXISTS (SELECT 1 FROM pve_runs r WHERE r.guest_id = g.id AND r.kind = 'backup'
                       AND r.status = 'running') AS running,
             EXISTS (SELECT 1 FROM pve_tasks t WHERE t.guest_id = g.id AND t.kind = 'backup'
                       AND t.status IN ('pending', 'delivered')) AS queued
        FROM pve_guests g
        LEFT JOIN LATERAL (
          SELECT r.status, r.finished_at, coalesce((r.stats->>'resticUnreadable')::int, 0) AS unreadable
            FROM pve_runs r
           WHERE r.guest_id = g.id AND r.kind = 'backup' AND r.status <> 'running'
           ORDER BY r.started_at DESC LIMIT 1
        ) newest ON true
       WHERE g.tenant_id = ${tenantId}`);
    return jobs.rows.map((job) => {
      const covered = guests.rows.filter(
        (guest) =>
          pveGuestBackable({
            kind: guest.kind as "vm" | "ct",
            template: guest.template,
            present: guest.present,
          }) &&
          (guest.job_id === job.id || (guest.job_id === null && job.scope_all)),
      );
      let failed = 0;
      let partial = 0;
      let running = 0;
      let queued = 0;
      let never = 0;
      let last: number | null = null;
      for (const guest of covered) {
        if (guest.status === "failed") failed++;
        else if (guest.status === "succeeded" && Number(guest.unreadable ?? 0) > 0) partial++;
        if (guest.running) running++;
        else if (guest.queued) queued++;
        if (guest.status === null && !guest.running) never++;
        if (guest.finished_at) {
          const at = new Date(guest.finished_at).getTime();
          last = last === null ? at : Math.max(last, at);
        }
      }
      const lastAt = last === null ? null : new Date(last).toISOString();
      const nextRunAt = job.enabled ? iso(job.next_run_at) : null;
      return {
        id: job.id,
        kind: "pve" as const,
        name: job.name,
        enabled: job.enabled,
        scopeMode: job.scope_all ? "all" : "selected",
        scopeCount: covered.length,
        schedule: job.schedule,
        lastRun: { at: lastAt, failed, partial, running, queued },
        nextRunAt,
        state: jobStateOf({
          enabled: job.enabled,
          scopeCount: covered.length,
          failed,
          running,
          queued,
          partial,
          restore: { failed: 0, warning: 0, unverified: 0, noBackup: never },
          manual: job.schedule === null,
          overdue: isOverdue({
            schedule: job.schedule,
            nextRunAt: nextRunAt,
            lastAt,
            createdAt: new Date(job.created_at),
            now,
          }),
        }),
      };
    });
  });
}

/**
 * GET /api/v1/tenant-jobs/:tenantId: one tenant's mail, machine and Proxmox VE jobs, read-only,
 * with the state the tenant's own Jobs page shows (the mail and machine jobs are its list,
 * read the same way on the application pool).
 */
export async function loadTenantJobs(
  deps: TenantJobsDeps,
  tenantId: string,
  now: Date = new Date(),
): Promise<TenantJobListDto> {
  const [tenant] = await deps.providerDb
    .select({ id: tenants.id })
    .from(tenants)
    .where(and(eq(tenants.id, tenantId), ne(tenants.status, "deleting")))
    .limit(1);
  if (!tenant) {
    throw new ProblemError(404, "Tenant not found");
  }
  const list = await listBackupJobs(deps.db, tenantId, {}, { revealHooks: false }, now);
  const items: TenantJobItemDto[] = [];
  for (const job of list.items) {
    if (job.kind !== "mail" && job.kind !== "endpoint") {
      continue;
    }
    items.push({
      id: job.id,
      kind: job.kind,
      name: job.name,
      enabled: job.enabled,
      scopeMode: job.scopeMode,
      scopeCount: job.scope.count,
      schedule: job.schedule,
      lastRun: {
        at: job.lastRun.at,
        failed: job.lastRun.failed,
        partial: job.lastRun.partial,
        running: job.lastRun.running,
        queued: job.lastRun.queued,
      },
      nextRunAt: job.nextRunAt,
      state: job.state,
    });
  }
  items.push(...(await pveJobItems(deps.db, tenantId, now)));
  return { tenantId, items };
}
