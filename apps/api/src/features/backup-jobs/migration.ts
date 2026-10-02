import {
  type LeftoverSchedule,
  type LegacyEndpointRow,
  type LegacyScheduleRow,
  planEndpointMigration,
  planMailMigration,
} from "@restow/core";
import {
  type Database,
  type Endpoint,
  backupJobMembers,
  backupJobs,
  endpoints,
  schedules,
  tenants,
} from "@restow/db";
import { and, asc, eq, inArray, isNull, ne, sql } from "drizzle-orm";
import { audit } from "../../lib/audit.js";
import { syncEndpointConfigs } from "./endpoint-sync.js";
import { endpointGroupName, languageOf, mailJobName, uniqueName } from "./names.js";
import { BACKUP_JOB_AUDIT_ACTIONS, SYSTEM_ACTOR } from "./service-types.js";

/**
 * The one-time step that turns the schedules and machine configurations of an older
 * installation into backup jobs (release 0.2.0; the rules are in @restow/core
 * backup-jobs/migration.ts and in the release notes, "Upgrade notes"). It runs when the api
 * starts, like the step that marks the own organisation (features/tenants/internal.ts), on the
 * installation pool, one transaction per tenant:
 *
 *   - nothing is deleted: a schedule a job took over keeps its row and gets
 *     `superseded_by_job_id`; a machine keeps its configuration (the job reproduces it, which
 *     the configuration writer proves by finding nothing to change);
 *   - a tenant is done when `tenants.backup_jobs_migrated_at` is set, so a second run (the next
 *     start, a second api replica) finds nothing to do, also for a tenant whose schedules stay
 *     as they were because no job can show them;
 *   - the step never keeps the api from starting: a tenant that fails stays as it is, with its
 *     old schedules still running, and is tried again at the next start.
 *
 * Every tenant gets an audit entry written by the system with what was done, and the
 * installation's chain one with the totals.
 */

const LOCK = "restow.backup-jobs-migration";

export interface TenantMigration {
  tenantId: string;
  mailJobId: string | null;
  mailMembers: number;
  mailOverrides: number;
  schedulesSuperseded: number;
  leftover: LeftoverSchedule[];
  endpointJobs: { id: string; name: string; machines: number; overrides: number }[];
  /** Machines whose configuration the jobs had to change; zero when the jobs reproduce them exactly. */
  machinesReconfigured: number;
}

export interface MigrationSummary {
  /** Tenants that were looked at. */
  tenants: number;
  /** Tenants that got at least one job. */
  tenantsWithJobs: number;
  mailJobs: number;
  endpointJobs: number;
  members: number;
  overrides: number;
  schedulesSuperseded: number;
  /** Schedules no job could show, left running as they were. */
  schedulesLeft: number;
  machinesReconfigured: number;
  failed: number;
}

function legacySchedule(row: typeof schedules.$inferSelect): LegacyScheduleRow {
  return {
    id: row.id,
    kind: row.kind as "backup" | "verify",
    protectedObjectId: row.protectedObjectId,
    intervalMinutes: row.intervalMinutes,
    cron: row.cron,
    timezone: row.timezone,
    enabled: row.enabled,
    nextRunAt: row.nextRunAt,
    lastRunAt: row.lastRunAt,
    createdAt: row.createdAt,
  };
}

function legacyEndpoint(row: Endpoint): LegacyEndpointRow {
  return {
    id: row.id,
    os: row.os,
    profile: row.profile,
    config: row.config,
    settings: { retention: row.settings.retention },
    createdAt: row.createdAt,
  };
}

type TenantRow = Pick<typeof tenants.$inferSelect, "id" | "language">;

