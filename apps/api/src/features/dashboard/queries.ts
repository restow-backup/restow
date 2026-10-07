import {
  StorageTargetError,
  installationDefaultStorage,
  isInterruptedOnly,
  staleBackupHours,
} from "@restow/core";
import {
  type Database,
  auditLog,
  backupJobs,
  endpointRuns,
  jobProgress,
  jobs,
  legalHolds,
  packs,
  protectedObjects,
  pveRuns,
  retentionPolicies,
  schedules,
  settings,
  snapshots,
  sources,
  storageTargets,
  tenants,
  verifyReports,
} from "@restow/db";
import { type SQL, and, count, desc, eq, inArray, isNotNull, isNull, sql } from "drizzle-orm";
import { notImported, snapshotNotImported } from "../../lib/imported-objects.js";
import { type Transaction, withTenantTx } from "../../lib/tenant-context.js";
import { DEFAULT_STORAGE_AUDIT_ACTIONS } from "../settings/default-storage.js";
import { SETTINGS_AUDIT_ACTIONS } from "../settings/service.js";
import { STORAGE_AUDIT_ACTIONS } from "../storage/service.js";
import type {
  BackupDayDto,
  ObjectKindCounts,
  RetentionWidget,
  StorageTargetHealth,
  VerificationDayDto,
} from "./dto.js";
import type { RetentionPolicyRow } from "./retention.js";
import { windowStart } from "./series.js";
import type { SetupFacts } from "./setup.js";

/**
 * The dashboard's own small queries. Everything about a tenant is read in a
 * transaction pinned to that tenant (Row Level Security applies) and names
 * the tenant explicitly on top; installation-level facts (settings, the
 * installation audit chain) are read on the pool the module comment of
 * apps/api/src/db.ts assigns them to.
 *
 * The trend series are computed here rather than on the stats datasets so the
 * two pages could be built in parallel; they are meant to move onto those
 * datasets later without changing this feature's response.
 */

/** Days of backup history returned: the page compares the last 14 or 30 days with the ones before. */
export const BACKUP_TREND_DAYS = 60;
/** Days of verification history and storage growth. */
export const HISTORY_DAYS = 30;
/** How far the storage forecast looks ahead. */
export const FORECAST_DAYS = 30;

const HOUR_MS = 60 * 60 * 1000;

/** A UTC day key of a timestamp column, grouped on in Postgres. */
function utcDay(column: SQL): SQL<string> {
  return sql<string>`to_char((${column}) at time zone 'UTC', 'YYYY-MM-DD')`;
}

/** When a job ended; older rows without `completed_at` fall back to their last update. */
const jobFinishedAt = sql`coalesce(${jobs.completedAt}, ${jobs.updatedAt})`;

const countWhere = (condition: SQL) =>
  sql<number>`count(*) filter (where ${condition})`.mapWith(Number);

// ---------------------------------------------------------------------------
// Tenant facts (setup checklist, retention, protected kinds, storage health)
// ---------------------------------------------------------------------------

export interface TenantFacts {
  kinds: ObjectKindCounts;
  storage: StorageTargetHealth;
  setup: Omit<SetupFacts, "storage" | "mail">;
  retention: {
    rows: RetentionPolicyRow[];
    activeHolds: number;
    snapshots: RetentionWidget["snapshots"];
    lastRun: RetentionWidget["lastRun"];
  };
}

/** Whether the environment describes a usable installation default storage. */
export function installationDefaultConfigured(env: NodeJS.ProcessEnv): boolean {
  try {
    installationDefaultStorage(env);
    return true;
  } catch (error) {
    if (error instanceof StorageTargetError) {
      return false;
    }
    throw error;
  }
}

/** The newest test of the installation's default storage, wherever it was recorded. */
export interface DefaultStorageTest {
  ok: boolean;
  at: Date;
}

/**
 * The newest test of the default storage recorded in the installation audit chain (no tenant;
 * features/settings/default-storage.ts), which only the installation pool reads. It belongs to no
 * tenant, but the default is every tenant without a target of its own, so it counts for all of them.
 */
export async function loadInstallationDefaultTest(
  providerDb: Database,
): Promise<DefaultStorageTest | null> {
  const [row] = await providerDb
    .select({
      at: auditLog.createdAt,
      ok: sql<string | null>`${auditLog.details}->>'ok'`,
    })
    .from(auditLog)
    .where(
      and(
        isNull(auditLog.tenantId),
        // Saving a default probes it first; that probe counts as its newest test.
        inArray(auditLog.action, [
          DEFAULT_STORAGE_AUDIT_ACTIONS.tested,
          DEFAULT_STORAGE_AUDIT_ACTIONS.saved,
        ]),
      ),
    )
    .orderBy(desc(auditLog.createdAt))
    .limit(1);
  return row ? { ok: row.ok === "true", at: row.at } : null;
}

