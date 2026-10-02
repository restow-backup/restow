import { type JobMemberOverrides, effectiveSettings } from "@restow/core";
import { type BackupJob, backupJobMembers, backupJobs } from "@restow/db";
import { and, eq, inArray } from "drizzle-orm";
import type { DbExecutor } from "../../lib/tenant-context.js";

/**
 * Which backup job a machine belongs to. Small and free of the rest of the feature, so the
 * endpoint feature can ask without importing the job service (which imports the endpoint service).
 */

export interface MachineJob {
  id: string;
  name: string;
}

/** The job of each machine (machines in no job are absent). */
export async function jobsOfEndpoints(
  tx: DbExecutor,
  tenantId: string,
  endpointIds: readonly string[],
): Promise<Map<string, MachineJob>> {
  const result = new Map<string, MachineJob>();
  if (endpointIds.length === 0) {
    return result;
  }
  const rows = await tx
    .select({
      endpointId: backupJobMembers.endpointId,
      id: backupJobs.id,
      name: backupJobs.name,
    })
    .from(backupJobMembers)
    .innerJoin(backupJobs, eq(backupJobs.id, backupJobMembers.jobId))
    .where(
      and(
        eq(backupJobMembers.tenantId, tenantId),
        inArray(backupJobMembers.endpointId, [...endpointIds]),
      ),
    );
  for (const row of rows) {
    if (row.endpointId) {
      result.set(row.endpointId, { id: row.id, name: row.name });
    }
  }
  return result;
}

/** The job of a machine with the machine's override, for the checks that look at what the job decides. */
export async function jobWithOverridesOf(
  tx: DbExecutor,
  tenantId: string,
  endpointId: string,
): Promise<{ job: BackupJob; overrides: JobMemberOverrides } | null> {
  const [row] = await tx
    .select({ job: backupJobs, overrides: backupJobMembers.overrides })
    .from(backupJobMembers)
    .innerJoin(backupJobs, eq(backupJobs.id, backupJobMembers.jobId))
    .where(
      and(eq(backupJobMembers.tenantId, tenantId), eq(backupJobMembers.endpointId, endpointId)),
    )
    .limit(1);
  return row ? { job: row.job, overrides: row.overrides ?? {} } : null;
}

/** The retention a job sets for a machine (job plus override); undefined when the machine keeps its own. */
export function jobRetentionOf(entry: { job: BackupJob; overrides: JobMemberOverrides }) {
  return effectiveSettings(entry.job.settings ?? {}, entry.overrides).retention;
}
