import { DATA_FOLDER_CANDIDATES, withDataFolder } from "@restow/core";
import { backupJobs, type Database, endpoints } from "@restow/db";
import { and, eq, inArray } from "drizzle-orm";
import { withTenantTx } from "../../lib/tenant-context.js";
import { ProblemError } from "../../problem.js";
import type { MachineFoldersDto } from "./dto.js";
import { jobProblem, jobSettingsSchema } from "./schemas.js";
import type { JobActor, JobContext } from "./service-types.js";
import { updateBackupJob } from "./write.js";

/**
 * The data folders of the machines a job editor shows (#59): what each machine's agent found, its
 * profile and why it has it. The editor compares the folders with the job's as they are being
 * edited. A machine whose agent does not report folders (before 0.4.0) has `folders: null`.
 */
export async function listMachineFolders(
  db: Database,
  tenantId: string,
  endpointIds: readonly string[],
): Promise<{ items: MachineFoldersDto[] }> {
  if (endpointIds.length === 0) {
    return { items: [] };
  }
  return withTenantTx(db, tenantId, async (tx) => {
    const rows = await tx
      .select({
        id: endpoints.id,
        hostname: endpoints.hostname,
        displayName: endpoints.displayName,
        os: endpoints.os,
        profile: endpoints.profile,
        settings: endpoints.settings,
      })
      .from(endpoints)
      .where(and(eq(endpoints.tenantId, tenantId), inArray(endpoints.id, [...endpointIds])));
    return {
      items: rows.map((row) => ({
        endpointId: row.id,
        name: row.displayName?.trim() || row.hostname,
        os: row.os,
        profile: row.profile,
        folders: row.settings.agent?.dataFolders ?? null,
        reportedAt: row.settings.agent?.reportedAt ?? null,
        machine: row.settings.agent?.machine ?? null,
        profileDetection: row.settings.profileDetection ?? null,
      })),
    };
  });
}

const KNOWN_FOLDERS = new Set(Object.values(DATA_FOLDER_CANDIDATES).flat());

/**
 * "Add to job" on a machine's page: the data folders join the job's folders, and an exclusion that
 * would still leave them out is narrowed (@restow/core `withDataFolder`). Only folders of the fixed
 * list; everything else is a change in the job editor. Saved as a change of the job's settings:
 * checked, audited and written to every machine of the job like any other. A machine of the job
 * that does not have the folder skips it (the agent backs up the paths that exist).
 */
export async function addDataFoldersToJob(
  db: Database,
  tenantId: string,
  id: string,
  folders: readonly string[],
  actor: JobActor,
  context: JobContext,
  options: { revealHooks: boolean },
) {
  for (const [index, folder] of folders.entries()) {
    if (!KNOWN_FOLDERS.has(folder)) {
      throw jobProblem(
        ["folders", String(index)],
        "unknown_data_folder",
        "Only the data folders an agent reports can be added here; change other folders in the job.",
      );
    }
  }
  const [job] = await withTenantTx(db, tenantId, (tx) =>
    tx
      .select({ kind: backupJobs.kind, settings: backupJobs.settings })
      .from(backupJobs)
      .where(and(eq(backupJobs.tenantId, tenantId), eq(backupJobs.id, id)))
      .limit(1),
  );
  if (!job) {
    throw new ProblemError(404, "Backup job not found");
  }
  if (job.kind !== "endpoint") {
    throw jobProblem(["folders"], "not_a_machine_job", "Only a machine job has folders.");
  }
  const stored = job.settings ?? {};
  const selection = folders.reduce(withDataFolder, {
    paths: stored.paths ?? [],
    excludes: stored.excludes ?? [],
  });
  const settings = jobSettingsSchema.parse({
    ...stored,
    paths: [...selection.paths],
    excludes: [...selection.excludes],
  });
  return updateBackupJob(db, tenantId, id, { settings }, actor, context, options);
}