async function storageHealth(
  tx: Transaction,
  tenantId: string,
  env: NodeJS.ProcessEnv,
  installationTest: DefaultStorageTest | null,
  defaultConfigured: boolean | undefined,
): Promise<StorageTargetHealth> {
  const [primary] = await tx
    .select({ status: storageTargets.status })
    .from(storageTargets)
    .where(and(eq(storageTargets.tenantId, tenantId), eq(storageTargets.role, "primary")))
    .limit(1);
  if (primary) {
    return { source: "tenant", status: primary.status };
  }
  if (!(defaultConfigured ?? installationDefaultConfigured(env))) {
    return { source: "installation_default", status: "misconfigured" };
  }
  // The default has no probe row of its own: data written to it proves it
  // works; otherwise the latest explicit test of it decides, whether the
  // tenant ran it from its storage page or the installation from its own page.
  const [written] = await tx
    .select({ id: packs.id })
    .from(packs)
    .where(eq(packs.tenantId, tenantId))
    .limit(1);
  if (written) {
    return { source: "installation_default", status: "ok" };
  }
  const [tenantTest] = await tx
    .select({
      ok: sql<string | null>`${auditLog.details}->>'ok'`,
      at: auditLog.createdAt,
    })
    .from(auditLog)
    .where(
      and(
        eq(auditLog.tenantId, tenantId),
        eq(auditLog.action, STORAGE_AUDIT_ACTIONS.defaultTested),
      ),
    )
    .orderBy(desc(auditLog.createdAt))
    .limit(1);
  const newest = [
    tenantTest ? { ok: tenantTest.ok === "true", at: tenantTest.at } : null,
    installationTest,
  ].reduce<DefaultStorageTest | null>(
    (latest, test) => (test && (!latest || test.at > latest.at) ? test : latest),
    null,
  );
  if (!newest) {
    return { source: "installation_default", status: "unverified" };
  }
  return { source: "installation_default", status: newest.ok ? "ok" : "error" };
}