/** Migrate one tenant; null when another process did it first. */
export async function migrateTenantToJobs(
  providerDb: Database,
  tenantId: string,
  now: Date,
): Promise<TenantMigration | null> {
  return providerDb.transaction(async (tx) => {
    await tx.execute(sql`select pg_advisory_xact_lock(hashtext(${`${LOCK}:${tenantId}`}))`);
    const [tenant] = await tx
      .select({
        id: tenants.id,
        language: tenants.language,
        migratedAt: tenants.backupJobsMigratedAt,
      })
      .from(tenants)
      .where(eq(tenants.id, tenantId))
      // Not FOR UPDATE: that conflicts with the key-share lock every insert referencing the
      // tenant takes (a run the scheduler writes, a machine's report), and a scheduler that
      // holds a schedule's lock while it writes its run would deadlock with this step.
      .for("no key update");
    if (!tenant || tenant.migratedAt !== null) {
      return null;
    }
    const language = languageOf(tenant as TenantRow);
    const result: TenantMigration = {
      tenantId,
      mailJobId: null,
      mailMembers: 0,
      mailOverrides: 0,
      schedulesSuperseded: 0,
      leftover: [],
      endpointJobs: [],
      machinesReconfigured: 0,
    };
    const existingJobs = await tx
      .select({
        id: backupJobs.id,
        kind: backupJobs.kind,
        name: backupJobs.name,
        scopeMode: backupJobs.scopeMode,
      })
      .from(backupJobs)
      .where(eq(backupJobs.tenantId, tenantId));

    // --- Mail: one job from the backup and verify schedules ---------------------------------
    // A tenant that has a mail job already (made by hand after this step failed for it at an
    // earlier start) keeps its schedules: they keep running next to that job, and the audit
    // entry and the totals list them so the operator can retire them.
    if (existingJobs.some((job) => job.kind === "mail")) {
      const running = await tx
        .select({
          id: schedules.id,
          kind: schedules.kind,
          protectedObjectId: schedules.protectedObjectId,
        })
        .from(schedules)
        .where(
          and(
            eq(schedules.tenantId, tenantId),
            inArray(schedules.kind, ["backup", "verify"]),
            eq(schedules.enabled, true),
            isNull(schedules.supersededByJobId),
          ),
        )
        .orderBy(asc(schedules.createdAt), asc(schedules.id));
      result.leftover = running.map((row) => ({
        id: row.id,
        kind: row.kind as "backup" | "verify",
        protectedObjectId: row.protectedObjectId,
        reason: "mail_job_exists" as const,
      }));
    } else {
      const rows = await tx
        .select()
        .from(schedules)
        .where(
          and(
            eq(schedules.tenantId, tenantId),
            inArray(schedules.kind, ["backup", "verify"]),
            isNull(schedules.supersededByJobId),
          ),
        )
        .orderBy(asc(schedules.createdAt), asc(schedules.id))
        // A scheduler running one of them right now finishes first (it locks the schedule while
        // it writes the run and advances the timer); the job then carries the advanced timer and
        // does not run the same backup again.
        .for("update");
      const plan = planMailMigration(rows.map(legacySchedule), now);
      result.leftover = [...plan.leftover];
      if (plan.create) {
        const takenNames = new Set(
          existingJobs.filter((job) => job.kind === "mail").map((job) => job.name),
        );
        const [job] = await tx
          .insert(backupJobs)
          .values({
            tenantId,
            kind: "mail",
            name: uniqueName(language, mailJobName(language), takenNames),
            scopeMode: plan.scopeMode,
            schedule: plan.schedule,
            verifySchedule: plan.verifySchedule,
            enabled: true,
            origin: "migration",
            nextRunAt: plan.nextRunAt,
            lastRunAt: plan.lastRunAt,
            verifyNextRunAt: plan.verifyNextRunAt,
            verifyLastRunAt: plan.verifyLastRunAt,
          })
          .returning();
        if (!job) {
          throw new Error("backup job insert returned no row");
        }
        result.mailJobId = job.id;
        if (plan.members.length > 0) {
          await tx.insert(backupJobMembers).values(
            plan.members.map((member) => ({
              tenantId,
              jobId: job.id,
              protectedObjectId: member.protectedObjectId,
              overrides: member.overrides,
              nextRunAt: member.nextRunAt,
              lastRunAt: member.lastRunAt,
              verifyNextRunAt: member.verifyNextRunAt,
              verifyLastRunAt: member.verifyLastRunAt,
            })),
          );
        }
        result.mailMembers = plan.members.length;
        result.mailOverrides = plan.members.filter(
          (member) => Object.keys(member.overrides).length > 0,
        ).length;
        if (plan.supersede.length > 0) {
          await tx
            .update(schedules)
            .set({ supersededByJobId: job.id })
            .where(
              and(
                eq(schedules.tenantId, tenantId),
                inArray(schedules.id, [...plan.supersede]),
                isNull(schedules.supersededByJobId),
              ),
            );
        }
        result.schedulesSuperseded = plan.supersede.length;
      }
    }

    // --- Machines: one job per group with the same profile, system and schedule ---------------
    const inJobs = await tx
      .select({ endpointId: backupJobMembers.endpointId })
      .from(backupJobMembers)
      .where(and(eq(backupJobMembers.tenantId, tenantId)));
    const taken = new Set(inJobs.flatMap((row) => (row.endpointId ? [row.endpointId] : [])));
    const machines = (
      await tx
        .select()
        .from(endpoints)
        .where(and(eq(endpoints.tenantId, tenantId), ne(endpoints.status, "revoked")))
        .orderBy(asc(endpoints.createdAt), asc(endpoints.id))
    ).filter((machine) => !taken.has(machine.id));
    const names = new Set(
      existingJobs.filter((job) => job.kind === "endpoint").map((job) => job.name),
    );
    for (const group of planEndpointMigration(machines.map(legacyEndpoint))) {
      const name = uniqueName(
        language,
        endpointGroupName(language, group.os, group.profile, group.schedule),
        names,
      );
      names.add(name);
      const [job] = await tx
        .insert(backupJobs)
        .values({
          tenantId,
          kind: "endpoint",
          name,
          scopeMode: "selected",
          schedule: group.schedule,
          settings: group.settings,
          enabled: true,
          origin: "migration",
        })
        .returning();
      if (!job) {
        throw new Error("backup job insert returned no row");
      }
      await tx.insert(backupJobMembers).values(
        group.members.map((member) => ({
          tenantId,
          jobId: job.id,
          endpointId: member.endpointId,
          overrides: member.overrides,
        })),
      );
      // The job reproduces every machine's configuration, so writing it changes nothing; this
      // is the same code that writes a configuration later, and its result is the proof.
      const synced = await syncEndpointConfigs(tx, tenantId, job, { actor: SYSTEM_ACTOR, now });
      result.machinesReconfigured += synced.updated.length;
      result.endpointJobs.push({
        id: job.id,
        name,
        machines: group.members.length,
        overrides: group.members.filter((member) => Object.keys(member.overrides).length > 0)
          .length,
      });
    }

    await tx.update(tenants).set({ backupJobsMigratedAt: now }).where(eq(tenants.id, tenantId));
    if (result.mailJobId !== null || result.endpointJobs.length > 0 || result.leftover.length > 0) {
      await audit(tx, {
        tenantId,
        actor: "system",
        action: BACKUP_JOB_AUDIT_ACTIONS.migrated,
        target: tenantId,
        targetType: "tenant",
        details: {
          via: "update",
          mail: {
            jobId: result.mailJobId,
            members: result.mailMembers,
            overrides: result.mailOverrides,
            schedulesSuperseded: result.schedulesSuperseded,
            // Left as they were because one job cannot show them (they keep running).
            left: result.leftover,
          },
          endpoints: {
            jobs: result.endpointJobs,
            machinesReconfigured: result.machinesReconfigured,
          },
        },
      });
    }
    return result;
  });
}

