import {
  type ExistingSchedule,
  type JobSchedule,
  type RecommendedSchedule,
  jobScheduleFromCadence,
  nextRunAt,
} from "@restow/core";
import { backupJobs, tenants } from "@restow/db";
import { and, eq } from "drizzle-orm";
import type { Transaction } from "../../lib/tenant-context.js";
import { languageOf, mailJobName, uniqueName } from "./names.js";

/**
 * The tenant's default mail job: the recommended backup and restore-check schedules
 * (@restow/core RECOMMENDED_SCHEDULE_DEFAULTS) as one job over every object, made once per
 * tenant when it has none that covers its objects. Since 0.2.0 this is what "recommended
 * schedules" means for backups and restore checks; the maintenance (retention, storage check,
 * directory sync) stays in `schedules`.
 */

/** What a job that covers every object stands in for when the recommendations are checked. */
export async function mailJobCoverage(
  tx: Transaction,
  tenantId: string,
): Promise<ExistingSchedule[]> {
  const [job] = await tx
    .select({ id: backupJobs.id })
    .from(backupJobs)
    .where(
      and(
        eq(backupJobs.tenantId, tenantId),
        eq(backupJobs.kind, "mail"),
        eq(backupJobs.scopeMode, "all"),
      ),
    )
    .limit(1);
  if (!job) {
    return [];
  }
  // A job that covers every object answers both: whether to back up, and whether to check.
  return (["backup", "verify"] as const).map((kind) => ({
    kind,
    protectedObjectId: null,
    intervalMinutes: null,
    cron: "* * * * *",
  }));
}

function scheduleOf(recommended: RecommendedSchedule | undefined): JobSchedule | null {
  return recommended ? jobScheduleFromCadence(recommended) : null;
}

/**
 * Make the default mail job from the recommended schedules, unless one that covers all objects
 * exists. Returns the new job, or null when nothing was made. The caller holds the tenant row
 * locked, so two processes never make it twice (the unique index is the last line of defence).
 */
export async function ensureDefaultMailJob(
  tx: Transaction,
  tenantId: string,
  recommended: readonly RecommendedSchedule[],
  now: Date,
): Promise<{ id: string; name: string } | null> {
  const backup = scheduleOf(recommended.find((entry) => entry.kind === "backup"));
  const verify = scheduleOf(recommended.find((entry) => entry.kind === "verify"));
  if (!backup && !verify) {
    return null;
  }
  const existing = await tx
    .select({ name: backupJobs.name, scopeMode: backupJobs.scopeMode })
    .from(backupJobs)
    .where(and(eq(backupJobs.tenantId, tenantId), eq(backupJobs.kind, "mail")));
  if (existing.some((job) => job.scopeMode === "all")) {
    return null;
  }
  const [tenant] = await tx
    .select({ language: tenants.language })
    .from(tenants)
    .where(eq(tenants.id, tenantId))
    .limit(1);
  const language = languageOf({ language: tenant?.language ?? null });
  const name = uniqueName(
    language,
    mailJobName(language),
    new Set(existing.map((job) => job.name)),
  );
  const first = (schedule: JobSchedule | null) =>
    schedule
      ? nextRunAt(
          schedule.kind === "interval"
            ? { intervalMinutes: schedule.intervalMinutes, cron: null, timezone: schedule.timeZone }
            : { intervalMinutes: null, cron: schedule.cron, timezone: schedule.timeZone },
          { now },
        )
      : null;
  const [job] = await tx
    .insert(backupJobs)
    .values({
      tenantId,
      kind: "mail",
      name,
      scopeMode: "all",
      schedule: backup,
      verifySchedule: verify,
      enabled: true,
      origin: "user",
      nextRunAt: first(backup),
      verifyNextRunAt: first(verify),
    })
    .returning({ id: backupJobs.id, name: backupJobs.name });
  return job ?? null;
}