export async function loadTenantFacts(
  db: Database,
  tenantId: string,
  env: NodeJS.ProcessEnv,
  /**
   * The installation-level test of the default storage (loadInstallationDefaultTest), read by the
   * caller on the installation pool; null when there is none, or it could not be read.
   */
  installationTest: DefaultStorageTest | null,
  /** Whether the current installation default is usable; omitted, `env` alone decides. */
  defaultConfigured?: boolean,
): Promise<TenantFacts> {
  return withTenantTx(db, tenantId, async (tx) => {
    const kindRows = await tx
      .select({ kind: protectedObjects.kind, n: count() })
      .from(protectedObjects)
      // Imported mailboxes are not protected objects: nothing is backed up from them.
      .where(
        and(
          eq(protectedObjects.tenantId, tenantId),
          eq(protectedObjects.status, "active"),
          notImported(),
        ),
      )
      .groupBy(protectedObjects.kind);
    const kindCount = (kind: keyof ObjectKindCounts) =>
      kindRows.find((row) => row.kind === kind)?.n ?? 0;
    const kinds = {
      mailbox: kindCount("mailbox"),
      onedrive: kindCount("onedrive"),
      imap: kindCount("imap"),
    };

    const sourceRows = await tx
      .select({ status: sources.status, n: count() })
      .from(sources)
      // The import source is no connected source: it never counts towards the setup.
      .where(and(eq(sources.tenantId, tenantId), sql`${sources.kind} <> 'import'`))
      .groupBy(sources.status);
    const sourceCount = (status: string) => sourceRows.find((row) => row.status === status)?.n ?? 0;

    // A backup runs on a schedule of an older release (one a job took over counts as the job's)
    // or on a mail job that has a schedule.
    const [scheduleRow] = await tx
      .select({ n: count() })
      .from(schedules)
      .where(
        and(
          eq(schedules.tenantId, tenantId),
          eq(schedules.kind, "backup"),
          eq(schedules.enabled, true),
          isNull(schedules.supersededByJobId),
        ),
      );
    const [jobRow] = await tx
      .select({ n: count() })
      .from(backupJobs)
      .where(
        and(
          eq(backupJobs.tenantId, tenantId),
          eq(backupJobs.kind, "mail"),
          eq(backupJobs.enabled, true),
          isNotNull(backupJobs.schedule),
        ),
      );

    const committed = sql`${snapshots.manifestPath} is not null`;
    const [snapshotRow] = await tx
      .select({
        active: countWhere(sql`${snapshots.status} = 'active' and ${committed}`),
        pruned: countWhere(sql`${snapshots.status} = 'pruned'`),
        // Backups only: an import does not make the first backup "done".
        backups: countWhere(
          sql`(${snapshots.status} = 'pruned' or (${snapshots.status} = 'active' and ${committed})) and ${snapshotNotImported()}`,
        ),
        oldestAt:
          sql<Date | null>`min(${snapshots.completedAt}) filter (where ${snapshots.status} = 'active' and ${committed})`.mapWith(
            snapshots.completedAt,
          ),
      })
      .from(snapshots)
      .where(eq(snapshots.tenantId, tenantId));

    const [reportRow] = await tx
      .select({
        reports: count(),
        green: countWhere(sql`${verifyReports.recoveryReadiness} = 'green'`),
      })
      .from(verifyReports)
      .where(eq(verifyReports.tenantId, tenantId));

    const policyRows = await tx
      .select({
        name: retentionPolicies.name,
        years: retentionPolicies.years,
        isDefault: retentionPolicies.isDefault,
        appliesTo: retentionPolicies.appliesTo,
      })
      .from(retentionPolicies)
      .where(eq(retentionPolicies.tenantId, tenantId))
      .orderBy(retentionPolicies.createdAt);

    const [holdRow] = await tx
      .select({ n: count() })
      .from(legalHolds)
      .where(and(eq(legalHolds.tenantId, tenantId), eq(legalHolds.active, true)));

    const [lastRetention] = await tx
      .select({ status: jobs.status, at: sql<Date>`${jobFinishedAt}`.mapWith(jobs.completedAt) })
      .from(jobs)
      .where(
        and(
          eq(jobs.tenantId, tenantId),
          eq(jobs.queue, "retention"),
          inArray(jobs.status, ["completed", "failed"]),
        ),
      )
      .orderBy(desc(jobFinishedAt))
      .limit(1);

    const activeSnapshots = snapshotRow?.active ?? 0;
    const prunedSnapshots = snapshotRow?.pruned ?? 0;
    return {
      kinds,
      storage: await storageHealth(tx, tenantId, env, installationTest, defaultConfigured),
      setup: {
        sources: {
          active: sourceCount("active"),
          error: sourceCount("error"),
          pending: sourceCount("pending"),
        },
        activeObjects: kinds.mailbox + kinds.onedrive + kinds.imap,
        enabledBackupSchedules: (scheduleRow?.n ?? 0) + (jobRow?.n ?? 0),
        completedSnapshots: snapshotRow?.backups ?? 0,
        verification: { reports: reportRow?.reports ?? 0, green: reportRow?.green ?? 0 },
      },
      retention: {
        rows: policyRows,
        activeHolds: holdRow?.n ?? 0,
        snapshots: {
          active: activeSnapshots,
          pruned: prunedSnapshots,
          oldestAt: toIso(snapshotRow?.oldestAt ?? null),
        },
        lastRun:
          lastRetention &&
          (lastRetention.status === "completed" || lastRetention.status === "failed")
            ? { at: toIso(lastRetention.at) ?? "", status: lastRetention.status }
            : null,
      },
    };
  });
}

/** An ISO string from a mapped timestamp column. */
function toIso(value: Date | null): string | null {
  return value && !Number.isNaN(value.getTime()) ? value.toISOString() : null;
}

// ---------------------------------------------------------------------------
// Notification mail (installation level)
// ---------------------------------------------------------------------------

/**
 * Whether a notification transport is configured, whether the operator marked
 * the mail as not needed, and how the latest test send ended. The test sends
 * are recorded in the installation audit chain (no tenant), which only the
 * installation pool reads.
 */
export async function loadMailFacts(
  db: Database,
  providerDb: Database,
): Promise<SetupFacts["mail"]> {
  const [row] = await db
    .select({ transport: settings.mailTransport, notNeeded: settings.mailNotNeeded })
    .from(settings)
    .limit(1);
  const [test] = await providerDb
    .select({ ok: sql<string | null>`${auditLog.details}->>'ok'` })
    .from(auditLog)
    .where(and(isNull(auditLog.tenantId), eq(auditLog.action, SETTINGS_AUDIT_ACTIONS.mailTested)))
    .orderBy(desc(auditLog.createdAt))
    .limit(1);
  return {
    configured: Boolean(row?.transport),
    lastTestOk: test ? test.ok === "true" : null,
    notNeeded: row?.notNeeded ?? false,
  };
}