/**
 * Migrate every tenant that was not migrated yet. Returns the totals, or null when there was
 * nothing to do (every later start). A tenant that fails is counted and left as it was.
 */
export async function migrateToBackupJobs(
  providerDb: Database,
  options: { now?: Date; onError?: (tenantId: string, error: unknown) => void } = {},
): Promise<MigrationSummary | null> {
  const now = options.now ?? new Date();
  const pending = await providerDb
    .select({ id: tenants.id })
    .from(tenants)
    .where(and(isNull(tenants.backupJobsMigratedAt), ne(tenants.status, "deleting")))
    .orderBy(asc(tenants.createdAt), asc(tenants.id));
  if (pending.length === 0) {
    return null;
  }
  const summary: MigrationSummary = {
    tenants: 0,
    tenantsWithJobs: 0,
    mailJobs: 0,
    endpointJobs: 0,
    members: 0,
    overrides: 0,
    schedulesSuperseded: 0,
    schedulesLeft: 0,
    machinesReconfigured: 0,
    failed: 0,
  };
  for (const { id } of pending) {
    try {
      const done = await migrateTenantToJobs(providerDb, id, now);
      if (!done) {
        continue;
      }
      summary.tenants++;
      const jobs = (done.mailJobId ? 1 : 0) + done.endpointJobs.length;
      if (jobs > 0) {
        summary.tenantsWithJobs++;
      }
      summary.mailJobs += done.mailJobId ? 1 : 0;
      summary.endpointJobs += done.endpointJobs.length;
      summary.members +=
        done.mailMembers + done.endpointJobs.reduce((sum, job) => sum + job.machines, 0);
      summary.overrides +=
        done.mailOverrides + done.endpointJobs.reduce((sum, job) => sum + job.overrides, 0);
      summary.schedulesSuperseded += done.schedulesSuperseded;
      summary.schedulesLeft += done.leftover.length;
      summary.machinesReconfigured += done.machinesReconfigured;
    } catch (error) {
      summary.failed++;
      options.onError?.(id, error);
    }
  }
  if (summary.tenants === 0 && summary.failed === 0) {
    return null;
  }
  if (summary.tenantsWithJobs > 0 || summary.schedulesLeft > 0) {
    await providerDb.transaction(async (tx) => {
      await audit(tx, {
        tenantId: null,
        actor: "system",
        action: BACKUP_JOB_AUDIT_ACTIONS.migrated,
        target: "installation",
        targetType: "installation",
        details: { via: "update", ...summary },
      });
    });
  }
  return summary;
}