// ---------------------------------------------------------------------------
// Trend series
// ---------------------------------------------------------------------------

export interface TenantTrends {
  backupDays: BackupDayDto[];
  verificationDays: VerificationDayDto[];
  lastCheckedAt: string | null;
  /** Bytes stored before the storage window started. */
  storageBaseline: number;
  storageWritten: { date: string; bytes: number }[];
}

/** Backup outcomes, verification ratings and bytes written per UTC day (only days with activity). */
export async function loadTenantTrends(
  db: Database,
  tenantId: string,
  now: Date,
): Promise<TenantTrends> {
  const backupSince = windowStart(now, BACKUP_TREND_DAYS);
  const historySince = windowStart(now, HISTORY_DAYS);
  return withTenantTx(db, tenantId, async (tx) => {
    const backupDay = utcDay(jobFinishedAt);
    const failedItems = sql`coalesce(${jobProgress.failed}, 0)`;
    const backupDays = await tx
      .select({
        date: backupDay,
        succeeded: countWhere(sql`${jobs.status} = 'completed' and ${failedItems} = 0`),
        withItemFailures: countWhere(sql`${jobs.status} = 'completed' and ${failedItems} > 0`),
        failed: countWhere(sql`${jobs.status} = 'failed'`),
      })
      .from(jobs)
      .leftJoin(jobProgress, eq(jobProgress.jobId, jobs.id))
      .where(
        and(
          eq(jobs.tenantId, tenantId),
          eq(jobs.queue, "backup"),
          inArray(jobs.status, ["completed", "failed"]),
          sql`${jobFinishedAt} >= ${backupSince.toISOString()}`,
        ),
      )
      .groupBy(backupDay);

    const checkedDay = utcDay(sql`${verifyReports.checkedAt}`);
    const verificationDays = await tx
      .select({
        date: checkedDay,
        green: countWhere(sql`${verifyReports.recoveryReadiness} = 'green'`),
        yellow: countWhere(sql`${verifyReports.recoveryReadiness} = 'yellow'`),
        red: countWhere(sql`${verifyReports.recoveryReadiness} = 'red'`),
      })
      .from(verifyReports)
      .where(
        and(
          eq(verifyReports.tenantId, tenantId),
          sql`${verifyReports.checkedAt} >= ${historySince.toISOString()}`,
        ),
      )
      .groupBy(checkedDay);

    const [lastCheck] = await tx
      .select({
        at: sql<Date | null>`max(${verifyReports.checkedAt})`.mapWith(verifyReports.checkedAt),
      })
      .from(verifyReports)
      .where(eq(verifyReports.tenantId, tenantId));

    const bytes = sql<number>`coalesce(sum(${packs.size}), 0)`.mapWith(Number);
    const [baseline] = await tx
      .select({ bytes })
      .from(packs)
      .where(
        and(eq(packs.tenantId, tenantId), sql`${packs.createdAt} < ${historySince.toISOString()}`),
      );
    const writtenDay = utcDay(sql`${packs.createdAt}`);
    const storageWritten = await tx
      .select({ date: writtenDay, bytes })
      .from(packs)
      .where(
        and(eq(packs.tenantId, tenantId), sql`${packs.createdAt} >= ${historySince.toISOString()}`),
      )
      .groupBy(writtenDay);

    return {
      backupDays,
      verificationDays,
      lastCheckedAt: toIso(lastCheck?.at ?? null),
      storageBaseline: baseline?.bytes ?? 0,
      storageWritten,
    };
  });
}

// ---------------------------------------------------------------------------
// Mailbox usage and the provider matrix extras
// ---------------------------------------------------------------------------

/** The mailbox cap the provider agreed with the tenant's customer (null = none; never enforced). */
export async function loadTenantCap(tx: Transaction, tenantId: string): Promise<number | null> {
  const [row] = await tx
    .select({ cap: tenants.mailboxCap })
    .from(tenants)
    .where(eq(tenants.id, tenantId))
    .limit(1);
  return row?.cap ?? null;
}

export interface TenantHealthExtras {
  /**
   * Jobs of any kind, backups and restores of servers and clients, and backups and restores of
   * VMs and containers of Proxmox VE, that failed in the last 24 hours.
   */
  failures24h: number;
  /** The same for the 24 hours before, so the provider view can show the trend. */
  failuresPrevious24h: number;
  /** The tenant's own primary target fails its probe. */
  storageError: boolean;
}

/** Failed jobs in the last two 24-hour windows and whether the primary target fails its probe. */
export async function loadTenantHealthExtras(
  db: Database,
  tenantId: string,
  now: Date,
): Promise<TenantHealthExtras> {
  const since = new Date(now.getTime() - 24 * HOUR_MS).toISOString();
  const previousSince = new Date(now.getTime() - 48 * HOUR_MS).toISOString();
  return withTenantTx(db, tenantId, async (tx) => {
    const [failed] = await tx
      .select({
        last: countWhere(sql`${jobFinishedAt} >= ${since}`),
        previous: countWhere(sql`${jobFinishedAt} < ${since}`),
      })
      .from(jobs)
      .where(
        and(
          eq(jobs.tenantId, tenantId),
          eq(jobs.status, "failed"),
          sql`${jobFinishedAt} >= ${previousSince}`,
        ),
      );
    // Failed backups and restores of servers and clients count like failed jobs; a run the agent
    // only lost to a restart is resumed by it and is no failure.
    const machineRuns = await tx
      .select({ finishedAt: endpointRuns.finishedAt, errors: endpointRuns.errors })
      .from(endpointRuns)
      .where(
        and(
          eq(endpointRuns.tenantId, tenantId),
          inArray(endpointRuns.kind, ["backup", "restore"]),
          eq(endpointRuns.status, "failed"),
          sql`${endpointRuns.finishedAt} >= ${previousSince}`,
        ),
      );
    const machineFailures = machineRuns.filter((run) => !isInterruptedOnly(run.errors ?? []));
    const machineLast = machineFailures.filter(
      (run) => run.finishedAt && run.finishedAt.toISOString() >= since,
    ).length;
    // Backups and restores of VMs and containers count the same way.
    const finishedAt = sql`coalesce(${pveRuns.finishedAt}, ${pveRuns.startedAt})`;
    const [guestRuns] = await tx
      .select({
        last: countWhere(sql`${finishedAt} >= ${since}`),
        previous: countWhere(sql`${finishedAt} < ${since}`),
      })
      .from(pveRuns)
      .where(
        and(
          eq(pveRuns.tenantId, tenantId),
          inArray(pveRuns.kind, ["backup", "restore"]),
          eq(pveRuns.status, "failed"),
          sql`${finishedAt} >= ${previousSince}`,
        ),
      );
    const [target] = await tx
      .select({ status: storageTargets.status })
      .from(storageTargets)
      .where(and(eq(storageTargets.tenantId, tenantId), eq(storageTargets.role, "primary")))
      .limit(1);
    return {
      failures24h: (failed?.last ?? 0) + machineLast + (guestRuns?.last ?? 0),
      failuresPrevious24h:
        (failed?.previous ?? 0) + machineFailures.length - machineLast + (guestRuns?.previous ?? 0),
      storageError: target?.status === "error",
    };
  });
}

// ---------------------------------------------------------------------------
// When a backup is overdue
// ---------------------------------------------------------------------------

/** After how many hours without a successful backup each kind reads as overdue (by its jobs' schedules). */
export interface StaleThresholds {
  /** Mailboxes, OneDrives and IMAP accounts: the enabled mail jobs. */
  mail: number;
  /** Servers and clients: the enabled endpoint jobs. */
  machines: number;
}

/**
 * The overdue bound of each kind from the schedules of the tenant's enabled jobs
 * (`staleBackupHours`: twice the longest planned gap of the most relaxed job, two days
 * without any schedule). A weekly job is not overdue on day three; an hourly one is after a day.
 */
export async function loadStaleThresholds(
  db: Database,
  tenantId: string,
  now: Date,
): Promise<StaleThresholds> {
  return withTenantTx(db, tenantId, async (tx) => {
    const rows = await tx
      .select({ kind: backupJobs.kind, schedule: backupJobs.schedule })
      .from(backupJobs)
      .where(
        and(
          eq(backupJobs.tenantId, tenantId),
          eq(backupJobs.enabled, true),
          isNotNull(backupJobs.schedule),
        ),
      );
    const of = (kind: "mail" | "endpoint") =>
      staleBackupHours(
        rows.filter((row) => row.kind === kind).map((row) => row.schedule),
        now,
      );
    return { mail: of("mail"), machines: of("endpoint") };
  });
}
